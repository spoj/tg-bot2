import net from "node:net";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Host-tools extension: send/spawn/steer_task/cancel tools that call
 * the host synchronously over the bridge socket mounted at PI_HOST_SOCKET. The host
 * authenticates PI_AGENT_TOKEN, validates each request, executes it, and returns the
 * result directly. PI_HOST_TOOLS selects which tools a run exposes (chat runs:
 * send,spawn,steer_task,cancel; task runs: send).
 */

const SEND_SCHEMA = Type.Object({
  method: Type.String({ description: "Telegram Bot API method name, such as sendMessage, sendDocument, or editMessageText" }),
  chat_id: Type.Optional(Type.Number({ description: "Telegram chat ID; defaults to the current chat for conversation agents" })),
  message_thread_id: Type.Optional(Type.Number({ description: "Telegram topic ID; defaults to the current topic for conversation agents" })),
  topic_name: Type.Optional(Type.String({ description: "Host convenience for sendMessage: rename this topic after delivery" })),
}, { additionalProperties: true });

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, never> };

const DEFAULT_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 5 * 60_000;

function text(content: string): ToolResult {
  return { content: [{ type: "text", text: content }], details: {} };
}

function failure(error: unknown): ToolResult {
  return text(`FAILED: ${String(error)}. The host may have completed a timed-out or disconnected call; check /run/timeline.jsonl before retrying.`);
}

/** Sends one request line to the host bridge and resolves with the response result. */
function callHost(type: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.PI_HOST_SOCKET;
    const token = process.env.PI_AGENT_TOKEN;
    if (!socketPath || socketPath.length === 0) {
      reject(new Error("PI_HOST_SOCKET is not set"));
      return;
    }
    if (!token || token.length === 0) {
      reject(new Error("PI_AGENT_TOKEN is not set"));
      return;
    }
    const socket = net.connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Host call ${type} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: randomUUID(), token, type, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      clearTimeout(timer);
      socket.destroy();
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        reject(new Error(`Host returned an invalid response for ${type}`));
        return;
      }
      if (response === null || typeof response !== "object" || Array.isArray(response)) {
        reject(new Error(`Host returned an invalid response for ${type}`));
        return;
      }
      const typed = response as Record<string, unknown>;
      if (typed.ok === true && typed.result !== null && typeof typed.result === "object" && !Array.isArray(typed.result)) {
        resolve(typed.result as Record<string, unknown>);
      } else {
        reject(new Error(typeof typed.error === "string" && typed.error.length > 0 ? typed.error : `Host rejected ${type}`));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Host connection failed: ${String(error)}`));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`Host closed the connection during ${type}`));
    });
  });
}


const HOST_TOOLS = {
  send: {
    label: "Send Telegram message",
    description: "Call an allowed Telegram Bot API method with its documented snake_case payload. Fields pass through unchanged; /workspace media paths are copied to host-managed attachments before upload.",
    parameters: SEND_SCHEMA,
    execute: async (request: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const result = await callHost("send", { request }, SEND_TIMEOUT_MS);
        const method = typeof result.method === "string" ? result.method : "Telegram request";
        const messageId = typeof result.messageId === "number" ? ` (message_id ${result.messageId})` : "";
        return text(`${method} succeeded${messageId}.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  spawn: {
    label: "Spawn background task",
    description: "Start a background task from a complete, self-contained prompt. Returns its runId and whether it started or queued; task_finished follows up when it settles.",
    parameters: Type.Object({ prompt: Type.String({ description: "The complete prompt with all instructions and context for the background task agent" }) }),
    execute: async (params: { prompt: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("spawn", { prompt: params.prompt });
        const runId = typeof result.runId === "string" ? result.runId : "unknown";
        if (result.status === "queued") {
          return text(`Queued background task ${runId} (all task slots busy); it will start automatically. The result arrives as a followup message when it settles; cancel it anytime with the cancel tool.`);
        }
        return text(`Launched background task ${runId}. The result arrives as a followup message when it settles; cancel it anytime with the cancel tool.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  steer_task: {
    label: "Steer background task",
    description: "Guide a running background task between tool calls. Returns whether the task was running.",
    parameters: Type.Object({
      runId: Type.String({ description: "The task run UUID returned by the spawn tool" }),
      message: Type.String({ description: "Steering instruction or clarification to inject into the task agent" }),
    }),
    execute: async (params: { runId: string; message: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("steer_task", { runId: params.runId, message: params.message });
        return result.status === "delivered"
          ? text(`Steering delivered to task ${params.runId}.`)
          : text(`Task ${params.runId} is not running (settled, queued, or unknown); steering was not delivered.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  cancel: {
    label: "Cancel background task",
    description: "Stop a running task or remove a queued task by runId. Returns what happened.",
    parameters: Type.Object({ runId: Type.String({ description: "The task run UUID returned by the spawn tool" }) }),
    execute: async (params: { runId: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("cancel", { runId: params.runId });
        if (result.status === "stopped") return text(`Task ${params.runId} is stopping; its settle followup will arrive with aborted status.`);
        if (result.status === "cancelled-queued") return text(`Queued task ${params.runId} was cancelled before it started.`);
        return text(`Task ${params.runId} is not running (settled or unknown); nothing to cancel.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
} as const;

export default function hostTools(pi: ExtensionAPI): void {
  const enabled = new Set((process.env.PI_HOST_TOOLS ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0));
  for (const [name, tool] of Object.entries(HOST_TOOLS)) {
    if (!enabled.has(name)) continue;
    pi.registerTool({
      name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params) {
        return tool.execute(params as never);
      },
    });
  }
}
