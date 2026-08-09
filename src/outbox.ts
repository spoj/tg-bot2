import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, link, unlink } from "node:fs/promises";
import path from "node:path";

export type WorkspaceOutboxRequest = {
  version: 1;
  id: string;
  type: "send_file";
  path: string;
  caption?: string;
};

export type WorkspaceOutboxSender = (
  chatId: number,
  sandboxPath: string,
  caption?: string,
) => Promise<void>;

export type WorkspaceOutboxOptions = {
  dataDir: string;
  sendFile: WorkspaceOutboxSender;
  pollIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: (error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_DIAGNOSTIC_LENGTH = 1_024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_REQUEST_PATH_LENGTH = 4_096;
const MAX_REQUEST_CAPTION_LENGTH = 16 * 1024;
const CHAT_DIRECTORY = /^-?\d+$/;
const JSON_REQUEST = /\.json$/;
// Recover claims older than five minutes after crashes without racing active senders.
const STALE_CLAIM_AGE_MS = 5 * 60_000;
const CLAIM_HEARTBEAT_INTERVAL_MS = Math.floor(STALE_CLAIM_AGE_MS / 3);
const CLAIM_NAME = /^\.in-progress-(\d+)-[^/]+$/u;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;

type ClaimLease = {
  stop: () => Promise<void>;
};


type OutboxEntry = {
  name: string;
  path: string;
  originalName?: string;
};

type PinnedDirectory = {
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
  realPath: string;
};

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotLinkable(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EISDIR" || code === "EINVAL" || code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "EXDEV";
}

function isDirectoryEntry(entry: Awaited<ReturnType<typeof lstat>>): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink();
}

function numericChatId(name: string): number | undefined {
  if (!CHAT_DIRECTORY.test(name)) return undefined;
  const chatId = Number(name);
  return Number.isSafeInteger(chatId) && String(chatId) === name ? chatId : undefined;
}

function outside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function validateRequest(value: unknown): WorkspaceOutboxRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (request.version !== 1) throw new Error("Outbox request version must be 1");
  if (request.type !== "send_file") throw new Error("Outbox request type must be send_file");
  if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Outbox request id must be a non-empty string");
  if (request.id.length > MAX_REQUEST_ID_LENGTH) throw new Error(`Outbox request id must be at most ${MAX_REQUEST_ID_LENGTH} characters`);
  if (typeof request.path !== "string" || request.path.length === 0) throw new Error("Outbox request path must be a non-empty string");
  if (request.path.length > MAX_REQUEST_PATH_LENGTH) throw new Error(`Outbox request path must be at most ${MAX_REQUEST_PATH_LENGTH} characters`);
  if (request.caption !== undefined && typeof request.caption !== "string") {
    throw new Error("Outbox request caption must be a string");
  }
  if (typeof request.caption === "string" && request.caption.length > MAX_REQUEST_CAPTION_LENGTH) {
    throw new Error(`Outbox request caption must be at most ${MAX_REQUEST_CAPTION_LENGTH} characters`);
  }
  return {
    version: 1,
    id: request.id,
    type: "send_file",
    path: request.path,
    ...(request.caption === undefined ? {} : { caption: request.caption }),
  };
}


function validateWorkspacePath(workspace: string, requestPath: string): void {
  if (requestPath.includes("\0")) throw new Error("Outbox request path contains a NUL byte");

  let relative = requestPath;
  if (requestPath === "/workspace") {
    throw new Error("Outbox request path must name a file");
  }
  if (requestPath.startsWith("/workspace/")) {
    relative = requestPath.slice("/workspace/".length);
  } else if (path.isAbsolute(requestPath)) {
    throw new Error("Outbox request path must be relative to /workspace");
  }

  const segments = relative.split(/[\\/]/u);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Outbox request path escapes the workspace");
  }
  const candidate = path.resolve(workspace, relative);
  if (outside(workspace, candidate)) throw new Error("Outbox request path escapes the workspace");
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

