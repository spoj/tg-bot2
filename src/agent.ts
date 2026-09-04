import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { conversationId, conversationSessionPath, type ConversationAgentRef } from "./agent-ref.js";
import type { AgentCredentials } from "./host-bridge.js";
import { PiWorker } from "./pi-worker.js";
import { SerialQueue } from "./queue.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import type { TimelineRecord } from "./events.js";
import { appendJsonl, defined, isMissing, readJsonl, replaceFileAtomic } from "./util.js";

export function runtimePrompt(connectorPrompt: string, notificationPath: string): string {
  return `${connectorPrompt}\nNotification settings path: ${notificationPath}.\n`;
}

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
  agentDir: string;
  appRoot: string;
  bwrapPath?: string;
  appendSystemPrompt?: string;
  hostTools?: string;
  agentToken: string;
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
  agentDir: string;
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

export type TimelineRecoveryHandler = (record: TimelineRecord, rawLine: string) => Promise<void>;

export type AgentNotifier = {
  interrupt(text: string, target: ConversationAgentRef, maxWaitMs?: number, identity?: NotificationIdentity): Promise<void>;
  followup(text: string, target: ConversationAgentRef, identity?: NotificationIdentity): Promise<void>;
  markTimelineProcessed?(sequence: number): Promise<void>;
  registerTimelineRecovery?(handler: TimelineRecoveryHandler): void;
  processTimelineEvent?(record: TimelineRecord, rawLine: string, handoff: TimelineRecoveryHandler): Promise<void>;
};

const RESTART_SETTLE_CAP_MS = 30_000;
export const USER_INTERRUPT_MAX_WAIT_MS = 2 * 60 * 1_000;
const MAX_RETAINED_DELIVERED = 1_024;
const NOTIFICATION_COMPACTION_THRESHOLD = 128;
const MAX_PENDING_NOTIFICATIONS = 1_024;
const TIMELINE_RETRY_BASE_MS = 1_000;
const TIMELINE_RETRY_MAX_MS = 30_000;
const WORKER_SHUTDOWN_ACTION_CAP_MS = 1_000;
function managerShutdownError(): Error {
  const error = new Error("Agent manager is shutting down");
  error.name = "AbortError";
  (error as NodeJS.ErrnoException).code = "ABORT_ERR";
  return error;
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
  | { type: "delivered"; id: string; sequence?: number | undefined }
  | { type: "checkpoint"; sequence: number };
type TimelineRecoveryRecord = { record: TimelineRecord; rawLine: string };
type TimelineRetry = TimelineRecoveryRecord & { handoff: TimelineRecoveryHandler; attempt: number; timer: ReturnType<typeof setTimeout> | undefined };
type PendingDeliveryRetry = { attempt: number; timer: ReturnType<typeof setTimeout> | undefined };

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
function parseQueuedNotification(value: unknown): PendingNotification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed queued notification");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) throw new Error("Malformed queued notification ID");
  if (raw.sequence !== undefined && (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1)) {
    throw new Error("Malformed queued notification sequence");
  }
  return { ...raw, target: validateNotificationTarget(raw.target) } as PendingNotification;
}


export class AgentManager {
  private readonly workspace: string;
  private readonly appRoot: string;
  private readonly agentDir: string;
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
  private readonly timelineHandoffs = new SerialQueue();
  private readonly pendingNotifications = new Map<string, PendingNotification>();
  private readonly deliveredNotifications = new Map<string, number | undefined>();
  private readonly workerStarts = new Set<Promise<AgentWorker>>();
  private readonly timelineRetries = new Map<number, TimelineRetry>();
  private readonly timelineRetryRuns = new Set<Promise<void>>();
  private readonly pendingDeliveryRetries = new Map<ConversationWorkerEntry, PendingDeliveryRetry>();
  private readonly shutdownSignal: Promise<void>;
  private resolveShutdownSignal!: () => void;
  private shutdownPromise: Promise<void> | undefined;
  private notificationsLoaded: Promise<void> | undefined;
  private notificationRecordsSinceCompaction = 0;
  private timelineCursor = 0;
  private timelineRecoveryHandler: TimelineRecoveryHandler | undefined;
  private timelineRecoveryDone = false;
  private timelineHandoffActive = false;
  private shuttingDown = false;
  constructor(config: { workspace: string }, options: AgentManagerOptions) {
    this.workspace = config.workspace;
    this.appRoot = options.appRoot;
    this.agentDir = options.agentDir;
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
    this.shutdownSignal = new Promise<void>((resolve) => { this.resolveShutdownSignal = resolve; });
    this.hostSocketDir = options.hostSocketDir;
    this.hostTimeline = options.hostTimeline;
    this.hostAttachments = options.hostAttachments;
  }

