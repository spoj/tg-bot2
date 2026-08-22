import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { WorkspaceTasks, type WorkspaceTaskWorkerOptions, type WorkspaceTasksOptions } from "../src/task.js";
import { WorkspaceEventLog } from "../src/events.js";
import { AgentEventRouter, type AgentNotifier } from "../src/agent.js";
import type { PiRunResult } from "../src/pi-worker.js";
import type { CancelRequest, SpawnRequest } from "../src/request-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-task-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  return { dataDir, workspace };
}

function spawnRecord(runId: string, prompt: string): SpawnRequest {
  return { type: "spawn_request", runId, prompt };
}
function cancelRecord(runId: string): CancelRequest {
  return { type: "cancel_request", runId };
}

async function logEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "events.jsonl"), "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

type FakeTask = {
  options: WorkspaceTaskWorkerOptions;
  resolveRun: (result: PiRunResult) => void;
  steer: Mock<(message: string) => Promise<void>>;
  stop: Mock;
  activity: Mock;
};

function fakeWorkerFactory() {
  const tasks: FakeTask[] = [];
  const factory = vi.fn((options: WorkspaceTaskWorkerOptions) => {
    let resolveRun!: (result: PiRunResult) => void;
    const run = new Promise<PiRunResult>((resolve) => { resolveRun = resolve; });
    const task: FakeTask = {
      options,
      resolveRun,
      steer: vi.fn(async () => undefined),
      stop: vi.fn(async () => { resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" }); }),
      activity: vi.fn(() => ({ at: 0, text: "" })),
    };
    tasks.push(task);
    return { run: () => run, steer: task.steer, stop: task.stop, activity: task.activity };
  });
  return { factory, tasks };
}

const success = (stdout = "final report"): PiRunResult => ({ code: 0, signal: null, stderr: "", stdout });

function setupTasks(
  workspace: string,
  factory: Mock,
  options: Partial<WorkspaceTasksOptions> & { notifier?: AgentNotifier } = {},
): { service: WorkspaceTasks; events: WorkspaceEventLog } {
  const events = new WorkspaceEventLog(workspace);
  const notifier = options.notifier ?? { followup: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) };
  const router = new AgentEventRouter(notifier);
  events.subscribe((record, rawLine) => router.onEvent(record, rawLine));
  const service = new WorkspaceTasks({
    workspace,
    events,
    notifier,
    appRoot: process.cwd(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    workerFactory: factory,
    ...options,
  });
  return { service, events };
}

describe("WorkspaceTasks", () => {
  it("rejects heartbeat intervals above the timer-safe limit", async () => {
    const { workspace } = await fixture();
    const { factory } = fakeWorkerFactory();
    expect(() => setupTasks(workspace, factory, { heartbeatIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("claims a spawn command into a uuid run directory, records output, and sends a completion followup", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    const claim = service.handleSpawnRequest(spawnRecord("run-1", "Investigate the parser regression."), workspace);
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(await claim).toBe("claimed");
    expect(tasks[0]?.options).toMatchObject({ runId: "run-1", prompt: "Investigate the parser regression." });
    expect(tasks[0]?.options.workspace).toBe(workspace);

    const runDir = path.join(workspace, ".pi", "tasks", "run-1");
    expect(await readFile(path.join(runDir, "prompt.txt"), "utf8")).toBe("Investigate the parser regression.");
    tasks[0]?.resolveRun(success("the findings"));
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "run-1", status: "done", exitCode: 0 },
    ]);
    expect(followup).toHaveBeenCalledWith(`Task "Investigate the parser regression." finished. Run files: /workspace/.pi/tasks/run-1/`);
  });

  it("truncates long prompts in the completion followup", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    await service.handleSpawnRequest(spawnRecord("run-1", "x".repeat(500)), workspace);
    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const message = (followup.mock.calls as unknown[][])[0]?.[0] as string;
    expect(message).toContain(`"${"x".repeat(99)}…"`);
  });

  it("reports a failed run with a stderr tail and no output file", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    await service.handleSpawnRequest(spawnRecord("run-1", "do the thing"), workspace);
    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", "run-1");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    expect(await logEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "run-1", status: "failed", exitCode: 3, stderr: "boom" },
    ]);
    expect(followup).toHaveBeenCalledWith(`Task "do the thing" failed (exit 3). Run files: /workspace/.pi/tasks/run-1/`);
  });

  it("reports a worker that fails to spawn as a failed task", async () => {
    const { workspace } = await fixture();
    const factory = vi.fn(async () => {
      throw new Error("bwrap missing");
    });
    const followup = vi.fn(async () => undefined);

    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });
    await service.handleSpawnRequest(spawnRecord("run-1", "prompt"), workspace);

    expect(await logEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "run-1", status: "failed", stderr: "bwrap missing" },
    ]);
    expect(followup).toHaveBeenCalledOnce();
  });

  it("steers a running task through handleSteerRequest and ignores unknown tasks", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, factory);

    await service.handleSpawnRequest(spawnRecord("run-1", "initial prompt"), workspace);
    expect(tasks).toHaveLength(1);

    await service.handleSteerRequest({ type: "steer_task_request", steerId: "s-1", runId: "run-1", message: "use python 3.12" }, workspace);
    expect(tasks[0]?.steer).toHaveBeenCalledWith("use python 3.12");

    // Steering an unknown task is a safe no-op
    await expect(service.handleSteerRequest({ type: "steer_task_request", steerId: "s-2", runId: "run-unknown", message: "noop" }, workspace))
      .resolves.toBeUndefined();
  });

  it("settles an empty or oversized prompt as failed without spawning", async () => {
    const { workspace } = await fixture();
    const { factory } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    expect(await service.handleSpawnRequest(spawnRecord("run-empty", "   "), workspace)).toBe("claimed");
    expect(await service.handleSpawnRequest(spawnRecord("run-big", "x".repeat(1024 * 1024 + 1)), workspace)).toBe("claimed");
    expect(factory).not.toHaveBeenCalled();
    expect(followup).toHaveBeenCalledTimes(2);
    expect(followup).toHaveBeenNthCalledWith(1, expect.stringContaining('Task "   " failed (exit unknown). Run files: /workspace/.pi/tasks/run-empty/'));
    const events = await logEvents(workspace);
    expect(events.filter((event) => event.type === "task_settled")).toHaveLength(2);
  });

  it("runs up to eight tasks concurrently and reports the rest as pending until slots free", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    for (let index = 0; index < 8; index += 1) {
      expect(await service.handleSpawnRequest(spawnRecord(`run-${index}`, `prompt ${index}`), workspace)).toBe("claimed");
    }
    expect(tasks).toHaveLength(8);
    expect(await service.handleSpawnRequest(spawnRecord("run-extra", "prompt 8"), workspace)).toBe("pending");
    expect(tasks).toHaveLength(8);

    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1));
    expect(await service.handleSpawnRequest(spawnRecord("run-extra", "prompt 8"), workspace)).toBe("claimed");
    expect(tasks).toHaveLength(9);
    expect(tasks[8]?.options.prompt).toBe("prompt 8");
    for (const task of tasks) task.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(9));
  });

  it("settles a signal-killed run as aborted with a followup", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    await service.handleSpawnRequest(spawnRecord("run-1", "prompt"), workspace);
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", "run-1");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted", signal: "SIGTERM" });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "run-1", status: "aborted" },
    ]);
    expect(followup).toHaveBeenCalledWith(`Task "prompt" aborted. Run files: /workspace/.pi/tasks/run-1/`);
  });

  it("cancels a running task mid-run and settles as aborted", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });

    await service.handleSpawnRequest(spawnRecord("run-1", "long prompt"), workspace);
    await service.handleCancelRequest(cancelRecord("run-1"), workspace);

    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(await logEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "run-1", status: "aborted" },
    ]);
  });

  it("ignores cancels for unknown runs", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, factory);

    await service.handleSpawnRequest(spawnRecord("run-real", "real"), workspace);
    await service.handleCancelRequest(cancelRecord("run-missing"), workspace);
    expect(tasks[0]?.stop).not.toHaveBeenCalled();
    expect(await logEvents(workspace)).toHaveLength(0);
  });

  it("flushes pending commands before the settle followup", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const flush = {
      flush: vi.fn(async () => undefined),
    };
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() }, flush });

    await service.handleSpawnRequest(spawnRecord("run-1", "flush me"), workspace);
    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(flush.flush).toHaveBeenCalledWith(workspace);
  });

  it("stamps aborted settles at boot for runs the host died on", async () => {
    const { workspace } = await fixture();
    const deadRun = path.join(workspace, ".pi", "tasks", "22222222-2222-4222-8222-222222222222");
    await mkdir(path.join(deadRun, "sessions"), { recursive: true });
    await writeFile(path.join(deadRun, "prompt.txt"), "prompt", "utf8");
    const noPromptRun = path.join(workspace, ".pi", "tasks", "44444444-4444-4444-8444-444444444444");
    await mkdir(path.join(noPromptRun, "sessions"), { recursive: true });
    const settledRun = path.join(workspace, ".pi", "tasks", "33333333-3333-4333-8333-333333333333");
    await mkdir(settledRun, { recursive: true });
    await writeFile(path.join(settledRun, "result.json"), '{"status":"done"}\n', "utf8");
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, factory);

    await service.start();

    expect(factory).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
    expect(await readJson(path.join(deadRun, "result.json"))).toEqual({ status: "aborted" });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "22222222-2222-4222-8222-222222222222", status: "aborted", exitCode: null },
    ]);
    expect(await readJson(path.join(settledRun, "result.json"))).toEqual({ status: "done" });
    await expect(readFile(path.join(noPromptRun, "result.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(noPromptRun, "sessions"), "utf8")).rejects.toThrow();
  });

  it("stop() stops in-flight workers and settles them as aborted", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, factory, { notifier: { followup, interrupt: vi.fn() } });
    await service.start();

    await service.handleSpawnRequest(spawnRecord("run-1", "prompt"), workspace);
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();

    const runDir = path.join(workspace, ".pi", "tasks", "run-1");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted" });
    expect(followup).toHaveBeenCalledWith(`Task "prompt" aborted. Run files: /workspace/.pi/tasks/run-1/`);
  });

  it("sends a heartbeat followup while tasks run and stays silent when idle", async () => {
    const { workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const callbacks: Array<() => void> = [];
    const setIntervalMock = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as unknown as typeof setInterval;
    const clearInterval = vi.fn() as unknown as typeof globalThis.clearInterval;
    const now = vi.fn(() => 60_000);
    const { service } = setupTasks(workspace, factory, {
      notifier: { followup, interrupt: vi.fn() },
      setInterval: setIntervalMock,
      clearInterval,
      now,
      heartbeatIntervalMs: 300_000,
    });
    await service.start();

    callbacks[0]?.();
    expect(followup).not.toHaveBeenCalled();

    await service.handleSpawnRequest(spawnRecord("run-1", "heartbeat me"), workspace);
    tasks[0]?.activity.mockReturnValue({ at: 45_000, text: "still thinking" });
    now.mockReturnValue(300_000);
    callbacks[0]?.();
    expect(followup).toHaveBeenCalledTimes(1);
    const message = (followup.mock.calls as unknown[][])[0]?.[0] as string;
    expect(message).toContain("1 task(s) running");
    expect(message).toContain('"heartbeat me"');
    expect(message).toContain('running 4m');
    expect(message).toContain('last output: "still thinking"');

    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    callbacks[0]?.();
    expect(followup).toHaveBeenCalledTimes(2);
  });
});
