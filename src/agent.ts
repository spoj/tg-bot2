import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PiWorker } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { SerialQueue } from "./queue.js";
import { TG_BOT_DIR, defined } from "./util.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import { EVENTS_PROMPT } from "./events.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";
import { TASKS_PROMPT } from "./task-protocol.js";

export const SYSTEM_PROMPT = [
`You are a persistent personal agent reached through Telegram. You serve several
chats at once: private chats with individual people and groups you choose. Every chat
event names its chat_id; answer a chat by calling the send tool with that chat_id.
Direct assistant text output is not delivered to Telegram — you must call the send tool
to communicate with any chat.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available. To automate a browser, call the start_browser tool; once ready, connect your scripts (Puppeteer, Playwright, or CDP) to ws+unix:///workspace/.browser/cdp.sock.
Browser profiles, authentication state, and screenshots persist under /workspace/.browser/ (e.g. /workspace/.browser/auth/<domain>.json).
Install optional project-local extensions with pi install npm:<package> -l --approve, pi install https://... -l --approve, pi install git:... -l --approve, or pi install ./... -l --approve. Use pi list --approve to inspect them. Project settings are stored at /workspace/.pi/settings.json. Settings and extension changes take effect on your next run.
`,
  OUTBOX_PROMPT,
  EVENTS_PROMPT,
  SCHEDULES_PROMPT,
  TASKS_PROMPT,
  `Keep Telegram-facing answers concise unless the user asks for detail.
/status is a host command that reports your current model, thinking level, and session summary.
You own the chat allow list at /workspace/.tg-bot/allowed.json: a JSON array of allowed chat IDs (e.g. [123456789, -1001234567890]). The host enforces it both ways — messages from unlisted chats never reach you (and log chat_denied in events.jsonl), and your sends to unlisted chat_ids are rejected. Edit the file to allow or remove chats; changes take effect immediately.
Choose your model and thinking level by editing /workspace/.pi/agent/settings.json (defaultProvider, defaultModel, defaultThinkingLevel); new values apply from your next run. Edit the file atomically because a malformed settings file breaks the next run.
Your session resumes across runs for up to two hours of inactivity; after a longer gap the next run starts fresh. To reset your context deliberately, touch /workspace/.tg-bot/new-session (any empty file) and the next run starts fresh.
Older conversations persist under /workspace/.pi/sessions/*.jsonl — read/grep them when the user references history.
`,
].join("");

export type AgentWorker = {
  isAlive(): boolean;
  isBusy(): boolean;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  close(): Promise<void>;
  stop(): Promise<void>;
  onReaped(callback: () => void): void;
};

export type AgentWorkerOptions = {
  workspace: string;
  appRoot: string;
  bwrapPath?: string;
  appendSystemPrompt?: string;
  hostTools?: string;
  resume: boolean;
  model?: string;
  thinkingLevel?: string;
  idleTimeoutMs?: number;
  stopGraceMs?: number;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type AgentWorkerFactory = (options: AgentWorkerOptions) => AgentWorker | Promise<AgentWorker>;

export type AgentManagerOptions = {
  appRoot: string;
  bwrapPath?: string;
  workerFactory?: AgentWorkerFactory;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type AgentStatus = {
  model?: { provider: string; id: string };
  thinkingLevel: string;
  sessionFile?: string;
  messageCount: number;
  autoCompactionEnabled: boolean;
  activeTasks?: number;
  activeSchedules?: number;
};

const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
const NEW_SESSION_MARKER = path.join(TG_BOT_DIR, "new-session");
const USER_SETTINGS_RELATIVE_PATH = path.join(".pi", "agent", "settings.json");

export async function loadUserSettings(workspace: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(workspace, USER_SETTINGS_RELATIVE_PATH), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function readSessionSummary(sessionsDirectory: string): Promise<{
  messageCount: number;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string | undefined;
  sessionFile: string;
} | undefined> {
  const newest = await newestSessionFile(sessionsDirectory);
  if (!newest) return undefined;
  try {
    const raw = await readFile(path.join(sessionsDirectory, newest.name), "utf8");
    let messageCount = 0;
    let model: { provider: string; id: string } | undefined;
    let thinkingLevel: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.type === "message") messageCount += 1;
      else if (record.type === "model_change" && typeof record.provider === "string" && typeof record.modelId === "string") {
        model = { provider: record.provider, id: record.modelId };
      } else if (record.type === "thinking_level_change" && typeof record.thinkingLevel === "string") {
        thinkingLevel = record.thinkingLevel;
      }
    }
    return { messageCount, model, thinkingLevel, sessionFile: newest.name };
  } catch {
    return undefined;
  }
}

async function newestSessionFile(sessionsDirectory: string): Promise<{ name: string; mtimeMs: number } | undefined> {
  try {
    const entries = await readdir(sessionsDirectory, { withFileTypes: true });
    let newest: { name: string; mtimeMs: number } | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
      const fileStat = await stat(path.join(sessionsDirectory, entry.name));
      if (!newest || fileStat.mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs: fileStat.mtimeMs };
    }
    return newest;
  } catch {
    return undefined;
  }
}

