import { readFile } from "node:fs/promises";
import path from "node:path";
import { PiWorker } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { SerialQueue } from "./queue.js";
import { conversationAgent, type ConversationAgentRef } from "./agent-ref.js";
import type { AgentCredentials } from "./host-bridge.js";
import { defined } from "./util.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import { TIMELINE_PROMPT, type BotEvent } from "./events.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";
import { TASKS_PROMPT } from "./task-protocol.js";
import { isMessageDirectedToBot, isBotGroupAdd } from "./telegram.js";

export const SYSTEM_PROMPT = [
`You are a persistent personal Telegram agent serving several chats.
Assistant text is not delivered; communicate with users through send. The host always targets this session's owning chat and topic.
The writable workspace is /workspace. Sessions and agent state live under /workspace/.pi. Host-managed attachments are read-only under /run/attachments; copy one into /workspace before editing it.
For browser automation, launch /usr/bin/google-chrome-stable --headless --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222 --user-data-dir=/workspace/.browser/profile, then connect with puppeteer-core at http://127.0.0.1:9222. The browser survives turns and stops with the session.
Install project extensions with pi install <pkg> -l --approve. Project settings live at /workspace/.pi/settings.json.
`,
  OUTBOX_PROMPT,
  TIMELINE_PROMPT,
  SCHEDULES_PROMPT,
  TASKS_PROMPT,
  `Behavior:
- Keep Telegram replies concise unless the user asks for detail. Prefer HTML parse mode and Telegram-safe tags.
- Keep chats responsive. If work needs sustained multi-step execution, acknowledge it, spawn a complete background task, then end the turn. Handle task_finished when it arrives.
- Let a topic's subject emerge through conversation. When a short, useful name becomes clear—or materially changes—include topic_name in a normal sendMessage call. The host renames this agent's topic in that same tool call. Never spend a separate tool call searching for or changing a topic name.
- After interpreting an attachment, call annotate with its exact /run/attachments path and a short factual description. The host inserts it into the attachment's original timeline event for later search.
- Use steer_conversation to wake another conversation owner when work belongs to its chat or topic. Give it the relevant timeline message reference and a concrete instruction; do not send into its conversation yourself.
- Read only the context needed: current thread in /run/timeline.jsonl, then its chat, then other chats. For older detail, search /workspace/.pi/sessions/<chat_id>/<message_thread_id>/ first, then sibling threads and root sessions. Background task sessions are under /workspace/.pi/tasks/<runId>/sessions/.
- /workspace/.allowed.json controls chat access. /workspace/.pi/agent/settings.json controls model and thinking. /restart applies settings changes.
- Always give bash commands that can hang an explicit timeout in seconds. Use 300 by default; increase it only when the operation requires more time.
`,
].join("");

export type AgentWorker = {
  isAlive(): boolean;
  isBusy(): boolean;
  prompt(message: string, streamingBehavior?: "steer" | "followUp", maxWaitMs?: number): Promise<void>;
  waitForSettled(): Promise<unknown>;
  close(): Promise<void>;
  stop(): Promise<void>;
  onReaped(callback: () => void): void;
};