  private getOrCreateEntry(actor: ConversationAgentRef): ConversationWorkerEntry {
    if (this.shuttingDown) throw managerShutdownError();
    const key = conversationId(actor);
    let entry = this.workers.get(key);
    if (!entry) {
      entry = { actor, worker: undefined, token: undefined, serial: new SerialQueue() };
      this.workers.set(key, entry);
    }
    return entry;
  }

  registerTimelineRecovery(handler: TimelineRecoveryHandler): void {
    this.timelineRecoveryHandler = handler;
  }

  async processTimelineEvent(record: TimelineRecord, rawLine: string, handoff: TimelineRecoveryHandler): Promise<void> {
    if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw new Error("Invalid timeline sequence");
    try {
      await this.timelineHandoffs.run(async () => {
        await this.loadPendingNotifications();
        if (this.shuttingDown) throw managerShutdownError();
        if (!this.timelineRecoveryDone) await this.recoverPersistedTimeline();
        if (record.seq > this.timelineCursor + 1) await this.recoverTimelineThrough(record.seq - 1, handoff);
        if (record.seq <= this.timelineCursor) return;
        await this.withTimelineHandoff(() => handoff(record, rawLine));
      });
    } catch (error) {
      this.scheduleTimelineRetry(record, rawLine, handoff);
      throw error;
    }
    this.cancelTimelineRetry(record.seq);
  }

  private scheduleTimelineRetry(record: TimelineRecord, rawLine: string, handoff: TimelineRecoveryHandler): void {
    if (this.shuttingDown) return;
    const previous = this.timelineRetries.get(record.seq);
    if (previous?.timer !== undefined) return;
    const retry: TimelineRetry = {
      record,
      rawLine,
      handoff,
      attempt: (previous?.attempt ?? 0) + 1,
      timer: undefined,
    };
    const delay = Math.min(TIMELINE_RETRY_MAX_MS, TIMELINE_RETRY_BASE_MS * 2 ** (retry.attempt - 1));
    retry.timer = this.setTimeoutFn(() => {
      if (this.timelineRetries.get(record.seq) !== retry) return;
      retry.timer = undefined;
      const run = this.processTimelineEvent(record, rawLine, handoff);
      this.timelineRetryRuns.add(run);
      void run.finally(() => this.timelineRetryRuns.delete(run)).catch(() => {});
    }, delay);
    retry.timer.unref?.();
    this.timelineRetries.set(record.seq, retry);
  }

  private cancelTimelineRetry(sequence: number): void {
    const retry = this.timelineRetries.get(sequence);
    if (!retry) return;
    if (retry.timer !== undefined) this.clearTimeoutFn(retry.timer);
    this.timelineRetries.delete(sequence);
  }

