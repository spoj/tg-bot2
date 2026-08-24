import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { PiWorker } from "../src/pi-worker.js";
import type { PiWorkerChildProcess } from "../src/sandbox.js";

type FakeStdin = EventEmitter & {
  end: Mock<(chunk?: string, encoding?: string) => void>;
  write: Mock<(chunk: string, encoding?: string) => boolean>;
  writable: boolean;
  destroyed: boolean;
};

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;
  readonly stdin = new EventEmitter() as unknown as FakeStdin;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

type ChildFixture = {
  child: FakeChild;
  spawn: Mock<(executable: string, args: string[], options: unknown) => PiWorkerChildProcess>;
  terminate: Mock<(child: PiWorkerChildProcess, signal: NodeJS.Signals) => void>;
};

function fakeChildFixture(): ChildFixture {
  const child = new FakeChild();
  child.stdin.end = vi.fn(() => {});
  child.stdin.write = vi.fn((chunk: string) => {
    const command = JSON.parse(chunk) as { id?: string; type?: string };
    queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} })}\n`));
    return true;
  });
  child.stdin.writable = true;
  child.stdin.destroyed = false;
  const spawn = vi.fn((_executable: string, _args: string[], _options: unknown) => child as unknown as PiWorkerChildProcess);
  const terminate = vi.fn((_child: PiWorkerChildProcess, _signal: NodeJS.Signals) => {});
  return { child, spawn, terminate };
}

async function fixture(): Promise<{ root: string; workspace: string; appRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "tg-pi-worker-"));
  const appRoot = path.join(root, "app");
  const workspace = path.join(root, "workspace");
  const cli = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
  await mkdir(workspace, { recursive: true });
  return { root, workspace, appRoot };
}

describe("PiWorker", () => {
  it("spawns bwrap with configured model and continuation flags and configures queue modes over RPC", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
        model: "openrouter/deepseek/deepseek-chat",
        thinkingLevel: "high",
        continueSession: true,
      });
      await worker.start();
      expect(spawn).toHaveBeenCalledOnce();
      const [, , options] = spawn.mock.calls[0] ?? [];
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(options).toEqual({ detached: true, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      expect(args).toContain("--mode");
      expect(args).toContain("rpc");
      expect(args).toContain("--session-dir");
      expect(args[args.indexOf("--session-dir") + 1]).toBe("/workspace/.pi/sessions");
      expect(args).toContain("--continue");
      expect(args).toEqual(expect.arrayContaining([
        "--model", "openrouter/deepseek/deepseek-chat",
        "--thinking", "high",
      ]));
      expect(child.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"set_steering_mode","mode":"all"'),
        "utf8",
      );
      expect(child.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"set_follow_up_mode","mode":"all"'),
        "utf8",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("prompt sends a prompt command with streamingBehavior and touches activity", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("hello world", "steer");
      expect(child.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"prompt","message":"hello world","streamingBehavior":"steer"'),
        "utf8",
      );
      expect(worker.isBusy()).toBe(true);
      expect(worker.activity().text).toBe("hello world");

      await worker.prompt("later task", "followUp");
      expect(child.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"prompt","message":"later task","streamingBehavior":"followUp"'),
        "utf8",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("waits for the matching RPC response before accepting a prompt", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({ workspace: f.workspace, appRoot: f.appRoot, spawnProcess: spawn, terminateProcessGroup: terminate });
      await worker.start();
      child.stdin.write.mockImplementation(() => true);

      let accepted = false;
      const pending = worker.prompt("complete instruction", "steer").then(() => { accepted = true; });
      await Promise.resolve();
      expect(accepted).toBe(false);
      const command = JSON.parse(child.stdin.write.mock.calls.at(-1)?.[0] ?? "{}") as { id: string };
      child.stdout.emit("data", `${JSON.stringify({ id: command.id, type: "response", success: true })}\n`);
      await pending;
      expect(accepted).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a prompt when the RPC worker rejects it", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({ workspace: f.workspace, appRoot: f.appRoot, spawnProcess: spawn, terminateProcessGroup: terminate });
      await worker.start();
      child.stdin.write.mockImplementation((chunk: string) => {
        const command = JSON.parse(chunk) as { id: string };
        queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({ id: command.id, type: "response", success: false, error: "prompt rejected" })}\n`));
        return true;
      });

      await expect(worker.prompt("complete instruction", "steer")).rejects.toThrow("prompt rejected");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("aborts a queued steer that exceeds its maximum wait without replacing its instruction", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("initial work");
      await worker.prompt("urgent update", "steer", 120_000);
      child.stdin.write.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      const commands = child.stdin.write.mock.calls.map(([line]) => JSON.parse(line) as Record<string, unknown>);
      expect(commands).toMatchObject([{ type: "abort" }]);
      expect(commands).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("cancels the steering deadline when the queued steer is delivered", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("initial work");
      await worker.prompt("urgent update", "steer", 120_000);
      child.stdout.emit("data", `${JSON.stringify({ type: "queue_update", steering: [], followUp: [] })}\n`);
      child.stdin.write.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(child.stdin.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not bound an initial user turn that was never queued", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("initial work", "steer", 120_000);
      child.stdin.write.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(child.stdin.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("tracks isBusy state across agent_start and agent_settled events", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.start();
      expect(worker.isBusy()).toBe(false);

      child.stdout.emit("data", `${JSON.stringify({ type: "agent_start" })}\n`);
      expect(worker.isBusy()).toBe(true);

      child.stdout.emit("data", `${JSON.stringify({ type: "agent_settled" })}\n`);
      expect(worker.isBusy()).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("waitForSettled resolves when agent_settled event is emitted", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("do work");
      const settled = worker.waitForSettled();

      child.stdout.emit("data", "output chunk\n");
      child.stdout.emit("data", `${JSON.stringify({ type: "agent_settled" })}\n`);

      const result = await settled;
      expect(result.stdout).toContain("output chunk");
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("preserves UTF-8 split across stdout chunks", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("do work");
      const settled = worker.waitForSettled();
      const output = Buffer.from("result 🙂\n", "utf8");
      const emojiStart = Buffer.from("result ", "utf8").length;
      child.stdout.emit("data", output.subarray(0, emojiStart + 1));
      child.stdout.emit("data", output.subarray(emojiStart + 1));
      child.stdout.emit("data", `${JSON.stringify({ type: "agent_settled" })}\n`);

      await expect(settled).resolves.toMatchObject({ stdout: expect.stringContaining("result 🙂") });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("waits for stdio close before finalizing captured output", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("do work");
      const settled = worker.waitForSettled();
      child.emit("exit", 0, null);
      child.stdout.emit("data", "final output\n");
      child.emit("close", 0, null);

      await expect(settled).resolves.toMatchObject({ stdout: expect.stringContaining("final output") });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("reaps the idle worker after idleTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      try {
        const { child, spawn, terminate } = fakeChildFixture();
        const reaped = vi.fn();
        const worker = new PiWorker({
          workspace: f.workspace,
          appRoot: f.appRoot,
          idleTimeoutMs: 1_000,
          spawnProcess: spawn,
          terminateProcessGroup: terminate,
        });
        worker.onReaped(reaped);
        await worker.start();

        expect(worker.isAlive()).toBe(true);
        const closing = vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalled());
        child.emit("close", 0, null);
        await closing;
        await vi.waitFor(() => expect(reaped).toHaveBeenCalledOnce());
        expect(worker.isAlive()).toBe(false);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() performs orderly shutdown with fallback SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      try {
        const { child, spawn, terminate } = fakeChildFixture();
        const worker = new PiWorker({
          workspace: f.workspace,
          appRoot: f.appRoot,
          spawnProcess: spawn,
          terminateProcessGroup: terminate,
          stopGraceMs: 250,
        });
        await worker.start();
        const closing = worker.close();
        expect(child.stdin.end).toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(250);
        expect(terminate).toHaveBeenCalledWith(child, "SIGKILL");

        child.emit("close", 0, null);
        await closing;
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() terminates process group with SIGTERM then SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      try {
        const { child, spawn, terminate } = fakeChildFixture();
        const worker = new PiWorker({
          workspace: f.workspace,
          appRoot: f.appRoot,
          spawnProcess: spawn,
          terminateProcessGroup: terminate,
          stopGraceMs: 250,
        });
        await worker.start();
        const stopping = worker.stop();
        expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");

        await vi.advanceTimersByTimeAsync(250);
        expect(terminate).toHaveBeenCalledWith(child, "SIGKILL");

        child.emit("close", null, "SIGKILL");
        await stopping;
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a custom session directory to the CLI", async () => {
    const f = await fixture();
    try {
      const { spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        sessionDir: "/workspace/.pi/subagents/alpha/sessions",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.start();
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(args[args.indexOf("--session-dir") + 1]).toBe("/workspace/.pi/subagents/alpha/sessions");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("writes appendSystemPrompt to a prompt file and mounts it read-only", async () => {
    const f = await fixture();
    try {
      const { spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        appendSystemPrompt: "custom system prompt",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.start();
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(args).toContain("--append-system-prompt");
      expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/app/append-system-prompt.md");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });




  it("uses the injected clock for activity timestamps", async () => {
    const f = await fixture();
    try {
      const { spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        now: () => 42_000,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.prompt("hello");
      expect(worker.activity()).toEqual({ at: 42_000, text: "hello" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("fires onInitialPromptWritten once after the first successful prompt write", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const onInitialPromptWritten = vi.fn();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
        onInitialPromptWritten,
      });
      await worker.prompt("initial prompt");
      expect(onInitialPromptWritten).toHaveBeenCalledOnce();

      await worker.prompt("steer", "steer");
      await worker.prompt("follow up", "followUp");
      expect(onInitialPromptWritten).toHaveBeenCalledOnce();
      expect(child.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"prompt","message":"initial prompt"'),
        "utf8",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("stop() before start() terminates the spawned process and settles with a signal", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.stop();
      const starting = worker.start();
      await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith(child, "SIGTERM"));
      expect(spawn).toHaveBeenCalledOnce();
      child.emit("close", null, "SIGTERM");
      await starting;
      const result = await worker.waitForSettled();
      expect(result.signal).toBe("SIGTERM");
      expect(result.code).toBeNull();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not respawn a stopped worker when prompted again", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      await worker.start();
      const stopping = worker.stop();
      child.emit("close", null, "SIGTERM");
      await stopping;
      await expect(worker.prompt("late steer", "steer")).rejects.toThrow("worker is stopped");
      expect(spawn).toHaveBeenCalledOnce();
      expect(child.stdin.write).not.toHaveBeenCalledWith(
        expect.stringContaining('"type":"prompt"'),
        "utf8",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("points PI_HOST_SOCKET at host-task.sock for task runs and host.sock otherwise", async () => {
    const f = await fixture();
    try {
      const runDir = path.join(f.root, "run");
      await mkdir(runDir, { recursive: true });

      const taskFixture = fakeChildFixture();
      const taskWorker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        hostSocketDir: runDir,
        taskRun: true,
        spawnProcess: taskFixture.spawn,
        terminateProcessGroup: taskFixture.terminate,
      });
      await taskWorker.start();
      const taskArgs = taskFixture.spawn.mock.calls[0]?.[1] ?? [];
      expect(taskArgs[taskArgs.indexOf("PI_HOST_SOCKET") + 1]).toBe("/run/host-task.sock");

      const chatFixture = fakeChildFixture();
      const chatWorker = new PiWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        hostSocketDir: runDir,
        taskRun: false,
        spawnProcess: chatFixture.spawn,
        terminateProcessGroup: chatFixture.terminate,
      });
      await chatWorker.start();
      const chatArgs = chatFixture.spawn.mock.calls[0]?.[1] ?? [];
      expect(chatArgs[chatArgs.indexOf("PI_HOST_SOCKET") + 1]).toBe("/run/host.sock");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects non-safe stop grace periods and idle timeouts", () => {
    expect(() => new PiWorker({
      workspace: "/tmp/ws",
      appRoot: "/tmp/app",
      spawnProcess: vi.fn(),
      terminateProcessGroup: vi.fn(),
      stopGraceMs: -1,
    })).toThrow("stopGraceMs must be a non-negative integer");

    expect(() => new PiWorker({
      workspace: "/tmp/ws",
      appRoot: "/tmp/app",
      spawnProcess: vi.fn(),
      terminateProcessGroup: vi.fn(),
      idleTimeoutMs: -1,
    })).toThrow("idleTimeoutMs must be a non-negative integer");

  });
});
