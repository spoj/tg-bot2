import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PiRpcWorker, StrictJsonlParser, type PiWorkerSpawn } from "../src/pi-worker.js";
import { buildBwrapArgs, buildPiWorkerBwrapArgs } from "../src/sandbox.js";

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
  closeOnKill = true;
  signalCode: Signal = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      if (this.closeOnKill) this.emit("close", null, signal);
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

it("rejects symlinked read-only and CLI sources", async () => {
  const f = await fixture();
  const sessions = path.join(f.root, "sessions");
  const readOnlyTarget = path.join(f.workspace, "target");
  const readOnlyLink = path.join(f.workspace, "linked-target");
  const cliLink = path.join(f.root, "linked-cli.js");
  try {
    await mkdir(sessions);
    await mkdir(readOnlyTarget);
    await symlink(readOnlyTarget, readOnlyLink, "dir");
    await expect(buildBwrapArgs({ workspace: f.workspace, sessions, readOnlyPaths: [readOnlyLink] }, { executable: "/bin/cat", args: [] }))
      .rejects.toThrow("read-only paths must not be symlinks");
    await symlink(f.cliPath, cliLink, "file");
    await expect(buildPiWorkerBwrapArgs({ workspace: f.workspace, appRoot: f.appRoot, cliPath: cliLink }))
      .rejects.toThrow("CLI must be a regular file");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
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
        "--mode", "rpc", "--session-dir", "/workspace/.pi/sessions", "--approve",
        "--append-system-prompt", "runtime prompt",
      ]));
      expect(calls[0]?.args).not.toEqual(expect.arrayContaining(["--ro-bind", f.appRoot, "/app"]));
      expect(calls[0]?.args).not.toContain(path.join(f.appRoot, ".env"));
      expect(calls[0]?.args).toContain("/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
      expect(calls[0]?.options.env).toEqual({});
      expect(calls[0]?.args).toContain(await realpath(process.execPath));
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

  it("reloads resources under project and user git install directories", async () => {
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
      await mkdir(path.join(f.workspace, ".pi", "git"), { recursive: true });
      await mkdir(path.join(f.workspace, ".pi", "agent", "git"), { recursive: true });
      await writeFile(path.join(f.workspace, ".pi", "git", "project.ts"), "export default () => {};\n");
      await writeFile(path.join(f.workspace, ".pi", "agent", "git", "user.ts"), "export default () => {};\n");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 25 });
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("reloads when any resource discovery setting changes", async () => {
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
      const settingsPath = path.join(f.workspace, ".pi", "settings.json");
      const updates = [
        { packages: ["./local-package"] },
        { extensions: ["./local-extension.ts"] },
        { skills: ["./local-skills"] },
        { prompts: ["./local-prompts"] },
        { themes: ["./local-themes"] },
      ];
      for (const [index, update] of updates.entries()) {
        await writeFile(settingsPath, `${JSON.stringify(update)}\n`);
        await vi.waitFor(() => expect(children).toHaveLength(index + 2), { timeout: 3_000, interval: 25 });
      }
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("watches configured local project and user sources outside .pi", async () => {
    const f = await fixture();
    const outsideExtension = path.join(f.root, "outside-extension.ts");
    const outsidePackage = path.join(f.root, "outside-package");
    await mkdir(outsidePackage, { recursive: true });
    await writeFile(outsideExtension, "export default () => {};\n");
    await writeFile(path.join(outsidePackage, "extension.ts"), "export default () => {};\n");
    await mkdir(path.join(f.workspace, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(f.workspace, ".pi", "settings.json"), JSON.stringify({
      extensions: [path.relative(path.join(f.workspace, ".pi"), outsideExtension)],
    }));
    await writeFile(path.join(f.workspace, ".pi", "agent", "settings.json"), JSON.stringify({
      packages: [path.relative(path.join(f.workspace, ".pi", "agent"), outsidePackage)],
    }));
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
      await writeFile(outsideExtension, "export default () => undefined;\n");
      await writeFile(path.join(outsidePackage, "extension.ts"), "export default () => undefined;\n");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 25 });
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("watches the parent of a missing local source", async () => {
    const f = await fixture();
    const missingExtension = path.join(f.root, "future", "extension.ts");
    await mkdir(path.join(f.workspace, ".pi"), { recursive: true });
    await writeFile(path.join(f.workspace, ".pi", "settings.json"), JSON.stringify({
      extensions: [path.relative(path.join(f.workspace, ".pi"), missingExtension)],
    }));
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
      await mkdir(path.dirname(missingExtension), { recursive: true });
      await writeFile(missingExtension, "export default () => {};");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 25 });
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("keeps a second extension change made during reload", async () => {
    const f = await fixture();
    const children: FakeChild[] = [];
    const secondPath = path.join(f.workspace, ".pi", "extensions", "second.ts");
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        const child = new FakeChild();
        children.push(child);
        if (children.length === 2) void writeFile(secondPath, "export default () => {};\n");
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      await mkdir(path.dirname(secondPath), { recursive: true });
      await writeFile(path.join(f.workspace, ".pi", "extensions", "first.ts"), "export default () => {};\n");
      await vi.waitFor(() => expect(children).toHaveLength(3), { timeout: 4_000, interval: 25 });
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("emits a bounded worker_error when extension reload startup fails", async () => {
    const f = await fixture();
    const children: FakeChild[] = [];
    const events: Record<string, unknown>[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        if (children.length > 0) throw new Error("reload failure ".repeat(1_000));
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    const unsubscribe = worker.onEvent((event) => events.push(event));
    try {
      await worker.start();
      const extensionDirectory = path.join(f.workspace, ".pi", "extensions");
      await mkdir(extensionDirectory, { recursive: true });
      await writeFile(path.join(extensionDirectory, "failure.ts"), "export default () => {};\n");
      await vi.waitFor(() => expect(events.some((event) => event.type === "worker_error")).toBe(true), {
        timeout: 3_000,
        interval: 25,
      });
      const errorEvent = events.find((event) => event.type === "worker_error");
      expect(typeof errorEvent?.error).toBe("string");
      expect(String(errorEvent?.error).length).toBeLessThanOrEqual(2_048);
    } finally {
      unsubscribe();
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

  it("does not return a prior assistant answer for a handled prompt", async () => {
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
      const first = worker.prompt("first");
      const firstCommand = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: firstCommand.id, command: "prompt", success: true });
      await first;
      record(child, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } });
      record(child, { type: "agent_settled" });
      await worker.waitForSettled();

      const handled = worker.prompt("/handled");
      const handledCommand = JSON.parse(child.commands[1] ?? "{}") as { id?: string };
      record(child, { type: "response", id: handledCommand.id, command: "prompt", success: true });
      await handled;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const stateRequest = JSON.parse(child.commands[2] ?? "{}") as { id?: string };
      const settled = worker.waitForSettled();
      record(child, {
        type: "response",
        id: stateRequest.id,
        command: "get_state",
        success: true,
        data: { isStreaming: false, pendingMessageCount: 0 },
      });
      await settled;
      await expect(worker.getLastAssistantText()).resolves.toBeUndefined();
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
      child.emit("close", 1, null);
      expect(command.id).toMatch(/^pi-rpc-/);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("terminates after a synchronous stdin write failure", async () => {
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
      child.stdin.write = (() => {
        throw new Error("stdin write failed");
      }) as typeof child.stdin.write;
      await expect(worker.prompt("fails synchronously")).rejects.toThrow("stdin write failed");
      await expect(worker.prompt("is terminal")).rejects.toThrow("stdin write failed");
      expect(child.signals).toContain("SIGKILL");
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("ignores late events from a stale child after restart", async () => {
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
      const oldChild = children[0]!;
      oldChild.closeOnKill = false;
      await worker.stop();
      await worker.start();
      const currentChild = children[1]!;
      const prompt = worker.prompt("current child");
      const command = JSON.parse(currentChild.commands[0] ?? "{}") as { id?: string };
      oldChild.stdout.write('{"type":"message_end","message":{"role":"assistant","content":[]}}\n');
      oldChild.stderr.write("late old stderr");
      oldChild.emit("error", new Error("late old error"));
      oldChild.emit("exit", 1, null);
      oldChild.emit("close", 1, null);
      oldChild.stdin.emit("error", new Error("late old stdin error"));
      record(currentChild, { type: "response", id: command.id, command: "prompt", success: true });
      await expect(prompt).resolves.toBeUndefined();
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
      rpcTimeoutMs: 20,
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
      await vi.advanceTimersByTimeAsync(50);
      expect(child.commands).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(20);
      await settledRejection;
    } finally {
      vi.useRealTimers();
      await worker.stop();
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
  it("surfaces assistant message_end errors after acceptance", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const events: Record<string, unknown>[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    const unsubscribe = worker.onEvent((event) => events.push(event));
    try {
      await worker.start();
      const prompt = worker.prompt("erroring turn");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
      const settled = worker.waitForSettled();
      record(child, {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
      });
      record(child, { type: "agent_settled" });
      await expect(settled).rejects.toThrow("provider failed");
      await expect(worker.getLastAssistantText()).resolves.toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({ errorMessage: "provider failed" }),
      }));
    } finally {
      unsubscribe();
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("allows slow prompt acceptance while keeping fast RPC deadlines", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      rpcTimeoutMs: 20,
      promptTimeoutMs: 200,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("slow acceptance");
      await vi.advanceTimersByTimeAsync(199);
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await expect(prompt).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("uses the configured RPC timeout for delayed state settlement", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      rpcTimeoutMs: 200,
      promptTimeoutMs: 300,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    try {
      await worker.start();
      const prompt = worker.prompt("handled");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
      await vi.advanceTimersByTimeAsync(50);
      const stateCommand = JSON.parse(child.commands[1] ?? "{}") as { id?: string };
      const settled = worker.waitForSettled();
      await vi.advanceTimersByTimeAsync(70);
      record(child, {
        type: "response",
        id: stateCommand.id,
        command: "get_state",
        success: true,
        data: { isStreaming: false, pendingMessageCount: 0 },
      });
      await expect(settled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects startup when the child exits during watcher setup", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => {
        queueMicrotask(() => child.emit("exit", 1, null));
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn,
    });
    try {
      await expect(worker.start()).rejects.toThrow("Pi worker exited");
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("emits one bounded worker_error for an unexpected idle exit", async () => {
    const f = await fixture();
    const child = new FakeChild();
    const events: Record<string, unknown>[] = [];
    const worker = new PiRpcWorker({
      workspace: f.workspace,
      appRoot: f.appRoot,
      cliPath: f.cliPath,
      spawn: (() => child as unknown as ReturnType<PiWorkerSpawn>) as PiWorkerSpawn,
    });
    const unsubscribe = worker.onEvent((event) => events.push(event));
    try {
      await worker.start();
      child.emit("exit", 1, null);
      const errors = events.filter((event) => event.type === "worker_error");
      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.error).length).toBeLessThanOrEqual(2_048);
      child.emit("close", 1, null);
      expect(events.filter((event) => event.type === "worker_error")).toHaveLength(1);
    } finally {
      unsubscribe();
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects timer values above Node's maximum", async () => {
    const f = await fixture();
    try {
      for (const option of ["stopGraceMs", "rpcTimeoutMs", "promptTimeoutMs", "lifecycleTimeoutMs"] as const) {
        expect(() => new PiRpcWorker({
          workspace: f.workspace,
          appRoot: f.appRoot,
          cliPath: f.cliPath,
          [option]: 2_147_483_648,
        } as ConstructorParameters<typeof PiRpcWorker>[0])).toThrow("2147483647");
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("bounds retained stderr while preserving the newest diagnostics", async () => {
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
      child.stderr.write(`${"x".repeat(100_000)}tail`);
      await Promise.resolve();
      const state = worker as unknown as { stderr: string };
      expect(state.stderr.length).toBeLessThanOrEqual(64 * 1024);
      expect(state.stderr.endsWith("tail")).toBe(true);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("sets the model via RPC", async () => {
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
      const setModel = worker.setModel("anthropic", "claude-sonnet-4-20250514");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string; provider?: string; modelId?: string };
      expect(command.type).toBe("set_model");
      expect(command.provider).toBe("anthropic");
      expect(command.modelId).toBe("claude-sonnet-4-20250514");
      record(child, { type: "response", id: command.id, command: "set_model", success: true });
      await expect(setModel).resolves.toBeUndefined();
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("sets the thinking level via RPC", async () => {
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
      const setThinkingLevel = worker.setThinkingLevel("high");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string; level?: string };
      expect(command.type).toBe("set_thinking_level");
      expect(command.level).toBe("high");
      record(child, { type: "response", id: command.id, command: "set_thinking_level", success: true });
      await expect(setThinkingLevel).resolves.toBeUndefined();
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("normalizes available models", async () => {
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
      const models = worker.getAvailableModels();
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string };
      expect(command.type).toBe("get_available_models");
      record(child, {
        type: "response",
        id: command.id,
        command: "get_available_models",
        success: true,
        data: {
          models: [
            { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet" },
            { provider: "openai", id: "gpt-5" },
          ],
        },
      });
      await expect(models).resolves.toEqual([
        { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet" },
        { provider: "openai", id: "gpt-5" },
      ]);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("normalizes available thinking levels", async () => {
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
      const levels = worker.getAvailableThinkingLevels();
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string };
      expect(command.type).toBe("get_available_thinking_levels");
      record(child, {
        type: "response",
        id: command.id,
        command: "get_available_thinking_levels",
        success: true,
        data: { levels: ["off", "minimal", "medium", "high", "max"] },
      });
      await expect(levels).resolves.toEqual(["off", "minimal", "medium", "high", "max"]);
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("normalizes session state", async () => {
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
      const state = worker.getSessionState();
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string };
      expect(command.type).toBe("get_state");
      record(child, {
        type: "response",
        id: command.id,
        command: "get_state",
        success: true,
        data: {
          model: { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet", contextWindow: 200_000 },
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          sessionFile: "/workspace/.pi/sessions/abc.json",
          sessionId: "abc",
          sessionName: "named session",
          autoCompactionEnabled: true,
          messageCount: 42,
          pendingMessageCount: 0,
        },
      });
      await expect(state).resolves.toEqual({
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "medium",
        sessionId: "abc",
        sessionFile: "/workspace/.pi/sessions/abc.json",
        messageCount: 42,
        autoCompactionEnabled: true,
      });
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects restart while a turn is unsettled", async () => {
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
      const prompt = worker.prompt("active");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      await expect(worker.restart()).rejects.toThrow("Pi worker is busy");
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("restarts an idle worker and keeps it live", async () => {
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
      await worker.restart();
      expect(children).toHaveLength(2);
      const prompt = worker.prompt("after restart");
      const command = JSON.parse(children[1]?.commands[0] ?? "{}") as { id?: string; type?: string };
      expect(command.type).toBe("prompt");
      record(children[1]!, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
    } finally {
      await worker.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
