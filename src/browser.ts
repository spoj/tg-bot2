import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { rm, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { Writable, Readable } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { WorkspaceEventLog } from "./events.js";
import { defined, errorMessage } from "./util.js";
import {
  spawnProcess,
  terminatePid,
  terminateProcessGroup,
  type PiWorkerChildProcess,
  type PiWorkerSpawn,
} from "./sandbox.js";

export interface HostBrowserOptions {
  workspace: string;
  events?: WorkspaceEventLog | undefined;
  idleTimeoutMs?: number | undefined;
  spawnProcess?: PiWorkerSpawn | undefined;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
export const IDLE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

const DEFAULT_EXECUTABLES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => typeof p === "string" && p.length > 0);

export function resolveChromeExecutable(): string {
  for (const candidate of DEFAULT_EXECUTABLES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome/Chromium executable found (checked PUPPETEER_EXECUTABLE_PATH, /usr/bin/google-chrome-stable, /usr/bin/chromium)");
}

export type BrowserClosedReason = "idle_timeout" | "agent_close" | "process_exit" | "host_shutdown";

export interface BrowserReadyResult {
  status: "started" | "existing";
  socketPath: string;
  wsEndpoint: string;
}

export class HostBrowserManager {
  private readonly workspace: string;
  private readonly events: WorkspaceEventLog | undefined;
  private readonly idleTimeoutMs: number;
  private readonly spawn: PiWorkerSpawn;
  private readonly socketPath: string;
  private readonly pidFile: string;
  private child: PiWorkerChildProcess | undefined;
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly activeSockets = new Set<WebSocket>();
  private lastActivityAt = 0;
  private idleCheckTimer: NodeJS.Timeout | undefined;
  private isStopping = false;
  private pipeBuffer = Buffer.alloc(0);
  private launchPromise: Promise<BrowserReadyResult> | undefined;

  constructor(options: HostBrowserOptions) {
    this.workspace = options.workspace;
    this.events = options.events;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.spawn = options.spawnProcess ?? spawnProcess;
    this.socketPath = path.join(this.workspace, ".browser", "cdp.sock");
    this.pidFile = path.join(this.workspace, ".browser", "chrome.pid");
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  getWsEndpoint(): string {
    return `ws+unix://${this.socketPath}`;
  }

  isRunning(): boolean {
    return this.child !== undefined && !this.child.killed && this.server !== undefined && this.server.listening;
  }

  /** Starts Chrome and the socket bridge if not already running, or reuses the existing instance. Throws after emitting browser_request_failed. */
  async startBrowser(origin?: string | undefined): Promise<BrowserReadyResult> {
    const requestId = randomUUID();
    try {
      if (this.isRunning()) {
        this.touch();
        const result: BrowserReadyResult = {
          status: "existing",
          socketPath: this.socketPath,
          wsEndpoint: this.getWsEndpoint(),
        };
        await this.events?.emit({
          type: "browser_ready",
          requestId,
          status: "existing",
          socketPath: this.socketPath,
          wsEndpoint: this.getWsEndpoint(),
          ...defined({ origin }),
        });
        return result;
      }

      if (this.launchPromise !== undefined) {
        await this.launchPromise;
        const result: BrowserReadyResult = {
          status: "existing",
          socketPath: this.socketPath,
          wsEndpoint: this.getWsEndpoint(),
        };
        await this.events?.emit({
          type: "browser_ready",
          requestId,
          status: "existing",
          socketPath: this.socketPath,
          wsEndpoint: this.getWsEndpoint(),
          ...defined({ origin }),
        });
        return result;
      }

      this.launchPromise = this.launch();
      try {
        const result = await this.launchPromise;
        await this.events?.emit({
          type: "browser_ready",
          requestId,
          status: "started",
          socketPath: this.socketPath,
          wsEndpoint: this.getWsEndpoint(),
          ...defined({ origin }),
        });
        return result;
      } finally {
        this.launchPromise = undefined;
      }
    } catch (error) {
      const detail = errorMessage(error);
      await this.events?.emit({
        type: "browser_request_failed",
        requestId,
        error: detail,
        ...defined({ origin }),
      });
      throw new Error(detail);
    }
  }

  /** Cleans up stale artifacts from previous crashes or restarts. */
  async cleanupStaleArtifacts(): Promise<void> {
    if (existsSync(this.pidFile)) {
      try {
        const raw = await readFile(this.pidFile, "utf8");
        const pid = parseInt(raw.trim(), 10);
        if (!isNaN(pid) && pid > 0) {
          terminatePid(pid, "SIGTERM");
        }
      } catch {
        // Ignore read error
      }
      await rm(this.pidFile, { force: true }).catch(() => {});
    }

    if (existsSync(this.socketPath)) {
      await rm(this.socketPath, { force: true }).catch(() => {});
    }
  }

  private async launch(): Promise<BrowserReadyResult> {
    await this.cleanupStaleArtifacts();

    const executablePath = resolveChromeExecutable();
    const browserDir = path.join(this.workspace, ".browser");
    const profileDir = path.join(browserDir, "profile");
    mkdirSync(profileDir, { recursive: true });

    const lockFile = path.join(profileDir, "SingletonLock");
    if (existsSync(lockFile)) {
      await rm(lockFile, { force: true }).catch(() => {});
    }

    const child = this.spawn(
      executablePath,
      [
        "--headless",
        "--remote-debugging-pipe",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      },
    );

    this.child = child;
    this.pipeBuffer = Buffer.alloc(0);
    this.lastActivityAt = Date.now();

    if (child.pid) {
      await writeFile(this.pidFile, String(child.pid), "utf8");
    }

    const pipeIn = child.stdio[3] as Writable | null;
    const pipeOut = child.stdio[4] as Readable | null;
    if (!pipeIn || !pipeOut) {
      terminateProcessGroup(child, "SIGKILL");
      throw new Error("Chrome stdio pipes (fd 3 and 4) are unavailable");
    }

    pipeOut.on("data", (chunk: Buffer | string) => {
      this.handlePipeData(chunk);
    });

    child.once("exit", (code, signal) => {
      this.handleChildExit(code, signal);
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("CDP Bridge\n");
    });

    const wss = new WebSocketServer({ server });
    this.server = server;
    this.wss = wss;

    wss.on("connection", (ws) => {
      this.activeSockets.add(ws);
      this.touch();

      ws.on("message", (data) => {
        this.touch();
        if (this.child && !this.child.killed && pipeIn.writable) {
          const str = typeof data === "string" ? data : data.toString("utf8");
          pipeIn.write(str + "\0");
        }
      });

      ws.on("error", () => {});

      ws.on("close", () => {
        this.activeSockets.delete(ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        server.on("error", () => {});
        try {
          chmodSync(this.socketPath, 0o600);
        } catch {
          // Ignore chmod error if unsupported
        }
        resolve();
      });
    });

    clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleTimeout();
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref();

    return {
      status: "started",
      socketPath: this.socketPath,
      wsEndpoint: this.getWsEndpoint(),
    };
  }

  private handlePipeData(chunk: Buffer | string): void {
    this.touch();
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.pipeBuffer = Buffer.concat([this.pipeBuffer, incoming]);

    let nullIdx: number;
    while ((nullIdx = this.pipeBuffer.indexOf(0)) !== -1) {
      const msg = this.pipeBuffer.subarray(0, nullIdx).toString("utf8");
      this.pipeBuffer = this.pipeBuffer.subarray(nullIdx + 1);
      for (const ws of this.activeSockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(msg);
          } catch {
            // Ignore send error for closing socket
          }
        }
      }
    }
  }

  private handleChildExit(code: number | null, _signal: NodeJS.Signals | null): void {
    if (this.isStopping) return;
    const reason: BrowserClosedReason = code === 0 ? "agent_close" : "process_exit";
    void this.cleanup(reason);
  }

  private checkIdleTimeout(): void {
    if (this.isStopping || !this.isRunning()) return;
    if (Date.now() - this.lastActivityAt >= this.idleTimeoutMs) {
      void this.stop("idle_timeout");
    }
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  async stop(reason: BrowserClosedReason = "host_shutdown"): Promise<void> {
    await this.cleanup(reason);
  }

  private async cleanup(reason: BrowserClosedReason): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;

    try {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = undefined;

      for (const ws of this.activeSockets) {
        try { ws.close(); } catch {}
      }
      this.activeSockets.clear();

      if (this.wss) {
        try { this.wss.close(); } catch {}
        this.wss = undefined;
      }

      if (this.server) {
        try {
          await new Promise<void>((resolve) => {
            this.server?.close(() => resolve());
            setTimeout(resolve, 500).unref();
          });
        } catch {}
        this.server = undefined;
      }

      if (this.child) {
        const child = this.child;
        this.child = undefined;
        terminateProcessGroup(child, "SIGTERM");
      }

      await rm(this.pidFile, { force: true }).catch(() => {});
      await rm(this.socketPath, { force: true }).catch(() => {});

      await this.events?.emit({
        type: "browser_closed",
        reason,
      });
    } finally {
      this.isStopping = false;
    }
  }
}
