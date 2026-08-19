import type { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { WorkspaceTasks, type WorkspaceTaskWorkerOptions, type WorkspaceTasksOptions } from "../src/task.js";
import type { PiRunResult } from "../src/pi-worker.js";
import { deferred } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-task-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "chats", "42", "workspace");
  await mkdir(path.join(workspace, ".tg-bot", "task"), { recursive: true });
  return { dataDir, workspace };
}

async function writeTask(workspace: string, name: string, prompt: string): Promise<void> {
  await writeFile(path.join(workspace, ".tg-bot", "task", name), prompt, "utf8");
}

async function systemEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "system.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

type FakeTask = {
  options: WorkspaceTaskWorkerOptions;
  resolveRun: (result: PiRunResult) => void;
  stop: Mock<() => Promise<void>>;
};

function fakeWorkerFactory() {
  const tasks: FakeTask[] = [];
  const factory = vi.fn(async (options: WorkspaceTaskWorkerOptions) => {
    const gate = deferred<PiRunResult>();
    const stop = vi.fn(async () => {
      gate.resolve({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    });
    tasks.push({ options, resolveRun: gate.resolve, stop });
    return { run: async () => await gate.promise, stop };
  });
  return { factory, tasks };
}

const success = (stdout = "final report"): PiRunResult => ({ code: 0, signal: null, stderr: "", stdout });

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
    agent: { followup: async () => undefined },
    workerFactory: factory as never,
    ...options,
  });
}

describe("WorkspaceTasks", () => {
  it("rejects poll intervals above the timer-safe limit", async () => {
    const { dataDir } = await fixture();
    const { factory } = fakeWorkerFactory();
    expect(() => setupTasks(dataDir, factory, { pollIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("claims a task into a uuid run directory, records output, and sends the agent a completion followup", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "research.md", "Investigate the parser regression.");
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    const poll = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(tasks[0]?.options).toMatchObject({ prompt: "Investigate the parser regression." });
    expect(tasks[0]?.options.workspace).toBe(workspace);

    const runDir = path.join(workspace, ".pi", "tasks", runId ?? "");
    expect(await readFile(path.join(runDir, "research.md"), "utf8")).toBe("Investigate the parser regression.");
    await writeFile(path.join(runDir, "sessions", "session-1.jsonl"), "{}\n", "utf8");
    tasks[0]?.resolveRun(success("the findings"));
    await poll;
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", name: "research.md", runId },
      { type: "task_settled", name: "research.md", runId, status: "done", exitCode: 0 },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task research.md finished. Prompt, output, session, and result files: /workspace/.pi/tasks/${runId}/`);
    expect((await readFile(path.join(workspace, ".tg-bot", "task", "research.md"), "utf8").catch(() => null))).toBeNull();
  });

  it("reports a failed run with a stderr tail and no output file", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "broken.txt", "do the thing");
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    const poll = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId ?? "";
    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await poll;
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", name: "broken.txt", runId },
      { type: "task_settled", name: "broken.txt", runId, status: "failed", exitCode: 3, stderr: "boom" },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task broken.txt failed (exit 3). Prompt, output, session, and result files: /workspace/.pi/tasks/${runId}/`);
  });

  it("reports a worker that fails to spawn as a failed task", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "unspawnable.md", "prompt");
    const factory = vi.fn(async () => {
      throw new Error("bwrap missing");
    });
    const followup = vi.fn(async () => undefined);

    await setupTasks(dataDir, factory, { agent: { followup } }).poll();

    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", name: "unspawnable.md", runId: expect.any(String) },
      { type: "task_settled", name: "unspawnable.md", status: "failed" },
    ]);
    expect(followup).toHaveBeenCalledOnce();
  });

  it("ignores files that do not match the task naming contract", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "space name.md", "a");
    await writeTask(workspace, ".hidden.md", "b");
    await writeTask(workspace, "no-extension", "c");
    await writeTask(workspace, "request.json", "d");
    const { factory } = fakeWorkerFactory();

    await setupTasks(dataDir, factory).poll();

    expect(factory).not.toHaveBeenCalled();
    expect((await readFile(path.join(workspace, ".tg-bot", "task", "space name.md"), "utf8"))).toBe("a");
  });

  it("consumes an empty prompt as a failed task without spawning", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "empty.md", "   ");
    const { factory } = fakeWorkerFactory();

    await setupTasks(dataDir, factory).poll();

    expect(factory).not.toHaveBeenCalled();
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", name: "empty.md", runId: expect.any(String) },
      { type: "task_settled", name: "empty.md", status: "failed" },
    ]);
  });

  it("runs up to eight tasks concurrently and claims the rest as slots free", async () => {
    const { dataDir, workspace } = await fixture();
    for (let index = 0; index < 10; index += 1) {
      await writeTask(workspace, `t-${String(index).padStart(2, "0")}.md`, `prompt ${index}`);
    }
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    const first = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(8));
    expect(tasks.map((task) => task.options.prompt)).toEqual([
      "prompt 0", "prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5", "prompt 6", "prompt 7",
    ]);

    tasks[0]?.resolveRun(success());
    tasks[1]?.resolveRun(success());
    await first;
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));

    const second = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(10));
    expect(tasks[8]?.options.prompt).toBe("prompt 8");
    expect(tasks[9]?.options.prompt).toBe("prompt 9");
    for (const task of tasks.slice(2)) task.resolveRun(success());
    await second;
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(10));
  });

  it("settles a signal-killed run as aborted with a followup", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "interrupted.md", "prompt");
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });

    const poll = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId ?? "";
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await poll;
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted", signal: "SIGTERM" });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task_claimed", name: "interrupted.md", runId },
      { type: "task_settled", name: "interrupted.md", runId, status: "aborted" },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task interrupted.md aborted (SIGTERM). Prompt, output, session, and result files: /workspace/.pi/tasks/${runId}/`);
  });

  it("stamps aborted settles at boot for runs the host died on", async () => {
    const { dataDir, workspace } = await fixture();
    const deadRun = path.join(workspace, ".pi", "tasks", "22222222-2222-4222-8222-222222222222");
    await mkdir(path.join(deadRun, "sessions"), { recursive: true });
    await writeFile(path.join(deadRun, "crashed.md"), "prompt", "utf8");
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
      { type: "task_settled", name: "crashed.md", runId: "22222222-2222-4222-8222-222222222222", status: "aborted", exitCode: null },
    ]);
    expect(await readJson(path.join(settledRun, "result.json"))).toEqual({ status: "done" });
  });

  it("stop() stops in-flight workers and settles them as aborted", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "long.md", "prompt");
    const { factory, tasks } = fakeWorkerFactory();
    const followup = vi.fn(async () => undefined);
    const service = setupTasks(dataDir, factory, { agent: { followup } });
    const started = service.start();

    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId ?? "";
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    await started;

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "aborted" });
    expect(followup).toHaveBeenCalledWith(42, `Task long.md aborted (SIGTERM). Prompt, output, session, and result files: /workspace/.pi/tasks/${runId}/`);
  });
});
