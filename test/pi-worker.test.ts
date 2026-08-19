import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { PiRunWorker } from "../src/pi-worker.js";
import type { PiWorkerChildProcess } from "../src/sandbox.js";

type FakeStdin = EventEmitter & { end: Mock<(chunk?: string, encoding?: string) => void> };

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

describe("PiRunWorker", () => {
  it("spawns bwrap with the one-shot profile and feeds the message on stdin", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: "hello world",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      const done = worker.run();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      const [, , options] = spawn.mock.calls[0] ?? [];
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(options).toEqual({ detached: true, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      expect(args).toContain("--print");
      expect(args).toContain("--session-dir");
      expect(args[args.indexOf("--session-dir") + 1]).toBe("/workspace/.pi/sessions");
      expect(child.stdin.end).toHaveBeenCalledWith("hello world", "utf8");
      child.emit("exit", 0, null);
      await expect(done).resolves.toEqual({ code: 0, signal: null, stderr: "", stdout: "" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("passes a custom session directory to the CLI", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: "delegated work",
        sessionDir: "/workspace/.pi/subagents/alpha/sessions",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      const done = worker.run();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(args[args.indexOf("--session-dir") + 1]).toBe("/workspace/.pi/subagents/alpha/sessions");
      child.emit("exit", 0, null);
      await expect(done).resolves.toEqual({ code: 0, signal: null, stderr: "", stdout: "" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("writes appendSystemPrompt to a prompt file and mounts it read-only", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: "hello",
        appendSystemPrompt: "custom system prompt",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      const done = worker.run();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      const args = spawn.mock.calls[0]?.[1] ?? [];
      expect(args).toContain("--append-system-prompt");
      expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/app/append-system-prompt.md");
      expect(args).toContain("/app/append-system-prompt.md");
      child.emit("exit", 0, null);
      await expect(done).resolves.toEqual({ code: 0, signal: null, stderr: "", stdout: "" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("captures bounded stdout and stderr into the run result", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: ".",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      const done = worker.run();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.stdout.emit("data", Buffer.from("out-"));
      child.stderr.emit("data", Buffer.from("err-"));
      child.stdout.emit("data", "tail");
      child.stderr.emit("data", "tail2");
      child.emit("exit", 1, null);
      await expect(done).resolves.toEqual({ code: 1, signal: null, stderr: "err-tail2", stdout: "out-tail" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a second concurrent run", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: ".",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      const done = worker.run();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      await expect(worker.run()).rejects.toThrow("already running");
      child.emit("exit", 0, null);
      await done;
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("stop() escalates SIGTERM to SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      try {
        const { child, spawn, terminate } = fakeChildFixture();
        const worker = new PiRunWorker({
          workspace: f.workspace,
          appRoot: f.appRoot,
          message: ".",
          spawnProcess: spawn,
          terminateProcessGroup: terminate,
          stopGraceMs: 250,
        });
        const done = worker.run();
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
        const stopping = worker.stop();
        expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");
        await vi.advanceTimersByTimeAsync(250);
        expect(terminate).toHaveBeenCalledWith(child, "SIGKILL");
        child.emit("exit", null, "SIGKILL");
        await stopping;
        await expect(done).resolves.toEqual({ code: null, signal: "SIGKILL", stderr: "", stdout: "" });
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() resolves immediately for an already-exited child", async () => {
    const f = await fixture();
    try {
      const { child, spawn, terminate } = fakeChildFixture();
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: ".",
        spawnProcess: spawn,
        terminateProcessGroup: terminate,
      });
      const done = worker.run();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await done;
      await expect(worker.stop()).resolves.toBeUndefined();
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects when bwrap spawning fails", async () => {
    const f = await fixture();
    try {
      const spawn = vi.fn(() => { throw new Error("no bwrap"); });
      const worker = new PiRunWorker({
        workspace: f.workspace,
        appRoot: f.appRoot,
        message: ".",
        spawnProcess: spawn,
        terminateProcessGroup: vi.fn(),
      });
      await expect(worker.run()).rejects.toThrow("spawn failed");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects non-safe stop grace periods", () => {
    expect(() => new PiRunWorker({
      workspace: "/tmp/ws",
      appRoot: "/tmp/app",
      message: ".",
      spawnProcess: vi.fn(),
      terminateProcessGroup: vi.fn(),
      stopGraceMs: -1,
    })).toThrow("stopGraceMs must be a non-negative integer");
  });
});
