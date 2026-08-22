import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostBridge } from "../src/host-bridge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ socketPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-bridge-test-"));
  temporaryDirectories.push(root);
  return { socketPath: path.join(root, "run", "host.sock") };
}

function makeBridge(socketPath: string, overrides: Partial<ConstructorParameters<typeof HostBridge>[0]["handlers"]> = {}): HostBridge {
  return new HostBridge({
    socketPath,
    browserTimeoutMs: 500,
    handlers: {
      send: async () => ({}),
      spawn: async () => ({ status: "launched", runId: "run-1" }),
      cancel: async () => ({ status: "not-running" }),
      steerTask: async () => ({ status: "delivered" }),
      startBrowser: async () => ({ status: "started", socketPath: "/s", wsEndpoint: "ws+unix:///s" }),
      ...overrides,
    },
  });
}

function call(socketPath: string, type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "req-1", type, params })}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      const parsed = JSON.parse(buffer.slice(0, newline)) as { id: string; ok: boolean; result?: unknown; error?: string };
      if (parsed.ok) resolve(parsed.result as Record<string, unknown>);
      else reject(new Error(parsed.error));
    });
    socket.on("error", reject);
  });
}

describe("HostBridge", () => {
  it("answers requests with handler results over the socket", async () => {
    const { socketPath } = await fixture();
    const bridge = makeBridge(socketPath);
    await bridge.start();
    try {
      expect(await call(socketPath, "spawn", { prompt: "work" })).toEqual({ status: "launched", runId: "run-1" });
      expect(await call(socketPath, "cancel", { runId: "run-1" })).toEqual({ status: "not-running" });
    } finally {
      await bridge.stop();
    }
  });

  it("reports handler failures to the caller", async () => {
    const { socketPath } = await fixture();
    const bridge = makeBridge(socketPath, { spawn: async () => { throw new Error("prompt too large"); } });
    await bridge.start();
    try {
      await expect(call(socketPath, "spawn", { prompt: "x" })).rejects.toThrow("prompt too large");
    } finally {
      await bridge.stop();
    }
  });

  it("rejects unknown request types", async () => {
    const { socketPath } = await fixture();
    const bridge = makeBridge(socketPath);
    await bridge.start();
    try {
      await expect(call(socketPath, "teleport")).rejects.toThrow("Unknown request type");
    } finally {
      await bridge.stop();
    }
  });

  it("times out start_browser without cancelling the launch", async () => {
    const { socketPath } = await fixture();
    let settled = false;
    const bridge = makeBridge(socketPath, {
      startBrowser: async () => {
        await new Promise((resolve) => setTimeout(() => { settled = true; resolve(undefined); }, 1200));
        return { status: "started", socketPath: "/s", wsEndpoint: "ws+unix:///s" };
      },
    });
    await bridge.start();
    try {
      await expect(call(socketPath, "start_browser")).rejects.toThrow("timed out after 500ms");
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      await bridge.stop();
    }
  });

  it("restarts cleanly over a stale socket file", async () => {
    const { socketPath } = await fixture();
    const first = makeBridge(socketPath);
    await first.start();
    await first.stop();
    const second = makeBridge(socketPath);
    await second.start();
    try {
      expect(await call(socketPath, "steer_task", { runId: "run-1", message: "hi" })).toEqual({ status: "delivered" });
    } finally {
      await second.stop();
    }
  });
});