async function countActiveTasks(workspace: string): Promise<number | undefined> {
  try {
    const taskEntries = await readdir(path.join(workspace, ".pi", "tasks"), { withFileTypes: true });
    let activeTasks = 0;
    for (const entry of taskEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        await stat(path.join(workspace, ".pi", "tasks", entry.name, "result.json"));
      } catch {
        activeTasks += 1;
      }
    }
    return activeTasks;
  } catch {
    return undefined;
  }
}

async function countActiveSchedules(workspace: string): Promise<number | undefined> {
  try {
    const rawSchedules = await readFile(path.join(workspace, TG_BOT_DIR, "schedules.json"), "utf8");
    const parsedSchedules = JSON.parse(rawSchedules) as { schedules?: unknown[] };
    if (!Array.isArray(parsedSchedules.schedules)) return undefined;
    return parsedSchedules.schedules.length;
  } catch {
    return undefined;
  }
}

export class AgentManager {
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly workerFactory: AgentWorkerFactory;
  private readonly serial = new SerialQueue();
  private worker: AgentWorker | undefined;
  private shuttingDown = false;

  constructor(config: { workspace: string }, options: AgentManagerOptions) {
    this.workspace = config.workspace;
    this.appRoot = options.appRoot;
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiWorker(workerOptions));
  }

  /**
   * Delivers a followup message to the agent using streaming followUp behavior.
   */
  async followup(text: string): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    return this.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker();
      await worker.prompt(text, "followUp");
    });
  }

  /**
   * Delivers an interrupt message to the agent using streaming steer behavior.
   */
  async interrupt(text: string): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    return this.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker();
      await worker.prompt(text, "steer");
    });
  }

  async beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      await worker.close().catch((error) => console.error("Agent shutdown stop failed", error));
    }
  }

  async disposeAll(): Promise<void> {
    await this.beginShutdown();
  }

  async status(): Promise<AgentStatus> {
    const workspace = this.workspace;
    const settings = await loadUserSettings(workspace);
    const sessionsDirectory = path.join(workspace, ".pi", "sessions");
    let result: AgentStatus = {
      thinkingLevel: typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "off",
      messageCount: 0,
      autoCompactionEnabled: (settings.autoCompaction as { enabled?: unknown } | undefined)?.enabled !== false,
    };
    const session = await readSessionSummary(sessionsDirectory);
    if (session) {
      result = {
        ...defined({ model: session.model }),
        thinkingLevel: session.thinkingLevel ?? result.thinkingLevel,
        sessionFile: session.sessionFile,
        messageCount: session.messageCount,
        autoCompactionEnabled: result.autoCompactionEnabled,
      };
    }
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    if (!result.model && settingsProvider && settingsModel) {
      result = { ...result, model: { provider: settingsProvider, id: settingsModel } };
    }
    const activeTasks = await countActiveTasks(workspace);
    if (activeTasks !== undefined) result = { ...result, activeTasks };
    const activeSchedules = await countActiveSchedules(workspace);
    if (activeSchedules !== undefined) result = { ...result, activeSchedules };
    return result;
  }

  private async ensureWorker(): Promise<AgentWorker> {
    const marker = path.join(this.workspace, NEW_SESSION_MARKER);
    const markerExists = existsSync(marker);

    if (markerExists && this.worker?.isAlive()) {
      await this.worker.close().catch(() => {});
      this.worker = undefined;
    }

    if (this.worker && this.worker.isAlive()) {
      return this.worker;
    }

    let resume = false;
    if (markerExists) {
      await rm(marker, { force: true }).catch(() => {});
    } else {
      const sessionsDirectory = path.join(this.workspace, ".pi", "sessions");
      const newest = await newestSessionFile(sessionsDirectory);
      if (newest && (this.now() - newest.mtimeMs) <= RESUME_WINDOW_MS) {
        resume = true;
      }
    }

    const settings = await loadUserSettings(this.workspace);
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    const model = settingsProvider && settingsModel ? `${settingsProvider}/${settingsModel}` : undefined;
    const thinkingLevel = typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined;

    const workerOptions: AgentWorkerOptions = {
      workspace: this.workspace,
      appRoot: this.appRoot,
      ...defined({
        bwrapPath: this.bwrapPath,
        model,
        thinkingLevel,
        stopGraceMs: this.stopGraceMs,
        idleTimeoutMs: this.idleTimeoutMs,
        setTimeout: this.setTimeoutFn,
        clearTimeout: this.clearTimeoutFn,
      }),
      appendSystemPrompt: SYSTEM_PROMPT,
      hostTools: "send,spawn,steer_task,cancel,start_browser",
      resume,
      spawnProcess: this.spawnProcess,
      terminateProcessGroup: this.terminateProcessGroup,
    };

    const worker = await this.workerFactory(workerOptions);
    worker.onReaped(() => {
      if (this.worker === worker) {
        this.worker = undefined;
      }
    });
    this.worker = worker;
    return worker;
  }
}
