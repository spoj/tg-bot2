import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Host-tools extension: send/spawn/cancel/start_browser tools that append one command record
 * to the shared /workspace/.tg-bot/events.jsonl log. The host tails that log, validates each
 * command, and performs the real work; the tool mints the UUID and returns it, so the
 * agent gets its correlation id in-context. PI_HOST_TOOLS selects which tools a run
 * exposes (chat runs: send,spawn,cancel,start_browser; task runs: send,start_browser).
 */

const SEND_SCHEMA = Type.Object({
  chat_id: Type.Number({ description: "The Telegram chat id to send to (from incoming events or allowed list); direct assistant text is not delivered to Telegram" }),
  message_thread_id: Type.Optional(Type.Number({ description: "Optional Telegram forum topic or message thread ID to send this message into" })),
  type: Type.String({ description: "Request type: send_message, send_file, send_media_group, send_location, send_poll, stop_poll, send_reaction, edit_message, or delete_message" }),
  path: Type.Optional(Type.String({ description: "Workspace file path for send_file (relative or /workspace/...)" })),
  caption: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  text: Type.Optional(Type.String({ description: "Message text for send_message or edit_message" })),
  parse_mode: Type.Optional(Type.String({ description: "Optional formatting: 'HTML' or 'MarkdownV2' (omit for plain text)" })),
  entities: Type.Optional(Type.Array(Type.Any())),
  link_preview_options: Type.Optional(Type.Any()),
  reply_markup: Type.Optional(Type.Any()),
  reply_to_message_id: Type.Optional(Type.Number()),
  disable_notification: Type.Optional(Type.Boolean()),
  media: Type.Optional(Type.Array(Type.Any())),
  latitude: Type.Optional(Type.Number()),
  longitude: Type.Optional(Type.Number()),
  horizontal_accuracy: Type.Optional(Type.Number()),
  heading: Type.Optional(Type.Number()),
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
}, { additionalProperties: true });

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, never> };

/** Appends one command line to events.jsonl; a single O_APPEND write, atomic across processes. */
function appendCommand(record: Record<string, unknown>): void {
  const line = `${JSON.stringify({ v: 1, t: new Date().toISOString(), ...record })}\n`;
  fs.appendFileSync("/workspace/.tg-bot/events.jsonl", line, { encoding: "utf8", mode: 0o600 });
}

function text(content: string): ToolResult {
  return { content: [{ type: "text", text: content }], details: {} };
}

function failure(error: unknown): ToolResult {
  return text(`FAILED to queue the request: ${String(error)}. Nothing was sent; retry if needed.`);
}

const HOST_TOOLS = {
  send: {
    label: "Send Telegram message",
    description: "Send a message, file, media album, location, poll, reaction, edit, or delete to a Telegram chat. You MUST use this tool to communicate with users on Telegram — direct assistant text output is not delivered to Telegram chats. The host validates and delivers it; failures arrive as followup messages.",
    parameters: SEND_SCHEMA,
    execute: (request: Record<string, unknown>): ToolResult => {
      const requestId = randomUUID();
      try {
        appendCommand({ type: "send_request", requestId, request });
        return text(`Queued for Telegram delivery as ${requestId}. Failures are reported to you as followup messages.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  spawn: {
    label: "Spawn background task",
    description: "Start an autonomous background task with a fresh Pi agent in the workspace. Pass a complete self-contained prompt. The result arrives as a followup message when the task settles; cancel it anytime with the cancel tool.",
    parameters: Type.Object({ prompt: Type.String({ description: "The complete prompt with all instructions and context for the background task agent" }) }),
    execute: (params: { prompt: string }): ToolResult => {
      const runId = randomUUID();
      try {
        appendCommand({ type: "spawn_request", runId, prompt: params.prompt });
        return text(`Queued as background task ${runId}. The result arrives as a followup message when it settles; cancel it anytime with the cancel tool.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  steer_task: {
    label: "Steer background task",
    description: "Send mid-flight steering instructions to a running background task. The task agent receives your guidance between tool calls without restarting.",
    parameters: Type.Object({
      runId: Type.String({ description: "The task run UUID returned by the spawn tool" }),
      message: Type.String({ description: "Steering instruction or clarification to inject into the task agent" }),
    }),
    execute: (params: { runId: string; message: string }): ToolResult => {
      const steerId = randomUUID();
      try {
        appendCommand({ type: "steer_task_request", steerId, runId: params.runId, message: params.message });
        return text(`Steering instruction sent to task ${params.runId}.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  cancel: {
    label: "Cancel background task",
    description: "Stop a running background task by the runId returned by the spawn tool. The task is aborted and its settle followup arrives with aborted status.",
    parameters: Type.Object({ runId: Type.String({ description: "The task run UUID returned by the spawn tool" }) }),
    execute: (params: { runId: string }): ToolResult => {
      try {
        appendCommand({ type: "cancel_request", runId: params.runId });
        return text(`Cancel requested for ${params.runId}; the host stops the task if it is still running.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  start_browser: {
    label: "Start browser",
    description: "Request a headless Chrome browser instance. The host launches Chrome with pipe transport and proxies it to a workspace UNIX domain socket (/workspace/.browser/cdp.sock), then emits a browser_ready event with the connection handle.",
    parameters: Type.Object({}),
    execute: (): ToolResult => {
      const requestId = randomUUID();
      try {
        appendCommand({ type: "browser_requested", requestId });
        return text(`Browser requested (ID: ${requestId}). A browser_ready event will arrive once Chrome and the socket proxy are ready.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  new_session: {
    label: "Start new session",
    description: "Reset your conversational context so your next interaction starts fresh in a new session. Your current turn will complete normally, after which the host stops the worker process immediately.",
    parameters: Type.Object({}),
    execute: (): ToolResult => {
      try {
        appendCommand({ type: "new_session_request" });
        return text("New session requested. Your current turn will complete, and the next user message will start in a fresh session.");
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
