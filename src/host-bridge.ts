import { mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { errorMessage, isMissing } from "./util.js";

/** One request line from an agent tool: `{id, type, params}`. */
type BridgeRequest = {
  id: string;
  type: string;
  params: Record<string, unknown>;
};

/** One response line to the agent tool: `{id, ok, result | error}`. */
type BridgeResponse = { id: string } & ({ ok: true; result: Record<string, unknown> } | { ok: false; error: string });

export type BridgeHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type HostBridgeHandlers = {
  send: BridgeHandler;
  spawn: BridgeHandler;
  cancel: BridgeHandler;
  steerTask: BridgeHandler;
  startBrowser: BridgeHandler;
};

export type HostBridgeOptions = {
  /** Absolute path of the UNIX socket the agent tools dial. */
  socketPath: string;
  handlers: HostBridgeHandlers;
  /** Rejects start_browser after this many milliseconds; the launch itself keeps running. */
  browserTimeoutMs?: number;
  /** Kills a connection whose request line exceeds this many bytes. */
  maxLineBytes?: number;
  logger?: (error: unknown) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

const DEFAULT_BROWSER_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeoutFn(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeoutFn(timer);
        resolve(value);
      },
      (error) => {
        clearTimeoutFn(timer);
        reject(error);
      },
    );
  });
}

/**
 * Agent-to-host RPC bridge over a UNIX socket: agent tools (running inside the
 * sandbox) send JSON request lines and receive one response line per request.
 * The host validates and executes every request; the agent never touches host state.
 */
export class HostBridge {
  private readonly socketPath: string;
  private readonly handlers: HostBridgeHandlers;
  private readonly browserTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly logger: (error: unknown) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private server: net.Server | undefined;
  private readonly connections = new Set<net.Socket>();

  constructor(options: HostBridgeOptions) {
    this.socketPath = options.socketPath;
    this.handlers = options.handlers;
    this.browserTimeoutMs = options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.logger = options.logger ?? ((error) => console.error("Host bridge error", error));
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
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
    let buffer = "";
    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (buffer.length > this.maxLineBytes) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) void this.handleLine(socket, line);
      }
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
      if (typeof typed.type !== "string") throw new Error("Request type must be a string");
      if (typed.params === null || typeof typed.params !== "object" || Array.isArray(typed.params)) {
        throw new Error("Request params must be a JSON object");
      }
      request = { id: typed.id, type: typed.type, params: typed.params as Record<string, unknown> };
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
    const handler = this.handlerFor(request.type);
    if (handler === undefined) {
      return { id: request.id, ok: false, error: `Unknown request type: ${request.type}` };
    }
    try {
      const execution = handler(request.params);
      const result = request.type === "start_browser"
        ? await withTimeout(execution, this.browserTimeoutMs, `Browser start timed out after ${this.browserTimeoutMs}ms`, this.setTimeoutFn, this.clearTimeoutFn)
        : await execution;
      return { id: request.id, ok: true, result };
    } catch (error) {
      return { id: request.id, ok: false, error: errorMessage(error) };
    }
  }

  private handlerFor(type: string): BridgeHandler | undefined {
    switch (type) {
      case "send": return this.handlers.send;
      case "spawn": return this.handlers.spawn;
      case "cancel": return this.handlers.cancel;
      case "steer_task": return this.handlers.steerTask;
      case "start_browser": return this.handlers.startBrowser;
      default: return undefined;
    }
  }
}
