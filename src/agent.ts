import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { conversationId, conversationSessionPath, type ConversationAgentRef } from "./agent-ref.js";
import type { AgentCredentials } from "./host-bridge.js";
import { PiWorker } from "./pi-worker.js";
import { SerialQueue } from "./queue.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";
import { TIMELINE_PROMPT } from "./events.js";
import { appendJsonl, defined, isMissing, readJsonl } from "./util.js";

const BASE_PROMPT = `You are a persistent personal agent serving one conversation in a shared long-term workspace.
Assistant text is not delivered; communicate through send. The host derives this session's connector-native destination from its authenticated conversation identity.
The writable workspace is /workspace. Sessions and agent state live under /workspace/.pi. Host-managed attachments are read-only under /run/attachments; copy one into /workspace before editing it.
For browser automation, create a private profile with mktemp -d /tmp/chrome-profile.XXXXXX, launch /usr/bin/google-chrome-stable --headless --no-sandbox --disable-dev-shm-usage --remote-debugging-port=0 --user-data-dir=<profile>, read the selected port from the first line of <profile>/DevToolsActivePort, then connect with puppeteer-core. Never reuse another agent's profile or a fixed debugging port. The browser survives turns and stops with the session.
Install project extensions with pi install <pkg> -l --approve. Project settings live at /workspace/.pi/settings.json.
`;

const BEHAVIOR_PROMPT = `Behavior:
- Every host notification starts with a stable notification ID and, for persisted timeline events, a sequence number. Treat repeated IDs as replay of the same notification.
- Inbound notifications contain the complete persisted connector event. Read its connector-native payload directly.
- Keep user-facing replies concise unless the user asks for detail.
- After interpreting an attachment, call annotate with its exact /run/attachments path and a short factual description. The host inserts it into the attachment's original timeline event for later search.
- Use steer_conversation to wake another conversation owner when work belongs to it. Copy the target conversation object from /run/timeline.jsonl and give a concrete instruction; do not send into its conversation yourself.
- Read only the context needed: this conversation in /run/timeline.jsonl, then its connector, then the wider workspace. Older sessions are under /workspace/.pi/sessions.
- Connector access policy is described by the connector prompt. Notification overrides live in this agent's notifications.json beside its session file; use {"wake":["event.type"],"mute":["event.type"]}. /restart applies model and notification setting changes.
- Always give bash commands that can hang an explicit timeout in seconds. Use 300 by default; increase it only when the operation requires more time.
`;

export function systemPrompt(connectorPrompt: string, notificationPath = "notifications.json"): string {
  return [BASE_PROMPT, connectorPrompt, TIMELINE_PROMPT, SCHEDULES_PROMPT, BEHAVIOR_PROMPT, `Notification settings path: ${notificationPath}.\n`].join("");
}

export const SYSTEM_PROMPT = systemPrompt("");

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
  notificationsPath: string;
  connectorPrompt: (connectorId: string) => string;
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

export type NotificationIdentity = { id: string; sequence?: number | undefined };

export type AgentNotifier = {
  interrupt(text: string, target: ConversationAgentRef, maxWaitMs?: number, identity?: NotificationIdentity): Promise<void>;
  followup(text: string, target: ConversationAgentRef, identity?: NotificationIdentity): Promise<void>;
};

const RESTART_SETTLE_CAP_MS = 30_000;
export const USER_INTERRUPT_MAX_WAIT_MS = 2 * 60 * 1_000;
const USER_SETTINGS_RELATIVE_PATH = path.join(".pi", "agent", "settings.json");

