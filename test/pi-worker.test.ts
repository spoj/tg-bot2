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
  child.stdin.write = vi.fn(() => true);
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
  it("spawns bwrap with --mode rpc and configures steering and followup modes to all", async () => {
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
      expect(spawn).toHaveBeenCalledOnce();
      const [, , options] = spawn.mock.calls[0] ?? [];
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(options).toEqual({ detached: true, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      expect(args).toContain("--mode");
      expect(args).toContain("rpc");
      expect(args).toContain("--session-dir");
      expect(args[args.indexOf("--session-dir") + 1]).toBe("/workspace/.pi/sessions");

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
        child.emit("exit", 0, null);
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

        child.emit("exit", 0, null);
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

        child.emit("exit", null, "SIGKILL");
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