export type AgentWorkerOptions = {
  workspace: string;
  sessionDir: string;
  model?: string;
  appRoot: string;
  bwrapPath?: string;
  appendSystemPrompt?: string;
  hostTools?: string;
  agentToken: string;
  thinkingLevel?: string;
  idleTimeoutMs?: number;
  stopGraceMs?: number;
  now?: () => number;
  hostSocketDir?: string;
  hostTimeline?: string;
  hostAttachments?: string;
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
  credentials: AgentCredentials;
  bwrapPath?: string;
  workerFactory?: AgentWorkerFactory;
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  idleTimeoutMs?: number;
  hostSocketDir?: string;
  hostTimeline?: string;
  hostAttachments?: string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export type AgentNotifier = {
  interrupt(text: string, target: ConversationAgentRef, maxWaitMs?: number): Promise<void>;
  followup(text: string, target: ConversationAgentRef): Promise<void>;
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

function formatTaskFinishedMessage(event: Extract<BotEvent, { type: "task_finished" }>): string {
  const outcome = event.status === "done"
    ? "finished"
    : event.status === "failed"
      ? `failed (exit ${event.exitCode ?? "unknown"})`
      : "aborted";
  return `Task "${truncate(event.prompt, 100)}" ${outcome}. Run files: /workspace/.pi/tasks/${event.runId}/`;
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
      case "task_finished":
        await this.handleTaskFinished(event);
        break;
      case "task_progress":
        await this.handleTaskProgress(event);
        break;
      case "schedule_fired":
        await this.handleScheduleFired(event);
        break;
      case "my_chat_member":
        await this.handleMyChatMember(event);
        break;
      default:
        break;
    }
  }

  private async handleMyChatMember(event: Extract<BotEvent, { type: "my_chat_member" }>): Promise<void> {
    // Only surface group adds; private-chat membership is not a self-provisioning signal.
    if (event.chat_id >= 0) return;
    if (!isBotGroupAdd(event.my_chat_member)) return;
    await this.notifier.followup(
      `Bot was added to group or channel ${event.chat_id}. To allow it, add ${event.chat_id} to /workspace/.allowed.json.`,
      conversationAgent(event.chat_id),
    );
  }

  private async handleTaskFinished(event: Extract<BotEvent, { type: "task_finished" }>): Promise<void> {
    await this.notifier.followup(formatTaskFinishedMessage(event), event.owner);
  }

  private async handleTaskProgress(event: Extract<BotEvent, { type: "task_progress" }>): Promise<void> {
    if (event.tasks.length > 0) await this.notifier.followup(formatTaskProgressMessage(event.tasks), event.owner);
  }

  private async handleScheduleFired(event: Extract<BotEvent, { type: "schedule_fired" }>): Promise<void> {
    await this.notifier.followup(`Scheduled instruction due ${event.dueAt}:\n${event.prompt}`, event.owner);
  }


  private async handleMessage(event: Extract<BotEvent, { type: "message" }>, rawLine: string): Promise<void> {
    const isPrivate = event.chat_id > 0;
    const botInfo = this.botInfoProvider?.();
    const msg = event.message as Parameters<typeof isMessageDirectedToBot>[0];
    if (isPrivate || (msg && isMessageDirectedToBot(msg, botInfo))) {
      const threadId = msg && typeof msg === "object" && "message_thread_id" in msg && typeof msg.message_thread_id === "number"
        ? msg.message_thread_id
        : 0;
      await this.notifier.interrupt(rawLine, conversationAgent(event.chat_id, threadId), USER_INTERRUPT_MAX_WAIT_MS);
    }
  }

  private async handleCallback(event: Extract<BotEvent, { type: "callback" }>, rawLine: string): Promise<void> {
    const query = event.callback_query as { message?: { message_thread_id?: number } } | undefined;
    const threadId = query?.message?.message_thread_id ?? 0;
    await this.notifier.interrupt(rawLine, conversationAgent(event.chat_id, threadId), USER_INTERRUPT_MAX_WAIT_MS);
  }

}

const RESTART_SETTLE_CAP_MS = 30_000;
export const USER_INTERRUPT_MAX_WAIT_MS = 2 * 60 * 1_000;
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


type ConversationWorkerEntry = {
  actor: ConversationAgentRef;
  worker: AgentWorker | undefined;
  token: string | undefined;
  serial: SerialQueue;
};

function conversationKey(actor: ConversationAgentRef): string {
  return `${actor.chatId}:${actor.threadId}`;
}

export class AgentManager {
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly credentials: AgentCredentials;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval | undefined;
  private readonly clearIntervalFn: typeof clearInterval | undefined;
  private readonly workerFactory: AgentWorkerFactory;
  private readonly hostSocketDir: string | undefined;
  private readonly hostTimeline: string | undefined;
  private readonly hostAttachments: string | undefined;
  private readonly workers = new Map<string, ConversationWorkerEntry>();
  private shuttingDown = false;

