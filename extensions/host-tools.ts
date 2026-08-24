import net from "node:net";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Host-tools extension: authenticated tools that synchronously call the host over
 * the bridge socket mounted at PI_HOST_SOCKET. PI_HOST_TOOLS selects the tools a
 * run exposes; conversation runs receive messaging, task, steering, and schedule
 * tools while background task runs receive annotate only.
 */

const SEND_SCHEMA = Type.Object({
  method: Type.String({ description: "Telegram Bot API method name, such as sendMessage, sendDocument, or editMessageText" }),
  topic_name: Type.Optional(Type.String({ description: "Host convenience for sendMessage: rename this topic after delivery" })),
}, { additionalProperties: true });
const RECURRENCE_SCHEMA = Type.Union([
  Type.Literal("hourly"),
  Type.Literal("daily"),
  Type.Literal("weekly"),
  Type.Null(),
]);

const SCHEDULE_FIELDS = {
  prompt: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "Complete instruction delivered to the owning conversation when due" }),
  start: Type.String({ description: "First run as a UTC ISO-8601 timestamp ending in Z" }),
  recurrence: RECURRENCE_SCHEMA,
};
const TASK_FIELDS = {
  prompt: Type.String({ minLength: 1, description: "Complete instruction for the background task agent" }),
  model: Type.Optional(Type.String({ minLength: 1, description: "Exact provider/model ID for this run" })),
  thinking: Type.Optional(Type.String({ minLength: 1, description: "Thinking level for this run" })),
};
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, never> };

const DEFAULT_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 5 * 60_000;

function text(content: string): ToolResult {
  return { content: [{ type: "text", text: content }], details: {} };
}

function failure(error: unknown): ToolResult {
  return text(`FAILED: ${String(error)}. The host may have completed a timed-out or disconnected call; check /run/timeline.jsonl, /run/schedules.json, and /run/tasks.json as applicable before retrying.`);
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
    description: "Call an allowed Telegram Bot API method in this agent's owning chat and thread. Omit chat_id and message_thread_id; the host derives both from the authenticated session.",
    parameters: SEND_SCHEMA,
    execute: async (request: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const result = await callHost("send", { request }, SEND_TIMEOUT_MS);
        const method = typeof result.method === "string" ? result.method : "Telegram request";
        const messageId = typeof result.messageId === "number" ? ` (message_id ${result.messageId})` : "";
        const attachments = Array.isArray(result.attachments)
          ? result.attachments.filter((value): value is string => typeof value === "string").map((value) => `\nAttachment: ${value}`).join("")
          : "";
        return text(`${method} succeeded${messageId}.${attachments}`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  annotate: {
    label: "Annotate timeline attachment",
    description: "Retroactively add or replace a short, searchable description beside a sent or received attachment in /run/timeline.jsonl.",
    parameters: Type.Object({
      attachment: Type.String({ description: "Exact /run/attachments/... path recorded in the timeline" }),
      description: Type.String({ minLength: 1, maxLength: 500, description: "Short factual description of the attachment's content" }),
    }),
    execute: async (params: { attachment: string; description: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("annotate", params);
        const occurrences = typeof result.occurrences === "number" ? result.occurrences : 1;
        return text(`Annotated ${occurrences} timeline occurrence${occurrences === 1 ? "" : "s"} of ${params.attachment}.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  spawn: {
    label: "Spawn background task",
    description: "Start a background task from a complete prompt, with optional model and thinking overrides. Returns its runId and whether it started or queued; task_finished follows up when it settles.",
    parameters: Type.Object(TASK_FIELDS),
    execute: async (params: { prompt: string; model?: string; thinking?: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("spawn", params);
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
  continue_task: {
    label: "Continue background task",
    description: "Resume an owned settled task in its existing session with an additional prompt and optional model and thinking overrides.",
    parameters: Type.Object({ runId: Type.String({ minLength: 1, description: "Task run UUID" }), ...TASK_FIELDS }),
    execute: async (params: { runId: string; prompt: string; model?: string; thinking?: string }): Promise<ToolResult> => {
      try {
        const result = await callHost("continue_task", params);
        if (result.status === "queued") return text(`Queued continuation of task ${params.runId}; it will resume when a task slot is free.`);
        return text(`Continued task ${params.runId} in its existing session.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  schedule_add: {
    label: "Add schedule",
    description: "Create a host-managed schedule owned by this conversation. Inspect all current schedules in /run/schedules.json.",
    parameters: Type.Object(SCHEDULE_FIELDS),
    execute: async (params: { prompt: string; start: string; recurrence: "hourly" | "daily" | "weekly" | null }): Promise<ToolResult> => {
      try {
        const result = await callHost("schedule_add", params);
        const schedule = result.schedule;
        const id = schedule !== null && typeof schedule === "object" && !Array.isArray(schedule) && typeof (schedule as Record<string, unknown>).id === "string"
          ? (schedule as Record<string, unknown>).id as string
          : "unknown";
        return text(`Created schedule ${id}. Current state: /run/schedules.json.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  schedule_replace: {
    label: "Replace schedule",
    description: "Fully replace an owned schedule. A changed start resets its next due time; other changes preserve the pending occurrence.",
    parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Schedule ID from /run/schedules.json" }), ...SCHEDULE_FIELDS }),
    execute: async (params: { id: string; prompt: string; start: string; recurrence: "hourly" | "daily" | "weekly" | null }): Promise<ToolResult> => {
      try {
        await callHost("schedule_replace", params);
        return text(`Replaced schedule ${params.id}. Current state: /run/schedules.json.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  schedule_remove: {
    label: "Remove schedule",
    description: "Permanently remove a schedule owned by this conversation.",
    parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Schedule ID from /run/schedules.json" }) }),
    execute: async (params: { id: string }): Promise<ToolResult> => {
      try {
        await callHost("schedule_remove", params);
        return text(`Removed schedule ${params.id}.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  schedule_take: {
    label: "Take schedule",
    description: "Make this conversation the owner of any existing schedule without changing its timing.",
    parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Schedule ID from /run/schedules.json" }) }),
    execute: async (params: { id: string }): Promise<ToolResult> => {
      try {
        await callHost("schedule_take", params);
        return text(`This conversation now owns schedule ${params.id}. Current state: /run/schedules.json.`);
      } catch (error) {
        return failure(error);
      }
    },
  },
  steer_conversation: {
    label: "Steer conversation agent",
    description: "Wake another allowed conversation agent and give it an instruction. This does not send a Telegram message.",
    parameters: Type.Object({
      chat_id: Type.Number({ description: "Owning chat ID of the conversation agent to wake" }),
      message_thread_id: Type.Optional(Type.Number({ description: "Owning topic ID; defaults to 0" })),
      message: Type.String({ minLength: 1, description: "Instruction for the target conversation agent" }),
    }),
    execute: async (params: { chat_id: number; message_thread_id?: number; message: string }): Promise<ToolResult> => {
      try {
        await callHost("steer_conversation", params);
        return text(`Steering delivered to conversation ${params.chat_id}:${params.message_thread_id ?? 0}.`);
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
