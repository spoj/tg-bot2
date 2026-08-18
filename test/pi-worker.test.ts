import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PiRpcWorker, StrictJsonlParser } from "../src/pi-worker.js";
import { buildBwrapArgs, buildPiWorkerBwrapArgs } from "../src/sandbox.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "../src/sandbox.js";

type Signal = NodeJS.Signals | null;

class FakeChild extends EventEmitter {
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

interface FixturePaths {
  root: string;
  appRoot: string;
  workspace: string;
  cliPath: string;
}

async function fixture(): Promise<FixturePaths> {
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

interface WithWorkerOptions extends Omit<ConstructorParameters<typeof PiRpcWorker>[0], "spawn" | "terminateProcessGroup" | "workspace" | "appRoot" | "cliPath"> {
  spawn?: (children: FakeChild[]) => PiWorkerSpawn;
  terminateProcessGroup?: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  useFakeTimers?: boolean;
  start?: boolean;
}

async function withWorker<T>(
  f: FixturePaths,
  options: WithWorkerOptions,
  fn: (context: { worker: PiRpcWorker; child: FakeChild; children: FakeChild[] }) => Promise<T>,
): Promise<T> {
  const children: FakeChild[] = [];
  const { spawn: spawnSetup, terminateProcessGroup: terminateSetup, useFakeTimers = false, start = true, ...workerOptions } = options;
  const spawn = spawnSetup
    ? spawnSetup(children)
    : ((() => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      }) as PiWorkerSpawn);
  const terminateProcessGroup = terminateSetup ?? ((child: unknown, signal: NodeJS.Signals) => {
    (child as FakeChild).kill(signal);
  });
  const worker = new PiRpcWorker({ workspace: f.workspace, appRoot: f.appRoot, cliPath: f.cliPath, ...workerOptions, spawn, terminateProcessGroup });
  if (useFakeTimers) vi.useFakeTimers();
  try {
    if (start) await worker.start();
    return await fn({ worker, child: children[0]!, children });
  } finally {
    if (useFakeTimers) vi.useRealTimers();
    await worker.stop();
    await rm(f.root, { recursive: true, force: true });
  }
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
    const calls: Array<{ executable: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
    process.env.TG_BOT_TOKEN = "must-not-leak";
    try {
      await withWorker(f, {
        appendSystemPrompt: "runtime prompt",
        bwrapPath: "/test/bwrap",
        spawn: (children) => (executable, args, options) => {
          calls.push({ executable, args, options });
          const child = new FakeChild();
          children.push(child);
          return child as unknown as ReturnType<PiWorkerSpawn>;
        },
      }, async ({ worker, child }) => {
        expect(await readFile(path.join(f.workspace, ".pi", "agent", "web-search.json"), "utf8"))
          .toBe('{"workflow":"none","autoOpenBrowser":false}\n');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.executable).toBe("/test/bwrap");
        expect(calls[0]?.args).toEqual(expect.arrayContaining(["--append-system-prompt", "runtime prompt"]));
        expect(calls[0]?.args).not.toEqual(expect.arrayContaining(["--ro-bind", f.appRoot, "/app"]));
        expect(calls[0]?.args).not.toContain(path.join(f.appRoot, ".env"));
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
      });
    } finally {
      delete process.env.TG_BOT_TOKEN;
    }
  });

  it("debounces extension resource changes and restarts the idle worker", async () => {
    const f = await fixture();
    await withWorker(f, {}, async ({ children }) => {
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
    });
  });

  it("reloads resources under project and user git install directories", async () => {
    const f = await fixture();
    await withWorker(f, {}, async ({ children }) => {
      await mkdir(path.join(f.workspace, ".pi", "git"), { recursive: true });
      await mkdir(path.join(f.workspace, ".pi", "agent", "git"), { recursive: true });
      await writeFile(path.join(f.workspace, ".pi", "git", "project.ts"), "export default () => {};\n");
      await writeFile(path.join(f.workspace, ".pi", "agent", "git", "user.ts"), "export default () => {};\n");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 25 });
    });
  });

  it("reloads when any resource discovery setting changes", async () => {
    const f = await fixture();
    await withWorker(f, {}, async ({ children }) => {
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
    });
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
    await withWorker(f, {}, async ({ children }) => {
      await writeFile(outsideExtension, "export default () => undefined;\n");
      await writeFile(path.join(outsidePackage, "extension.ts"), "export default () => undefined;\n");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 25 });
    });
  });

  it("watches the parent of a missing local source", async () => {
    const f = await fixture();
    const missingExtension = path.join(f.root, "future", "extension.ts");
    await mkdir(path.join(f.workspace, ".pi"), { recursive: true });
    await writeFile(path.join(f.workspace, ".pi", "settings.json"), JSON.stringify({
      extensions: [path.relative(path.join(f.workspace, ".pi"), missingExtension)],
    }));
    await withWorker(f, {}, async ({ children }) => {
      await mkdir(path.dirname(missingExtension), { recursive: true });
      await writeFile(missingExtension, "export default () => {};");
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000, interval: 25 });
    });
  });

  it("keeps a second extension change made during reload", async () => {
    const f = await fixture();
    const secondPath = path.join(f.workspace, ".pi", "extensions", "second.ts");
    await withWorker(f, {
      spawn: (children) => () => {
        const child = new FakeChild();
        children.push(child);
        if (children.length === 2) void writeFile(secondPath, "export default () => {};\n");
        return child as unknown as ReturnType<PiWorkerSpawn>;
      },
    }, async ({ children }) => {
      await mkdir(path.dirname(secondPath), { recursive: true });
      await writeFile(path.join(f.workspace, ".pi", "extensions", "first.ts"), "export default () => {};\n");
      await vi.waitFor(() => expect(children).toHaveLength(3), { timeout: 4_000, interval: 25 });
    });
  });

  it("emits a bounded worker_error when extension reload startup fails", async () => {
    const f = await fixture();
    const events: Record<string, unknown>[] = [];
    await withWorker(f, {
      spawn: (children) => () => {
        if (children.length > 0) throw new Error("reload failure ".repeat(1_000));
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ReturnType<PiWorkerSpawn>;
      },
    }, async ({ worker }) => {
      const unsubscribe = worker.onEvent((event) => events.push(event));
      try {
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
      }
    });
  });

  it("waits for an active turn before reloading extensions", async () => {
    const f = await fixture();
    await withWorker(f, {}, async ({ worker, children }) => {
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
    });
  });

  it("settles a prompt handled before an agent turn", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
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
    });
  });


  it("rejects pending requests and settled waiters when the process exits", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const prompt = worker.prompt("will fail");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      const settled = worker.waitForSettled();
      child.emit("exit", 1, null);
      await expect(prompt).rejects.toThrow("Pi worker exited");
      await expect(settled).rejects.toThrow("Pi worker exited");
      child.emit("close", 1, null);
      expect(command.id).toMatch(/^pi-rpc-/);
    });
  });

  it("terminates after a synchronous stdin write failure", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      child.stdin.write = (() => {
        throw new Error("stdin write failed");
      }) as typeof child.stdin.write;
      await expect(worker.prompt("fails synchronously")).rejects.toThrow("stdin write failed");
      await expect(worker.prompt("is terminal")).rejects.toThrow("stdin write failed");
      expect(child.signals).toContain("SIGKILL");
    });
  });

  it("ignores late events from a stale child after restart", async () => {
    await withWorker(await fixture(), {}, async ({ worker, children }) => {
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
    });
  });

  it("settles active work when abort is acknowledged without agent_settled", async () => {
    await withWorker(await fixture(), { rpcTimeoutMs: 20 }, async ({ worker, child }) => {
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
    });
  });

  it("does not retain a prompt epoch after abort acknowledges first", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
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

      const nextPrompt = worker.prompt("after abort");
      const nextCommand = JSON.parse(child.commands[2] ?? "{}") as { id?: string; type?: string; message?: string };
      expect(nextCommand).toMatchObject({ type: "prompt", message: "after abort" });
      record(child, { type: "response", id: nextCommand.id, command: "prompt", success: true });
      await expect(nextPrompt).resolves.toBeUndefined();
    });
  });

  it("rejects settlement waiters when the state probe times out", async () => {
    await withWorker(await fixture(), { useFakeTimers: true, rpcTimeoutMs: 20 }, async ({ worker, child }) => {
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
    });
  });

  it("does not claim startup success when stop overlaps startup", async () => {
    await withWorker(await fixture(), { start: false }, async ({ worker, children }) => {
      const initialStart = worker.start();
      const initialFailure = expect(initialStart).rejects.toThrow("superseded by stop");
      const stopping = worker.stop();
      const restart = worker.start();
      await initialFailure;
      await stopping;
      await expect(restart).resolves.toBeUndefined();
      expect(children).toHaveLength(1);
    });
  });

  it("serializes a restart that overlaps stop", async () => {
    await withWorker(await fixture(), { start: false }, async ({ worker, children }) => {
      await worker.start();
      await Promise.all([worker.stop(), worker.start()]);
      expect(children).toHaveLength(2);
    });
  });

  it("surfaces assistant message_end errors after acceptance", async () => {
    const events: Record<string, unknown>[] = [];
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const unsubscribe = worker.onEvent((event) => events.push(event));
      try {
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
        expect(events).toContainEqual(expect.objectContaining({
          type: "message_end",
          message: expect.objectContaining({ errorMessage: "provider failed" }),
        }));
      } finally {
        unsubscribe();
      }
    });
  });

  it("rejects a late waitForSettled after a provider failure", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const prompt = worker.prompt("erroring turn");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      child.stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n` +
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } })}\n` +
        `${JSON.stringify({ type: "agent_settled" })}\n`,
      );
      await prompt;
      await expect(worker.waitForSettled()).rejects.toThrow("provider failed");
    });
  });

  it("allows slow prompt acceptance while keeping fast RPC deadlines", async () => {
    await withWorker(await fixture(), { useFakeTimers: true, rpcTimeoutMs: 20, promptTimeoutMs: 200 }, async ({ worker, child }) => {
      const prompt = worker.prompt("slow acceptance");
      await vi.advanceTimersByTimeAsync(199);
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await expect(prompt).resolves.toBeUndefined();
    });
  });

  it("uses the configured RPC timeout for delayed state settlement", async () => {
    await withWorker(await fixture(), { useFakeTimers: true, rpcTimeoutMs: 200, promptTimeoutMs: 300 }, async ({ worker, child }) => {
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
    });
  });

  it("rejects startup when the child exits during watcher setup", async () => {
    await withWorker(await fixture(), {
      start: false,
      spawn: () => () => {
        const child = new FakeChild();
        queueMicrotask(() => child.emit("exit", 1, null));
        return child as unknown as ReturnType<PiWorkerSpawn>;
      },
    }, async ({ worker }) => {
      await expect(worker.start()).rejects.toThrow("Pi worker exited");
    });
  });

  it("emits one bounded worker_error for an unexpected idle exit", async () => {
    const events: Record<string, unknown>[] = [];
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const unsubscribe = worker.onEvent((event) => events.push(event));
      try {
        child.emit("exit", 1, null);
        const errors = events.filter((event) => event.type === "worker_error");
        expect(errors).toHaveLength(1);
        expect(String(errors[0]?.error).length).toBeLessThanOrEqual(2_048);
        child.emit("close", 1, null);
        expect(events.filter((event) => event.type === "worker_error")).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });
  });

  it("rejects timer values above Node's maximum", async () => {
    const f = await fixture();
    try {
      for (const option of ["stopGraceMs", "rpcTimeoutMs", "promptTimeoutMs", "lifecycleTimeoutMs"] as const) {
        expect(() => new PiRpcWorker({
          workspace: f.workspace,
          appRoot: f.appRoot,
          cliPath: f.cliPath,
          spawn: () => { throw new Error("unused"); },
          terminateProcessGroup: () => {},
          [option]: 2_147_483_648,
        } as ConstructorParameters<typeof PiRpcWorker>[0])).toThrow("2147483647");
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("bounds retained stderr while preserving the newest diagnostics", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const prompt = worker.prompt("crashing turn");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
      const settled = worker.waitForSettled();
      const settlementError = settled.then(
        () => { throw new Error("expected settlement to reject on exit"); },
        (error: unknown): Error => error as Error,
      );
      child.stderr.write(`${"x".repeat(100_000)}tail`);
      await Promise.resolve();
      child.emit("exit", 1, null);
      const error = await settlementError;
      expect(error.message).toMatch(/tail$/);
      expect(error.message.length).toBeLessThanOrEqual(64 * 1024 + 64);
    });
  });

  it("sets the model via RPC", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const setModel = worker.setModel("anthropic", "claude-sonnet-4-20250514");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string; provider?: string; modelId?: string };
      expect(command.type).toBe("set_model");
      expect(command.provider).toBe("anthropic");
      expect(command.modelId).toBe("claude-sonnet-4-20250514");
      record(child, { type: "response", id: command.id, command: "set_model", success: true });
      await expect(setModel).resolves.toBeUndefined();
    });
  });

  it("sets the thinking level via RPC", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const setThinkingLevel = worker.setThinkingLevel("high");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string; type?: string; level?: string };
      expect(command.type).toBe("set_thinking_level");
      expect(command.level).toBe("high");
      record(child, { type: "response", id: command.id, command: "set_thinking_level", success: true });
      await expect(setThinkingLevel).resolves.toBeUndefined();
    });
  });

  it("normalizes available models", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
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
    });
  });

  it("normalizes available thinking levels", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
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
    });
  });

  it("normalizes session state", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
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
    });
  });

  it("rejects restart while a turn is unsettled", async () => {
    await withWorker(await fixture(), {}, async ({ worker, child }) => {
      const prompt = worker.prompt("active");
      const command = JSON.parse(child.commands[0] ?? "{}") as { id?: string };
      await expect(worker.restart()).rejects.toThrow("Pi worker is busy");
      record(child, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
    });
  });

  it("restarts an idle worker and keeps it live", async () => {
    await withWorker(await fixture(), { start: false }, async ({ worker, children }) => {
      await worker.start();
      expect(children).toHaveLength(1);
      await worker.restart();
      expect(children).toHaveLength(2);
      const prompt = worker.prompt("after restart");
      const command = JSON.parse(children[1]?.commands[0] ?? "{}") as { id?: string; type?: string };
      expect(command.type).toBe("prompt");
      record(children[1]!, { type: "response", id: command.id, command: "prompt", success: true });
      await prompt;
    });
  });
});
