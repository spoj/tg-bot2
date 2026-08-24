import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { PiWorker } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { SerialQueue } from "./queue.js";
import { conversationAgent, type ConversationAgentRef } from "./agent-ref.js";
import type { AgentCredentials } from "./host-bridge.js";
import { appendJsonl, defined, isMissing, readJsonl } from "./util.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import { TIMELINE_PROMPT, type BotEvent, type TimelineEnvelope } from "./events.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";
import { TASKS_PROMPT } from "./task-protocol.js";
import { isMessageDirectedToBot, isBotGroupAdd } from "./telegram.js";

export const SYSTEM_PROMPT = [
`You are a persistent personal Telegram agent serving several chats.
Assistant text is not delivered; communicate with users through send. The host always targets this session's owning chat and topic.
The writable workspace is /workspace. Sessions and agent state live under /workspace/.pi. Host-managed attachments are read-only under /run/attachments; copy one into /workspace before editing it.
For browser automation, create a private profile with mktemp -d /tmp/chrome-profile.XXXXXX, launch /usr/bin/google-chrome-stable --headless --no-sandbox --disable-dev-shm-usage --remote-debugging-port=0 --user-data-dir=<profile>, read the selected port from the first line of <profile>/DevToolsActivePort, then connect with puppeteer-core. Never reuse another agent's profile or a fixed debugging port. The browser survives turns and stops with the session.
Install project extensions with pi install <pkg> -l --approve. Project settings live at /workspace/.pi/settings.json.
`,
  OUTBOX_PROMPT,
  TIMELINE_PROMPT,
  SCHEDULES_PROMPT,
  TASKS_PROMPT,
  `Behavior:
- Every host notification starts with a stable notification ID and, for persisted timeline events, a sequence number. Treat repeated IDs as replay of the same notification.
- User-message notifications contain the complete raw Telegram event. Task and progress notifications name authoritative files; read those files rather than treating status text as the complete instruction or result.
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

export type NotificationIdentity = {
  id: string;
  sequence?: number | undefined;
};

export type AgentNotifier = {
  interrupt(text: string, target: ConversationAgentRef, maxWaitMs?: number, identity?: NotificationIdentity): Promise<void>;
  followup(text: string, target: ConversationAgentRef, identity?: NotificationIdentity): Promise<void>;
};

function preview(text: string, maxLength: number): string {
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
  return `Task ${event.runId} ${outcome}. Complete instruction and results: /workspace/.pi/tasks/${event.runId}/prompt.txt, output.md, result.json`;
}

function formatTaskProgressMessage(tasks: Extract<BotEvent, { type: "task_progress" }>["tasks"]): string {
  const lines = tasks.map((task) => {
    const running = formatDuration(task.runningMs);
    const idle = task.idleMs !== null ? formatDuration(task.idleMs) : "unknown";
    const activity = task.lastOutput ? `; activity preview: "${preview(task.lastOutput, 120)}"` : "";
    return `- ${task.runId} running ${running}, last activity ${idle} ago${activity}; complete instruction: /workspace/.pi/tasks/${task.runId}/prompt.txt`;
  });
  return `Task heartbeat: ${tasks.length} task(s) running. Activity text is a preview only.\n${lines.join("\n")}`;
}
const SERVICE_MESSAGE_FIELDS = [
  "forum_topic_created", "forum_topic_closed", "forum_topic_reopened", "forum_topic_edited",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "new_chat_members", "left_chat_member",
  "new_chat_title", "new_chat_photo", "delete_chat_photo", "group_chat_created", "supergroup_chat_created",
  "channel_chat_created", "message_auto_delete_timer_changed", "migrate_to_chat_id", "migrate_from_chat_id",
  "pinned_message", "video_chat_scheduled", "video_chat_started", "video_chat_ended", "video_chat_participants_invited",
] as const;

function hasUserContent(event: Extract<BotEvent, { type: "message" }>): boolean {
  if (event.attachments.length > 0) return true;
  if (event.message === null || typeof event.message !== "object") return false;
  const message = event.message as Record<string, unknown>;
  return !SERVICE_MESSAGE_FIELDS.some((field) => field in message);
}

function eventIdentity(event: Partial<TimelineEnvelope>): NotificationIdentity | undefined {
  return typeof event.id === "string"
    ? { id: event.id, ...(typeof event.seq === "number" ? { sequence: event.seq } : {}) }
    : undefined;
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

  async onEvent(event: BotEvent & Partial<TimelineEnvelope>, rawLine: string): Promise<void> {
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

  private async handleMyChatMember(event: Extract<BotEvent, { type: "my_chat_member" }> & Partial<TimelineEnvelope>): Promise<void> {
    // Only surface group adds; private-chat membership is not a self-provisioning signal.
    if (event.chat_id >= 0) return;
    if (!isBotGroupAdd(event.my_chat_member)) return;
    await this.notifier.followup(
      `Bot was added to group or channel ${event.chat_id}. To allow it, add ${event.chat_id} to /workspace/.allowed.json.`,
      conversationAgent(event.chat_id),
      eventIdentity(event),
    );
  }

  private async handleTaskFinished(event: Extract<BotEvent, { type: "task_finished" }> & Partial<TimelineEnvelope>): Promise<void> {
    await this.notifier.followup(formatTaskFinishedMessage(event), event.owner, eventIdentity(event));
  }

  private async handleTaskProgress(event: Extract<BotEvent, { type: "task_progress" }> & Partial<TimelineEnvelope>): Promise<void> {
    if (event.tasks.length > 0) await this.notifier.followup(formatTaskProgressMessage(event.tasks), event.owner, eventIdentity(event));
  }

  private async handleScheduleFired(event: Extract<BotEvent, { type: "schedule_fired" }> & Partial<TimelineEnvelope>): Promise<void> {
    await this.notifier.followup(`Scheduled instruction due ${event.dueAt}:\n${event.prompt}`, event.owner, eventIdentity(event));
  }


  private async handleMessage(event: Extract<BotEvent, { type: "message" }> & Partial<TimelineEnvelope>, rawLine: string): Promise<void> {
    if (!hasUserContent(event)) return;
    const isPrivate = event.chat_id > 0;
    const botInfo = this.botInfoProvider?.();
    const msg = event.message as Parameters<typeof isMessageDirectedToBot>[0];
    if (isPrivate || (msg && isMessageDirectedToBot(msg, botInfo))) {
      const threadId = msg && typeof msg === "object" && "message_thread_id" in msg && typeof msg.message_thread_id === "number"
        ? msg.message_thread_id
        : 0;
      await this.notifier.interrupt(rawLine, conversationAgent(event.chat_id, threadId), USER_INTERRUPT_MAX_WAIT_MS, eventIdentity(event));
    }
  }

  private async handleCallback(event: Extract<BotEvent, { type: "callback" }> & Partial<TimelineEnvelope>, rawLine: string): Promise<void> {
    const query = event.callback_query as { message?: { message_thread_id?: number } } | undefined;
    const threadId = query?.message?.message_thread_id ?? 0;
    await this.notifier.interrupt(rawLine, conversationAgent(event.chat_id, threadId), USER_INTERRUPT_MAX_WAIT_MS, eventIdentity(event));
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
type PendingNotification = {
  id: string;
  sequence?: number | undefined;
  target: ConversationAgentRef;
  text: string;
  behavior: "steer" | "followUp";
  maxWaitMs?: number | undefined;
};

type NotificationLogRecord =
  | { type: "queued"; notification: PendingNotification }
  | { type: "delivered"; id: string };

const NOTIFICATIONS_FILE = "notifications.jsonl";
const LEGACY_NOTIFICATIONS_FILE = path.join(".pi", NOTIFICATIONS_FILE);

function notificationPrompt(notification: PendingNotification): string {
  const sequence = notification.sequence === undefined ? "" : ` seq=${notification.sequence}`;
  return `[notification id=${notification.id}${sequence}]\n${notification.text}`;
}


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
  private readonly notificationWrites = new SerialQueue();
  private readonly pendingNotifications = new Map<string, PendingNotification>();
  private readonly deliveredNotifications = new Set<string>();
  private readonly notificationsPath: string;
  private notificationsLoaded: Promise<void> | undefined;
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
    this.notificationsPath = path.join(path.dirname(this.workspace), NOTIFICATIONS_FILE);
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

  async start(): Promise<void> {
    await this.loadPendingNotifications();
    const targets = new Map<string, ConversationAgentRef>();
    for (const notification of this.pendingNotifications.values()) {
      targets.set(conversationKey(notification.target), notification.target);
    }
    await Promise.all([...targets.values()].map(async (target) => {
      const entry = this.getOrCreateEntry(target);
      await entry.serial.run(() => this.deliverPending(entry)).catch((error) => {
        console.error("Pending notification replay failed", error);
      });
    }));
  }

  async followup(text: string, target: ConversationAgentRef, identity?: NotificationIdentity): Promise<void> {
    return this.enqueueAndDeliver({
      id: identity?.id ?? randomUUID(),
      ...(identity?.sequence === undefined ? {} : { sequence: identity.sequence }),
      target,
      text,
      behavior: "followUp",
    });
  }

  async interrupt(text: string, target: ConversationAgentRef, maxWaitMs?: number, identity?: NotificationIdentity): Promise<void> {
    return this.enqueueAndDeliver({
      id: identity?.id ?? randomUUID(),
      ...(identity?.sequence === undefined ? {} : { sequence: identity.sequence }),
      target,
      text,
      behavior: "steer",
      ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
    });
  }

  private async enqueueAndDeliver(notification: PendingNotification): Promise<void> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    await this.enqueueNotification(notification);
    const entry = this.getOrCreateEntry(notification.target);
    return entry.serial.run(async () => {
      if (this.shuttingDown) throw new Error("Agent manager is shutting down");
      await this.deliverPending(entry);
    });
  }

  private async deliverPending(entry: ConversationWorkerEntry): Promise<void> {
    for (;;) {
      const notification = [...this.pendingNotifications.values()].find((candidate) =>
        conversationKey(candidate.target) === conversationKey(entry.actor));
      if (!notification) return;
      const worker = await this.ensureWorker(entry);
      await worker.prompt(notificationPrompt(notification), notification.behavior, notification.maxWaitMs);
      await this.acknowledgeNotification(notification.id);
    }
  }

  private async loadPendingNotifications(): Promise<void> {
    this.notificationsLoaded ??= (async () => {
      await mkdir(path.dirname(this.notificationsPath), { recursive: true, mode: 0o700 });
      const legacyPath = path.join(this.workspace, LEGACY_NOTIFICATIONS_FILE);
      let lines: string[];
      try {
        lines = await readJsonl(this.notificationsPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await rename(legacyPath, this.notificationsPath);
          lines = await readJsonl(this.notificationsPath);
        } catch (migrationError) {
          if (!isMissing(migrationError)) throw migrationError;
          lines = [];
        }
      }
      await rm(legacyPath, { force: true });
      for (const line of lines) {
        const record = JSON.parse(line) as NotificationLogRecord;
        if (record.type === "queued") {
          if (!this.deliveredNotifications.has(record.notification.id)) {
            this.pendingNotifications.set(record.notification.id, record.notification);
          }
        } else if (record.type === "delivered") {
          this.pendingNotifications.delete(record.id);
          this.deliveredNotifications.add(record.id);
        }
      }
    })();
    await this.notificationsLoaded;
  }

  private async enqueueNotification(notification: PendingNotification): Promise<void> {
    await this.loadPendingNotifications();
    await this.notificationWrites.run(async () => {
      if (this.pendingNotifications.has(notification.id) || this.deliveredNotifications.has(notification.id)) return;
      await appendJsonl(this.notificationsPath, JSON.stringify({ type: "queued", notification } satisfies NotificationLogRecord));
      this.pendingNotifications.set(notification.id, notification);
    });
  }

  private async acknowledgeNotification(id: string): Promise<void> {
    await this.notificationWrites.run(async () => {
      await appendJsonl(this.notificationsPath, JSON.stringify({ type: "delivered", id } satisfies NotificationLogRecord));
      this.pendingNotifications.delete(id);
      this.deliveredNotifications.add(id);
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
    const token = this.credentials.issue(actor, ["send", "annotate", "spawn", "steer_conversation", "steer_task", "cancel", "schedule"]);
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
      hostTools: "send,annotate,spawn,steer_conversation,steer_task,cancel,schedule_add,schedule_replace,schedule_remove,schedule_take",
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
