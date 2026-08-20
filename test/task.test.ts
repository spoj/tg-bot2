import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { WorkspaceTasks, type WorkspaceTaskWorkerOptions, type WorkspaceTasksOptions } from "../src/task.js";
import type { PiRunResult } from "../src/pi-worker.js";
import type { SessionToolCall } from "../src/session-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-task-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "chats", "42", "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  return { dataDir, workspace };
}

const callRef = (index = 0) => ({ sessionId: "11111111-1111-4111-8111-111111111111", recordId: "a1b2c3d4", index });
function spawnCall(prompt: unknown, index = 0): SessionToolCall {
  return { ref: callRef(index), name: "spawn", args: { prompt } };
}
function cancelCall(runId: unknown): SessionToolCall {
  return { ref: callRef(90), name: "cancel", args: { runId } };
}

async function systemEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "system.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}
const success = (stdout = "final report"): PiRunResult => ({ code: 0, signal: null, stderr: "", stdout });

type FakeTask = {
  options: WorkspaceTaskWorkerOptions;
  resolveRun: (result: PiRunResult) => void;
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
      stop: vi.fn(async () => { resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" }); }),
      activity: vi.fn(() => ({ at: 0, text: "" })),
    };
    tasks.push(task);
    return { run: () => run, stop: task.stop, activity: task.activity };
  });
  return { factory, tasks };
}
function setupTasks(
  dataDir: string,
  factory: Mock,
  options: Partial<WorkspaceTasksOptions> = {},
): WorkspaceTasks {
  return new WorkspaceTasks({
    dataDir,
    appRoot: process.cwd(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    agent: { followup: vi.fn(async () => undefined) },
    workerFactory: factory,
    ...options,
  });
}

describe("WorkspaceTasks", () => {
  it("rejects heartbeat intervals above the timer-safe limit", async () => {
    const { dataDir } = await fixture();
    const { factory } = fakeWorkerFactory();
    expect(() => setupTasks(dataDir, factory, { heartbeatIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("claims a spawn into a uuid run directory, records output, and sends a completion followup", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    const claim = service.handleSpawn(spawnCall("Investigate the parser regression."), 42, workspace);
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(await claim).toBe("claimed");
    const runId = tasks[0]?.options.runId;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(tasks[0]?.options).toMatchObject({ prompt: "Investigate the parser regression." });
    expect(tasks[0]?.options.workspace).toBe(workspace);

    const runDir = path.join(workspace, ".pi", "tasks", runId ?? "");
    expect(await readFile(path.join(runDir, "prompt.txt"), "utf8")).toBe("Investigate the parser regression.");
    tasks[0]?.resolveRun(success("the findings"));
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    const events = await systemEvents(workspace);
    expect(events).toMatchObject([
      { type: "task_claimed", runId, prompt: "Investigate the parser regression.", callRef: callRef() },
      { type: "task_settled", runId, status: "done", exitCode: 0 },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task "Investigate the parser regression." finished. Run files: /workspace/.pi/tasks/${runId}/`);
  });

  it("truncates long prompts in the completion followup", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });
    await service.handleSpawn(spawnCall("x".repeat(500)), 42, workspace);
    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    const message = (followup.mock.calls as unknown[][])[0]?.[1] as string;
    expect(message).toContain(`"${"x".repeat(119)}…"`);
  });

  it("reports a failed run with a stderr tail and no output file", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    await service.handleSpawn(spawnCall("do the thing"), 42, workspace);
    const runId = tasks[0]?.options.runId ?? "";
    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", runId, prompt: "do the thing" },
      { type: "task_settled", runId, status: "failed", exitCode: 3, stderr: "boom" },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task "do the thing" failed (exit 3). Run files: /workspace/.pi/tasks/${runId}/`);
  });

  it("reports a worker that fails to spawn as a failed task", async () => {
    const { dataDir, workspace } = await fixture();
    const factory = vi.fn(async () => {
      throw new Error("bwrap missing");
    });
    const followup = vi.fn(async () => undefined);

    await setupTasks(dataDir, factory, { agent: { followup } }).handleSpawn(spawnCall("prompt"), 42, workspace);

    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", runId: expect.any(String), prompt: "prompt" },
      { type: "task_settled", status: "failed", stderr: "bwrap missing" },
    ]);
    expect(followup).toHaveBeenCalledOnce();
  });

  it("settles an empty or oversized prompt as failed without spawning", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    expect(await service.handleSpawn(spawnCall("   "), 42, workspace)).toBe("claimed");
    expect(await service.handleSpawn(spawnCall("x".repeat(1024 * 1024 + 1), 1), 42, workspace)).toBe("claimed");
    expect(factory).not.toHaveBeenCalled();
    expect(followup).toHaveBeenCalledTimes(2);
    const events = await systemEvents(workspace);
    expect(followup).toHaveBeenNthCalledWith(1, 42, expect.stringContaining('Task "   " failed (exit unknown). Run files: /workspace/.pi/tasks/'));
    expect(events.filter((event) => event.type === "task_settled")).toHaveLength(2);
  });

  it("runs up to eight tasks concurrently and reports the rest as pending until slots free", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    for (let index = 0; index < 8; index += 1) {
      expect(await service.handleSpawn(spawnCall(`prompt ${index}`, index), 42, workspace)).toBe("claimed");
    }
    expect(tasks).toHaveLength(8);
    const extra = spawnCall("prompt 8", 8);
    expect(await service.handleSpawn(extra, 42, workspace)).toBe("pending");
    expect(tasks).toHaveLength(8);

    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1));
    expect(await service.handleSpawn(extra, 42, workspace)).toBe("claimed");
    expect(tasks).toHaveLength(9);
    expect(tasks[8]?.options.prompt).toBe("prompt 8");
    for (const task of tasks) task.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(9));
  });

  it("settles a signal-killed run as aborted with a followup", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    await service.handleSpawn(spawnCall("prompt"), 42, workspace);
    const runId = tasks[0]?.options.runId ?? "";
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted", signal: "SIGTERM" });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", runId },
      { type: "task_settled", runId, status: "aborted" },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task "prompt" aborted (SIGTERM). Run files: /workspace/.pi/tasks/${runId}/`);
  });

  it("cancels a running task mid-run and records the request", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    await service.handleSpawn(spawnCall("long prompt"), 42, workspace);
    const runId = tasks[0]?.options.runId ?? "";
    await service.handleCancel(cancelCall(runId), 42, workspace);

    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", runId },
      { type: "task_cancelled", runId, callRef: callRef(90) },
    ]);
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", runId },
      { type: "task_cancelled", runId },
      { type: "task_settled", runId, status: "aborted" },
    ]);
  });

  it("ignores cancels for unknown runs and malformed run ids", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const service = setupTasks(dataDir, factory);

    await service.handleSpawn(spawnCall("real"), 42, workspace);
    await service.handleCancel(cancelCall("00000000-0000-4000-8000-000000000000"), 42, workspace);
    await service.handleCancel(cancelCall(undefined), 42, workspace);
    expect(tasks[0]?.stop).not.toHaveBeenCalled();
    expect(await systemEvents(workspace)).toMatchObject([{ type: "task_claimed" }]);
  });

  it("flushes the run's session calls before the settle followup", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const order: string[] = [];
    const flush = {
      flushTaskRun: vi.fn(async () => {
        order.push("flush");
      }),
    };
    const service = setupTasks(dataDir, factory, { agent: { followup }, flush });

    await service.handleSpawn(spawnCall("flush me"), 42, workspace);
    const runId = tasks[0]?.options.runId ?? "";
    tasks[0]?.resolveRun(success());
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(flush.flushTaskRun).toHaveBeenCalledWith(42, workspace, runId);
    expect(order).toEqual(["flush"]);
    expect(followup).toHaveBeenCalledOnce();
  });

  it("stamps aborted settles at boot for runs the host died on", async () => {
    const { dataDir, workspace } = await fixture();
    const deadRun = path.join(workspace, ".pi", "tasks", "22222222-2222-4222-8222-222222222222");
    await mkdir(path.join(deadRun, "sessions"), { recursive: true });
    await writeFile(path.join(deadRun, "prompt.txt"), "prompt", "utf8");
    const noPromptRun = path.join(workspace, ".pi", "tasks", "44444444-4444-4444-8444-444444444444");
    await mkdir(path.join(noPromptRun, "sessions"), { recursive: true });
    const settledRun = path.join(workspace, ".pi", "tasks", "33333333-3333-4333-8333-333333333333");
    await mkdir(settledRun, { recursive: true });
    await writeFile(path.join(settledRun, "result.json"), '{"status":"done"}\n', "utf8");
    const { factory, tasks } = fakeWorkerFactory();
    const service = setupTasks(dataDir, factory);

    await service.start();

    expect(factory).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
    expect(await readJson(path.join(deadRun, "result.json"))).toEqual({ status: "aborted" });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_settled", runId: "22222222-2222-4222-8222-222222222222", status: "aborted", exitCode: null },
    ]);
    expect(await readJson(path.join(settledRun, "result.json"))).toEqual({ status: "done" });
    await expect(readFile(path.join(noPromptRun, "result.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(noPromptRun, "sessions"), "utf8")).rejects.toThrow();
  });

  it("stop() stops in-flight workers and settles them as aborted", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });
    await service.start();

    await service.handleSpawn(spawnCall("prompt"), 42, workspace);
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId ?? "";
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted" });
    expect(followup).toHaveBeenCalledWith(42, `Task "prompt" aborted (SIGTERM). Run files: /workspace/.pi/tasks/${runId}/`);
  });

  it("sends a heartbeat followup while tasks run and stays silent when idle", async () => {
    const { dataDir, workspace } = await fixture();
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const callbacks: Array<() => void> = [];
    const setIntervalMock = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as unknown as typeof setInterval;
    const clearInterval = vi.fn() as unknown as typeof globalThis.clearInterval;
    const now = vi.fn(() => 60_000);
    const service = setupTasks(dataDir, factory, {
      agent: { followup },
      setInterval: setIntervalMock,
      clearInterval,
      now,
      heartbeatIntervalMs: 300_000,
    });
    await service.start();

    callbacks[0]?.();
    expect(followup).not.toHaveBeenCalled();

    await service.handleSpawn(spawnCall("heartbeat me"), 42, workspace);
    tasks[0]?.activity.mockReturnValue({ at: 45_000, text: "still thinking" });
    now.mockReturnValue(300_000);
    callbacks[0]?.();
    expect(followup).toHaveBeenCalledTimes(1);
    const message = (followup.mock.calls as unknown[][])[0]?.[1] as string;
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
