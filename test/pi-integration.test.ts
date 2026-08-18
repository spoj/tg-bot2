import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiWorkerBwrapArgs, checkSandboxEnvironment, terminateProcessGroup } from "../src/sandbox.js";

type JsonRecord = Record<string, unknown>;

// Opt-in integration gate: exercise the REAL bundled pi CLI (and bubblewrap)
// only when explicitly requested, so the default offline test run stays hermetic.
const integration = process.env.RUN_BWRAP_TESTS === "1" ? describe : describe.skip;

const RPC_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 60_000;
const CANONICAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STOP_GRACE_MS = 2_000;

interface PendingRequest {
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  type: string;
  resolve: (value: JsonRecord) => void;
}

/** Minimal strict-JSONL RPC driver over the real pi CLI's stdin/stdout. */
class PiHarness {
  readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waiters: EventWaiter[] = [];
  private buffer = "";
  private nextId = 0;
  stderr = "";

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => { this.stderr += chunk.toString(); });
  }

  private push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      return; // Ignore non-JSON startup noise.
    }
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success === true) pending.resolve(record);
      else pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi RPC command failed"));
      return;
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      if (waiter !== undefined && waiter.type === record.type) {
        this.waiters.splice(i, 1);
        waiter.resolve(record);
      }
    }
  }

  request(command: JsonRecord, timeoutMs = RPC_TIMEOUT_MS): Promise<JsonRecord> {
    const id = `pi-it-${++this.nextId}`;
    const line = `${JSON.stringify({ id, ...command })}\n`;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${String(command.type)} timed out. Stderr: ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(line);
    });
  }

  waitForEvent(type: string, timeoutMs = SETTLE_TIMEOUT_MS): Promise<JsonRecord> {
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${type} event. Stderr: ${this.stderr}`));
      }, timeoutMs);
      this.waiters.push({
        type,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
      });
    });
  }

  async getState(): Promise<JsonRecord> {
    const response = await this.request({ type: "get_state" });
    const data = response.data;
    return data !== null && typeof data === "object" ? (data as JsonRecord) : {};
  }
}

async function startWorker() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-pi-integration-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  // The bundled CLI lives in this repository's own node_modules; the repo root
  // is the appRoot, exactly as the production worker treats it.
  const appRoot = await realpath(process.cwd());
  const { bwrapPath } = await checkSandboxEnvironment(path.join(root, "data"));
  const { args } = await buildPiWorkerBwrapArgs({ workspace, appRoot });
  const child = spawn(bwrapPath, args, { detached: true, env: {}, stdio: ["pipe", "pipe", "pipe"] });
  return { root, child, harness: new PiHarness(child) };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  terminateProcessGroup(child, "SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_GRACE_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null && child.signalCode === null) {
    terminateProcessGroup(child, "SIGKILL");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_GRACE_MS);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

integration("Pi RPC integration (requires RUN_BWRAP_TESTS=1)", () => {
  it("drives the real pi CLI through its RPC lifecycle without provider credentials", async () => {
    const { root, child, harness } = await startWorker();
    try {
      // 1. get_state exposes a well-formed session.
      const state = await harness.getState();
      expect(typeof state.sessionId).toBe("string");
      expect((state.sessionId as string).length).toBeGreaterThan(0);
      expect(typeof state.thinkingLevel).toBe("string");
      expect(typeof state.isStreaming).toBe("boolean");
      expect(typeof state.messageCount).toBe("number");

      // 2. get_available_thinking_levels succeeds and returns canonical levels.
      // Offline (no credentials) the agent resolves to an unconfigured, non-reasoning
      // model, so it reports only "off". A credentialed reasoning model reports the
      // full canonical set; assert every reported level is canonical and "off" is present.
      const levelsResponse = await harness.request({ type: "get_available_thinking_levels" });
      const levelsData = levelsResponse.data;
      const levels = levelsData !== null && typeof levelsData === "object" ? (levelsData as JsonRecord).levels : undefined;
      expect(Array.isArray(levels)).toBe(true);
      for (const level of levels as unknown[]) {
        expect(CANONICAL_THINKING_LEVELS).toContain(level);
      }
      expect(levels).toContain("off");

      // 3. set_thinking_level succeeds and round-trips into get_state, clamped to the
      // model's available levels. Offline, "high" clamps to "off" (the only level).
      await harness.request({ type: "set_thinking_level", level: "high" });
      const highState = await harness.getState();
      expect(typeof highState.thinkingLevel).toBe("string");
      expect(levels).toContain(highState.thinkingLevel);

      // 4. new_session yields a fresh session id.
      const beforeId = highState.sessionId;
      await harness.request({ type: "new_session" });
      const freshState = await harness.getState();
      expect(freshState.sessionId).not.toBe(beforeId);
      // 5. A prompt without credentials must settle without crashing the worker.
      // Register the settlement waiter before awaiting acceptance so a fast
      // agent_settled is not missed. Only the specific no-credentials rejection
      // is tolerated (it produces no agent turn); a settlement timeout or any
      // other RPC error must fail the test.
      const promptSettled = harness.waitForEvent("agent_settled");
      try {
        await harness.request({ type: "prompt", message: "hi" });
        await promptSettled;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/No API key found|No model selected|Authentication failed/.test(message)) {
          throw error;
        }
      }
      const afterPrompt = await harness.getState();
      expect(afterPrompt.isStreaming).toBe(false);
    } finally {
      await stopChild(child);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
