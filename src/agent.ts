import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PiWorker } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { SerialQueue } from "./queue.js";
import { TG_BOT_DIR, defined, parseOrigin } from "./util.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import { EVENTS_PROMPT, WorkspaceEventLog, type BotEvent } from "./events.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";
import { TASKS_PROMPT } from "./task-protocol.js";
import { isMessageDirectedToBot, isBotGroupAdd } from "./telegram.js";

export const SYSTEM_PROMPT = [
`You are a persistent personal agent reached through Telegram serving multiple chats concurrently.
Direct assistant text output is not delivered to Telegram — you must call the send tool with the target chat_id to communicate.
Your writable workspace is /workspace; runtime/sessions live under /workspace/.pi. Attachments are downloaded to /workspace/attachments/<chat_id>/...
To automate a browser, call start_browser and connect scripts to ws+unix:///workspace/.browser/cdp.sock.
Install project extensions with pi install <pkg> -l --approve; project settings live at /workspace/.pi/settings.json.
`,
  OUTBOX_PROMPT,
  EVENTS_PROMPT,
  SCHEDULES_PROMPT,
  TASKS_PROMPT,
  `Keep Telegram-facing answers concise unless the user asks for detail.
Responsiveness & Multi-Chat Orchestration:
- Never leave users hanging on long queries. For multi-step research or deep tasks, send a quick acknowledgment via the send tool, spawn a background task (spawn tool), and finish your turn so the main loop stays responsive to other chats. Deliver findings when task_settled arrives.
- Message formatting: Prefer parse_mode: "HTML" (using <b>, <i>, <code>, <pre>, <blockquote>, <a>, bullet points •) over raw markdown so messages render cleanly on Telegram.
- Forum topics: When conversing in a topic (message_thread_id is present), rename it around message 2-3 to a short descriptive name distinct from the last 10 active topic names in events.jsonl using edit_forum_topic.
- Allowlist & Status: /workspace/.tg-bot/allowed.json controls allowed chat IDs. /status reports current model, thinking level, and session info. Adjust model/thinking in /workspace/.pi/agent/settings.json.
- Session continuity: Active sessions resume across runs within 2 hours of inactivity; an admin can /restart to apply settings changes.
- Context gathering hierarchy:
  1. Thread context: if message_thread_id is present, query events.jsonl filtered by chat_id and message_thread_id (using grep, rq, or jq).
  2. Chat context: if not in a thread or broader context is needed, query events.jsonl filtered by chat_id.
  3. Global context: search unconstrained across events.jsonl for system events, tasks, or schedules.
  Session files persist under /workspace/.pi/sessions/<chat_id>/<message_thread_id>/*.jsonl (with 0 for general/unthreaded chats; background tasks under /workspace/.pi/tasks/<runId>/sessions/). When referencing older history, search active thread sessions first, then the chat (<chat_id>/*), then root sessions.
`,
].join("");

export type AgentWorker = {
  isAlive(): boolean;
  isBusy(): boolean;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  waitForSettled(): Promise<unknown>;
  close(): Promise<void>;
  stop(): Promise<void>;
  onReaped(callback: () => void): void;
};

export const DEFAULT_CHAT_BUSY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const CHAT_BUSY_TIMEOUT_MESSAGE =
  "Interrupted: Operation took over 2 minutes with no progress. If this task requires long computation or multi-step execution, consider acknowledging the user with the send tool and spawning a background task (spawn tool) to keep the chat loop responsive.";

