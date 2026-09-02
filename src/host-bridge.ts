import { randomBytes } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { AgentRef } from "./agent-ref.js";
import { errorMessage, isMissing } from "./util.js";

type BridgeRequest = {
  id: string;
  token: string;
  type: string;
  params: Record<string, unknown>;
};

type BridgeResponse = { id: string } & ({ ok: true; result: Record<string, unknown> } | { ok: false; error: string });

export type HostCapability = "send" | "annotate" | "steer_conversation" | "schedule";

export type BridgeHandler = (params: Record<string, unknown>, actor: AgentRef) => Promise<Record<string, unknown>>;

export type HostBridgeHandlers = {
  send: BridgeHandler;
  annotate: BridgeHandler;
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
  socketPath: string;
  credentials: AgentCredentials;
  handlers: Partial<HostBridgeHandlers>;
  maxLineBytes?: number;
  logger?: (error: unknown) => void;
};

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
function bridgeStartupAbort(): Error {
  const error = new Error("Host bridge startup aborted");
  error.name = "AbortError";
  (error as NodeJS.ErrnoException).code = "ABORT_ERR";
  return error;
}

export class HostBridge {
  private readonly socketPath: string;
  private readonly credentials: AgentCredentials;
  private readonly handlers: Partial<HostBridgeHandlers>;
  private readonly maxLineBytes: number;
  private readonly logger: (error: unknown) => void;
  private server: net.Server | undefined;
  private readonly connections = new Set<net.Socket>();
  private readonly invocations = new Set<Promise<BridgeResponse>>();
  private startPromise: Promise<void> | undefined;
  private listenReject: ((error: Error) => void) | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(options: HostBridgeOptions) {
    this.socketPath = options.socketPath;
    this.credentials = options.credentials;
    this.handlers = options.handlers;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.logger = options.logger ?? ((error) => console.error("Host bridge error", error));
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;
    const starting = this.startInternal();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.stopped) return;
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (this.stopped) return;
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (this.stopped) return;
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          this.listenReject = undefined;
          reject(error);
        };
        this.listenReject = onError;
        server.once("error", onError);
        server.listen(this.socketPath, () => {
          if (this.stopped) {
            onError(bridgeStartupAbort());
            void this.closeServer(server);
            return;
          }
          if (settled) return;
          settled = true;
          this.listenReject = undefined;
          server.removeListener("error", onError);
          server.on("error", (error) => this.logger(error));
          resolve();
        });
      });
    } catch (error) {
      if (this.listenReject) this.listenReject = undefined;
      if (this.server === server) this.server = undefined;
      await this.closeServer(server);
      throw error;
    }
  }

  private closeServer(server: net.Server): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    const stopping = this.stopInternal();
    this.stopPromise = stopping;
    return stopping;
  }

  private async stopInternal(): Promise<void> {
    this.listenReject?.(bridgeStartupAbort());
    const server = this.server;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const close = server ? this.closeServer(server) : Promise.resolve();
    await Promise.all([
      close,
      this.startPromise?.catch(() => {}) ?? Promise.resolve(),
      this.waitForInvocations(),
    ]);
    if (this.server === server) this.server = undefined;
    await unlink(this.socketPath).catch(() => {});
  }

  private handleConnection(socket: net.Socket): void {
    if (this.stopped) {
      socket.destroy();
      return;
    }
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
        if (line.trim().length > 0) void this.handleLine(socket, line).catch((error) => this.logger(error));
      }
      if (Buffer.byteLength(buffer, "utf8") > this.maxLineBytes) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connections.delete(socket);
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    if (this.stopped) return;
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
    if (this.stopped) return;
    const invocation = this.invoke(request);
    this.invocations.add(invocation);
    try {
      const response = await invocation;
      if (!this.stopped && !socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    } finally {
      this.invocations.delete(invocation);
    }
  }

  private async waitForInvocations(): Promise<void> {
    await Promise.allSettled([...this.invocations]);
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
      case "steer_conversation": return this.handlers.steerConversation ? { handler: this.handlers.steerConversation, capability: "steer_conversation" } : undefined;
      default: return undefined;
    }
  }
}
