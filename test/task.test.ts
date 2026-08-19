import type { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

async function tasksDirectory(workspace: string): Promise<string[]> {
  return (await readdir(path.join(workspace, ".pi", "tasks"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task", name: "research.md", runId, status: "done", exitCode: 0 },
    ]);
    expect(followup).toHaveBeenCalledWith(42, `Task research.md finished. Prompt, output, session, and result files: /workspace/.pi/tasks/${runId}/`);
    expect((await readdir(path.join(workspace, ".tg-bot", "task"))).length).toBe(0);
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

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "task", name: "broken.txt", runId, status: "failed", exitCode: 3, stderr: "boom" },
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

    expect(await systemEvents(workspace)).toMatchObject([{ type: "task", name: "unspawnable.md", status: "failed" }]);
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
    expect((await readdir(path.join(workspace, ".tg-bot", "task"))).sort()).toEqual([".hidden.md", "no-extension", "request.json", "space name.md"]);
  });

  it("consumes an empty prompt as a failed task without spawning", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "empty.md", "   ");
    const { factory } = fakeWorkerFactory();

    await setupTasks(dataDir, factory).poll();

    expect(factory).not.toHaveBeenCalled();
    expect(await systemEvents(workspace)).toMatchObject([{ type: "task", name: "empty.md", status: "failed" }]);
    expect((await readdir(path.join(workspace, ".tg-bot", "task"))).length).toBe(0);
  });

  it("runs one task at a time and claims the next after settling", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "a.md", "first prompt");
    await writeTask(workspace, "b.txt", "second prompt");
    const { factory, tasks } = fakeWorkerFactory();
    const service = setupTasks(dataDir, factory);

    const first = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(await readFile(path.join(workspace, ".pi", "tasks", tasks[0]?.options.runId ?? "", "a.md"), "utf8")).toBe("first prompt");

    tasks[0]?.resolveRun(success());
    await first;
    const second = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(2));
    expect(await readFile(path.join(workspace, ".pi", "tasks", tasks[1]?.options.runId ?? "", "b.txt"), "utf8")).toBe("second prompt");
    tasks[1]?.resolveRun(success());
    await second;
  });

  it("re-queues an orphaned run directory from a crashed host", async () => {
    const { dataDir, workspace } = await fixture();
    const orphan = path.join(workspace, ".pi", "tasks", "11111111-1111-4111-8111-111111111111");
    await mkdir(path.join(orphan, "sessions"), { recursive: true });
    await writeFile(path.join(orphan, "recover.md"), "recovered prompt", "utf8");
    const { factory, tasks } = fakeWorkerFactory();

    const poll = setupTasks(dataDir, factory).poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(tasks[0]?.options).toMatchObject({ prompt: "recovered prompt" });
    expect(await readFile(path.join(workspace, ".pi", "tasks", tasks[0]?.options.runId ?? "", "recover.md"), "utf8")).toBe("recovered prompt");
    tasks[0]?.resolveRun(success());
    await poll;
  });

  it("keeps settled run directories and prunes beyond the cap", async () => {
    const { dataDir, workspace } = await fixture();
    for (let index = 0; index < 18; index += 1) {
      const runDir = path.join(workspace, ".pi", "tasks", `run-${String(index).padStart(2, "0")}`);
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "result.json"), '{"status":"done"}\n', "utf8");
      const at = new Date(1_700_000_000_000 + index * 1_000);
      await utimes(runDir, at, at);
    }
    const { factory } = fakeWorkerFactory();

    await setupTasks(dataDir, factory).poll();

    const remaining = await tasksDirectory(workspace);
    expect(remaining).toHaveLength(16);
    expect(remaining).not.toContain("run-00");
    expect(remaining).toContain("run-17");
  });

  it("leaves a signal-interrupted run orphaned for boot recovery", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "interrupted.md", "prompt");
    const { factory, tasks } = fakeWorkerFactory();

    const poll = setupTasks(dataDir, factory).poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId ?? "";
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await poll;

    const runDir = path.join(workspace, ".pi", "tasks", runId);
    await expect(readFile(path.join(runDir, "result.json"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(runDir, "interrupted.md"), "utf8")).toBe("prompt");
  });

  it("stop() stops the in-flight worker and leaves the task for boot recovery", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "long.md", "prompt");
    const { factory, tasks } = fakeWorkerFactory();
    const service = setupTasks(dataDir, factory);
    const started = service.start();

    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const runId = tasks[0]?.options.runId ?? "";
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    expect(await readFile(path.join(workspace, ".pi", "tasks", runId, "long.md"), "utf8")).toBe("prompt");
    await started;
  });
});