export type AgentWorkerOptions = {
  workspace: string;
  sessionDir?: string;
  appRoot: string;
  bwrapPath?: string;
  appendSystemPrompt?: string;
  hostTools?: string;
  agentOrigin?: string;
  resume: boolean;
  thinkingLevel?: string;
  idleTimeoutMs?: number;
  busyTimeoutMs?: number;
  busyTimeoutMessage?: string;
  now?: () => number;
  hostSocketDir?: string;
  hostEventsLog?: string;
  /** Chat runs dial the full host socket (false); task runs get the restricted one (true). */
  taskRun?: boolean;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
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
  busyTimeoutMs?: number;
  hostSocketDir?: string;
  hostEventsLog?: string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  events?: WorkspaceEventLog;
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
export type AgentTarget = {
  chatId?: number | undefined;
  threadId?: number | undefined;
};

export type AgentNotifier = {
  interrupt(text: string, target?: AgentTarget): Promise<void>;
  followup(text: string, target?: AgentTarget): Promise<void>;
};

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatTaskSettledMessage(event: Extract<BotEvent, { type: "task_settled" }>): string {
  const outcome = event.status === "done"
    ? "finished"
    : event.status === "failed"
      ? `failed (exit ${event.exitCode ?? "unknown"})`
      : "aborted";
  const promptText = event.prompt ? ` "${truncate(event.prompt, 100)}"` : "";
  return `Task${promptText} ${outcome}. Run files: /workspace/.pi/tasks/${event.runId}/`;
}

function formatTaskProgressMessage(tasks: Extract<BotEvent, { type: "task_progress" }>["tasks"]): string {
  const lines = tasks.map((task) => {
    const running = formatDuration(task.runningMs);
    const idle = task.idleMs !== null ? formatDuration(task.idleMs) : "unknown";
    const snippet = task.lastOutput ? `; last output: "${truncate(task.lastOutput, 120)}"` : "";
    return `- ${task.runId} "${truncate(task.prompt, 80)}" running ${running}, last activity ${idle} ago${snippet}`;
  });
  return `Task heartbeat: ${tasks.length} task(s) running.\n${lines.join("\n")}`;
}

/**
 * Routes workspace events to agent notifications, applying interaction policy
 * (interrupt vs followup vs ignore) and prompt formatting.
 */

function originToTarget(origin?: string): AgentTarget | undefined {
  const parsed = parseOrigin(origin);
  if (!parsed || parsed.kind !== "chat") return undefined;
  return {
    chatId: parsed.chatId,
    ...(parsed.threadId > 0 ? { threadId: parsed.threadId } : {}),
  };
}

export class AgentEventRouter {
  private readonly botInfoProvider?: (() => { id: number; username?: string } | undefined) | undefined;

  constructor(
    private readonly notifier: AgentNotifier,
    options: {
      botInfo?: () => { id: number; username?: string } | undefined;
    } = {},
  ) {
    this.botInfoProvider = options.botInfo;
  }

  async onEvent(event: BotEvent, rawLine: string): Promise<void> {
    switch (event.type) {
      case "message":
        await this.handleMessage(event, rawLine);
        break;
      case "callback":
        await this.handleCallback(event, rawLine);
        break;
      case "task_settled":
        await this.handleTaskSettled(event);
        break;
      case "task_progress":
        await this.handleTaskProgress(event);
        break;
      case "my_chat_member":
        await this.handleMyChatMember(event);
        break;
      default:
        // Send and browser outcomes reach the agent synchronously through the
        // tool results; the events remain in the log as timeline history only.
        break;
    }
  }

  private async handleMyChatMember(event: Extract<BotEvent, { type: "my_chat_member" }>): Promise<void> {
    // Only surface group adds; private-chat membership is not a self-provisioning signal.
    if (event.chat_id >= 0) return;
    if (!isBotGroupAdd(event.my_chat_member)) return;
    await this.notifier.followup(
      `Bot was added to group or channel ${event.chat_id}. To allow it, add ${event.chat_id} to /workspace/.tg-bot/allowed.json.`,
      { chatId: event.chat_id },
    );
  }

  private async handleTaskSettled(event: Extract<BotEvent, { type: "task_settled" }>): Promise<void> {
    const originTarget = originToTarget(event.origin);
    if (originTarget) {
      await this.notifier.followup(formatTaskSettledMessage(event), originTarget);
    }
  }

  private async handleTaskProgress(event: Extract<BotEvent, { type: "task_progress" }>): Promise<void> {
    const originTarget = originToTarget(event.origin);
    if (originTarget && event.tasks.length > 0) {
      await this.notifier.followup(formatTaskProgressMessage(event.tasks), originTarget);
    }
  }

  private async handleMessage(event: Extract<BotEvent, { type: "message" }>, rawLine: string): Promise<void> {
    const isPrivate = event.chat_id > 0;
    const botInfo = this.botInfoProvider?.();
    const msg = event.message as Parameters<typeof isMessageDirectedToBot>[0];
    if (isPrivate || (msg && isMessageDirectedToBot(msg, botInfo))) {
      const threadId = msg && typeof msg === "object" && "message_thread_id" in msg && typeof msg.message_thread_id === "number"
        ? msg.message_thread_id
        : undefined;
      await this.notifier.interrupt(rawLine, { chatId: event.chat_id, threadId });
    }
  }

  private async handleCallback(event: Extract<BotEvent, { type: "callback" }>, rawLine: string): Promise<void> {
    const query = event.callback_query as { message?: { message_thread_id?: number } } | undefined;
    const threadId = query?.message?.message_thread_id;
    await this.notifier.interrupt(rawLine, { chatId: event.chat_id, threadId });
  }

}

const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
const RESTART_SETTLE_CAP_MS = 30_000;
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
    const raw = await readFile(newest.fullPath, "utf8");
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

async function newestSessionFile(sessionsDirectory: string): Promise<{ fullPath: string; name: string; mtimeMs: number } | undefined> {
  let newest: { fullPath: string; name: string; mtimeMs: number } | undefined;
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = await stat(fullPath);
          if (!newest || fileStat.mtimeMs > newest.mtimeMs) {
            newest = { fullPath, name: entry.name, mtimeMs: fileStat.mtimeMs };
          }
        } catch {}
      }
    }
  }
  await walk(sessionsDirectory);
  return newest;
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

