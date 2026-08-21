import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Host-tools extension: send/spawn/cancel tools that append one command record to the
 * shared /workspace/.tg-bot/system.jsonl log. The host tails that log, validates each
 * command, and performs the real work; the tool mints the UUID and returns it, so the
 * agent gets its correlation id in-context. PI_HOST_TOOLS selects which tools a run
 * exposes (chat runs: send,spawn,cancel; task runs: send).
 */

const SEND_SCHEMA = Type.Object({
  chat_id: Type.Number({ description: "The Telegram chat id to send to; must be on the allow list" }),
  type: Type.String({ description: "Request type: send_file, send_media_group, send_message, send_location, send_poll, stop_poll, send_reaction, edit_message, or delete_message" }),
  path: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  parse_mode: Type.Optional(Type.String()),
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

/** Appends one command line to system.jsonl; a single O_APPEND write, atomic across processes. */
function appendCommand(record: Record<string, unknown>): void {
  const line = `${JSON.stringify({ v: 1, t: new Date().toISOString(), ...record })}\n`;
  appendFileSync("/workspace/.tg-bot/system.jsonl", line, { encoding: "utf8", mode: 0o600 });
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
    description: "Queue one Telegram send: a message, file, media album, location, poll, reaction, edit, or delete. The host validates and delivers it; failures arrive as followup messages.",
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
    description: "Start a background task with a fresh Pi agent. Include the complete prompt; the result arrives as a followup message when the task settles.",
    parameters: Type.Object({ prompt: Type.String({ description: "The complete prompt for the task agent" }) }),
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
  cancel: {
    label: "Cancel background task",
    description: "Stop a running background task, identified by the runId the spawn tool returned.",
    parameters: Type.Object({ runId: Type.String({ description: "The task run UUID" }) }),
    execute: (params: { runId: string }): ToolResult => {
      try {
        appendCommand({ type: "cancel_request", runId: params.runId });
        return text(`Cancel requested for ${params.runId}; the host stops the task if it is still running.`);
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
