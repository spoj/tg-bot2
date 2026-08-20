import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Host-tools extension: registers no-op send/spawn/cancel tools whose calls the
 * host consumes from the session file. The harness records every tool call in the
 * session log regardless of what execute does; the in-sandbox result text is the
 * agent's ack while the host performs the real work. PI_HOST_TOOLS selects which
 * tools a run exposes (chat runs: send,spawn,cancel; task runs: send).
 */

const SEND_SCHEMA = Type.Object({
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

const HOST_TOOLS = {
  send: {
    label: "Send Telegram message",
    description: "Queue one Telegram send: a message, file, media album, location, poll, reaction, edit, or delete. The host validates and delivers it; failures arrive as followup messages.",
    parameters: SEND_SCHEMA,
    result: "Queued for Telegram delivery. Failures are reported to you as followup messages.",
  },
  spawn: {
    label: "Spawn background task",
    description: "Start a background task with a fresh Pi agent. Include the complete prompt; the result arrives as a followup message when the task settles.",
    parameters: Type.Object({ prompt: Type.String({ description: "The complete prompt for the task agent" }) }),
    result: "Queued as a background task. The result arrives as a followup message when it settles.",
  },
  cancel: {
    label: "Cancel background task",
    description: "Stop a running background task, identified by the runId from its task_claimed event in .tg-bot/system.jsonl.",
    parameters: Type.Object({ runId: Type.String({ description: "The task run UUID" }) }),
    result: "Cancel requested; the host stops the task if it is still running.",
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
      async execute() {
        return { content: [{ type: "text", text: tool.result }], details: {} };
      },
    });
  }
}
