import { randomBytes } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { AgentRef } from "./agent-ref.js";
import { errorMessage, isMissing } from "./util.js";

/** One request line from an agent tool: `{id, token, type, params}`. */
type BridgeRequest = {
  id: string;
  token: string;
  type: string;
  params: Record<string, unknown>;
};

/** One response line to the agent tool: `{id, ok, result | error}`. */
type BridgeResponse = { id: string } & ({ ok: true; result: Record<string, unknown> } | { ok: false; error: string });

export type HostCapability = "send" | "annotate" | "spawn" | "continue_task" | "cancel" | "steer_task" | "steer_conversation" | "schedule";

export type BridgeHandler = (params: Record<string, unknown>, actor: AgentRef) => Promise<Record<string, unknown>>;

export type HostBridgeHandlers = {
  send: BridgeHandler;
  annotate: BridgeHandler;
  spawn: BridgeHandler;
  continueTask: BridgeHandler;
  cancel: BridgeHandler;
  steerTask: BridgeHandler;
  steerConversation: BridgeHandler;
  scheduleAdd: BridgeHandler;
  scheduleReplace: BridgeHandler;
  scheduleRemove: BridgeHandler;
  scheduleTake: BridgeHandler;
};

type AgentCredential = {
  actor: AgentRef;
  capabilities: ReadonlySet<HostCapability>;
};

export class AgentCredentials {
  private readonly entries = new Map<string, AgentCredential>();

  issue(actor: AgentRef, capabilities: readonly HostCapability[]): string {
    const token = randomBytes(32).toString("base64url");
    this.entries.set(token, { actor, capabilities: new Set(capabilities) });
    return token;
  }

  revoke(token: string): void {
    this.entries.delete(token);
  }

  authorize(token: string, capability: HostCapability): AgentRef {
    const credential = this.entries.get(token);
    if (!credential) throw new Error("Unknown agent token");
    if (!credential.capabilities.has(capability)) {
      throw new Error(`Agent is not allowed to call ${capability}`);
    }
    return credential.actor;
  }
}

export type HostBridgeOptions = {
  /** Absolute path of the UNIX socket the agent tools dial. */
  socketPath: string;
  credentials: AgentCredentials;
  /** Handlers by request type; a type without a handler is rejected as unknown. */
  handlers: Partial<HostBridgeHandlers>;
  /** Kills a connection whose request line exceeds this many bytes. */
  maxLineBytes?: number;
  logger?: (error: unknown) => void;
};

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

/**
 * Agent-to-host RPC bridge over a UNIX socket: agent tools (running inside the
 * sandbox) send JSON request lines and receive one response line per request.
 * The host validates and executes every request; the agent never touches host state.
 */
export class HostBridge {
  private readonly socketPath: string;
  private readonly credentials: AgentCredentials;
  private readonly handlers: Partial<HostBridgeHandlers>;
  private readonly maxLineBytes: number;
  private readonly logger: (error: unknown) => void;
  private server: net.Server | undefined;
  private readonly connections = new Set<net.Socket>();

  constructor(options: HostBridgeOptions) {
    this.socketPath = options.socketPath;
    this.credentials = options.credentials;
    this.handlers = options.handlers;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.logger = options.logger ?? ((error) => console.error("Host bridge error", error));
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        server.on("error", (error) => this.logger(error));
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlink(this.socketPath).catch(() => {});
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
          socket.destroy();
          return;
        }
        if (line.trim().length > 0) void this.handleLine(socket, line);
      }
      if (Buffer.byteLength(buffer, "utf8") > this.maxLineBytes) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connections.delete(socket);
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: BridgeRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request must be a JSON object");
      const typed = parsed as Record<string, unknown>;
      if (typeof typed.id !== "string" || typed.id.length === 0) throw new Error("Request id must be a non-empty string");
      if (typeof typed.token !== "string" || typed.token.length === 0) throw new Error("Request token must be a non-empty string");
      if (typeof typed.type !== "string") throw new Error("Request type must be a string");
      if (typed.params === null || typeof typed.params !== "object" || Array.isArray(typed.params)) {
        throw new Error("Request params must be a JSON object");
      }
      request = { id: typed.id, token: typed.token, type: typed.type, params: typed.params as Record<string, unknown> };
    } catch (error) {
      this.logger(error);
      return;
    }
    const response = await this.invoke(request);
    if (!socket.destroyed && socket.writable) {
      socket.write(`${JSON.stringify(response)}\n`);
    }
  }

  private async invoke(request: BridgeRequest): Promise<BridgeResponse> {
    const route = this.handlerFor(request.type);
    if (route === undefined) {
      return { id: request.id, ok: false, error: `Unknown request type: ${request.type}` };
    }
    try {
      const actor = this.credentials.authorize(request.token, route.capability);
      const result = await route.handler(request.params, actor);
      return { id: request.id, ok: true, result };
    } catch (error) {
      return { id: request.id, ok: false, error: errorMessage(error) };
    }
  }

  private scheduleHandlerFor(type: string): BridgeHandler | undefined {
    switch (type) {
      case "schedule_add": return this.handlers.scheduleAdd;
      case "schedule_replace": return this.handlers.scheduleReplace;
      case "schedule_remove": return this.handlers.scheduleRemove;
      case "schedule_take": return this.handlers.scheduleTake;
      default: return undefined;
    }
  }

  private handlerFor(type: string): { handler: BridgeHandler; capability: HostCapability } | undefined {
    const scheduleHandler = this.scheduleHandlerFor(type);
    if (scheduleHandler) return { handler: scheduleHandler, capability: "schedule" };
    switch (type) {
      case "send": return this.handlers.send ? { handler: this.handlers.send, capability: "send" } : undefined;
      case "annotate": return this.handlers.annotate ? { handler: this.handlers.annotate, capability: "annotate" } : undefined;
      case "spawn": return this.handlers.spawn ? { handler: this.handlers.spawn, capability: "spawn" } : undefined;
      case "continue_task": return this.handlers.continueTask ? { handler: this.handlers.continueTask, capability: "continue_task" } : undefined;
      case "cancel": return this.handlers.cancel ? { handler: this.handlers.cancel, capability: "cancel" } : undefined;
      case "steer_task": return this.handlers.steerTask ? { handler: this.handlers.steerTask, capability: "steer_task" } : undefined;
      case "steer_conversation": return this.handlers.steerConversation ? { handler: this.handlers.steerConversation, capability: "steer_conversation" } : undefined;
      default: return undefined;
    }
  }
}
