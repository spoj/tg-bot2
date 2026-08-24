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

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string; eventsLog: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "task-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const eventsLog = path.join(dataDir, "timeline.jsonl");
  await writeFile(eventsLog, "", "utf8");
  return { dataDir, workspace, eventsLog };
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
      // Default fake: the initial prompt is written as soon as the run starts.
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

/** Fake worker whose initial-prompt write happens only when the test calls promptWritten(). */
type GatedTask = FakeTask & { promptWritten: () => void };

function gatedWorkerFactory(): { factory: Mock; tasks: GatedTask[] } {
  const tasks: GatedTask[] = [];
  const factory = vi.fn(async (options: WorkspaceTaskWorkerOptions): Promise<GatedTask> => {
    const task = {} as GatedTask;
    task.options = options;
    task.steer = vi.fn(async () => undefined);
    task.stop = vi.fn(async () => task.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" }));
    task.activity = vi.fn(() => ({ at: 0, text: "" }));
    task.resolveRun = () => {};
    task.onPrompted = vi.fn();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    task.promptWritten = () => releaseGate();
    task.run = () => {
      void gate.then(() => {
        task.onPrompted.mock.calls[0]?.[0]();
      });
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

const CHAT = conversationAgent(123);

function setupTasks(
  workspace: string,
  eventsLog: string,
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
    timeline,
    credentials,
    appRoot: process.cwd(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    workerFactory: factory,
    ...taskOptions,
  });
  return { service, timeline, credentials };
}

describe("WorkspaceTasks", () => {
  it("rejects heartbeat intervals above the timer-safe limit", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory } = fakeWorkerFactory();
    expect(() => setupTasks(workspace, eventsLog, factory, { heartbeatIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("rejects empty and oversized prompts without spawning or settling", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await expect(service.spawn("   ", CHAT)).rejects.toThrow("non-empty");
    await expect(service.spawn("x".repeat(1024 * 1024 + 1), CHAT)).rejects.toThrow("exceeds");
    await expect(service.spawn("🙂".repeat(262_145), CHAT)).rejects.toThrow("exceeds");
    expect(factory).not.toHaveBeenCalled();
    const events = await readTimeline(eventsLog);
    expect(events).toHaveLength(0);
  });

  it("issues anonymous tasks annotate-only host credentials", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service, credentials } = setupTasks(workspace, eventsLog, factory);
    await service.spawn("inspect attachment", CHAT, "run-isolated");
    const token = tasks[0]?.options.token;
    expect(credentials.authorize(token!, "annotate")).toEqual({ kind: "task", runId: "run-isolated" });
    expect(() => credentials.authorize(token!, "send")).toThrow("not allowed to call send");
    tasks[0]?.resolveRun(success());
    await vi.waitFor(async () => expect(await readJson(path.join(workspace, ".pi", "tasks", "run-isolated", "result.json"))).toMatchObject({ status: "done" }));
  });

  it("spawns into a uuid run directory, records output, and settles with a followup", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const launched = await service.spawn("Investigate the parser regression.", CHAT);
    expect(tasks).toHaveLength(1);
    expect(launched.status).toBe("launched");
    expect(tasks[0]?.options).toMatchObject({ runId: launched.runId, prompt: "Investigate the parser regression." });

    const runDir = path.join(workspace, ".pi", "tasks", launched.runId);
    expect(await readFile(path.join(runDir, "prompt.txt"), "utf8")).toBe("Investigate the parser regression.");
    tasks[0]?.resolveRun(success("the findings"));
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    const events = await readTimeline(eventsLog);
    expect(events.map((event) => ({ type: event.type, ...("runId" in event ? { runId: event.runId } : {}) }))).toMatchObject([
      { type: "task_finished", runId: launched.runId },
    ]);
    expect(followup).toHaveBeenCalledWith(
      `Task ${launched.runId} finished. Complete instruction and results: /workspace/.pi/tasks/${launched.runId}/prompt.txt, output.md, result.json`,
      CHAT,
      expect.objectContaining({ id: expect.any(String), sequence: expect.any(Number) }),
    );
  });

  it("replaces planted artifact symlinks without touching their targets", async () => {
    const { dataDir, workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);
    const launched = await service.spawn("safe artifacts", CHAT);
    const runDir = path.join(workspace, ".pi", "tasks", launched.runId);
    const sentinel = path.join(dataDir, "sentinel");
    await writeFile(sentinel, "unchanged", "utf8");
    await symlink(sentinel, path.join(runDir, "output.md"));
    await symlink(sentinel, path.join(runDir, "result.json"));

    tasks[0]?.resolveRun(success("safe output"));
    await vi.waitFor(async () => expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("safe output"));

    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done" });
  });

  it("reports a failed run with a stderr tail and no output file", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("do the thing", CHAT);
    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    expect(followup).toHaveBeenCalledWith(
      `Task ${runId} failed (exit 3). Complete instruction and results: /workspace/.pi/tasks/${runId}/prompt.txt, output.md, result.json`,
      CHAT,
      expect.objectContaining({ id: expect.any(String), sequence: expect.any(Number) }),
    );
  });

  it("reports a worker that fails to spawn as a failed task", async () => {
    const { workspace, eventsLog } = await fixture();
    const factory = vi.fn(async () => {
      throw new Error("bwrap missing");
    });
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    await service.spawn("prompt", CHAT);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const events = await readTimeline(eventsLog);
    expect(events).toMatchObject([{ type: "task_finished", status: "failed", stderr: "bwrap missing" }]);
  });

  it("steers a running task and reports unknown runs", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    const { runId } = await service.spawn("initial prompt", CHAT);
    expect(tasks).toHaveLength(1);

    await expect(service.steer(runId, "use python 3.12")).resolves.toBe("delivered");
    expect(tasks[0]?.steer).toHaveBeenCalledWith("use python 3.12");
    await expect(service.steer("run-unknown", "noop")).resolves.toBe("not-running");
  });

  it("queues steers arriving before the initial prompt and delivers them in order after it", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = gatedWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    const { runId } = await service.spawn("initial prompt", CHAT);
    const task = tasks[0];
    expect(task).toBeDefined();
    expect(task?.onPrompted).toHaveBeenCalledOnce();

    await expect(service.steer(runId, "first steer")).resolves.toBe("delivered");
    await expect(service.steer(runId, "second steer")).resolves.toBe("delivered");
    expect(task?.steer).not.toHaveBeenCalled();

    task?.promptWritten();
    await vi.waitFor(() => expect(task?.steer.mock.calls.map((call) => call[0])).toEqual(["first steer", "second steer"]));

    await expect(service.steer(runId, "third steer")).resolves.toBe("delivered");
    await vi.waitFor(() => expect(task?.steer).toHaveBeenLastCalledWith("third steer"));
  });

  it("cancels a task before its initial prompt is written and settles it aborted without steering", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = gatedWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("long prompt", CHAT);
    const task = tasks[0];
    expect(task?.onPrompted).toHaveBeenCalledOnce();

    await expect(service.steer(runId, "too early")).resolves.toBe("delivered");
    await expect(service.cancel(runId)).resolves.toBe("stopped");
    expect(task?.stop).toHaveBeenCalledOnce();
    expect(task?.steer).not.toHaveBeenCalled();

    // A late prompt-write signal must not flush queued steers into the cancelled run.
    task?.promptWritten();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(task?.steer).not.toHaveBeenCalled();

    const events = await readTimeline(eventsLog);
    expect(events).toMatchObject([{ type: "task_finished", runId, status: "aborted" }]);
  });

  it("settles a cancelled starting task as aborted even when its prompt write never fires", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = gatedWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("long prompt", CHAT);
    const task = tasks[0];
    await expect(service.steer(runId, "too early")).resolves.toBe("delivered");
    await expect(service.cancel(runId)).resolves.toBe("stopped");
    expect(task?.steer).not.toHaveBeenCalled();

    // promptWritten() is never called: the cancelled run must still settle aborted.
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(task?.steer).not.toHaveBeenCalled();
    expect((followup.mock.calls as unknown[][])[0]?.[0]).toContain("aborted");
    const events = await readTimeline(eventsLog);
    expect(events).toMatchObject([{ type: "task_finished", runId, status: "aborted" }]);
  });

  it("runs up to eight tasks concurrently and queues the rest until slots free", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });
    await service.start();

    for (let index = 0; index < 8; index += 1) {
      await expect(service.spawn(`prompt ${index}`, CHAT)).resolves.toMatchObject({ status: "launched" });
    }
    expect(tasks).toHaveLength(8);
    const queued = await service.spawn("prompt 8", CHAT);
    expect(queued.status).toBe("queued");
    expect(tasks).toHaveLength(8);
    expect(await readTimeline(eventsLog)).toHaveLength(0);

    // A settled task frees a slot and the queued spawn launches automatically.
    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(tasks).toHaveLength(9));
    expect(tasks[8]?.options.prompt).toBe("prompt 8");
    expect(tasks[8]?.options.runId).toBe(queued.runId);
    for (const task of tasks) task.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(9));
  });

  it("settles a signal-killed run as aborted with a followup", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("prompt", CHAT);
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted", signal: "SIGTERM" });
    expect(followup).toHaveBeenCalledWith(
      `Task ${runId} aborted. Complete instruction and results: /workspace/.pi/tasks/${runId}/prompt.txt, output.md, result.json`,
      CHAT,
      expect.objectContaining({ id: expect.any(String), sequence: expect.any(Number) }),
    );
  });

  it("cancels a running task mid-run and settles as aborted", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("long prompt", CHAT);
    await expect(service.cancel(runId)).resolves.toBe("stopped");

    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const events = await readTimeline(eventsLog);
    expect(events).toMatchObject([{ type: "task_finished", runId, status: "aborted" }]);
  });

  it("cancels a queued spawn before it launches", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);
    await service.start();

    for (let index = 0; index < 8; index += 1) {
      await service.spawn(`prompt ${index}`, CHAT);
    }
    const queued = await service.spawn("never runs", CHAT);
    await expect(service.cancel(queued.runId)).resolves.toBe("cancelled-queued");

    tasks[0]?.resolveRun(success());
    await vi.waitFor(async () => {
      const settled = (await readTimeline(eventsLog)).filter((event) => event.type === "task_finished");
      expect(settled).toHaveLength(1);
    });
    // The freed slot stays empty: the cancelled spawn never launches.
    expect(tasks).toHaveLength(8);
  });

  it("reports cancels for unknown runs", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await service.spawn("real", CHAT);
    await expect(service.cancel("run-missing")).resolves.toBe("not-running");
    expect(tasks[0]?.stop).not.toHaveBeenCalled();
    const events = await readTimeline(eventsLog);
    expect(events).toHaveLength(0);
  });

  it("marks unfinished run directories aborted without replaying timeline history", async () => {
    const { workspace, eventsLog } = await fixture();
    const deadRun = path.join(workspace, ".pi", "tasks", "22222222-2222-4222-8222-222222222222");
    await mkdir(path.join(deadRun, "sessions"), { recursive: true });
    await writeFile(path.join(deadRun, "prompt.txt"), "prompt", "utf8");
    const finishedRun = path.join(workspace, ".pi", "tasks", "33333333-3333-4333-8333-333333333333");
    await mkdir(finishedRun, { recursive: true });
    await writeFile(path.join(finishedRun, "prompt.txt"), "done earlier", "utf8");
    await writeFile(path.join(finishedRun, "result.json"), JSON.stringify({ status: "done", exitCode: 0 }), "utf8");
    const emptyRun = path.join(workspace, ".pi", "tasks", "44444444-4444-4444-8444-444444444444");
    await mkdir(path.join(emptyRun, "sessions"), { recursive: true });
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await service.start();

    expect(factory).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
    expect(await readJson(path.join(deadRun, "result.json"))).toEqual({ status: "aborted" });
    expect(await readJson(path.join(finishedRun, "result.json"))).toEqual({ status: "done", exitCode: 0 });
    await expect(readFile(path.join(emptyRun, "sessions"), "utf8")).rejects.toThrow();
    expect(await readTimeline(eventsLog)).toEqual([]);
  });

  it("stop() stops in-flight workers and settles them as aborted", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });
    await service.start();

    const { runId } = await service.spawn("prompt", CHAT);
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted" });
    expect(followup).toHaveBeenCalledWith(
      `Task ${runId} aborted. Complete instruction and results: /workspace/.pi/tasks/${runId}/prompt.txt, output.md, result.json`,
      CHAT,
      expect.objectContaining({ id: expect.any(String), sequence: expect.any(Number) }),
    );
  });

  it("sends a heartbeat followup while tasks run and stays silent when idle", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const callbacks: Array<() => void> = [];
    const setIntervalMock = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as unknown as typeof setInterval;
    const clearInterval = vi.fn() as unknown as typeof globalThis.clearInterval;
    const now = vi.fn(() => 60_000);
    const { service } = setupTasks(workspace, eventsLog, factory, {
      notifier: { followup, interrupt: vi.fn() },
      setInterval: setIntervalMock,
      clearInterval,
      now,
      heartbeatIntervalMs: 300_000,
    });
    await service.start();

    callbacks[0]?.();
    expect(followup).not.toHaveBeenCalled();

    await service.spawn("heartbeat me", CHAT);
    tasks[0]?.activity.mockReturnValue({ at: 45_000, text: "still thinking" });
    now.mockReturnValue(300_000);
    callbacks[0]?.();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1));
    const message = (followup.mock.calls as unknown[][])[0]?.[0] as string;
    expect(message).toContain("1 task(s) running");
    expect(message).toContain(`/workspace/.pi/tasks/`);
    expect(message).toContain("/prompt.txt");
    expect(message).toContain("running 4m");
    expect(message).toContain('activity preview: "still thinking"');
    expect(message).toContain("preview only");

    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    callbacks[0]?.();
    expect(followup).toHaveBeenCalledTimes(2);
  });

});