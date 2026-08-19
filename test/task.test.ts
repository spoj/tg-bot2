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

async function subagentsDirectory(workspace: string): Promise<string[]> {
  return (await readdir(path.join(workspace, ".pi", "subagents"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function chatEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "events.jsonl"), "utf8");
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
  wakeAgent: Mock | undefined,
  options: Partial<WorkspaceTasksOptions> = {},
): WorkspaceTasks {
  return new WorkspaceTasks({
    dataDir,
    appRoot: "/tmp/tg-bot2-app",
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    workerFactory: factory as never,
    ...(wakeAgent === undefined ? {} : { wakeAgent }),
    ...options,
  });
}

describe("WorkspaceTasks", () => {
  it("rejects poll intervals above the timer-safe limit", async () => {
    const { dataDir } = await fixture();
    const { factory } = fakeWorkerFactory();
    expect(() => setupTasks(dataDir, factory, undefined, { pollIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("claims a task, runs one subagent, records output, and wakes the agent", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "research.md", "Investigate the parser regression.");
    const { factory, tasks } = fakeWorkerFactory();
    const wakeAgent = vi.fn(async () => {});
    const service = setupTasks(dataDir, factory, wakeAgent);

    const poll = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(tasks[0]?.options).toMatchObject({ taskId: "research", prompt: "Investigate the parser regression." });
    expect(tasks[0]?.options.workspace).toBe(workspace);

    const runDir = path.join(workspace, ".pi", "subagents", "research");
    await writeFile(path.join(runDir, "sessions", "session-1.jsonl"), "{}\n", "utf8");
    tasks[0]?.resolveRun(success("the findings"));
    await poll;

    expect(await readFile(path.join(runDir, "output.md"), "utf8")).toBe("the findings");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "done", exitCode: 0 });
    const events = await chatEvents(workspace);
    expect(events.at(-1)).toMatchObject({
      type: "subagent",
      id: "research",
      status: "done",
      outputFile: "/workspace/.pi/subagents/research/output.md",
      sessionFile: "/workspace/.pi/subagents/research/sessions/session-1.jsonl",
      exitCode: 0,
    });
    expect(wakeAgent).toHaveBeenCalledWith(42);
    expect((await readdir(path.join(workspace, ".tg-bot", "task"))).length).toBe(0);
  });

  it("reports a failed run with a stderr tail and no output file", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "broken.txt", "do the thing");
    const { factory, tasks } = fakeWorkerFactory();
    const wakeAgent = vi.fn(async () => {});
    const service = setupTasks(dataDir, factory, wakeAgent);

    const poll = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    tasks[0]?.resolveRun({ code: 3, signal: null, stderr: "boom", stdout: "" });
    await poll;

    const runDir = path.join(workspace, ".pi", "subagents", "broken");
    expect(await readJson(path.join(runDir, "result.json"))).toMatchObject({ status: "failed", exitCode: 3, stderr: "boom" });
    await expect(readFile(path.join(runDir, "output.md"), "utf8")).rejects.toThrow();
    const events = await chatEvents(workspace);
    expect(events.at(-1)).toMatchObject({ type: "subagent", id: "broken", status: "failed", exitCode: 3, stderr: "boom" });
    expect(wakeAgent).toHaveBeenCalledWith(42);
  });

  it("reports a worker that fails to spawn as a failed task", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "unspawnable.md", "prompt");
    const factory = vi.fn(async () => {
      throw new Error("bwrap missing");
    });
    const wakeAgent = vi.fn(async () => {});

    await setupTasks(dataDir, factory, wakeAgent).poll();

    const events = await chatEvents(workspace);
    expect(events.at(-1)).toMatchObject({ type: "subagent", id: "unspawnable", status: "failed" });
    expect(wakeAgent).toHaveBeenCalledWith(42);
  });

  it("ignores files that do not match the task naming contract", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "space name.md", "a");
    await writeTask(workspace, ".hidden.md", "b");
    await writeTask(workspace, "no-extension", "c");
    await writeTask(workspace, "request.json", "d");
    const { factory } = fakeWorkerFactory();

    await setupTasks(dataDir, factory, undefined).poll();

    expect(factory).not.toHaveBeenCalled();
    expect((await readdir(path.join(workspace, ".tg-bot", "task"))).sort()).toEqual([".hidden.md", "no-extension", "request.json", "space name.md"]);
  });

  it("consumes an empty prompt as a failed task without spawning", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "empty.md", "   ");
    const { factory } = fakeWorkerFactory();
    const wakeAgent = vi.fn(async () => {});

    await setupTasks(dataDir, factory, wakeAgent).poll();

    expect(factory).not.toHaveBeenCalled();
    const events = await chatEvents(workspace);
    expect(events.at(-1)).toMatchObject({ type: "subagent", id: "empty", status: "failed" });
    expect((await readdir(path.join(workspace, ".tg-bot", "task"))).length).toBe(0);
  });

  it("runs one task at a time and claims the next after settling", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "a.md", "first prompt");
    await writeTask(workspace, "b.txt", "second prompt");
    const { factory, tasks } = fakeWorkerFactory();
    const service = setupTasks(dataDir, factory, undefined);

    const first = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(tasks[0]?.options.taskId).toBe("a");

    tasks[0]?.resolveRun(success());
    await first;
    const second = service.poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(2));
    expect(tasks[1]?.options.taskId).toBe("b");
    tasks[1]?.resolveRun(success());
    await second;
  });

  it("re-queues an orphaned run directory from a crashed host", async () => {
    const { dataDir, workspace } = await fixture();
    const orphan = path.join(workspace, ".pi", "subagents", "orphan");
    await mkdir(path.join(orphan, "sessions"), { recursive: true });
    await writeFile(path.join(orphan, "task.md"), "recovered prompt", "utf8");
    const { factory, tasks } = fakeWorkerFactory();

    const poll = setupTasks(dataDir, factory, undefined).poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(tasks[0]?.options).toMatchObject({ taskId: "orphan", prompt: "recovered prompt" });
    tasks[0]?.resolveRun(success());
    await poll;
  });

  it("keeps settled run directories and prunes beyond the cap", async () => {
    const { dataDir, workspace } = await fixture();
    for (let index = 0; index < 18; index += 1) {
      const runDir = path.join(workspace, ".pi", "subagents", `task-${String(index).padStart(2, "0")}`);
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "result.json"), '{"status":"done"}\n', "utf8");
      const at = new Date(1_700_000_000_000 + index * 1_000);
      await utimes(runDir, at, at);
    }
    const { factory } = fakeWorkerFactory();

    await setupTasks(dataDir, factory, undefined).poll();

    const remaining = await subagentsDirectory(workspace);
    expect(remaining).toHaveLength(16);
    expect(remaining).not.toContain("task-00");
    expect(remaining).toContain("task-17");
  });

  it("leaves a signal-interrupted run orphaned for boot recovery", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "interrupted.md", "prompt");
    const { factory, tasks } = fakeWorkerFactory();

    const poll = setupTasks(dataDir, factory, undefined).poll();
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    tasks[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await poll;

    const runDir = path.join(workspace, ".pi", "subagents", "interrupted");
    await expect(readFile(path.join(runDir, "result.json"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(runDir, "task.md"), "utf8")).toBe("prompt");
  });

  it("stop() stops the in-flight worker and leaves the task for boot recovery", async () => {
    const { dataDir, workspace } = await fixture();
    await writeTask(workspace, "long.md", "prompt");
    const { factory, tasks } = fakeWorkerFactory();
    const service = setupTasks(dataDir, factory, undefined);
    const started = service.start();

    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    await service.stop();
    expect(tasks[0]?.stop).toHaveBeenCalledOnce();
    expect(await readFile(path.join(workspace, ".pi", "subagents", "long", "task.md"), "utf8")).toBe("prompt");
    await started;
  });
});