  private async withTimelineHandoff<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.timelineHandoffActive;
    this.timelineHandoffActive = true;
    try {
      return await task();
    } finally {
      this.timelineHandoffActive = previous;
    }
  }
  async markTimelineProcessed(sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid timeline sequence");
    if (this.shuttingDown) throw managerShutdownError();
    await this.loadPendingNotifications();
    await this.notificationWrites.run(async () => {
      if (this.shuttingDown) throw managerShutdownError();
      if (sequence <= this.timelineCursor) return;
      if (this.hostTimeline !== undefined && sequence > this.timelineCursor + 1) {
        throw new Error("Timeline notification sequence gap");
      }
      await this.appendNotificationRecord({ type: "checkpoint", sequence });
      this.timelineCursor = sequence;
      this.pruneDeliveredThrough(sequence);
      await this.maybeCompactNotifications();
    });
  }
  async start(): Promise<void> {
    await this.loadPendingNotifications();
    if (this.shuttingDown) throw managerShutdownError();
    const targets = new Map<string, ConversationAgentRef>();
    for (const notification of this.pendingNotifications.values()) targets.set(conversationId(notification.target), notification.target);
    for (const target of targets.values()) {
      const entry = this.getOrCreateEntry(target);
      this.schedulePendingDelivery(entry);
    }
    try {
      await this.timelineHandoffs.run(() => this.recoverPersistedTimeline());
    } catch (error) {
      if (this.shuttingDown || this.timelineRetries.size === 0) throw error;
      console.error("Timeline startup recovery failed; retry scheduled", error);
    }
  }

  private schedulePendingDelivery(entry: ConversationWorkerEntry): void {
    void entry.serial.run(() => this.deliverPending(entry)).then(
      () => this.cancelPendingDeliveryRetry(entry),
      (error) => {
        console.error("Pending notification replay failed", error);
        this.schedulePendingDeliveryRetry(entry);
      },
    );
  }

  private schedulePendingDeliveryRetry(entry: ConversationWorkerEntry): void {
    if (this.shuttingDown) return;
    const previous = this.pendingDeliveryRetries.get(entry);
    if (previous?.timer !== undefined) return;
    const retry: PendingDeliveryRetry = { attempt: (previous?.attempt ?? 0) + 1, timer: undefined };
    const delay = Math.min(TIMELINE_RETRY_MAX_MS, TIMELINE_RETRY_BASE_MS * 2 ** (retry.attempt - 1));
    retry.timer = this.setTimeoutFn(() => {
      if (this.pendingDeliveryRetries.get(entry) !== retry) return;
      retry.timer = undefined;
      this.schedulePendingDelivery(entry);
    }, delay);
    retry.timer.unref?.();
    this.pendingDeliveryRetries.set(entry, retry);
  }

  private cancelPendingDeliveryRetry(entry: ConversationWorkerEntry): void {
    const retry = this.pendingDeliveryRetries.get(entry);
    if (!retry) return;
    if (retry.timer !== undefined) this.clearTimeoutFn(retry.timer);
    this.pendingDeliveryRetries.delete(entry);
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
    if (this.shuttingDown) throw managerShutdownError();
    await this.enqueueNotification(notification);
    if (this.shuttingDown) throw managerShutdownError();
    const entry = this.getOrCreateEntry(notification.target);
    if (this.timelineHandoffActive && notification.sequence !== undefined) {
      this.schedulePendingDelivery(entry);
      return;
    }
    return entry.serial.run(async () => {
      if (this.shuttingDown) throw managerShutdownError();
      await this.deliverPending(entry);
    });
  }

  private async deliverPending(entry: ConversationWorkerEntry): Promise<void> {
    for (;;) {
      const notification = [...this.pendingNotifications.values()].find((candidate) => sameTarget(candidate.target, entry.actor));
      if (!notification) return;
      const worker = await this.ensureWorker(entry);
      if (this.shuttingDown) throw managerShutdownError();
      const promptAccepted = await Promise.race([
        worker.prompt(notificationPrompt(notification), notification.behavior, notification.maxWaitMs).then(() => true),
        this.shutdownSignal.then(() => false),
      ]);
      if (!promptAccepted) throw managerShutdownError();
      await this.acknowledgeNotification(notification.id);
    }
  }
  private async loadPendingNotifications(): Promise<void> {
    this.notificationsLoaded ??= (async () => {
      await mkdir(path.dirname(this.notificationsPath), { recursive: true, mode: 0o700 });
      let lines: string[];
      let exists = true;
      try {
        lines = await readJsonl(this.notificationsPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        lines = [];
        exists = false;
      }
      this.notificationRecordsSinceCompaction = 0;
      let hasCheckpoint = false;
      let legacyTimelineSequence = 0;
      for (const line of lines) {
        const record = this.parseNotificationLogRecord(line);
        if (record.type === "queued" && record.notification.sequence !== undefined) {
          legacyTimelineSequence = Math.max(legacyTimelineSequence, record.notification.sequence);
        }
        if (record.type === "delivered" && record.sequence !== undefined) {
          legacyTimelineSequence = Math.max(legacyTimelineSequence, record.sequence);
        }
        if (this.applyNotificationLogRecord(record)) hasCheckpoint = true;
      }
      this.pruneDeliveredThrough(this.timelineCursor);
      if (exists && !hasCheckpoint) {
        this.establishLegacyTimelineBaseline(legacyTimelineSequence);
        await this.compactNotifications();
      }
    })();
    await this.notificationsLoaded;
  }

  private parseNotificationLogRecord(line: string): NotificationLogRecord {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed notification log record");
    const record = parsed as NotificationLogRecord;
    if (record.type === "queued") return { type: "queued", notification: parseQueuedNotification(record.notification) };
    if (record.type === "delivered") {
      if (typeof record.id !== "string" || record.id.length === 0) throw new Error("Malformed delivered notification ID");
      if (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || record.sequence < 1)) {
        throw new Error("Malformed delivered notification sequence");
      }
      return record;
    }
    if (record.type === "checkpoint") {
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) throw new Error("Malformed notification checkpoint");
      return record;
    }
    throw new Error("Unknown notification log record");
  }

  private applyNotificationLogRecord(record: NotificationLogRecord): boolean {
    if (record.type === "queued") {
      if (!this.deliveredNotifications.has(record.notification.id)) this.pendingNotifications.set(record.notification.id, record.notification);
      return false;
    }
    if (record.type === "delivered") {
      this.pendingNotifications.delete(record.id);
      this.rememberDelivered(record.id, record.sequence);
      return false;
    }
    this.timelineCursor = Math.max(this.timelineCursor, record.sequence);
    return true;
  }

  /** Establishes a legacy cursor from durable notification identities. */
  private establishLegacyTimelineBaseline(sequence: number): void {
    this.timelineCursor = Math.max(this.timelineCursor, sequence);
    this.pruneDeliveredThrough(this.timelineCursor);
  }

  private async enqueueNotification(notification: PendingNotification): Promise<void> {
    if (this.shuttingDown) throw managerShutdownError();
    await this.loadPendingNotifications();
    await this.notificationWrites.run(async () => {
      if (this.shuttingDown) throw managerShutdownError();
      if (this.pendingNotifications.has(notification.id) || this.deliveredNotifications.has(notification.id)) return;
      if (notification.sequence !== undefined && notification.sequence <= this.timelineCursor) return;
      if (this.pendingNotifications.size >= MAX_PENDING_NOTIFICATIONS) {
        throw new Error("Pending notification backlog is full");
      }
      await this.appendNotificationRecord({ type: "queued", notification });
      this.pendingNotifications.set(notification.id, notification);
      await this.maybeCompactNotifications();
    });
  }

  private async acknowledgeNotification(id: string): Promise<void> {
    await this.notificationWrites.run(async () => {
      const notification = this.pendingNotifications.get(id);
      if (!notification) return;
      await this.appendNotificationRecord({
        type: "delivered",
        id,
        ...(notification.sequence === undefined ? {} : { sequence: notification.sequence }),
      });
      this.pendingNotifications.delete(id);
      this.rememberDelivered(id, notification.sequence);
      await this.maybeCompactNotifications();
    });
  }

  private rememberDelivered(id: string, sequence: number | undefined): void {
    this.deliveredNotifications.delete(id);
    this.deliveredNotifications.set(id, sequence);
    while (this.deliveredNotifications.size > MAX_RETAINED_DELIVERED) {
      let oldest: string | undefined;
      for (const [candidate, candidateSequence] of this.deliveredNotifications) {
        if (candidateSequence === undefined) {
          oldest = candidate;
          break;
        }
        oldest ??= candidate;
      }
      if (oldest === undefined) break;
      this.deliveredNotifications.delete(oldest);
    }
  }
  private pruneDeliveredThrough(sequence: number): boolean {
    let pruned = false;
    for (const [id, deliveredSequence] of this.deliveredNotifications) {
      if (deliveredSequence !== undefined && deliveredSequence <= sequence) {
        this.deliveredNotifications.delete(id);
        pruned = true;
      }
    }
    return pruned;
  }

  private async appendNotificationRecord(record: NotificationLogRecord): Promise<void> {
    await appendJsonl(this.notificationsPath, JSON.stringify(record));
    this.notificationRecordsSinceCompaction += 1;
  }

  private async maybeCompactNotifications(): Promise<void> {
    if (this.notificationRecordsSinceCompaction < NOTIFICATION_COMPACTION_THRESHOLD) return;
    await this.compactNotifications();
  }

  private async compactNotifications(): Promise<void> {
    const records: string[] = [];
    for (const notification of this.pendingNotifications.values()) {
      records.push(JSON.stringify({ type: "queued", notification } satisfies NotificationLogRecord));
    }
    for (const [id, sequence] of this.deliveredNotifications) {
      records.push(JSON.stringify({ type: "delivered", id, ...(sequence === undefined ? {} : { sequence }) } satisfies NotificationLogRecord));
    }
    records.push(JSON.stringify({ type: "checkpoint", sequence: this.timelineCursor } satisfies NotificationLogRecord));
    await replaceFileAtomic(this.notificationsPath, `${records.join("\n")}\n`);
    this.notificationRecordsSinceCompaction = 0;
  }

  private async readTimelineRecords(): Promise<TimelineRecoveryRecord[] | undefined> {
    const timelinePath = this.hostTimeline;
    if (timelinePath === undefined) return undefined;
    let lines: string[];
    try {
      lines = await readJsonl(timelinePath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const records: TimelineRecoveryRecord[] = [];
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed timeline record");
      const record = parsed as TimelineRecord;
      if (record.v !== 2) throw new Error("Timeline migration did not complete");
      if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw new Error("Malformed timeline sequence");
      records.push({ record, rawLine: line });
    }
    return records;
  }

  private initializeTimelineBaseline(records: readonly TimelineRecoveryRecord[]): void {
    const firstSequence = records[0]?.record.seq;
    if (firstSequence === undefined || firstSequence <= 1 || this.timelineCursor >= firstSequence - 1) return;
    this.timelineCursor = firstSequence - 1;
    this.pruneDeliveredThrough(this.timelineCursor);
  }

  private async recoverTimelineThrough(targetSequence: number, recovery: TimelineRecoveryHandler): Promise<void> {
    const records = await this.readTimelineRecords();
    if (records === undefined) return;
    this.initializeTimelineBaseline(records);
    for (const { record, rawLine } of records) {
      if (record.seq > targetSequence) break;
      if (this.shuttingDown) throw managerShutdownError();
      if (record.seq <= this.timelineCursor) continue;
      await this.withTimelineHandoff(() => recovery(record, rawLine));
    }
  }

  private async recoverPersistedTimeline(): Promise<void> {
    const recovery = this.timelineRecoveryHandler;
    if (this.timelineRecoveryDone || !this.hostTimeline || !recovery) return;
    const records = await this.readTimelineRecords();
    if (records === undefined) {
      this.timelineRecoveryDone = true;
      return;
    }
    this.initializeTimelineBaseline(records);
    for (const { record, rawLine } of records) {
      if (this.shuttingDown) throw managerShutdownError();
      if (record.seq <= this.timelineCursor) continue;
      try {
        await this.withTimelineHandoff(() => recovery(record, rawLine));
      } catch (error) {
        console.error("Timeline notification recovery failed", error);
        this.scheduleTimelineRetry(record, rawLine, recovery);
        throw error;
      }
    }
    this.timelineRecoveryDone = true;
  }

  async restartAll(): Promise<void> {
    if (this.shuttingDown) throw managerShutdownError();
    await Promise.all([...this.workers.values()].map(async (entry) => {
      await entry.serial.run(async () => {
        const worker = entry.worker;
        if (!worker?.isAlive()) {
          this.release(entry, worker);
          return;
        }
        let settleTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            worker.waitForSettled(),
            new Promise<void>((resolve) => {
              settleTimer = this.setTimeoutFn(resolve, RESTART_SETTLE_CAP_MS);
              settleTimer.unref?.();
            }),
          ]);
        } finally {
          if (settleTimer !== undefined) this.clearTimeoutFn(settleTimer);
        }
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
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.resolveShutdownSignal();
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    for (const retry of this.timelineRetries.values()) {
      if (retry.timer !== undefined) this.clearTimeoutFn(retry.timer);
    }
    this.timelineRetries.clear();
    for (const retry of this.pendingDeliveryRetries.values()) {
      if (retry.timer !== undefined) this.clearTimeoutFn(retry.timer);
    }
    this.pendingDeliveryRetries.clear();
    const entries = [...this.workers.values()];
    this.workers.clear();
    const closing = entries.map((entry) => {
      const worker = entry.worker;
      this.release(entry, worker);
      return worker ? this.closeWorkerForShutdown(worker) : Promise.resolve();
    });
    const starts = [...this.workerStarts];
    await Promise.allSettled([
      this.timelineHandoffs.idle(),
      ...this.timelineRetryRuns,
      ...closing,
      ...starts.map((start) => start.catch(() => {})),
      ...entries.map((entry) => entry.serial.idle()),
      this.notificationWrites.idle(),
      ...(this.notificationsLoaded === undefined ? [] : [this.notificationsLoaded]),
    ]);
  }

  async disposeAll(): Promise<void> {
    await this.beginShutdown();
  }

  private async closeWorkerForShutdown(worker: AgentWorker): Promise<void> {
    const capMs = this.stopGraceMs ?? WORKER_SHUTDOWN_ACTION_CAP_MS;
    const closeCompleted = await this.runBoundedWorkerAction(() => worker.close(), capMs);
    if (closeCompleted) return;
    console.error("Agent shutdown close timed out");
    const stopCompleted = await this.runBoundedWorkerAction(() => worker.stop(), capMs);
    if (!stopCompleted) console.error("Agent shutdown stop timed out");
  }

  private async runBoundedWorkerAction(action: () => Promise<void>, capMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve().then(action).then(
      () => true,
      (error) => {
        console.error("Agent shutdown worker action failed", error);
        return false;
      },
    );
    const timeout = new Promise<boolean>((resolve) => {
      timer = this.setTimeoutFn(() => resolve(false), capMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) this.clearTimeoutFn(timer);
    }
  }

  private release(entry: ConversationWorkerEntry, worker?: AgentWorker): void {
    if (worker && entry.worker !== worker) return;
    if (entry.token) this.credentials.revoke(entry.token);
    entry.token = undefined;
    entry.worker = undefined;
  }

  private async ensureWorker(entry: ConversationWorkerEntry): Promise<AgentWorker> {
    if (this.shuttingDown) throw managerShutdownError();
    if (entry.worker?.isAlive()) return entry.worker;
    this.release(entry, entry.worker);
    if (this.shuttingDown) throw managerShutdownError();
    const actor = entry.actor;
    const token = this.credentials.issue(actor, ["send", "annotate", "steer_conversation", "schedule"]);
    entry.token = token;
    try {
      const sessionDir = path.posix.join("/workspace/.pi/sessions", conversationSessionPath(actor));
      const workerOptions: AgentWorkerOptions = {
        workspace: this.workspace,
        sessionDir,
        appRoot: this.appRoot,
        agentDir: this.agentDir,
        agentToken: token,
        now: this.now,
        ...defined({
          bwrapPath: this.bwrapPath,
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
        appendSystemPrompt: runtimePrompt(this.connectorPrompt(actor.connectorId), path.posix.join(sessionDir, "notifications.json")),
        hostTools: "send,annotate,steer_conversation,schedule_add,schedule_replace,schedule_remove,schedule_take",
        spawnProcess: this.spawnProcess,
        terminateProcessGroup: this.terminateProcessGroup,
      };
      const starting = this.createWorker(entry, token, workerOptions);
      this.workerStarts.add(starting);
      try {
        return await starting;
      } finally {
        this.workerStarts.delete(starting);
      }
    } catch (error) {
      this.release(entry);
      throw error;
    }
  }

  private async createWorker(entry: ConversationWorkerEntry, token: string, options: AgentWorkerOptions): Promise<AgentWorker> {
    if (this.shuttingDown) throw managerShutdownError();
    const worker = await this.workerFactory(options);
    if (this.shuttingDown) {
      await this.closeWorkerForShutdown(worker);
      throw managerShutdownError();
    }
    if (entry.token !== token) {
      await this.closeWorkerForShutdown(worker);
      throw managerShutdownError();
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
