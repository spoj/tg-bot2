import { randomUUID } from "node:crypto";
import { constants as fsConstants, watch } from "node:fs";
import type { FSWatcher, Stats } from "node:fs";
import { lstat, link, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { appendChatEvent } from "./events.js";
import { SerialQueue } from "./queue.js";
import { appendBoundedJsonl, chatPaths, defined, errorCode, numericChatId, openPinnedDirectory, TG_BOT_DIR, type PinnedDirectory } from "./util.js";
import { validateRequest, validateWorkspacePath, type WorkspaceOutboxDispatcher, type WorkspaceOutboxRequest } from "./outbox-protocol.js";

export type WorkspaceOutboxOptions = {
  dataDir: string;
  dispatch: WorkspaceOutboxDispatcher;
  pollIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  watch?: typeof watch;
  logger?: (error: unknown) => void;
};
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 50;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_DIAGNOSTIC_LENGTH = 1_024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_JSONL_LINES = 256;
const MAX_JSONL_BYTES = 64 * 1024;
const JSON_REQUEST = /\.json$/;
// Bound attacker-controlled directory work while preserving lexical ordering of the captured entries.
const MAX_CHAT_DIRECTORIES_PER_POLL = 256;
const MAX_OUTBOX_ENTRIES_PER_CHAT = 256;
const MAX_PROCESSED_ENTRIES_TO_CHECK = 256;
// Recover claims older than five minutes after crashes without racing active senders.
const STALE_CLAIM_AGE_MS = 5 * 60_000;
const CLAIM_HEARTBEAT_INTERVAL_MS = Math.floor(STALE_CLAIM_AGE_MS / 3);
const CLAIM_NAME = /^\.in-progress-(\d+)-[^/]+$/u;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
const OUTBOX_DIR = "outbox";
const POLL_RESULTS_FILE = "poll-results.jsonl";

type ClaimLease = {
  stop: () => Promise<void>;
};
type ChatWatcher = {
  watcher: FSWatcher;
  debounce: ReturnType<typeof setTimeout> | undefined;
};

type OutboxEntry = {
  name: string;
  path: string;
};

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function errorMessage(error: unknown): string {
  let detail: string;
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    detail = "unknown error";
  }
  return detail.length > MAX_DIAGNOSTIC_LENGTH ? `${detail.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : detail;
}

function isNotLinkable(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EISDIR" || code === "EINVAL" || code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "EXDEV";
}

async function readRequest(filePath: string): Promise<WorkspaceOutboxRequest> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Outbox request is not a regular file");
    if (stat.size > MAX_REQUEST_BYTES) throw new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`);

    const buffer = Buffer.allocUnsafe(MAX_REQUEST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      bytesRead += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    if (bytesRead > MAX_REQUEST_BYTES) throw new Error(`Outbox request exceeds ${MAX_REQUEST_BYTES} bytes`);

    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Outbox request contains malformed JSON");
    }
    return validateRequest(parsed);
  } finally {
    await handle.close();
  }
}