export async function loadUserSettings(workspace: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(workspace, USER_SETTINGS_RELATIVE_PATH), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
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

function notificationPrompt(notification: PendingNotification): string {
  const sequence = notification.sequence === undefined ? "" : ` seq=${notification.sequence}`;
  return `[notification id=${notification.id}${sequence}]\n${notification.text}`;
}

function validateNotificationTarget(value: unknown): ConversationAgentRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid notification target");
  const target = value as Record<string, unknown>;
  if (target.kind !== "conversation" || typeof target.connectorId !== "string" || typeof target.conversationKey !== "string"
    || target.address === null || typeof target.address !== "object" || Array.isArray(target.address)) {
    throw new Error("Invalid notification target");
  }
  return {
    kind: "conversation",
    connectorId: target.connectorId,
    conversationKey: target.conversationKey,
    address: target.address as Record<string, unknown>,
  };
}

export class AgentManager {
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly credentials: AgentCredentials;
  private readonly notificationsPath: string;
  private readonly connectorPrompt: (connectorId: string) => string;
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
  private notificationsLoaded: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(config: { workspace: string }, options: AgentManagerOptions) {
    this.workspace = config.workspace;
    this.appRoot = options.appRoot;
    this.credentials = options.credentials;
    this.notificationsPath = path.resolve(options.notificationsPath);
    this.connectorPrompt = options.connectorPrompt;
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
    const key = conversationId(actor);
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
    for (const notification of this.pendingNotifications.values()) targets.set(conversationId(notification.target), notification.target);
    await Promise.all([...targets.values()].map(async (target) => {
      const entry = this.getOrCreateEntry(target);
      await entry.serial.run(() => this.deliverPending(entry)).catch((error) => console.error("Pending notification replay failed", error));
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
      const notification = [...this.pendingNotifications.values()].find((candidate) => sameTarget(candidate.target, entry.actor));
      if (!notification) return;
      const worker = await this.ensureWorker(entry);
      await worker.prompt(notificationPrompt(notification), notification.behavior, notification.maxWaitMs);
      await this.acknowledgeNotification(notification.id);
    }
  }

  private async loadPendingNotifications(): Promise<void> {
    this.notificationsLoaded ??= (async () => {
      await mkdir(path.dirname(this.notificationsPath), { recursive: true, mode: 0o700 });
      let lines: string[];
      try {
        lines = await readJsonl(this.notificationsPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        lines = [];
      }
      for (const line of lines) {
        const record = JSON.parse(line) as NotificationLogRecord;
        if (record.type === "queued") {
          const notification = { ...record.notification, target: validateNotificationTarget(record.notification.target) };
          if (!this.deliveredNotifications.has(notification.id)) this.pendingNotifications.set(notification.id, notification);
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
    await Promise.all([...this.workers.values()].map(async (entry) => {
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
    }));
  }

  async beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(entries.map((entry) => {
      const worker = entry.worker;
      this.release(entry, worker);
      return worker ? worker.close().catch((error) => console.error("Agent shutdown stop failed", error)) : Promise.resolve();
    }));
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
    const token = this.credentials.issue(actor, ["send", "annotate", "steer_conversation", "schedule"]);
    entry.token = token;
    const settings = await loadUserSettings(this.workspace);
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    const model = settingsProvider && settingsModel ? `${settingsProvider}/${settingsModel}` : undefined;
    const thinkingLevel = typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined;
    const sessionDir = path.posix.join("/workspace/.pi/sessions", conversationSessionPath(actor));
    const workerOptions: AgentWorkerOptions = {
      workspace: this.workspace,
      sessionDir,
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
      appendSystemPrompt: systemPrompt(this.connectorPrompt(actor.connectorId), path.posix.join(sessionDir, "notifications.json")),
      hostTools: "send,annotate,steer_conversation,schedule_add,schedule_replace,schedule_remove,schedule_take",
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
    entry.worker = worker;
    worker.onReaped(() => this.release(entry, worker));
    return worker;
  }
}

function sameTarget(left: ConversationAgentRef, right: ConversationAgentRef): boolean {
  return left.connectorId === right.connectorId && left.conversationKey === right.conversationKey;
}
export { AgentEventRouter } from "./agent-router.js";