type ConversationWorkerEntry = {
  worker: AgentWorker | undefined;
  serial: SerialQueue;
};

function conversationKey(chatId?: number, threadId?: number): string {
  if (chatId === undefined) return "default";
  return `${chatId}:${threadId ?? 0}`;
}

function sessionDirectoryPath(workspace: string, chatId?: number, threadId?: number): string {
  if (chatId === undefined) {
    return path.join(workspace, ".pi", "sessions");
  }
  return path.join(workspace, ".pi", "sessions", String(chatId), String(threadId ?? 0));
}

export class AgentManager {
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly busyTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval | undefined;
  private readonly clearIntervalFn: typeof clearInterval | undefined;
  private readonly workerFactory: AgentWorkerFactory;
  private readonly hostSocketDir: string | undefined;
  private readonly hostEventsLog: string | undefined;
  private readonly workers = new Map<string, ConversationWorkerEntry>();
  private readonly events: WorkspaceEventLog | undefined;
  private shuttingDown = false;
  constructor(config: { workspace: string }, options: AgentManagerOptions) {
    this.workspace = config.workspace;
    this.appRoot = options.appRoot;
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.busyTimeoutMs = options.busyTimeoutMs;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.setIntervalFn = options.setInterval;
    this.clearIntervalFn = options.clearInterval;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiWorker(workerOptions));
    this.hostSocketDir = options.hostSocketDir;
    this.hostEventsLog = options.hostEventsLog;
    this.events = options.events;
  }

  private getOrCreateEntry(chatId?: number, threadId?: number): ConversationWorkerEntry {
    const key = conversationKey(chatId, threadId);
    let entry = this.workers.get(key);
    if (!entry) {
      entry = {
        worker: undefined,
        serial: new SerialQueue(),
      };
      this.workers.set(key, entry);
    }
    return entry;
  }

  /**
   * Delivers a followup message to the targeted conversation worker using streaming followUp behavior.
   */
  async followup(text: string, target?: AgentTarget): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = this.getOrCreateEntry(target?.chatId, target?.threadId);
    return entry.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(entry, target?.chatId, target?.threadId);
      await worker.prompt(text, "followUp");
    });
  }

  /**
   * Delivers an interrupt message to the targeted conversation worker using streaming steer behavior.
   */
  async interrupt(text: string, target?: AgentTarget): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = this.getOrCreateEntry(target?.chatId, target?.threadId);
    return entry.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(entry, target?.chatId, target?.threadId);
      await worker.prompt(text, "steer");
    });
  }

  /**
   * Restarts every conversation worker: each active worker first waits for its current
   * turn to settle (bounded by a hard 30s cap), then is closed, so the next message
   * respawns it with the current settings while its session is still fresh. A worker
   * whose close fails stays in the map and exit detection owns its cleanup.
   * Used by the host /restart command to apply settings changes.
   */
  async restartAll(): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    await Promise.all(
      [...this.workers.values()].map(async (entry) => {
        await entry.serial.run(async () => {
          const worker = entry.worker;
          if (!worker?.isAlive()) return;
          await Promise.race([
            worker.waitForSettled(),
            new Promise<void>((resolve) => {
              const timer = this.setTimeoutFn(resolve, RESTART_SETTLE_CAP_MS);
              timer.unref?.();
            }),
          ]);
          try {
            await worker.close();
          } catch (error) {
            console.error("Agent restart close failed", error);
            return;
          }
          entry.worker = undefined;
        });
      }),
    );
  }

  async beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = [...this.workers.values()];
    this.workers.clear();
    const closes = entries.map((entry) => {
      const worker = entry.worker;
      entry.worker = undefined;
      return worker ? worker.close().catch((error) => console.error("Agent shutdown stop failed", error)) : Promise.resolve();
    });
    await Promise.all(closes);
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

  private async ensureWorker(entry: ConversationWorkerEntry, chatId?: number, threadId?: number): Promise<AgentWorker> {
    if (entry.worker && entry.worker.isAlive()) {
      return entry.worker;
    }
    const sessionSubdir = chatId !== undefined
      ? path.join(".pi", "sessions", String(chatId), String(threadId ?? 0))
      : path.join(".pi", "sessions");
    const sessionDir = sessionDirectoryPath(this.workspace, chatId, threadId);

    const newest = await newestSessionFile(sessionDir);
    const resume = newest !== undefined && (this.now() - newest.mtimeMs) <= RESUME_WINDOW_MS;

    const settings = await loadUserSettings(this.workspace);
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    const model = settingsProvider && settingsModel ? `${settingsProvider}/${settingsModel}` : undefined;
    const thinkingLevel = typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined;

    const workerOptions: AgentWorkerOptions = {
      workspace: this.workspace,
      sessionDir: `/workspace/${sessionSubdir}`,
      appRoot: this.appRoot,
      now: this.now,
      ...defined({
        bwrapPath: this.bwrapPath,
        model,
        thinkingLevel,
        stopGraceMs: this.stopGraceMs,
        idleTimeoutMs: this.idleTimeoutMs,
        busyTimeoutMs: this.busyTimeoutMs ?? DEFAULT_CHAT_BUSY_TIMEOUT_MS,
        busyTimeoutMessage: CHAT_BUSY_TIMEOUT_MESSAGE,
        hostSocketDir: this.hostSocketDir,
        hostEventsLog: this.hostEventsLog,
        setTimeout: this.setTimeoutFn,
        clearTimeout: this.clearTimeoutFn,
        setInterval: this.setIntervalFn,
        clearInterval: this.clearIntervalFn,
      }),
      appendSystemPrompt: SYSTEM_PROMPT,
      hostTools: "send,spawn,steer_task,cancel,start_browser",
      taskRun: false,
      agentOrigin: conversationKey(chatId, threadId),
      resume,
      spawnProcess: this.spawnProcess,
      terminateProcessGroup: this.terminateProcessGroup,
    };

    const worker = await this.workerFactory(workerOptions);
    worker.onReaped(() => {
      if (entry.worker === worker) {
        entry.worker = undefined;
      }
    });
    entry.worker = worker;
    return worker;
  }
}
