import net from "node:net";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Authenticated connector, timeline, steering, and schedule tools that call the
 * host synchronously over PI_HOST_SOCKET. PI_HOST_TOOLS selects exposed tools.
 */

const SEND_SCHEMA = Type.Object({}, { additionalProperties: true });
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
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

const DEFAULT_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 5 * 60_000;

function text(content: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: content }], details };
}

function failure(error: unknown): ToolResult {
  return text(`FAILED: ${String(error)}. The host may have completed a timed-out or disconnected call; check /run/timeline.jsonl and /run/schedules.json as applicable before retrying.`);
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
    label: "Send through connector",
    description: "Execute one connector-native request in this agent's owning conversation. The host derives the destination from the authenticated session.",
    parameters: SEND_SCHEMA,
    execute: async (request: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const result = await callHost("send", { request }, SEND_TIMEOUT_MS);
        const operation = typeof result.method === "string" ? result.method : "Connector request";
        const resource = typeof result.messageId === "number" ? ` (message_id ${result.messageId})` : "";
        const messageIds = Array.isArray(result.messageIds)
          ? result.messageIds.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value))
          : [];
        const deliveryStatus = typeof result.deliveryStatus === "string" ? result.deliveryStatus : undefined;
        const persistenceError = typeof result.persistenceError === "string" ? result.persistenceError : undefined;
        const deliveredButUncertain = result.uncertain === true ||
          deliveryStatus?.startsWith("delivered_") === true ||
          persistenceError !== undefined;
        const details: Record<string, unknown> = {
          ...(messageIds.length > 0 ? { messageIds } : {}),
          ...(typeof result.uncertain === "boolean" ? { uncertain: result.uncertain } : {}),
          ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
          ...(persistenceError === undefined ? {} : { persistenceError }),
        };
        const album = messageIds.length > 0 ? `\nMessage IDs: ${messageIds.join(", ")}` : "";
        const attachments = Array.isArray(result.attachments)
          ? result.attachments.filter((value): value is string => typeof value === "string").map((value) => `\nAttachment: ${value}`).join("")
          : "";
        if (deliveredButUncertain) {
          const status = deliveryStatus === undefined ? "" : ` Delivery status: ${deliveryStatus}.`;
          const persistence = persistenceError === undefined ? "" : ` Persistence error: ${persistenceError}.`;
          return text(`${operation} delivered${resource}, but persistence is uncertain.${status}${persistence} Do not blindly retry.${album}${attachments}`, details);
        }
        return text(`${operation} succeeded${resource}.${album}${attachments}`, details);
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
    description: "Wake another allowed conversation agent and give it an instruction. This does not send a connector message.",
    parameters: Type.Object({
      conversation: Type.Object({
        connectorId: Type.String(),
        conversationKey: Type.String(),
        address: Type.Record(Type.String(), Type.Unknown()),
      }),
      message: Type.String({ minLength: 1, description: "Instruction for the target conversation agent" }),
    }),
    execute: async (params: { conversation: { connectorId: string; conversationKey: string; address: Record<string, unknown> }; message: string }): Promise<ToolResult> => {
      try {
        await callHost("steer_conversation", params);
        return text(`Steering delivered to ${params.conversation.connectorId}/${params.conversation.conversationKey}.`);
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
