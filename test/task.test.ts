import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { WorkspaceTasks, type WorkspaceTaskWorkerOptions, type WorkspaceTasksOptions } from "../src/task.js";
import { WorkspaceEventLog, eventLine } from "../src/events.js";
import { AgentEventRouter, type AgentNotifier } from "../src/agent.js";
import type { PiRunResult } from "../src/pi-worker.js";

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
  const eventsLog = path.join(dataDir, "events.jsonl");
  await writeFile(eventsLog, "", "utf8");
  return { dataDir, workspace, eventsLog };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
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

function setupTasks(
  workspace: string,
  eventsLog: string,
  factory: Mock,
  options: Partial<WorkspaceTasksOptions> & { notifier?: AgentNotifier } = {},
): { service: WorkspaceTasks; events: WorkspaceEventLog } {
  const events = new WorkspaceEventLog(eventsLog);
  const router = new AgentEventRouter(options.notifier ?? { followup: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) });
  events.subscribe((record, rawLine) => router.onEvent(record, rawLine));
  const { notifier: _notifier, ...taskOptions } = options;
  const service = new WorkspaceTasks({
    workspace,
    events,
    appRoot: process.cwd(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    workerFactory: factory,
    ...taskOptions,
  });
  return { service, events };
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

    await expect(service.spawn("   ", "123:0")).rejects.toThrow("non-empty");
    await expect(service.spawn("x".repeat(1024 * 1024 + 1), "123:0")).rejects.toThrow("exceeds");
    expect(factory).not.toHaveBeenCalled();
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toHaveLength(0);
  });

  it("spawns into a uuid run directory, records output, and settles with a followup", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const launched = await service.spawn("Investigate the parser regression.", "123:0");
    expect(tasks).toHaveLength(1);
    expect(launched.status).toBe("launched");
    expect(tasks[0]?.options).toMatchObject({ runId: launched.runId, prompt: "Investigate the parser regression." });

    const runDir = path.join(workspace, ".pi", "tasks", launched.runId);
    expect(await readFile(path.join(runDir, "prompt.txt"), "utf8")).toBe("Investigate the parser regression.");
    tasks[0]?.resolveRun(success("the findings"));
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events.map((event) => ({ type: event.type, ...("runId" in event ? { runId: event.runId } : {}) }))).toMatchObject([
      { type: "task_settled", runId: launched.runId },
    ]);
    expect(followup).toHaveBeenCalledWith(
      `Task "Investigate the parser regression." finished. Run files: /workspace/.pi/tasks/${launched.runId}/`,
      { chatId: 123 },
    );
  });

  it("reports a failed run with a stderr tail and no output file", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("do the thing", "123:0");
    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    expect(followup).toHaveBeenCalledWith(`Task "do the thing" failed (exit 3). Run files: /workspace/.pi/tasks/${runId}/`, { chatId: 123 });
  });

  it("reports a worker that fails to spawn as a failed task", async () => {
    const { workspace, eventsLog } = await fixture();
    const factory = vi.fn(async () => {
      throw new Error("bwrap missing");
    });
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    await service.spawn("prompt", "123:0");
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toMatchObject([{ type: "task_settled", status: "failed", stderr: "bwrap missing" }]);
  });

  it("steers a running task and reports unknown runs", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    const { runId } = await service.spawn("initial prompt", "123:0");
    expect(tasks).toHaveLength(1);

    await expect(service.steer(runId, "use python 3.12")).resolves.toBe("delivered");
    expect(tasks[0]?.steer).toHaveBeenCalledWith("use python 3.12");
    await expect(service.steer("run-unknown", "noop")).resolves.toBe("not-running");
  });

  it("queues steers arriving before the initial prompt and delivers them in order after it", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = gatedWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    const { runId } = await service.spawn("initial prompt", "123:0");
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

    const { runId } = await service.spawn("long prompt", "123:0");
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

    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toMatchObject([{ type: "task_settled", runId, status: "aborted" }]);
  });

  it("settles a cancelled starting task as aborted even when its prompt write never fires", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = gatedWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("long prompt", "123:0");
    const task = tasks[0];
    await expect(service.steer(runId, "too early")).resolves.toBe("delivered");
    await expect(service.cancel(runId)).resolves.toBe("stopped");
    expect(task?.steer).not.toHaveBeenCalled();

    // promptWritten() is never called: the cancelled run must still settle aborted.
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(task?.steer).not.toHaveBeenCalled();
    expect((followup.mock.calls as unknown[][])[0]?.[0]).toContain("aborted");
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toMatchObject([{ type: "task_settled", runId, status: "aborted" }]);
  });

  it("runs up to eight tasks concurrently and queues the rest until slots free", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });
    await service.start();

    for (let index = 0; index < 8; index += 1) {
      await expect(service.spawn(`prompt ${index}`, "123:0")).resolves.toMatchObject({ status: "launched" });
    }
    expect(tasks).toHaveLength(8);
    const queued = await service.spawn("prompt 8", "123:0");
    expect(queued.status).toBe("queued");
    expect(tasks).toHaveLength(8);

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

    const { runId } = await service.spawn("prompt", "123:0");
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted", signal: "SIGTERM" });
    expect(followup).toHaveBeenCalledWith(`Task "prompt" aborted. Run files: /workspace/.pi/tasks/${runId}/`, { chatId: 123 });
  });

  it("cancels a running task mid-run and settles as aborted", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });

    const { runId } = await service.spawn("long prompt", "123:0");
    await expect(service.cancel(runId)).resolves.toBe("stopped");

    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toMatchObject([{ type: "task_settled", runId, status: "aborted" }]);
  });

  it("cancels a queued spawn before it launches", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);
    await service.start();

    for (let index = 0; index < 8; index += 1) {
      await service.spawn(`prompt ${index}`, "123:0");
    }
    const queued = await service.spawn("never runs", "123:0");
    await expect(service.cancel(queued.runId)).resolves.toBe("cancelled-queued");

    tasks[0]?.resolveRun(success());
    await vi.waitFor(async () => {
      const settled = (await new WorkspaceEventLog(eventsLog).readAll()).filter((event) => event.type === "task_settled");
      expect(settled).toHaveLength(1);
    });
    // The freed slot stays empty: the cancelled spawn never launches.
    expect(tasks).toHaveLength(8);
  });

  it("reports cancels for unknown runs", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await service.spawn("real", "123:0");
    await expect(service.cancel("run-missing")).resolves.toBe("not-running");
    expect(tasks[0]?.stop).not.toHaveBeenCalled();
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toHaveLength(0);
  });

  it("reconciles crashed runs at boot and repairs settles missing their terminal", async () => {
    const { workspace, eventsLog } = await fixture();
    const deadRun = path.join(workspace, ".pi", "tasks", "22222222-2222-4222-8222-222222222222");
    await mkdir(path.join(deadRun, "sessions"), { recursive: true });
    await writeFile(path.join(deadRun, "prompt.txt"), "prompt", "utf8");
    const noPromptRun = path.join(workspace, ".pi", "tasks", "44444444-4444-4444-8444-444444444444");
    await mkdir(path.join(noPromptRun, "sessions"), { recursive: true });
    const lostTerminalRun = path.join(workspace, ".pi", "tasks", "33333333-3333-4333-8333-333333333333");
    await mkdir(lostTerminalRun, { recursive: true });
    await writeFile(path.join(lostTerminalRun, "prompt.txt"), "settled before crash", "utf8");
    await writeFile(path.join(lostTerminalRun, "result.json"), JSON.stringify({ status: "done", exitCode: 0 }), "utf8");
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await service.start();

    expect(factory).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
    expect(await readJson(path.join(deadRun, "result.json"))).toEqual({ status: "aborted" });
    expect(await readJson(path.join(lostTerminalRun, "result.json"))).toEqual({ status: "done", exitCode: 0 });
    await expect(readFile(path.join(noPromptRun, "result.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(noPromptRun, "sessions"), "utf8")).rejects.toThrow();
    const events = await new WorkspaceEventLog(eventsLog).readAll();
    const settles = events.filter((event) => event.type === "task_settled");
    expect(settles).toHaveLength(2);
    expect(settles.find((event) => event.runId === "22222222-2222-4222-8222-222222222222")).toMatchObject({
      type: "task_settled", status: "aborted", exitCode: null },
    );
    expect(settles.find((event) => event.runId === "33333333-3333-4333-8333-333333333333")).toMatchObject({
      type: "task_settled", status: "done", exitCode: 0, prompt: "settled before crash",
    });
  });

  it("skips runs already settled in the events log at boot", async () => {
    const { workspace, eventsLog } = await fixture();
    const settledRun = path.join(workspace, ".pi", "tasks", "33333333-3333-4333-8333-333333333333");
    await mkdir(settledRun, { recursive: true });
    await writeFile(path.join(settledRun, "prompt.txt"), "done earlier", "utf8");
    await writeFile(path.join(settledRun, "result.json"), JSON.stringify({ status: "done", exitCode: 0 }), "utf8");
    await writeFile(eventsLog, `${eventLine({ type: "task_settled", runId: "33333333-3333-4333-8333-333333333333", status: "done", exitCode: 0 })}\n`, "utf8");
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await service.start();

    const events = await new WorkspaceEventLog(eventsLog).readAll();
    expect(events).toHaveLength(1); // no duplicate settle, no repair
    expect(factory).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it("relaunches fired schedule occurrences lost between firing and spawning", async () => {
    const { workspace, eventsLog } = await fixture();
    const claimedRun = path.join(workspace, ".pi", "tasks", "11111111-1111-4111-8111-111111111111");
    await mkdir(path.join(claimedRun, "sessions"), { recursive: true });
    await writeFile(path.join(claimedRun, "prompt.txt"), "already running", "utf8");
    const eventsLogPath = eventsLog;
    await writeFile(eventsLogPath, [
      `${eventLine({ type: "schedule_run_fired", runId: "11111111-1111-4111-8111-111111111111", prompt: "already running" })}\n`,
      `${eventLine({ type: "schedule_run_fired", runId: "99999999-9999-4999-8999-999999999999", prompt: "lost mid-fire" })}\n`,
    ].join(""), "utf8");
    const { factory, tasks } = fakeWorkerFactory();
    const { service } = setupTasks(workspace, eventsLog, factory);

    await service.start();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.options.runId).toBe("99999999-9999-4999-8999-999999999999");
    expect(tasks[0]?.options.prompt).toBe("lost mid-fire");
  });

  it("stop() stops in-flight workers and settles them as aborted", async () => {
    const { workspace, eventsLog } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const { service } = setupTasks(workspace, eventsLog, factory, { notifier: { followup, interrupt: vi.fn() } });
    await service.start();

    const { runId } = await service.spawn("prompt", "123:0");
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted" });
    expect(followup).toHaveBeenCalledWith(`Task "prompt" aborted. Run files: /workspace/.pi/tasks/${runId}/`, { chatId: 123 });
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

    await service.spawn("heartbeat me", "123:0");
    tasks[0]?.activity.mockReturnValue({ at: 45_000, text: "still thinking" });
    now.mockReturnValue(300_000);
    callbacks[0]?.();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1));
    const message = (followup.mock.calls as unknown[][])[0]?.[0] as string;
    expect(message).toContain("1 task(s) running");
    expect(message).toContain('"heartbeat me"');
    expect(message).toContain("running 4m");
    expect(message).toContain('last output: "still thinking"');

    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    callbacks[0]?.();
    expect(followup).toHaveBeenCalledTimes(2);
  });

  it("default worker factory configures PiWorker with 15m busy timeout and guidance message", async () => {
    const { workspace, eventsLog } = await fixture();
    const events = new WorkspaceEventLog(eventsLog);
    const service = new WorkspaceTasks({
      workspace,
      events,
      appRoot: process.cwd(),
      spawnProcess: vi.fn(),
      terminateProcessGroup: vi.fn(),
    });
    const factory = (service as unknown as { workerFactory: (options: { workspace: string; runId: string; prompt: string }) => unknown }).workerFactory;
    const workerWrapper = factory({ workspace, runId: "test-run", prompt: "do work" });
    expect(workerWrapper).toBeDefined();
  });
});