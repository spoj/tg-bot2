import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { conversationAgent } from "../src/agent-ref.js";
import { AgentEventRouter, type AgentNotifier } from "../src/agent.js";
import { WorkspaceTimeline } from "../src/events.js";
import { AgentCredentials } from "../src/host-bridge.js";
import type { PiRunResult } from "../src/pi-worker.js";
import { WorkspaceTasks, type WorkspaceTaskWorkerOptions, type WorkspaceTasksOptions } from "../src/task.js";

const temporaryDirectories: string[] = [];
const NOW = Date.parse("2026-08-24T04:00:00.000Z");
const CHAT = conversationAgent(123, 7);
const OTHER_CHAT = conversationAgent(456);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string; eventsLog: string; statePath: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "task-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  const eventsLog = path.join(dataDir, "timeline.jsonl");
  const statePath = path.join(dataDir, "run", "tasks.json");
  await mkdir(workspace, { recursive: true });
  await writeFile(eventsLog, "", "utf8");
  return { dataDir, workspace, eventsLog, statePath };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function readTimeline(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

type FakeTask = {
  options: WorkspaceTaskWorkerOptions;
  run: () => Promise<PiRunResult>;
  steer: Mock;
  stop: Mock;
  activity: Mock;
  onPrompted: Mock;
  resolveRun: (result: PiRunResult) => void;
};

function fakeWorkerFactory(): { factory: Mock; tasks: FakeTask[] } {
  const tasks: FakeTask[] = [];
  const factory = vi.fn(async (options: WorkspaceTaskWorkerOptions): Promise<FakeTask> => {
    const task = {} as FakeTask;
    task.options = options;
    task.steer = vi.fn(async () => undefined);
    task.stop = vi.fn(async () => task.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" }));
    task.activity = vi.fn(() => ({ at: 0, text: "" }));
    task.resolveRun = () => {};
    task.onPrompted = vi.fn();
    task.run = () => {
      task.onPrompted.mock.calls[0]?.[0]();
      return new Promise<PiRunResult>((resolve) => {
        task.resolveRun = resolve;
      });
    };
    tasks.push(task);
    return task;
  });
  return { factory, tasks };
}

const success = (stdout = "final report"): PiRunResult => ({ code: 0, signal: null, stderr: "", stdout });

function setupTasks(
  workspace: string,
  eventsLog: string,
  statePath: string,
  factory: Mock,
  options: Partial<WorkspaceTasksOptions> & { notifier?: AgentNotifier } = {},
): { service: WorkspaceTasks; timeline: WorkspaceTimeline; credentials: AgentCredentials } {
  const timeline = new WorkspaceTimeline(eventsLog);
  const router = new AgentEventRouter(options.notifier ?? { followup: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) });
  timeline.subscribe((record, rawLine) => router.onEvent(record, rawLine));
  const { notifier: _notifier, ...taskOptions } = options;
  const credentials = new AgentCredentials();
  const service = new WorkspaceTasks({
    workspace,
    statePath,
    timeline,
    credentials,
    appRoot: process.cwd(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    workerFactory: factory,
    now: () => NOW,
    ...taskOptions,
  });
  return { service, timeline, credentials };
}

function stateTasks(state: Record<string, unknown>): Array<Record<string, unknown>> {
  return state.tasks as Array<Record<string, unknown>>;
}

describe("WorkspaceTasks", () => {
  it("rejects invalid intervals and launch options", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory } = fakeWorkerFactory();
    expect(() => setupTasks(workspace, eventsLog, statePath, factory, { heartbeatIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    await expect(service.spawn({ prompt: "   " }, CHAT)).rejects.toThrow("non-empty");
    await expect(service.spawn({ prompt: "x".repeat(1024 * 1024 + 1) }, CHAT)).rejects.toThrow("exceeds");
    await expect(service.spawn({ prompt: "work", model: "" }, CHAT)).rejects.toThrow("model");
    await expect(service.spawn({ prompt: "work", thinking: "" }, CHAT)).rejects.toThrow("thinking");
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes optional model and thinking while keeping task credentials annotate-only", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service, credentials } = setupTasks(workspace, eventsLog, statePath, factory);
    await service.spawn({ prompt: "inspect attachment", model: "openrouter/model", thinking: "high" }, CHAT, "run-isolated");
    expect(tasks[0]?.options).toMatchObject({ prompt: "inspect attachment", model: "openrouter/model", thinking: "high", continuation: false });
    const token = tasks[0]?.options.token;
    expect(credentials.authorize(token!, "annotate")).toEqual({ kind: "task", runId: "run-isolated" });
    expect(() => credentials.authorize(token!, "send")).toThrow("not allowed to call send");
    tasks[0]?.resolveRun(success());
    await vi.waitFor(async () => expect(stateTasks(await readJson(statePath))[0]).toMatchObject({ status: "done" }));
  });

  it("stores host state and only sessions plus latest output in the shared task folder", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, statePath, factory, { notifier: { followup, interrupt: vi.fn() } });

    const launched = await service.spawn({ prompt: "Investigate the parser regression." }, CHAT);
    const runDir = path.join(workspace, ".pi", "tasks", launched.runId);
    expect(stateTasks(await readJson(statePath))).toMatchObject([{
      id: launched.runId,
      owner: { chat_id: 123, message_thread_id: 7 },
      status: "running",
      updated_at: "2026-08-24T04:00:00.000Z",
    }]);
    await expect(readFile(path.join(runDir, "prompt.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(runDir, "result.json"), "utf8")).rejects.toThrow();

    tasks[0]?.resolveRun(success("the findings"));
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(stateTasks(await readJson(statePath))[0]).toMatchObject({ status: "done" });
    expect((await readTimeline(eventsLog)).map((event) => event.type)).toEqual(["task_started", "task_finished"]);
    expect(followup).toHaveBeenCalledWith(
      `Task ${launched.runId} finished. Output: /workspace/.pi/tasks/${launched.runId}/output.md. Continue it with continue_task.`,
      CHAT,
      expect.objectContaining({ id: expect.any(String), sequence: expect.any(Number) }),
    );
  });

  it("removes stale output when a task fails", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, statePath, factory, { notifier: { followup, interrupt: vi.fn() } });
    const { runId } = await service.spawn({ prompt: "do the thing" }, CHAT);
    const output = path.join(workspace, ".pi", "tasks", runId, "output.md");
    await writeFile(output, "stale", "utf8");

    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    await expect(readFile(output, "utf8")).rejects.toThrow();
    expect(stateTasks(await readJson(statePath))[0]).toMatchObject({ status: "failed" });
    expect((followup.mock.calls as unknown[][])[0]?.[0]).toContain("Error: boom");
  });

  it("continues an owned settled task in its existing session and replaces output", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    const { runId } = await service.spawn({ prompt: "first pass" }, CHAT);
    const runDir = path.join(workspace, ".pi", "tasks", runId);
    const sessionMarker = path.join(runDir, "sessions", "marker");
    await writeFile(sessionMarker, "same session", "utf8");
    tasks[0]?.resolveRun(success("first output"));
    await vi.waitFor(async () => expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("first output"));

    await expect(service.continueTask({ runId, prompt: "refine it", model: "anthropic/model", thinking: "medium" }, CHAT))
      .resolves.toEqual({ runId, status: "launched" });
    expect(tasks[1]?.options).toMatchObject({ runId, prompt: "refine it", model: "anthropic/model", thinking: "medium", continuation: true });
    expect(await readFile(sessionMarker, "utf8")).toBe("same session");
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();

    tasks[1]?.resolveRun(success("refined output"));
    await vi.waitFor(async () => expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("refined output"));
    expect((await readTimeline(eventsLog)).map((event) => event.type)).toEqual([
      "task_started", "task_finished", "task_continued", "task_finished",
    ]);
  });

  it("restricts continue, steer, and cancel to the immutable owner", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    const { runId } = await service.spawn({ prompt: "owned task" }, CHAT);

    await expect(service.continueTask({ runId, prompt: "too soon" }, CHAT)).rejects.toThrow("use steer_task");
    await expect(service.steer(runId, "steal", OTHER_CHAT)).rejects.toThrow("not owned");
    await expect(service.cancel(runId, OTHER_CHAT)).rejects.toThrow("not owned");
    await expect(service.steer(runId, "owner steer", CHAT)).resolves.toBe("delivered");
    expect(tasks[0]?.steer).toHaveBeenCalledWith("owner steer");

    tasks[0]?.resolveRun(success());
    await vi.waitFor(async () => expect(stateTasks(await readJson(statePath))[0]).toMatchObject({ status: "done" }));
    await expect(service.continueTask({ runId, prompt: "steal continuation" }, OTHER_CHAT)).rejects.toThrow("not owned");
  });

  it("cancels owned running and queued tasks", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    await service.start();
    for (let index = 0; index < 8; index += 1) await service.spawn({ prompt: `prompt ${index}` }, CHAT);
    const queued = await service.spawn({ prompt: "queued" }, CHAT);

    await expect(service.cancel(queued.runId, CHAT)).resolves.toBe("cancelled-queued");
    expect(stateTasks(await readJson(statePath)).find((task) => task.id === queued.runId)).toMatchObject({ status: "aborted" });
    await expect(service.cancel(tasks[0]!.options.runId, CHAT)).resolves.toBe("stopped");
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    for (const task of tasks.slice(1)) task.resolveRun(success());
    await service.stop();
  });

  it("launches queued work when a slot settles", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    await service.start();
    for (let index = 0; index < 8; index += 1) await service.spawn({ prompt: `prompt ${index}` }, CHAT);
    const queued = await service.spawn({ prompt: "prompt 8" }, CHAT);
    expect(queued.status).toBe("queued");

    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(tasks).toHaveLength(9));
    expect(tasks[8]?.options).toMatchObject({ runId: queued.runId, prompt: "prompt 8" });
    for (const task of tasks.slice(1)) task.resolveRun(success());
    await service.stop();
  });

  it("marks interrupted persisted tasks aborted and prunes old terminal state", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      tasks: [
        { id: "running", owner: { chat_id: 123, message_thread_id: 7 }, status: "running", updated_at: "2026-08-23T00:00:00.000Z" },
        { id: "old", owner: { chat_id: 123, message_thread_id: 7 }, status: "done", updated_at: "2026-07-01T00:00:00.000Z" },
        { id: "recent", owner: { chat_id: 123, message_thread_id: 7 }, status: "failed", updated_at: "2026-08-20T00:00:00.000Z" },
      ],
    }), "utf8");
    const { factory } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);

    await service.start();

    expect(stateTasks(await readJson(statePath))).toMatchObject([
      { id: "running", status: "aborted", updated_at: "2026-08-24T04:00:00.000Z" },
      { id: "recent", status: "failed" },
    ]);
    await expect(service.continueTask({ runId: "old", prompt: "revive" }, CHAT)).rejects.toThrow("no longer tracked");
    expect(factory).not.toHaveBeenCalled();
    await service.stop();
  });

  it("requires a retained session before continuing", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      tasks: [{ id: "missing-session", owner: { chat_id: 123, message_thread_id: 7 }, status: "done", updated_at: "2026-08-23T00:00:00.000Z" }],
    }), "utf8");
    const { factory } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);

    await expect(service.continueTask({ runId: "missing-session", prompt: "resume" }, CHAT)).rejects.toThrow("no resumable session");
  });

  it("replaces planted output symlinks without touching their targets", async () => {
    const { dataDir, workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    const { runId } = await service.spawn({ prompt: "safe output" }, CHAT);
    const output = path.join(workspace, ".pi", "tasks", runId, "output.md");
    const sentinel = path.join(dataDir, "sentinel");
    await writeFile(sentinel, "unchanged", "utf8");
    await symlink(sentinel, output);

    tasks[0]?.resolveRun(success("safe"));
    await vi.waitFor(async () => expect(await readFile(output, "utf8")).toBe("safe"));
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  it("stops active workers and records them aborted", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, statePath, factory);
    await service.start();
    const { runId } = await service.spawn({ prompt: "long work" }, CHAT);

    await service.stop();

    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    expect(stateTasks(await readJson(statePath)).find((task) => task.id === runId)).toMatchObject({ status: "aborted" });
  });

  it("emits owner-grouped heartbeat activity without prompt artifacts", async () => {
    const { workspace, eventsLog, statePath } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const callbacks: Array<() => void> = [];
    const setIntervalMock = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as unknown as typeof setInterval;
    const now = vi.fn(() => 60_000);
    const { service } = setupTasks(workspace, eventsLog, statePath, factory, {
      notifier: { followup, interrupt: vi.fn() },
      setInterval: setIntervalMock,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
      now,
      heartbeatIntervalMs: 300_000,
    });
    await service.start();
    await service.spawn({ prompt: "heartbeat me" }, CHAT);
    tasks[0]?.activity.mockReturnValue({ at: 45_000, text: "still thinking" });
    now.mockReturnValue(300_000);

    callbacks[0]?.();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const message = (followup.mock.calls as unknown[][])[0]?.[0] as string;
    expect(message).toContain("1 task(s) running");
    expect(message).toContain("running 4m");
    expect(message).toContain('activity preview: "still thinking"');
    expect(message).not.toContain("prompt.txt");
    tasks[0]?.resolveRun(success());
    await service.stop();
  });
});
