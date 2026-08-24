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

it("manages schedules through the authenticated host bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-tools-test-"));
  const socketPath = path.join(root, "host.sock");
  const scheduleAdd = vi.fn(async () => ({ schedule: { id: "schedule-1" } }));
  const scheduleReplace = vi.fn(async () => ({ schedule: { id: "schedule-1" } }));
  const scheduleRemove = vi.fn(async () => ({ id: "schedule-1" }));
  const scheduleTake = vi.fn(async () => ({ schedule: { id: "schedule-1" } }));
  const credentials = new AgentCredentials();
  const actor = conversationAgent(42, 7);
  const token = credentials.issue(actor, ["schedule"]);
  const bridge = new HostBridge({ socketPath, credentials, handlers: { scheduleAdd, scheduleReplace, scheduleRemove, scheduleTake } });
  await bridge.start();
  vi.stubEnv("PI_HOST_SOCKET", socketPath);
  vi.stubEnv("PI_AGENT_TOKEN", token);
  vi.stubEnv("PI_HOST_TOOLS", "schedule_add,schedule_replace,schedule_remove,schedule_take");
  try {
    const registered = new Map<string, RegisteredTool>();
    hostTools({ registerTool: (tool: RegisteredTool) => registered.set(tool.name, tool) } as never);
    const definition = { prompt: "Prepare report", start: "2026-08-25T09:00:00.000Z", recurrence: "daily" };

    await expect(registered.get("schedule_add")?.execute("tool-add", definition)).resolves.toMatchObject({
      content: [{ text: "Created schedule schedule-1. Current state: /run/schedules.json." }],
    });
    await expect(registered.get("schedule_replace")?.execute("tool-replace", { id: "schedule-1", ...definition })).resolves.toMatchObject({
      content: [{ text: "Replaced schedule schedule-1. Current state: /run/schedules.json." }],
    });
    await expect(registered.get("schedule_take")?.execute("tool-take", { id: "schedule-1" })).resolves.toMatchObject({
      content: [{ text: "This conversation now owns schedule schedule-1. Current state: /run/schedules.json." }],
    });
    await expect(registered.get("schedule_remove")?.execute("tool-remove", { id: "schedule-1" })).resolves.toMatchObject({
      content: [{ text: "Removed schedule schedule-1." }],
    });
    expect(scheduleAdd).toHaveBeenCalledWith(definition, actor);
    expect(scheduleReplace).toHaveBeenCalledWith({ id: "schedule-1", ...definition }, actor);
    expect(scheduleTake).toHaveBeenCalledWith({ id: "schedule-1" }, actor);
    expect(scheduleRemove).toHaveBeenCalledWith({ id: "schedule-1" }, actor);
  } finally {
    vi.unstubAllEnvs();
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});