import net from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationAgent } from "../src/agent-ref.js";
import { AgentCredentials, HostBridge, type HostCapability } from "../src/host-bridge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ socketPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-bridge-test-"));
  temporaryDirectories.push(root);
  return { socketPath: path.join(root, "run", "host.sock") };
}

function makeBridge(
  socketPath: string,
  capabilities: HostCapability[] = ["send"],
  overrides: Partial<ConstructorParameters<typeof HostBridge>[0]["handlers"]> = {},
): { bridge: HostBridge; token: string; credentials: AgentCredentials } {
  const credentials = new AgentCredentials();
  const token = credentials.issue(conversationAgent("connector:test", "conversation:123", { id: 123, thread: 4 }), capabilities);
  const bridge = new HostBridge({
    socketPath,
    credentials,
    handlers: {
      send: async () => ({}),
      ...overrides,
    },
  });
  return { bridge, token, credentials };
}

function call(socketPath: string, token: string, type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "req-1", token, type, params })}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      const parsed = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: unknown; error?: string };
      if (parsed.ok) resolve(parsed.result as Record<string, unknown>);
      else reject(new Error(parsed.error));
    });
    socket.on("error", reject);
  });
}

describe("HostBridge", () => {
  it("does not recreate its socket when stopped during startup", async () => {
    const { socketPath } = await fixture();
    const { bridge } = makeBridge(socketPath);
    const starting = bridge.start();
    const stopping = bridge.stop();

    await expect(Promise.all([starting, stopping])).resolves.toEqual([undefined, undefined]);
    await expect(stat(socketPath)).rejects.toThrow();
  });
  it("waits for in-flight handlers before completing stop", async () => {
    const { socketPath } = await fixture();
    let release!: () => void;
    const work = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let completed = false;
    const send = vi.fn(async () => {
      markStarted();
      await work;
      completed = true;
      return {};
    });
    const { bridge, token } = makeBridge(socketPath, ["send"], { send });
    await bridge.start();
    const socket = net.connect(socketPath);
    socket.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          socket.write(`${JSON.stringify({ id: "req-1", token, type: "send", params: {} })}\n`);
          resolve();
        });
        socket.once("error", reject);
      });
      await started;

      let stopped = false;
      const stopping = bridge.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      release();
      await stopping;
      expect(completed).toBe(true);
    } finally {
      release();
      socket.destroy();
      await bridge.stop();
    }
  });

  it("bounds stop when an in-flight handler never settles", async () => {
    let rejectHandler!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const send = vi.fn(() => new Promise<Record<string, unknown>>((_, reject) => {
      markStarted();
      rejectHandler = reject;
    }));
    const { socketPath } = await fixture();
    const credentials = new AgentCredentials();
    const token = credentials.issue(conversationAgent("connector:test", "conversation:123", { id: 123 }), ["send"]);
    const bridge = new HostBridge({ socketPath, credentials, handlers: { send } });
    await bridge.start();
    const socket = net.connect(socketPath);
    socket.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          socket.write(`${JSON.stringify({ id: "req-1", token, type: "send", params: {} })}\n`);
          resolve();
        });
        socket.once("error", reject);
      });
      await started;
      vi.useFakeTimers();

      let stopped = false;
      const stopping = bridge.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);

      rejectHandler(new Error("late handler failure"));
      await Promise.resolve();
    } finally {
      rejectHandler?.(new Error("test cleanup"));
      socket.destroy();
      await bridge.stop();
      vi.useRealTimers();
    }
  });

  it("resolves authenticated actors before invoking handlers", async () => {
    const { socketPath } = await fixture();
    const send = vi.fn(async () => ({}));
    const { bridge, token } = makeBridge(socketPath, ["send"], { send });
    await bridge.start();
    try {
      await expect(call(socketPath, token, "send", { request: {} })).resolves.toEqual({});
      expect(send).toHaveBeenCalledWith({ request: {} }, conversationAgent("connector:test", "conversation:123", { id: 123, thread: 4 }));
    } finally {
      await bridge.stop();
    }
  });

  it("rejects unknown tokens and capabilities", async () => {
    const { socketPath } = await fixture();
    const { bridge, token } = makeBridge(socketPath, ["send"], { annotate: async () => ({}) });
    await bridge.start();
    try {
      await expect(call(socketPath, "unknown", "send")).rejects.toThrow("Unknown agent token");
      await expect(call(socketPath, token, "annotate")).rejects.toThrow("not allowed to call annotate");
    } finally {
      await bridge.stop();
    }
  });

  it("preserves UTF-8 split across socket chunks", async () => {
    const { socketPath } = await fixture();
    const { bridge, token } = makeBridge(socketPath, ["send"], { send: async (params) => ({ text: params.text }) });
    await bridge.start();
    try {
      const text = "hello 🙂";
      const payload = Buffer.from(`${JSON.stringify({ id: "req-utf8", token, type: "send", params: { text } })}\n`, "utf8");
      const emojiStart = payload.indexOf(Buffer.from("🙂", "utf8"));
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        const chunks: Buffer[] = [];
        socket.on("connect", () => {
          socket.write(payload.subarray(0, emojiStart + 1));
          setTimeout(() => socket.write(payload.subarray(emojiStart + 1)), 10);
        });
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const response = Buffer.concat(chunks);
          const newline = response.indexOf(0x0a);
          if (newline === -1) return;
          socket.destroy();
          const parsed = JSON.parse(response.subarray(0, newline).toString("utf8")) as { result: { text: string } };
          resolve(parsed.result.text);
        });
        socket.on("error", reject);
      });
      expect(echoed).toBe(text);
    } finally {
      await bridge.stop();
    }
  });

  it("reports handler failures and unknown request types", async () => {
    const { socketPath } = await fixture();
    const { bridge, token } = makeBridge(socketPath, ["annotate"], { annotate: async () => { throw new Error("description too large"); } });
    await bridge.start();
    try {
      await expect(call(socketPath, token, "annotate", { attachment: "/run/attachments/example", description: "x" })).rejects.toThrow("description too large");
      await expect(call(socketPath, token, "teleport")).rejects.toThrow("Unknown request type");
    } finally {
      await bridge.stop();
    }
  });

  it("rejects request types whose handlers are not exposed", async () => {
    const { socketPath } = await fixture();
    const credentials = new AgentCredentials();
    const token = credentials.issue(conversationAgent("connector:test", "conversation:123", { id: 123 }), ["send", "annotate"]);
    const bridge = new HostBridge({ socketPath, credentials, handlers: { send: async () => ({}) } });
    await bridge.start();
    try {
      await expect(call(socketPath, token, "send", { request: {} })).resolves.toEqual({});
      await expect(call(socketPath, token, "annotate", { attachment: "/run/attachments/example", description: "work" })).rejects.toThrow("Unknown request type: annotate");
    } finally {
      await bridge.stop();
    }
  });
});
