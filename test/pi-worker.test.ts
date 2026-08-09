import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PiRpcWorker, StrictJsonlParser, type PiWorkerSpawn } from "../src/pi-worker.js";

type Signal = NodeJS.Signals | null;

class FakeChild extends EventEmitter {
  readonly pid = 2_147_000_000;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.commands.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  exitCode: number | null = null;
  signalCode: Signal = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

function record(child: FakeChild, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-pi-worker-test-"));
  const appRoot = path.join(root, "app");
  const workspace = path.join(root, "workspace");
  const cliPath = path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  await mkdir(path.dirname(cliPath), { recursive: true, mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(cliPath, "#!/usr/bin/env node\n", { mode: 0o700 });
  await writeFile(path.join(appRoot, ".env"), "TG_BOT_TOKEN=must-not-be-visible\n", { mode: 0o600 });
  return { root, appRoot, workspace, cliPath };
}

describe("StrictJsonlParser", () => {
  it("uses LF framing, accepts CRLF, and preserves Unicode line separators", () => {
    const parser = new StrictJsonlParser();
    const first = JSON.stringify({ text: "before\u2028after" });
    expect(parser.push(`${first}\r\n{"ok":true}`)).toEqual([{ text: "before\u2028after" }]);
    expect(parser.end()).toEqual([{ ok: true }]);
  });

  it("rejects malformed records rather than silently resynchronizing", () => {
    const parser = new StrictJsonlParser();
    expect(() => parser.push("not-json\n")).toThrow("Invalid Pi RPC JSON");
  });
});

describe("PiRpcWorker", () => {
  it("constructs a read-only app worker profile and correlates responses", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const calls: Array<{ executable: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
    const spawnProcess: PiWorkerSpawn = (executable, args, options) => {
      calls.push({ executable, args, options });
      return child as unknown as ReturnType<PiWorkerSpawn>;
    };
    const worker = new PiRpcWorker({ workspace: f.workspace, appRoot: f.appRoot, cliPath: f.cliPath, appendSystemPrompt: "runtime prompt", bwrapPath: "/test/bwrap", spawn: spawnProcess });
    try {
      process.env.TG_BOT_TOKEN = "must-not-leak";
      await worker.start();
      expect(await readFile(path.join(f.workspace, ".pi", "agent", "web-search.json"), "utf8"))
        .toBe('{"workflow":"none","autoOpenBrowser":false}\n');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.executable).toBe("/test/bwrap");
      expect(calls[0]?.args).toEqual(expect.arrayContaining([
        "--ro-bind", path.join(f.appRoot, "node_modules"), "/app/node_modules",
        "--bind", f.workspace, "/workspace",
        "--share-net", "--cap-drop", "ALL",
        "--setenv", "HOME", "/workspace",
        "--setenv", "PI_CODING_AGENT_DIR", "/workspace/.pi/agent",
        "--setenv", "PATH", "/workspace/.local/bin:/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
        "--mode", "rpc", "--continue", "--session-dir", "/workspace/.pi/sessions", "--approve",
        "--append-system-prompt", "runtime prompt",
      ]));
      expect(calls[0]?.args).not.toEqual(expect.arrayContaining(["--ro-bind", f.appRoot, "/app"]));
      expect(calls[0]?.args).not.toContain(path.join(f.appRoot, ".env"));
      expect(calls[0]?.args).toContain("/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
      expect(calls[0]?.options.env).toEqual({});
      const prompt = worker.prompt("hello");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string; message?: string };
      expect(command.type).toBe("prompt");
      expect(command.message).toBe("hello");
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
      const settled = worker.waitForSettled();
      record(child, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } });
      record(child, { type: "agent_settled" });
      await settled;
      await expect(worker.getLastAssistantText()).resolves.toBe("answer");
    } finally {
      delete process.env.TG_BOT_TOKEN;
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("debounces extension resource changes and restarts the idle worker", async () => {
    const f = await fixture();
    const children: FakeChild[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      expect(children).toHaveLength(1);
      await writeFile(path.join(f.workspace, ".pi", "settings.json"), '{"theme":"dark"}\n');
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(children).toHaveLength(1);
      const extensionDirectory = path.join(f.workspace, ".pi", "extensions");
      await mkdir(extensionDirectory, { recursive: true });
      const extensionPath = path.join(extensionDirectory, "example.ts");
      await writeFile(extensionPath, "export default () => {};\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(extensionPath, "export default () => { return undefined; };\n");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(children).toHaveLength(2);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("waits for an active turn before reloading extensions", async () => {
    const f = await fixture();
    const children: FakeChild[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("active");
      const command = JSON.parse(children[0]?.commands[0] ?? "{}") as { id?: string };
      record(children[0]!, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
      record(children[0]!, { type: "agent_start" });
      await vi.waitFor(() => expect(children[0]?.commands).toHaveLength(2), { timeout: 1_000, interval: 10 });
      const stateCommand = JSON.parse(children[0]?.commands[1] ?? "{}") as { id?: string };
      record(children[0]!, {
        type: "response",
        id: stateCommand.id,
        command: "get_state",
        success: true,
        data: { isStreaming: true, pendingMessageCount: 0 },
      });
      const extensionDirectory = path.join(f.workspace, ".pi", "extensions");
      await mkdir(extensionDirectory, { recursive: true });
      await writeFile(path.join(extensionDirectory, "active.ts"), "export default () => {};\n");
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(children).toHaveLength(1);
      const settled = worker.waitForSettled();
      record(children[0]!, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      record(children[0]!, { type: "agent_settled" });
      await settled;
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 50 });
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("settles a prompt handled before an agent turn", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("/handled");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const stateRequest = JSON.parse(child.commands[1] ?? "{}") as { id?: string; type?: string };
      const settled = worker.waitForSettled();
      record(child, {
        type: "response",
        id: stateRequest.id,
        command: "get_state",
        success: true,
        data: { isStreaming: false, pendingMessageCount: 0 },
      });
      await settled;
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects pending requests and settled waiters when the process exits", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("will fail");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      const settled = worker.waitForSettled();
      child.emit("exit", 1, null);
      await expect(prompt).rejects.toThrow("Pi worker exited");
      await expect(settled).rejects.toThrow("Pi worker exited");
      expect(command.id).toMatch(/^pi-rpc-/);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("settles active work when abort is acknowledged without agent_settled", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      rpcTimeoutMs: 20,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("active");
      const promptCommand = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: promptCommand.id, command: "prompt", success: true });
      await prompt;
      const settled = worker.waitForSettled();
      const abort = worker.abort();
      const abortCommand = JSON.parse(child.commands[1] ?? "{}") as { id?: string };
      record(child, { type: "response", id: abortCommand.id, command: "abort", success: true });
      await abort;
      await expect(settled).resolves.toBeUndefined();
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not retain a prompt epoch after abort acknowledges first", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("aborted before acknowledgement");
      const promptCommand = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      const settled = worker.waitForSettled();
      const abort = worker.abort();
      const abortCommand = JSON.parse(child.commands[1] ?? "{}") as { id?: string };
      record(child, { type: "response", id: abortCommand.id, command: "abort", success: true });
      await abort;
      await expect(settled).resolves.toBeUndefined();
      record(child, { type: "response", id: promptCommand.id, command: "prompt", success: true });
      await expect(prompt).resolves.toBeUndefined();
      const state = worker as unknown as {
        acceptedWork: Set<number>;
        unsettledWork: Set<number>;
        startedWork: Set<number>;
        settledBeforeAcceptance: Set<number>;
      };
      expect(state.acceptedWork.size).toBe(0);
      expect(state.unsettledWork.size).toBe(0);
      expect(state.startedWork.size).toBe(0);
      expect(state.settledBeforeAcceptance.size).toBe(0);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("settles a steer whose response arrives after agent_settled", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("first");
      const promptCommand = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: promptCommand.id, command: "prompt", success: true });
      await prompt;
      const steer = worker.steer("late");
      const settled = worker.waitForSettled();
      const steerCommand = JSON.parse(child.commands[1] ?? "{}") as { id?: string };
      record(child, { type: "agent_settled" });
      record(child, { type: "response", id: steerCommand.id, command: "steer", success: true });
      await expect(steer).resolves.toBeUndefined();
      await expect(settled).resolves.toBeUndefined();
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects settlement waiters when the state probe times out", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("silent state");
      const promptCommand = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: promptCommand.id, command: "prompt", success: true });
      await prompt;
      const settled = worker.waitForSettled();
      const settledRejection = expect(settled).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(100);
      await settledRejection;
    } finally {
      await worker.stop();
      vi.useRealTimers();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("does not claim startup success when stop overlaps startup", async () => {
    const f = await fixture();
    const children: FakeChild[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    try {
      const initialStart = worker.start();
      const initialFailure = expect(initialStart).rejects.toThrow("superseded by stop");
      const stopping = worker.stop();
      const restart = worker.start();
      await initialFailure;
      await stopping;
      await expect(restart).resolves.toBeUndefined();
      expect(children).toHaveLength(1);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("serializes a restart that overlaps stop", async () => {
    const f = await fixture();
    const children: FakeChild[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      await Promise.all([worker.stop(), worker.start()]);
      expect(children).toHaveLength(2);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