async function openChildDirectory(parent: PinnedDirectory, name: string): Promise<PinnedDirectory> {
  const child = path.join(parent.path, name);
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  return openPinnedDirectory(child);
}
async function readBoundedEntries(directory: string, limit: number) {
  const directoryHandle = await opendir(directory);
  const entries = [];
  try {
    for (;;) {
      const entry = await directoryHandle.read();
      if (entry === null) break;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
  } finally {
    await directoryHandle.close().catch(() => {});
  }
  return entries;
}

export class WorkspaceOutbox {
  private readonly dataDir: string;
  private readonly dispatch: WorkspaceOutboxDispatcher;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly watchFs: typeof watch;
  private readonly logger: (error: unknown) => void;
  private readonly queues = new Map<number, SerialQueue>();
  private readonly chatWatchers = new Map<number, ChatWatcher>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceOutboxOptions) {
    if (!Number.isSafeInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) || (options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) <= 0 || (options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) > MAX_TIMER_MS) {
      throw new Error("Outbox poll interval must be a positive timer-safe integer");
    }
    this.dataDir = path.resolve(options.dataDir);
    this.dispatch = options.dispatch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace outbox error", error));
    this.watchFs = options.watch ?? watch;
  }

  async start(): Promise<void> {
    if (this.running) {
      if (this.startInFlight) await this.startInFlight;
      return;
    }
    this.running = true;
    const initialPoll = this.poll();
    this.startInFlight = initialPoll;
    try {
      await initialPoll;
    } finally {
      if (this.startInFlight === initialPoll) this.startInFlight = undefined;
    }
    if (!this.running) return;
    this.timer = this.schedule(() => {
      void this.poll().catch((error) => this.report(error));
    }, this.pollIntervalMs);
    const unref = (this.timer as unknown as { unref?: () => void }).unref;
    unref?.call(this.timer);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.closeWatchers();
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    for (;;) {
      const pending: Promise<void>[] = [];
      if (this.startInFlight) pending.push(this.startInFlight);
      if (this.pollInFlight) pending.push(this.pollInFlight);
      let queued = 0;
      for (const queue of this.queues.values()) queued += queue.size;
      if (queued > 0) pending.push((async (): Promise<void> => {
        for (;;) {
          const live = [...this.queues.values()];
          if (live.length === 0) return;
          await Promise.all(live.map((queue) => queue.idle()));
          await Promise.resolve();
        }
      })());
      if (pending.length === 0) return;
      await Promise.all(pending.map((operation) => operation.catch(() => {})));
    }
  }

  /** Poll numeric chat workspaces; concurrent calls share one operation. */
  async poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    const operation = this.runPoll();
    this.pollInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = undefined;
    }
  }

  /** Process one numeric chat workspace; same-chat calls are serialized. Reuse a poll-pinned chats root when available. */
  async processChat(chatId: number, chatsRoot?: PinnedDirectory): Promise<void> {
    if (!Number.isSafeInteger(chatId)) throw new Error("Outbox chat ID must be a safe integer");
    const workspace = chatPaths(this.dataDir, chatId).workspace;
    await this.enqueueChatScan(chatId, workspace, chatsRoot);
  }

  private enqueueChatScan(chatId: number, workspace: string, chatsRoot?: PinnedDirectory): Promise<void> {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(chatId, queue);
    }
    return queue.run(() => this.processChatNow(chatId, workspace, chatsRoot)).finally(() => {
      if (queue.size === 0 && this.queues.get(chatId) === queue) {
        this.queues.delete(chatId);
      }
    });
  }

  /** Watch one chat's outbox directory, scheduling a debounced scan on filesystem events. */
  private async ensureWatcher(chatId: number, workspace: string): Promise<void> {
    if (!this.running || this.chatWatchers.has(chatId)) return;
    const outboxDirectory = path.join(workspace, TG_BOT_DIR, OUTBOX_DIR);
    let stat: Stats;
    try {
      stat = await lstat(outboxDirectory);
    } catch (error) {
      if (!isMissing(error)) this.report(error);
      return;
    }
    if (!this.running) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    let watcher: FSWatcher;
    try {
      watcher = this.watchFs(outboxDirectory);
    } catch (error) {
      this.report(error);
      return;
    }
    const entry: ChatWatcher = { watcher, debounce: undefined };
    this.chatWatchers.set(chatId, entry);
    watcher.on("change", () => this.debounceChatScan(chatId, workspace));
    watcher.on("rename", () => this.debounceChatScan(chatId, workspace));
    const disarm = (): void => {
      if (this.chatWatchers.get(chatId) !== entry) return;
      clearTimeout(entry.debounce);
      entry.debounce = undefined;
      this.chatWatchers.delete(chatId);
    };
    watcher.on("error", disarm);
    watcher.on("close", disarm);
  }

  private debounceChatScan(chatId: number, workspace: string): void {
    const entry = this.chatWatchers.get(chatId);
    if (!entry) return;
    clearTimeout(entry.debounce);
    const timer = setTimeout(() => {
      if (this.chatWatchers.get(chatId) !== entry) return;
      entry.debounce = undefined;
      void this.enqueueChatScan(chatId, workspace).catch((error) => this.report(error));
    }, WATCH_DEBOUNCE_MS);
    entry.debounce = timer;
    timer.unref();
  }

  private closeWatchers(): void {
    for (const entry of this.chatWatchers.values()) {
      clearTimeout(entry.debounce);
      entry.debounce = undefined;
      try {
        entry.watcher.close();
      } catch {
        // Watcher teardown must never interrupt shutdown.
      }
    }
    this.chatWatchers.clear();
  }


  private async runPoll(): Promise<void> {
    let chatsRoot: PinnedDirectory | undefined;
    try {
      chatsRoot = await openPinnedDirectory(path.join(this.dataDir, "chats"));
      const entries = await readBoundedEntries(chatsRoot.path, MAX_CHAT_DIRECTORIES_PER_POLL);
      const chats = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => ({ chatId: numericChatId(entry.name), name: entry.name }))
        .filter((entry): entry is { chatId: number; name: string } => entry.chatId !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const { chatId } of chats) {
        const workspace = chatPaths(this.dataDir, chatId).workspace;
        if (this.running) await this.ensureWatcher(chatId, workspace);
        try {
          await this.processChat(chatId, chatsRoot);
        } catch (error) {
          this.report(error);
        }
      }
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (chatsRoot) await this.closeDirectory(chatsRoot);
    }
  }

  private async processChatNow(chatId: number, workspace: string, chatsRoot?: PinnedDirectory): Promise<void> {
    let openedChatsRoot: PinnedDirectory | undefined;
    let chatDirectory: PinnedDirectory | undefined;
    let workspaceDirectory: PinnedDirectory | undefined;
    let metadata: PinnedDirectory | undefined;
    let outbox: PinnedDirectory | undefined;
    let processed: PinnedDirectory | undefined;
    let failed: PinnedDirectory | undefined;
    try {
      openedChatsRoot = chatsRoot ?? await openPinnedDirectory(path.join(this.dataDir, "chats"));
      chatDirectory = await openPinnedDirectory(path.join(openedChatsRoot.path, String(chatId)));
      workspaceDirectory = await openPinnedDirectory(path.join(chatDirectory.path, "workspace"));
      if (workspaceDirectory.realPath !== path.join(chatDirectory.realPath, "workspace")) {
        throw new Error(`Workspace for chat ${chatId} is outside the chat directory`);
      }
      metadata = await openPinnedDirectory(path.join(workspaceDirectory.path, TG_BOT_DIR));
      outbox = await openPinnedDirectory(path.join(metadata.path, OUTBOX_DIR));
      const outboxPath = outbox.path;
      processed = await openChildDirectory(outbox, "processed");
      failed = await openChildDirectory(outbox, "failed");

      const entries = (await readBoundedEntries(outbox.path, MAX_OUTBOX_ENTRIES_PER_CHAT))
        .filter((entry) => JSON_REQUEST.test(entry.name) || CLAIM_NAME.test(entry.name))
        .map((entry) => ({ name: entry.name, path: path.join(outboxPath, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const claimMatch = CLAIM_NAME.exec(entry.name);
        const stale = claimMatch !== null && this.isStaleClaim(claimMatch);
        if (claimMatch !== null && !stale) continue;
        if (stale && await this.claimWasAlreadyArchived(entry, processed, chatId)) continue;
        const claim = await this.claimEntry(outbox, entry, chatId, stale);
        if (!claim) continue;
        const archiveName = entry.name;
        let lease: ClaimLease | undefined;
        let request: WorkspaceOutboxRequest | undefined;
        try {
          lease = this.startClaimLease(claim, chatId);
          request = await readRequest(claim.path);
          if (request.type === "send_file") validateWorkspacePath(workspace, request.path);
          const result = await this.dispatch(chatId, request);
          if (result !== undefined) {
            try {
              if (result.messageId !== undefined) {
                appendChatEvent(workspace, {
                  type: "send",
                  kind: request.type,
                  id: request.id,
                  messageId: result.messageId,
                  ...defined({ pollId: result.pollId }),
                  ok: true,
                });
              }
              if (result.data !== undefined) {
                await appendBoundedJsonl(
                  path.join(metadata.path, POLL_RESULTS_FILE),
                  JSON.stringify({ id: request.id, result: result.data }),
                  { maxLines: MAX_JSONL_LINES, maxBytes: MAX_JSONL_BYTES },
                );
              }
            } catch (error) {
              // Delivery succeeded; a lost ack or result must never resend the request.
              this.reportRequestError(chatId, archiveName, error);
            }
          }
        } catch (error) {
          if (lease) {
            await lease.stop();
            lease = undefined;
          }
          try {
            await this.archiveClaimed(claim.path, failed, archiveName);
          } catch (moveError) {
            this.report(moveError);
          }
          if (request !== undefined) {
            appendChatEvent(workspace, {
              type: "send",
              kind: request.type,
              id: request.id,
              ok: false,
              error: errorMessage(error),
            });
          }
          this.reportRequestError(chatId, archiveName, error);
          continue;
        }

        if (lease) {
          await lease.stop();
          lease = undefined;
        }
        try {
          await this.archiveClaimed(claim.path, processed, archiveName);
        } catch (error) {
          // Sending succeeded. Never put this request in failed, where it would be resent.
          this.reportRequestError(chatId, archiveName, error);
          try {
            await this.discardSentClaim(claim.path);
          } catch (discardError) {
            this.report(discardError);
          }
        }
      }
    } catch (error) {
      if (!isMissing(error)) this.report(error);
    } finally {
      if (failed) await this.closeDirectory(failed);
      if (processed) await this.closeDirectory(processed);
      if (outbox) await this.closeDirectory(outbox);
      if (metadata) await this.closeDirectory(metadata);
      if (workspaceDirectory) await this.closeDirectory(workspaceDirectory);
      if (chatDirectory) await this.closeDirectory(chatDirectory);
      if (chatsRoot === undefined && openedChatsRoot) await this.closeDirectory(openedChatsRoot);
    }
  }

  private startClaimLease(claim: OutboxEntry, chatId: number): ClaimLease {
    let stopped = false;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = (): void => {
      if (stopped || heartbeatInFlight) return;
      const operation = this.refreshClaim(claim);
      heartbeatInFlight = operation;
      void operation
        .catch((error) => this.reportRequestError(chatId, claim.name, error))
        .finally(() => {
          if (heartbeatInFlight === operation) heartbeatInFlight = undefined;
        });
    };
    const timer = this.schedule(heartbeat, CLAIM_HEARTBEAT_INTERVAL_MS);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
    return {
      stop: async () => {
        stopped = true;
        this.cancelSchedule(timer);
        if (heartbeatInFlight) await heartbeatInFlight.catch(() => {});
      },
    };
  }

  private async refreshClaim(claim: OutboxEntry): Promise<void> {
    const previousPath = claim.path;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimName = `.in-progress-${this.now()}-${randomUUID()}`;
      const claimPath = path.join(path.dirname(previousPath), claimName);
      try {
        await rename(previousPath, claimPath);
        claim.name = claimName;
        claim.path = claimPath;
        return;
      } catch (error) {
        if (isExisting(error)) continue;
        throw error;
      }
    }
    throw new Error("Unable to refresh outbox request lease");
  }

  private isStaleClaim(match: RegExpExecArray): boolean {
    const createdAt = Number(match[1]);
    if (!Number.isSafeInteger(createdAt)) return false;
    const current = this.now();
    return Number.isFinite(current) && current >= createdAt && current - createdAt >= STALE_CLAIM_AGE_MS;
  }
  private async claimWasAlreadyArchived(entry: OutboxEntry, processed: PinnedDirectory, chatId: number): Promise<boolean> {
    let claimStat: Awaited<ReturnType<typeof lstat>>;
    try {
      claimStat = await lstat(entry.path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }

    const processedEntries = await readBoundedEntries(processed.path, MAX_PROCESSED_ENTRIES_TO_CHECK);
    for (const processedEntry of processedEntries) {
      if (!processedEntry.isFile() || processedEntry.isSymbolicLink()) continue;
      const processedPath = path.join(processed.path, processedEntry.name);
      let processedStat: Awaited<ReturnType<typeof lstat>>;
      try {
        processedStat = await lstat(processedPath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (processedStat.dev !== claimStat.dev || processedStat.ino !== claimStat.ino) continue;
      try {
        await unlink(entry.path);
      } catch (error) {
        if (!isMissing(error)) this.reportRequestError(chatId, entry.name, error);
      }
      return true;
    }
    return false;
  }

  private async discardSentClaim(claimedPath: string): Promise<void> {
    try {
      await unlink(claimedPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async claimEntry(
    outbox: PinnedDirectory,
    entry: OutboxEntry,
    chatId: number,
    stale = false,
  ): Promise<OutboxEntry | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let claimName: string;
      try {
        claimName = `.in-progress-${this.now()}-${randomUUID()}`;
      } catch (error) {
        this.reportRequestError(chatId, entry.name, error);
        return undefined;
      }
      const claimPath = path.join(outbox.path, claimName);
      try {
        await rename(entry.path, claimPath);
        return { name: claimName, path: claimPath };
      } catch (error) {
        if (isMissing(error)) return undefined;
        if (isExisting(error)) continue;
        this.reportRequestError(chatId, entry.name, error);
        return undefined;
      }
    }
    this.reportRequestError(chatId, entry.name, new Error(`Unable to claim${stale ? " stale" : ""} outbox request`));
    return undefined;
  }

  private async archiveClaimed(claimedPath: string, destination: PinnedDirectory, originalName: string): Promise<void> {
    const preferredPath = path.join(destination.path, originalName);
    const preferred = await this.tryLinkArchive(claimedPath, preferredPath);
    if (preferred.ok) return;
    if (!preferred.retry) throw preferred.error;

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const archiveName = `${originalName}.${this.now()}-${randomUUID()}`;
      const archivePath = path.join(destination.path, archiveName);
      const linked = await this.tryLinkArchive(claimedPath, archivePath);
      if (linked.ok) return;
      if (linked.error && isExisting(linked.error)) continue;
      if (linked.error && !isNotLinkable(linked.error)) throw linked.error;
      try {
        await rename(claimedPath, archivePath);
        return;
      } catch (error) {
        if (isExisting(error)) continue;
        throw error;
      }
    }
    throw new Error("Unable to archive outbox request without a name collision");
  }

  private async tryLinkArchive(claimedPath: string, archivePath: string): Promise<{ ok: true } | { ok: false; retry: boolean; error: unknown }> {
    try {
      await link(claimedPath, archivePath);
    } catch (error) {
      return { ok: false, retry: isExisting(error) || isNotLinkable(error), error };
    }
    try {
      await unlink(claimedPath);
    } catch (error) {
      return { ok: false, retry: false, error };
    }
    return { ok: true };
  }
  private reportRequestError(chatId: number, name: string, error: unknown): void {
    this.report(new Error(`Outbox request ${chatId}/${name} failed: ${errorMessage(error)}`));
  }

  private report(error: unknown): void {
    try {
      this.logger(error);
    } catch {
      // Diagnostics must never interrupt outbox processing.
    }
  }

  private async closeDirectory(directory: PinnedDirectory): Promise<void> {
    try {
      await directory.handle.close();
    } catch (error) {
      this.report(error);
    }
  }
}