async function openPinnedDirectory(directory: string): Promise<PinnedDirectory> {
  const initial = await lstat(directory);
  if (!isDirectoryEntry(initial)) throw new Error(`Outbox path is not a real directory: ${directory}`);
  const canonical = await realpath(directory);
  const canonicalStat = await lstat(canonical);
  if (!isDirectoryEntry(canonicalStat)) throw new Error(`Outbox path is not a real directory: ${directory}`);

  const handle = await open(canonical, fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!isDirectoryEntry(openedStat) || openedStat.dev !== canonicalStat.dev || openedStat.ino !== canonicalStat.ino) {
      throw new Error(`Outbox directory changed while opening: ${directory}`);
    }
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (openedPath !== canonical) throw new Error(`Outbox directory is not stable: ${directory}`);
    return { handle, path: `/proc/self/fd/${handle.fd}`, realPath: canonical };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
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

export class WorkspaceOutbox {
  private readonly dataDir: string;
  private readonly sendFile: WorkspaceOutboxSender;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly claimOriginalNames = new Map<string, string>();
  private readonly schedule: typeof setInterval;
  private readonly cancelSchedule: typeof clearInterval;
  private readonly logger: (error: unknown) => void;
  private readonly chatOperations = new Map<number, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private running = false;

  constructor(options: WorkspaceOutboxOptions) {
    if (!Number.isSafeInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) || (options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) <= 0) {
      throw new Error("Outbox poll interval must be a positive integer");
    }
    this.dataDir = path.resolve(options.dataDir);
    this.sendFile = options.sendFile;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? setInterval;
    this.cancelSchedule = options.clearInterval ?? clearInterval;
    this.logger = options.logger ?? ((error) => console.error("Workspace outbox error", error));
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
    if (!this.running || this.timer !== undefined) return;
    this.timer = this.schedule(() => {
      void this.poll().catch((error) => this.report(error));
    }, this.pollIntervalMs);
    const unref = (this.timer as unknown as { unref?: () => void }).unref;
    unref?.call(this.timer);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    for (;;) {
      const pending: Promise<void>[] = [];
      if (this.startInFlight) pending.push(this.startInFlight);
      if (this.pollInFlight) pending.push(this.pollInFlight);
      pending.push(...this.chatOperations.values());
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

  /** Process one numeric chat workspace; same-chat calls are serialized. */
  async processChat(chatId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId)) throw new Error("Outbox chat ID must be a safe integer");
    const workspace = path.join(this.dataDir, "chats", String(chatId), "workspace");

    const previous = this.chatOperations.get(chatId) ?? Promise.resolve();
    const operation = previous.then(
      () => this.processChatNow(chatId, workspace),
      () => this.processChatNow(chatId, workspace),
    );
    this.chatOperations.set(chatId, operation);
    try {
      await operation;
    } finally {
      if (this.chatOperations.get(chatId) === operation) this.chatOperations.delete(chatId);
    }
  }

  private async runPoll(): Promise<void> {
    let chatsRoot: PinnedDirectory | undefined;
    try {
      chatsRoot = await openPinnedDirectory(path.join(this.dataDir, "chats"));
      const entries = await readdir(chatsRoot.path, { withFileTypes: true });
      const chats = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => ({ chatId: numericChatId(entry.name), name: entry.name }))
        .filter((entry): entry is { chatId: number; name: string } => entry.chatId !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const { chatId } of chats) {
        try {
          await this.processChat(chatId);
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

  private async processChatNow(chatId: number, workspace: string): Promise<void> {
    let chatsRoot: PinnedDirectory | undefined;
    let chatDirectory: PinnedDirectory | undefined;
    let workspaceDirectory: PinnedDirectory | undefined;
    let metadata: PinnedDirectory | undefined;
    let outbox: PinnedDirectory | undefined;
    let processed: PinnedDirectory | undefined;
    let failed: PinnedDirectory | undefined;
    try {
      chatsRoot = await openPinnedDirectory(path.join(this.dataDir, "chats"));
      chatDirectory = await openPinnedDirectory(path.join(chatsRoot.path, String(chatId)));
      workspaceDirectory = await openPinnedDirectory(path.join(chatDirectory.path, "workspace"));
      if (workspaceDirectory.realPath !== path.join(chatDirectory.realPath, "workspace")) {
        throw new Error(`Workspace for chat ${chatId} is outside the chat directory`);
      }
      metadata = await openPinnedDirectory(path.join(workspaceDirectory.path, ".tg-bot"));
      const openedOutbox = await openPinnedDirectory(path.join(metadata.path, "outbox"));
      outbox = openedOutbox;
      processed = await openChildDirectory(openedOutbox, "processed");
      failed = await openChildDirectory(openedOutbox, "failed");

      const entries = (await readdir(openedOutbox.path, { withFileTypes: true }))
        .filter((entry) => JSON_REQUEST.test(entry.name) || CLAIM_NAME.test(entry.name))
        .map((entry) => ({ name: entry.name, path: path.join(openedOutbox.path, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const claim = CLAIM_NAME.test(entry.name)
          ? await this.claimStaleEntry(openedOutbox, entry, chatId)
          : await this.claimEntry(openedOutbox, entry, chatId);
        if (!claim) continue;
        const archiveName = claim.originalName ?? entry.name;
        let lease: ClaimLease | undefined;
        try {
          lease = this.startClaimLease(claim, chatId);
          const request = await readRequest(claim.path);
          validateWorkspacePath(workspace, request.path);
          await this.sendFile(chatId, request.path, request.caption);
          await lease.stop();
          lease = undefined;
          await this.archiveClaimed(claim.path, processed, archiveName);
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
          this.reportRequestError(chatId, archiveName, error);
        } finally {
          if (lease) await lease.stop();
          this.claimOriginalNames.delete(claim.path);
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
      if (chatsRoot) await this.closeDirectory(chatsRoot);
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
        .catch((error) => this.reportRequestError(chatId, claim.originalName ?? claim.name, error))
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
        this.claimOriginalNames.delete(previousPath);
        this.claimOriginalNames.set(claimPath, claim.originalName ?? claim.name);
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

  private isStaleClaim(name: string): boolean {
    const match = CLAIM_NAME.exec(name);
    if (!match) return false;
    const createdAt = Number(match[1]);
    if (!Number.isSafeInteger(createdAt)) return false;
    const current = this.now();
    return Number.isFinite(current) && current >= createdAt && current - createdAt >= STALE_CLAIM_AGE_MS;
  }

  private async claimStaleEntry(outbox: PinnedDirectory, entry: OutboxEntry, chatId: number): Promise<OutboxEntry | undefined> {
    if (!this.isStaleClaim(entry.name)) return undefined;
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
        const originalName = this.claimOriginalNames.get(entry.path) ?? entry.name;
        this.claimOriginalNames.set(claimPath, originalName);
        return { name: claimName, path: claimPath, originalName };
      } catch (error) {
        if (isMissing(error)) return undefined;
        if (isExisting(error)) continue;
        this.reportRequestError(chatId, entry.name, error);
        return undefined;
      }
    }
    this.reportRequestError(chatId, entry.name, new Error("Unable to claim stale outbox request"));
    return undefined;
  }

  private async claimEntry(outbox: PinnedDirectory, entry: OutboxEntry, chatId: number): Promise<OutboxEntry | undefined> {
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
        this.claimOriginalNames.set(claimPath, entry.name);
        return { name: claimName, path: claimPath, originalName: entry.name };
      } catch (error) {
        if (isMissing(error)) return undefined;
        if (isExisting(error)) continue;
        this.reportRequestError(chatId, entry.name, error);
        return undefined;
      }
    }
    this.reportRequestError(chatId, entry.name, new Error("Unable to claim outbox request"));
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
    let detail: string;
    try {
      detail = error instanceof Error ? error.message : String(error);
    } catch {
      detail = "unknown error";
    }
    const bounded = detail.length > MAX_DIAGNOSTIC_LENGTH ? `${detail.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : detail;
    this.report(new Error(`Outbox request ${chatId}/${name} failed: ${bounded}`));
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

export const DEFAULT_WORKSPACE_OUTBOX_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
