import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import hostTools from "../extensions/host-tools.js";
import { conversationAgent } from "../src/agent-ref.js";
import { AgentCredentials, HostBridge } from "../src/host-bridge.js";
import { deferred } from "./helpers.js";


type RegisteredTool = {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
};

it("keeps send calls open through the outbox retry window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-tools-test-"));
  const socketPath = path.join(root, "host.sock");
  const handlerStarted = deferred<void>();
  const response = deferred<Record<string, unknown>>();
  const credentials = new AgentCredentials();
  const token = credentials.issue(conversationAgent(42), ["send"]);
  const bridge = new HostBridge({
    socketPath,
    credentials,
    handlers: {
      send: async () => {
        handlerStarted.resolve();
        return response.promise;
      },
    },
  });
  await bridge.start();
  vi.useFakeTimers();
  vi.stubEnv("PI_HOST_SOCKET", socketPath);
  vi.stubEnv("PI_AGENT_TOKEN", token);
  vi.stubEnv("PI_HOST_TOOLS", "send");
  try {
    let sendTool: RegisteredTool | undefined;
    hostTools({
      registerTool: (tool: RegisteredTool) => {
        if (tool.name === "send") sendTool = tool;
      },
    } as never);
    if (!sendTool) throw new Error("send tool was not registered");

    const pending = sendTool.execute("tool-1", { method: "sendMessage", chat_id: 42, text: "hello" });
    await handlerStarted.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    response.resolve({ method: "sendMessage" });

    await expect(pending).resolves.toMatchObject({ content: [{ text: "sendMessage succeeded." }] });
  } finally {
    response.resolve({ method: "sendMessage" });
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});