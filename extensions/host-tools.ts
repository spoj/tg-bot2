import net from "node:net";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Host-tools extension: send/spawn/steer_task/cancel/start_browser tools that call
 * the host synchronously over the bridge socket mounted at PI_HOST_SOCKET. The host
 * validates, executes, and records outcomes in its own events log; each tool returns
 * the host's result directly. PI_HOST_TOOLS selects which tools a run exposes
 * (chat runs: send,spawn,steer_task,cancel,start_browser; task runs: send,start_browser).
 */

const SEND_SCHEMA = Type.Object({
  chat_id: Type.Optional(Type.Number({ description: "Target Telegram chat ID (defaults to current chat for chat agents)" })),
  message_thread_id: Type.Optional(Type.Number({ description: "Optional Telegram forum topic or message thread ID (defaults to current topic for chat agents)" })),
  type: Type.String({ description: "Request type: send_message, send_file, send_media_group, send_location, send_poll, stop_poll, send_reaction, edit_message, delete_message, create_forum_topic, edit_forum_topic, close_forum_topic, reopen_forum_topic, or delete_forum_topic" }),
  path: Type.Optional(Type.String({ description: "Workspace file path for send_file (relative or /workspace/...)" })),
  caption: Type.Optional(Type.String({ description: "Optional caption for send_file" })),
  kind: Type.Optional(Type.String({ description: "File kind for send_file: auto, photo, audio, video, voice, or document" })),
  text: Type.Optional(Type.String({ description: "Message text for send_message or edit_message" })),
  parse_mode: Type.Optional(Type.String({ description: "Formatting parse mode: prefer 'HTML' (supports <b>, <i>, <code>, <pre>, <blockquote>, <u>, <s>, <a>, bullet points •) or 'MarkdownV2'" })),
  entities: Type.Optional(Type.Array(Type.Any())),
  link_preview_options: Type.Optional(Type.Any()),
  reply_markup: Type.Optional(Type.Any()),
  reply_to_message_id: Type.Optional(Type.Number()),
  disable_notification: Type.Optional(Type.Boolean()),
  media: Type.Optional(Type.Array(Type.Any())),
  latitude: Type.Optional(Type.Number()),
  longitude: Type.Optional(Type.Number()),
  horizontal_accuracy: Type.Optional(Type.Number()),
  live_period: Type.Optional(Type.Number()),
  venue: Type.Optional(Type.Any()),
  question: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  is_anonymous: Type.Optional(Type.Boolean()),
  allows_multiple_answers: Type.Optional(Type.Boolean()),
  poll_type: Type.Optional(Type.String()),
  correct_option_id: Type.Optional(Type.Number()),
  message_id: Type.Optional(Type.Number()),
  reaction: Type.Optional(Type.Array(Type.Any())),
  name: Type.Optional(Type.String({ description: "Topic name for create_forum_topic or edit_forum_topic" })),
  icon_color: Type.Optional(Type.Number({ description: "Color of the topic icon (RGB integer) for create_forum_topic" })),
  icon_custom_emoji_id: Type.Optional(Type.String({ description: "Unique identifier of the custom emoji shown as the topic icon" })),
}, { additionalProperties: true });

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, never> };

const DEFAULT_TIMEOUT_MS = 30_000;
const BROWSER_TIMEOUT_MS = 25_000;

function text(content: string): ToolResult {
  return { content: [{ type: "text", text: content }], details: {} };
}

function failure(error: unknown): ToolResult {
  return text(`FAILED: ${String(error)}. Nothing was executed by the host; retry if needed.`);
}

