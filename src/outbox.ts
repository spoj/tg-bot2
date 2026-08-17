import { randomUUID } from "node:crypto";
import { constants as fsConstants, watch } from "node:fs";
import type { FSWatcher, Stats } from "node:fs";
import { lstat, link, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { appendChatEvent } from "./events.js";
import { SerialQueue } from "./queue.js";

export type WorkspaceOutboxFileKind = "auto" | "photo" | "audio" | "video" | "voice" | "document";
export type WorkspaceOutboxMessageEntity = {
  type: string;
  offset: number;
  length: number;
  [key: string]: unknown;
};

export type WorkspaceOutboxSendFileRequest = {
  version: 1;
  id: string;
  type: "send_file";
  path: string;
  caption?: string;
  kind?: WorkspaceOutboxFileKind;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendMessageRequest = {
  version: 1;
  id: string;
  type: "send_message";
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: unknown;
  reply_to_message_id?: number;
  entities?: WorkspaceOutboxMessageEntity[];
  link_preview_options?: unknown;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendLocationRequest = {
  version: 1;
  id: string;
  type: "send_location";
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  heading?: number;
  live_period?: number;
  venue?: { title: string; address: string };
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendPollRequest = {
  version: 1;
  id: string;
  type: "send_poll";
  question: string;
  options: string[];
  is_anonymous?: boolean;
  allows_multiple_answers?: boolean;
  poll_type?: "regular" | "quiz";
  correct_option_id?: number;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export type WorkspaceOutboxStopPollRequest = {
  version: 1;
  id: string;
  type: "stop_poll";
  message_id: number;
  reply_markup?: unknown;
};

export type WorkspaceOutboxReaction =
  | { type: "emoji"; emoji: string }
  | { type: "custom_emoji"; custom_emoji_id: string };

export type WorkspaceOutboxSendReactionRequest = {
  version: 1;
  id: string;
  type: "send_reaction";
  message_id: number;
  reaction: WorkspaceOutboxReaction[];
};

export type WorkspaceOutboxEditMessageRequest = {
  version: 1;
  id: string;
  type: "edit_message";
  message_id: number;
  text?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  entities?: WorkspaceOutboxMessageEntity[];
  link_preview_options?: unknown;
  reply_markup?: unknown;
};

export type WorkspaceOutboxDeleteMessageRequest = {
  version: 1;
  id: string;
  type: "delete_message";
  message_id: number;
};

export type WorkspaceOutboxRequest =
  | WorkspaceOutboxSendFileRequest
  | WorkspaceOutboxSendMessageRequest
  | WorkspaceOutboxSendLocationRequest
  | WorkspaceOutboxSendPollRequest
  | WorkspaceOutboxStopPollRequest
  | WorkspaceOutboxSendReactionRequest
  | WorkspaceOutboxEditMessageRequest
  | WorkspaceOutboxDeleteMessageRequest;

export type WorkspaceOutboxDispatchResult = {
  messageId?: number;
  pollId?: string;
  data?: unknown;
};

export type WorkspaceOutboxDispatcher = (
  chatId: number,
  request: WorkspaceOutboxRequest,
) => Promise<WorkspaceOutboxDispatchResult | undefined>;

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
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_REQUEST_PATH_LENGTH = 4_096;
const MAX_REQUEST_CAPTION_LENGTH = 16 * 1024;
const MAX_REQUEST_TEXT_LENGTH = 4_096;
const MAX_MESSAGE_ENTITIES = 100;
const MAX_REQUEST_REPLY_MARKUP_BYTES = 8_192;
const MAX_LINK_PREVIEW_OPTIONS_BYTES = 8_192;
const MAX_JSONL_LINES = 256;
const MAX_JSONL_BYTES = 64 * 1024;
const POLL_RESULTS_NAME = "poll-results.jsonl";
const MAX_POLL_QUESTION_LENGTH = 300;
const MAX_POLL_OPTION_LENGTH = 100;
const MAX_POLL_OPTIONS = 10;
const MIN_POLL_OPTIONS = 2;
const MAX_VENUE_FIELD_LENGTH = 256;
const MAX_REACTION_EMOJI_LENGTH = 64;
const MAX_CUSTOM_EMOJI_ID_LENGTH = 64;
const MAX_REACTIONS = 3;
const MAX_LIVE_PERIOD_SECONDS = 86_400;
const MIN_LIVE_PERIOD_SECONDS = 60;
const MAX_HORIZONTAL_ACCURACY_METERS = 1_500;
const CHAT_DIRECTORY = /^-?\d+$/;
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
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;

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
  if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Outbox request id must be a non-empty string");
  if (request.id.length > MAX_REQUEST_ID_LENGTH) throw new Error(`Outbox request id must be at most ${MAX_REQUEST_ID_LENGTH} characters`);
  if (request.type === "send_file") return validateSendFileRequest(request.id, request);
  if (request.type === "send_message") return validateSendMessageRequest(request.id, request);
  if (request.type === "send_location") return validateSendLocationRequest(request.id, request);
  if (request.type === "send_poll") return validateSendPollRequest(request.id, request);
  if (request.type === "stop_poll") return validateStopPollRequest(request.id, request);
  if (request.type === "send_reaction") return validateSendReactionRequest(request.id, request);
  if (request.type === "edit_message") return validateEditMessageRequest(request.id, request);
  if (request.type === "delete_message") return validateDeleteMessageRequest(request.id, request);
  throw new Error("Outbox request type must be send_file, send_message, send_location, send_poll, stop_poll, send_reaction, edit_message, or delete_message");
}

function validateMessageId(request: Record<string, unknown>, name: string): number {
  if (typeof request[name] !== "number" || !Number.isSafeInteger(request[name]) || (request[name] as number) < 1) {
    throw new Error(`Outbox request ${name} must be a positive integer`);
  }
  return request[name] as number;
}
function validateBoolean(request: Record<string, unknown>, name: string): boolean | undefined {
  if (request[name] === undefined) return undefined;
  if (typeof request[name] !== "boolean") throw new Error(`Outbox request ${name} must be a boolean`);
  return request[name] as boolean;
}

function validateBoundedJsonObject(value: unknown, name: string, maxBytes: number): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Outbox request ${name} must be an object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Outbox request ${name} must be JSON-serializable`);
  }
  if (serialized.length > maxBytes) {
    throw new Error(`Outbox request ${name} must be at most ${maxBytes} bytes`);
  }
  return value;
}

function validateReplyMarkup(request: Record<string, unknown>): unknown {
  if (request.reply_markup === undefined) return undefined;
  return validateBoundedJsonObject(request.reply_markup, "reply_markup", MAX_REQUEST_REPLY_MARKUP_BYTES);
}

function validateLinkPreviewOptions(request: Record<string, unknown>): unknown {
  if (request.link_preview_options === undefined) return undefined;
  return validateBoundedJsonObject(request.link_preview_options, "link_preview_options", MAX_LINK_PREVIEW_OPTIONS_BYTES);
}

function validateEntities(request: Record<string, unknown>): WorkspaceOutboxMessageEntity[] | undefined {
  const raw = request.entities;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("Outbox request entities must be an array");
  if (raw.length > MAX_MESSAGE_ENTITIES) throw new Error(`Outbox request entities must have at most ${MAX_MESSAGE_ENTITIES} entries`);
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Outbox request entities entry ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.type !== "string") throw new Error(`Outbox request entities entry ${index} must have a string type`);
    if (typeof candidate.offset !== "number" || !Number.isSafeInteger(candidate.offset) || candidate.offset < 0) {
      throw new Error(`Outbox request entities entry ${index} offset must be a non-negative integer`);
    }
    if (typeof candidate.length !== "number" || !Number.isSafeInteger(candidate.length) || candidate.length < 0) {
      throw new Error(`Outbox request entities entry ${index} length must be a non-negative integer`);
    }
    return candidate as WorkspaceOutboxMessageEntity;
  });
}

function validateSendFileRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxSendFileRequest {
  if (typeof request.path !== "string" || request.path.length === 0) throw new Error("Outbox request path must be a non-empty string");
  if (request.path.length > MAX_REQUEST_PATH_LENGTH) throw new Error(`Outbox request path must be at most ${MAX_REQUEST_PATH_LENGTH} characters`);
  if (request.caption !== undefined && typeof request.caption !== "string") {
    throw new Error("Outbox request caption must be a string");
  }
  if (typeof request.caption === "string" && request.caption.length > MAX_REQUEST_CAPTION_LENGTH) {
    throw new Error(`Outbox request caption must be at most ${MAX_REQUEST_CAPTION_LENGTH} characters`);
  }
  if (request.kind !== undefined && request.kind !== "auto" && request.kind !== "photo" && request.kind !== "audio" && request.kind !== "video" && request.kind !== "voice" && request.kind !== "document") {
    throw new Error("Outbox request kind must be auto, photo, audio, video, voice, or document");
  }
  let replyToMessageId: number | undefined;
  if (request.reply_to_message_id !== undefined) replyToMessageId = validateMessageId(request, "reply_to_message_id");
  const disableNotification = validateBoolean(request, "disable_notification");
  return {
    version: 1,
    id,
    type: "send_file",
    path: request.path,
    ...(request.caption === undefined ? {} : { caption: request.caption }),
    ...(request.kind === undefined ? {} : { kind: request.kind as WorkspaceOutboxFileKind }),
    ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
    ...(disableNotification === undefined ? {} : { disable_notification: disableNotification }),
  };
}

function validateSendMessageRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxSendMessageRequest {
  if (typeof request.text !== "string" || request.text.length === 0) throw new Error("Outbox request text must be a non-empty string");
  if (request.text.length > MAX_REQUEST_TEXT_LENGTH) throw new Error(`Outbox request text must be at most ${MAX_REQUEST_TEXT_LENGTH} characters`);
  if (request.parse_mode !== undefined && request.parse_mode !== "HTML" && request.parse_mode !== "MarkdownV2") {
    throw new Error("Outbox request parse_mode must be HTML or MarkdownV2");
  }
  if (request.parse_mode !== undefined && request.entities !== undefined) {
    throw new Error("Outbox request cannot combine parse_mode with entities");
  }
  const entities = validateEntities(request);
  const replyMarkup = validateReplyMarkup(request);
  const linkPreviewOptions = validateLinkPreviewOptions(request);
  let replyToMessageId: number | undefined;
  if (request.reply_to_message_id !== undefined) replyToMessageId = validateMessageId(request, "reply_to_message_id");
  const disableNotification = validateBoolean(request, "disable_notification");
  return {
    version: 1,
    id,
    type: "send_message",
    text: request.text,
    ...(request.parse_mode === undefined ? {} : { parse_mode: request.parse_mode }),
    ...(entities === undefined ? {} : { entities }),
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    ...(linkPreviewOptions === undefined ? {} : { link_preview_options: linkPreviewOptions }),
    ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
    ...(disableNotification === undefined ? {} : { disable_notification: disableNotification }),
  };
}

function validateSendLocationRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxSendLocationRequest {
  if (typeof request.latitude !== "number" || !Number.isFinite(request.latitude) || request.latitude < -90 || request.latitude > 90) {
    throw new Error("Outbox request latitude must be a number between -90 and 90");
  }
  if (typeof request.longitude !== "number" || !Number.isFinite(request.longitude) || request.longitude < -180 || request.longitude > 180) {
    throw new Error("Outbox request longitude must be a number between -180 and 180");
  }
  if (request.horizontal_accuracy !== undefined) {
    if (typeof request.horizontal_accuracy !== "number" || !Number.isFinite(request.horizontal_accuracy) || request.horizontal_accuracy < 0 || request.horizontal_accuracy > MAX_HORIZONTAL_ACCURACY_METERS) {
      throw new Error(`Outbox request horizontal_accuracy must be between 0 and ${MAX_HORIZONTAL_ACCURACY_METERS}`);
    }
  }
  if (request.heading !== undefined) {
    if (typeof request.heading !== "number" || !Number.isFinite(request.heading) || request.heading < 1 || request.heading > 360) {
      throw new Error("Outbox request heading must be between 1 and 360");
    }
  }
  if (request.live_period !== undefined) {
    if (typeof request.live_period !== "number" || !Number.isSafeInteger(request.live_period) || request.live_period < MIN_LIVE_PERIOD_SECONDS || request.live_period > MAX_LIVE_PERIOD_SECONDS) {
      throw new Error(`Outbox request live_period must be between ${MIN_LIVE_PERIOD_SECONDS} and ${MAX_LIVE_PERIOD_SECONDS} seconds`);
    }
  }
  let venue: { title: string; address: string } | undefined;
  if (request.venue !== undefined) {
    if (request.venue === null || typeof request.venue !== "object" || Array.isArray(request.venue)) {
      throw new Error("Outbox request venue must be an object with title and address");
    }
    const candidate = request.venue as Record<string, unknown>;
    if (typeof candidate.title !== "string" || candidate.title.length === 0 || candidate.title.length > MAX_VENUE_FIELD_LENGTH) {
      throw new Error(`Outbox request venue title must be a string of at most ${MAX_VENUE_FIELD_LENGTH} characters`);
    }
    if (typeof candidate.address !== "string" || candidate.address.length === 0 || candidate.address.length > MAX_VENUE_FIELD_LENGTH) {
      throw new Error(`Outbox request venue address must be a string of at most ${MAX_VENUE_FIELD_LENGTH} characters`);
    }
    venue = { title: candidate.title, address: candidate.address };
  }
  let replyToMessageId: number | undefined;
  if (request.reply_to_message_id !== undefined) replyToMessageId = validateMessageId(request, "reply_to_message_id");
  const disableNotification = validateBoolean(request, "disable_notification");
  return {
    version: 1,
    id,
    type: "send_location",
    latitude: request.latitude,
    longitude: request.longitude,
    ...(request.horizontal_accuracy === undefined ? {} : { horizontal_accuracy: request.horizontal_accuracy }),
    ...(request.heading === undefined ? {} : { heading: request.heading }),
    ...(request.live_period === undefined ? {} : { live_period: request.live_period }),
    ...(venue === undefined ? {} : { venue }),
    ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
    ...(disableNotification === undefined ? {} : { disable_notification: disableNotification }),
  };
}

function validateSendPollRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxSendPollRequest {
  if (typeof request.question !== "string" || request.question.length === 0 || request.question.length > MAX_POLL_QUESTION_LENGTH) {
    throw new Error(`Outbox request question must be a string of at most ${MAX_POLL_QUESTION_LENGTH} characters`);
  }
  if (!Array.isArray(request.options) || request.options.length < MIN_POLL_OPTIONS || request.options.length > MAX_POLL_OPTIONS) {
    throw new Error(`Outbox request options must have between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} entries`);
  }
  const options = request.options.map((option, index) => {
    if (typeof option !== "string" || option.length === 0 || option.length > MAX_POLL_OPTION_LENGTH) {
      throw new Error(`Outbox request option ${index} must be a string of at most ${MAX_POLL_OPTION_LENGTH} characters`);
    }
    return option;
  });
  if (request.is_anonymous !== undefined && typeof request.is_anonymous !== "boolean") {
    throw new Error("Outbox request is_anonymous must be a boolean");
  }
  if (request.allows_multiple_answers !== undefined && typeof request.allows_multiple_answers !== "boolean") {
    throw new Error("Outbox request allows_multiple_answers must be a boolean");
  }
  if (request.poll_type !== undefined && request.poll_type !== "regular" && request.poll_type !== "quiz") {
    throw new Error("Outbox request poll_type must be regular or quiz");
  }
  if (request.poll_type === "quiz" && request.correct_option_id === undefined) {
    throw new Error("Outbox quiz requests require correct_option_id");
  }
  if (request.correct_option_id !== undefined) {
    if (typeof request.correct_option_id !== "number" || !Number.isSafeInteger(request.correct_option_id) || request.correct_option_id < 0 || request.correct_option_id >= options.length) {
      throw new Error("Outbox request correct_option_id must index an option");
    }
  }
  let replyToMessageId: number | undefined;
  if (request.reply_to_message_id !== undefined) replyToMessageId = validateMessageId(request, "reply_to_message_id");
  const disableNotification = validateBoolean(request, "disable_notification");
  return {
    version: 1,
    id,
    type: "send_poll",
    question: request.question,
    options,
    ...(request.is_anonymous === undefined ? {} : { is_anonymous: request.is_anonymous }),
    ...(request.allows_multiple_answers === undefined ? {} : { allows_multiple_answers: request.allows_multiple_answers }),
    ...(request.poll_type === undefined ? {} : { poll_type: request.poll_type }),
    ...(request.correct_option_id === undefined ? {} : { correct_option_id: request.correct_option_id }),
    ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
    ...(disableNotification === undefined ? {} : { disable_notification: disableNotification }),
  };
}

function validateStopPollRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxStopPollRequest {
  const replyMarkup = validateReplyMarkup(request);
  return {
    version: 1,
    id,
    type: "stop_poll",
    message_id: validateMessageId(request, "message_id"),
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
  };
}

function validateSendReactionRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxSendReactionRequest {
  const raw = request.reaction;
  if (!Array.isArray(raw)) throw new Error("Outbox request reaction must be an array");
  if (raw.length > MAX_REACTIONS) throw new Error(`Outbox request reaction must have at most ${MAX_REACTIONS} entries`);
  const reaction: WorkspaceOutboxReaction[] = raw.map((entry, index): WorkspaceOutboxReaction => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Outbox request reaction entry ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === "emoji") {
      if (typeof candidate.emoji !== "string" || candidate.emoji.length === 0 || candidate.emoji.length > MAX_REACTION_EMOJI_LENGTH) {
        throw new Error(`Outbox request reaction entry ${index} emoji must be a non-empty string of at most ${MAX_REACTION_EMOJI_LENGTH} characters`);
      }
      return { type: "emoji", emoji: candidate.emoji };
    }
    if (candidate.type === "custom_emoji") {
      if (typeof candidate.custom_emoji_id !== "string" || candidate.custom_emoji_id.length === 0 || candidate.custom_emoji_id.length > MAX_CUSTOM_EMOJI_ID_LENGTH) {
        throw new Error(`Outbox request reaction entry ${index} custom_emoji_id must be a non-empty string of at most ${MAX_CUSTOM_EMOJI_ID_LENGTH} characters`);
      }
      return { type: "custom_emoji", custom_emoji_id: candidate.custom_emoji_id };
    }
    throw new Error(`Outbox request reaction entry ${index} must have type emoji or custom_emoji`);
  });
  return {
    version: 1,
    id,
    type: "send_reaction",
    message_id: validateMessageId(request, "message_id"),
    reaction,
  };
}

function validateEditMessageRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxEditMessageRequest {
  let text: string | undefined;
  if (request.text !== undefined) {
    if (typeof request.text !== "string" || request.text.length === 0) throw new Error("Outbox request text must be a non-empty string");
    if (request.text.length > MAX_REQUEST_TEXT_LENGTH) throw new Error(`Outbox request text must be at most ${MAX_REQUEST_TEXT_LENGTH} characters`);
    text = request.text;
  }
  if (request.parse_mode !== undefined && request.parse_mode !== "HTML" && request.parse_mode !== "MarkdownV2") {
    throw new Error("Outbox request parse_mode must be HTML or MarkdownV2");
  }
  if (request.parse_mode !== undefined && request.entities !== undefined) {
    throw new Error("Outbox request cannot combine parse_mode with entities");
  }
  const entities = validateEntities(request);
  const replyMarkup = validateReplyMarkup(request);
  const linkPreviewOptions = validateLinkPreviewOptions(request);
  if (text === undefined && replyMarkup === undefined && linkPreviewOptions === undefined) {
    throw new Error("Outbox request edit_message must include text, reply_markup, or link_preview_options");
  }
  return {
    version: 1,
    id,
    type: "edit_message",
    message_id: validateMessageId(request, "message_id"),
    ...(text === undefined ? {} : { text }),
    ...(request.parse_mode === undefined ? {} : { parse_mode: request.parse_mode }),
    ...(entities === undefined ? {} : { entities }),
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    ...(linkPreviewOptions === undefined ? {} : { link_preview_options: linkPreviewOptions }),
  };
}


function validateDeleteMessageRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxDeleteMessageRequest {
  return {
    version: 1,
    id,
    type: "delete_message",
    message_id: validateMessageId(request, "message_id"),
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
  if (candidate === path.resolve(workspace) || outside(workspace, candidate)) throw new Error("Outbox request path escapes the workspace");
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

  const handle = await open(canonical, fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!isDirectoryEntry(openedStat) || openedStat.dev !== initial.dev || openedStat.ino !== initial.ino) {
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
  private readonly chatOperations = new Map<number, SerialQueue>();
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
      pending.push(...[...this.chatOperations.values()].map((queue) => queue.idle()));
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
    await this.enqueueChatScan(chatId, workspace);
  }

  /** Enqueue a scan of one chat's outbox on its dedicated serial queue. */
  private enqueueChatScan(chatId: number, workspace: string): Promise<void> {
    let queue = this.chatOperations.get(chatId);
    if (!queue) {
      queue = new SerialQueue();
      this.chatOperations.set(chatId, queue);
    }
    const activeQueue = queue;
    return activeQueue.run(() => this.processChatNow(chatId, workspace)).finally(() => {
      if (activeQueue.size === 0 && this.chatOperations.get(chatId) === activeQueue) {
        this.chatOperations.delete(chatId);
      }
    });
  }

  /** Fire-and-forget scan triggered by a watcher event; errors are reported, not thrown. */
  private scheduleChatScan(chatId: number, workspace: string): void {
    void this.enqueueChatScan(chatId, workspace).catch((error) => this.report(error));
  }

  /** Watch one chat's outbox directory, scheduling a debounced scan on filesystem events. */
  private async ensureWatcher(chatId: number, workspace: string): Promise<void> {
    if (!this.running || this.chatWatchers.has(chatId)) return;
    const outboxDirectory = path.join(workspace, ".tg-bot", "outbox");
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

  /** Debounce a burst of watcher events into a single scan. */
  private debounceChatScan(chatId: number, workspace: string): void {
    const entry = this.chatWatchers.get(chatId);
    if (!entry) return;
    clearTimeout(entry.debounce);
    const timer = setTimeout(() => {
      if (this.chatWatchers.get(chatId) !== entry) return;
      entry.debounce = undefined;
      this.scheduleChatScan(chatId, workspace);
    }, WATCH_DEBOUNCE_MS);
    entry.debounce = timer;
    timer.unref();
  }

  /** Close every watcher and clear every pending debounce. */
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
        const workspace = path.join(this.dataDir, "chats", String(chatId), "workspace");
        if (this.running) await this.ensureWatcher(chatId, workspace);
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

      const entries = (await readBoundedEntries(openedOutbox.path, MAX_OUTBOX_ENTRIES_PER_CHAT))
        .filter((entry) => JSON_REQUEST.test(entry.name) || CLAIM_NAME.test(entry.name))
        .map((entry) => ({ name: entry.name, path: path.join(openedOutbox.path, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const isClaim = CLAIM_NAME.test(entry.name);
        const stale = isClaim && this.isStaleClaim(entry.name);
        if (isClaim && !stale) continue;
        if (stale && await this.claimWasAlreadyArchived(entry, processed, chatId)) continue;
        const claim = await this.claimEntry(openedOutbox, entry, chatId, stale);
        if (!claim) continue;
        const archiveName = claim.originalName ?? entry.name;
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
                  ...(result.pollId === undefined ? {} : { pollId: result.pollId }),
                  ok: true,
                });
              }
              if (result.data !== undefined) {
                await this.appendBoundedJsonl(metadata.path, POLL_RESULTS_NAME, JSON.stringify({ id: request.id, result: result.data }));
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
        return { name: claimName, path: claimPath, originalName: entry.name };
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
  /** Appends one JSON line to a bounded store, rotating when line or byte caps are exceeded. */
  private async appendBoundedJsonl(directoryPath: string, fileName: string, record: string): Promise<void> {
    const filePath = path.join(directoryPath, fileName);
    const line = `${record}\n`;
    const handle = await this.openBoundedJsonl(filePath);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Outbox JSONL store is not a regular file");
      await handle.write(line, null, "utf8");
      const total = stat.size + Buffer.byteLength(line, "utf8");
      const lines = await this.latestBoundedJsonlLines(handle, total);
      if (lines.length > MAX_JSONL_LINES || total > MAX_JSONL_BYTES) {
        await this.replaceBoundedJsonl(filePath, `${lines.slice(-MAX_JSONL_LINES).join("\n")}\n`);
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Opens a store file, replacing a symlink the workspace may have planted at its path. */
  private async openBoundedJsonl(filePath: string): Promise<Awaited<ReturnType<typeof open>>> {
    try {
      return await open(filePath, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600);
    } catch (error) {
      if (errorCode(error) !== "ELOOP") throw error;
      try {
        await unlink(filePath);
      } catch (unlinkError) {
        if (!isMissing(unlinkError)) throw unlinkError;
      }
      return open(filePath, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCKING, 0o600);
    }
  }

  /** Reads the tail of the store (bounded), dropping a possible partial first line. */
  private async latestBoundedJsonlLines(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string[]> {
    const readLength = Math.min(size, MAX_JSONL_BYTES);
    const position = size - readLength;
    const buffer = Buffer.allocUnsafe(readLength);
    let bytesRead = 0;
    while (bytesRead < readLength) {
      const result = await handle.read(buffer, bytesRead, readLength - bytesRead, position + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    const complete = position === 0 ? lines : lines.slice(1);
    return complete.filter(Boolean);
  }

  /** Atomically rewrites a store file via a unique temporary file in the same directory. */
  private async replaceBoundedJsonl(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tempPath = path.join(directory, `.jsonl-${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
        await handle.write(content, null, "utf8");
      } catch (error) {
        if (isExisting(error)) continue;
        throw error;
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
      await rename(tempPath, filePath);
      return;
    }
    throw new Error("Unable to rewrite outbox JSONL store");
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
