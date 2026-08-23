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
  const attachment = "/run/attachments/42/2026-08-23/request/report.pdf";
  try {
    let sendTool: RegisteredTool | undefined;
    hostTools({
      registerTool: (tool: RegisteredTool) => {
        if (tool.name === "send") sendTool = tool;
      },
    } as never);
    if (!sendTool) throw new Error("send tool was not registered");

    const pending = sendTool.execute("tool-1", { method: "sendDocument", chat_id: 42, document: "/workspace/report.pdf" });
    await handlerStarted.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    response.resolve({ method: "sendDocument", attachments: [attachment] });

    await expect(pending).resolves.toMatchObject({ content: [{ text: `sendDocument succeeded.\nAttachment: ${attachment}` }] });
  } finally {
    response.resolve({ method: "sendDocument", attachments: [attachment] });
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("retroactively annotates an attachment through the host bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-tools-test-"));
  const socketPath = path.join(root, "host.sock");
  const annotate = vi.fn(async () => ({ occurrences: 2 }));
  const credentials = new AgentCredentials();
  const token = credentials.issue(conversationAgent(42), ["annotate"]);
  const bridge = new HostBridge({ socketPath, credentials, handlers: { annotate } });
  await bridge.start();
  vi.stubEnv("PI_HOST_SOCKET", socketPath);
  vi.stubEnv("PI_AGENT_TOKEN", token);
  vi.stubEnv("PI_HOST_TOOLS", "annotate");
  try {
    let annotateTool: RegisteredTool | undefined;
    hostTools({
      registerTool: (tool: RegisteredTool) => {
        if (tool.name === "annotate") annotateTool = tool;
      },
    } as never);
    if (!annotateTool) throw new Error("annotate tool was not registered");

    const params = {
      attachment: "/run/attachments/42/2026-08-23/1/voice.ogg",
      description: "Voice note asking about deployment logs",
    };
    await expect(annotateTool.execute("tool-2", params)).resolves.toMatchObject({
      content: [{ text: `Annotated 2 timeline occurrences of ${params.attachment}.` }],
    });
    expect(annotate).toHaveBeenCalledWith(params, conversationAgent(42));
  } finally {
    vi.unstubAllEnvs();
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("steers another conversation through the host bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-tools-test-"));
  const socketPath = path.join(root, "host.sock");
  const steerConversation = vi.fn(async () => ({ status: "delivered" }));
  const credentials = new AgentCredentials();
  const token = credentials.issue(conversationAgent(42, 7), ["steer_conversation"]);
  const bridge = new HostBridge({ socketPath, credentials, handlers: { steerConversation } });
  await bridge.start();
  vi.stubEnv("PI_HOST_SOCKET", socketPath);
  vi.stubEnv("PI_AGENT_TOKEN", token);
  vi.stubEnv("PI_HOST_TOOLS", "steer_conversation");
  try {
    let steerTool: RegisteredTool | undefined;
    hostTools({
      registerTool: (tool: RegisteredTool) => {
        if (tool.name === "steer_conversation") steerTool = tool;
      },
    } as never);
    if (!steerTool) throw new Error("steer_conversation tool was not registered");
    const params = { chat_id: 99, message_thread_id: 3, message: "Handle timeline message 120" };
    await expect(steerTool.execute("tool-3", params)).resolves.toMatchObject({
      content: [{ text: "Steering delivered to conversation 99:3." }],
    });
    expect(steerConversation).toHaveBeenCalledWith(params, conversationAgent(42, 7));
  } finally {
    vi.unstubAllEnvs();
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});