/** Sends one request line to the host bridge and resolves with the response result. */
function callHost(type: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.PI_HOST_SOCKET;
    if (!socketPath || socketPath.length === 0) {
      reject(new Error("PI_HOST_SOCKET is not set"));
      return;
    }
    const socket = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Host call ${type} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: randomUUID(), type, params })}\n`);
    });
    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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

function getChatOrigin(): { chatId: number; threadId?: number } | undefined {
  const origin = process.env.PI_AGENT_ORIGIN;
  if (!origin || origin.startsWith("task:") || origin === "default") return undefined;
  const [chatStr, threadStr] = origin.split(":");
  const chatId = Number(chatStr);
  const threadId = Number(threadStr);
  if (!Number.isSafeInteger(chatId)) return undefined;
  return {
    chatId,
    ...(Number.isSafeInteger(threadId) && threadId > 0 ? { threadId } : {}),
  };
}

function originParam(): Record<string, unknown> {
  const origin = process.env.PI_AGENT_ORIGIN;
  return origin ? { origin } : {};
}

const HOST_TOOLS = {
  send: {
    label: "Send Telegram message",
    description: "Send a message, file, media album, location, poll, reaction, edit, or delete to a Telegram chat. Executes synchronously: the host validates, delivers to Telegram, and returns the outcome (messageId/pollId or the failure detail) in the tool result.",
    parameters: SEND_SCHEMA,
    execute: async (request: Record<string, unknown>): Promise<ToolResult> => {
      const chatOrigin = getChatOrigin();
      const rawChatId = request.chat_id;
      let targetChatId: number | undefined;
      let targetThreadId: number | undefined;

      if (typeof rawChatId === "number" && Number.isSafeInteger(rawChatId)) {
        targetChatId = rawChatId;
        if (typeof request.message_thread_id === "number" && Number.isSafeInteger(request.message_thread_id)) {
          targetThreadId = request.message_thread_id;
        }
      } else if (chatOrigin !== undefined) {
        targetChatId = chatOrigin.chatId;
        targetThreadId = typeof request.message_thread_id === "number" && Number.isSafeInteger(request.message_thread_id)
          ? request.message_thread_id
          : chatOrigin.threadId;
      } else {
        return text("FAILED: chat_id is required when calling send from a background task or without an active chat session.");
      }

      const finalRequest: Record<string, unknown> = {
        ...request,
        chat_id: targetChatId,
        ...(targetThreadId !== undefined ? { message_thread_id: targetThreadId } : {}),
      };
      try {
        const result = await callHost("send", { request: finalRequest, ...originParam() });
        const messageId = typeof result.messageId === "number" ? ` (messageId ${result.messageId})` : "";
        return text(`Sent ${result.request_type ?? "request"}${messageId}.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  spawn: {
    label: "Spawn background task",
    description: "Start an autonomous background task with a fresh Pi agent in the workspace. Pass a complete self-contained prompt. Executes synchronously: the host mints the runId and launches the task immediately (or queues it when all 8 slots are busy; queued tasks start automatically as slots free). The result arrives as a followup message when the task settles; cancel it anytime with the cancel tool.",
    parameters: Type.Object({ prompt: Type.String({ description: "The complete prompt with all instructions and context for the background task agent" }) }),
    execute: async (params: { prompt: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("spawn", { prompt: params.prompt, ...originParam() });
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
    description: "Send mid-flight steering instructions to a running background task. The task agent receives your guidance between tool calls without restarting. Reports synchronously whether the task was running.",
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
    description: "Stop a running background task by the runId returned by the spawn tool, or remove a queued task before it starts. Reports synchronously what happened; a stopped task's settle followup arrives with aborted status.",
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
  start_browser: {
    label: "Start browser",
    description: "Request a headless Chrome browser instance. Blocks until Chrome and the socket bridge are ready, then returns the connection handle in the tool result. Write a puppeteer-core script that connects via ws+unix:///workspace/.browser/cdp.sock (import puppeteer from 'puppeteer-core'). The browser is shared across sessions, so end every script with one of: (1) release the tab — await page.close(); await browser.disconnect(); or (2) keep the page state and stop the script — await browser.disconnect(); process.exit(0). NEVER call browser.close(), which kills the shared Chrome and every session's tabs; disconnecting with a live page still attached (no page.close, no process.exit) leaks the tab in the shared browser.",
    parameters: Type.Object({}),
    execute: async (): Promise<ToolResult> => {
      try {
        const result = await callHost("start_browser", { ...originParam() }, BROWSER_TIMEOUT_MS);
        const wsEndpoint = typeof result.wsEndpoint === "string" ? result.wsEndpoint : "unknown";
        const socketPath = typeof result.socketPath === "string" ? result.socketPath : "unknown";
        return text(`Browser is ready (${result.status === "existing" ? "reused existing" : "started"}). CDP endpoint: ${wsEndpoint} (socket: ${socketPath})`);
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