  constructor(config: { workspace: string }, options: AgentManagerOptions) {
    this.workspace = config.workspace;
    this.appRoot = options.appRoot;
    this.credentials = options.credentials;
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.setIntervalFn = options.setInterval;
    this.clearIntervalFn = options.clearInterval;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiWorker(workerOptions));
    this.hostSocketDir = options.hostSocketDir;
    this.hostTimeline = options.hostTimeline;
    this.hostAttachments = options.hostAttachments;
  }

  private getOrCreateEntry(actor: ConversationAgentRef): ConversationWorkerEntry {
    const key = conversationKey(actor);
    let entry = this.workers.get(key);
    if (!entry) {
      entry = { actor, worker: undefined, token: undefined, serial: new SerialQueue() };
      this.workers.set(key, entry);
    }
    return entry;
  }

  async followup(text: string, target: ConversationAgentRef): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = this.getOrCreateEntry(target);
    return entry.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(entry);
      await worker.prompt(text, "followUp");
    });
  }

  async interrupt(text: string, target: ConversationAgentRef, maxWaitMs?: number): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = this.getOrCreateEntry(target);
    return entry.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(entry);
      await worker.prompt(text, "steer", maxWaitMs);
    });
  }

  async restartAll(): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    await Promise.all(
      [...this.workers.values()].map(async (entry) => {
        await entry.serial.run(async () => {
          const worker = entry.worker;
          if (!worker?.isAlive()) {
            this.release(entry, worker);
            return;
          }
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
          this.release(entry, worker);
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
      this.release(entry, worker);
      return worker ? worker.close().catch((error) => console.error("Agent shutdown stop failed", error)) : Promise.resolve();
    });
    await Promise.all(closes);
  }

  async disposeAll(): Promise<void> {
    await this.beginShutdown();
  }

  private release(entry: ConversationWorkerEntry, worker?: AgentWorker): void {
    if (worker && entry.worker !== worker) return;
    if (entry.token) this.credentials.revoke(entry.token);
    entry.token = undefined;
    entry.worker = undefined;
  }

  private async ensureWorker(entry: ConversationWorkerEntry): Promise<AgentWorker> {
    if (entry.worker?.isAlive()) return entry.worker;
    this.release(entry, entry.worker);

    const actor = entry.actor;
    const token = this.credentials.issue(actor, ["send", "annotate", "spawn", "steer_conversation", "steer_task", "cancel"]);
    entry.token = token;
    const settings = await loadUserSettings(this.workspace);
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    const model = settingsProvider && settingsModel ? `${settingsProvider}/${settingsModel}` : undefined;
    const thinkingLevel = typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined;

    const workerOptions: AgentWorkerOptions = {
      workspace: this.workspace,
      sessionDir: `/workspace/${path.join(".pi", "sessions", String(actor.chatId), String(actor.threadId))}`,
      appRoot: this.appRoot,
      agentToken: token,
      now: this.now,
      ...defined({
        bwrapPath: this.bwrapPath,
        model,
        thinkingLevel,
        stopGraceMs: this.stopGraceMs,
        idleTimeoutMs: this.idleTimeoutMs,
        hostSocketDir: this.hostSocketDir,
        hostTimeline: this.hostTimeline,
        hostAttachments: this.hostAttachments,
        setTimeout: this.setTimeoutFn,
        clearTimeout: this.clearTimeoutFn,
        setInterval: this.setIntervalFn,
        clearInterval: this.clearIntervalFn,
      }),
      appendSystemPrompt: SYSTEM_PROMPT,
      hostTools: "send,annotate,spawn,steer_conversation,steer_task,cancel",
      taskRun: false,
      spawnProcess: this.spawnProcess,
      terminateProcessGroup: this.terminateProcessGroup,
    };

    let worker: AgentWorker;
    try {
      worker = await this.workerFactory(workerOptions);
    } catch (error) {
      this.release(entry);
      throw error;
    }
    worker.onReaped(() => this.release(entry, worker));
    entry.worker = worker;
    return worker;
  }
}
