import path from "node:path";
import { defined } from "./util.js";

export type WorkspaceOutboxFileKind = "auto" | "photo" | "audio" | "video" | "voice" | "document";
type WorkspaceOutboxMessageEntity = {
  type: string;
  offset: number;
  length: number;
  [key: string]: unknown;
};

type WorkspaceOutboxSendFileRequest = {
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

type WorkspaceOutboxStopPollRequest = {
  version: 1;
  id: string;
  type: "stop_poll";
  message_id: number;
  reply_markup?: unknown;
};

export type WorkspaceOutboxReaction =
  | { type: "emoji"; emoji: string }
  | { type: "custom_emoji"; custom_emoji_id: string };

type WorkspaceOutboxSendReactionRequest = {
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
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  entities?: WorkspaceOutboxMessageEntity[];
  link_preview_options?: unknown;
  reply_markup?: unknown;
};

type WorkspaceOutboxDeleteMessageRequest = {
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

const MAX_REQUEST_ID_LENGTH = 256;
const MAX_REQUEST_PATH_LENGTH = 4_096;
const MAX_REQUEST_CAPTION_LENGTH = 16 * 1024;
const MAX_REQUEST_TEXT_LENGTH = 4_096;
const MAX_MESSAGE_ENTITIES = 100;
const MAX_REQUEST_REPLY_MARKUP_BYTES = 8_192;
const MAX_LINK_PREVIEW_OPTIONS_BYTES = 8_192;
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

function outside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function validateRequest(value: unknown): WorkspaceOutboxRequest {
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
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
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
    ...defined({ caption: request.caption }),
    ...defined({ kind: request.kind as WorkspaceOutboxFileKind }),
    ...defined({ reply_to_message_id: replyToMessageId }),
    ...defined({ disable_notification: disableNotification }),
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
    ...defined({ parse_mode: request.parse_mode }),
    ...defined({ entities }),
    ...defined({ reply_markup: replyMarkup }),
    ...defined({ link_preview_options: linkPreviewOptions }),
    ...defined({ reply_to_message_id: replyToMessageId }),
    ...defined({ disable_notification: disableNotification }),
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
    ...defined({ horizontal_accuracy: request.horizontal_accuracy }),
    ...defined({ heading: request.heading }),
    ...defined({ live_period: request.live_period }),
    ...defined({ venue }),
    ...defined({ reply_to_message_id: replyToMessageId }),
    ...defined({ disable_notification: disableNotification }),
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
    ...defined({ is_anonymous: request.is_anonymous }),
    ...defined({ allows_multiple_answers: request.allows_multiple_answers }),
    ...defined({ poll_type: request.poll_type }),
    ...defined({ correct_option_id: request.correct_option_id }),
    ...defined({ reply_to_message_id: replyToMessageId }),
    ...defined({ disable_notification: disableNotification }),
  };
}

function validateStopPollRequest(id: string, request: Record<string, unknown>): WorkspaceOutboxStopPollRequest {
  const replyMarkup = validateReplyMarkup(request);
  return {
    version: 1,
    id,
    type: "stop_poll",
    message_id: validateMessageId(request, "message_id"),
    ...defined({ reply_markup: replyMarkup }),
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
  return {
    version: 1,
    id,
    type: "edit_message",
    message_id: validateMessageId(request, "message_id"),
    text: request.text,
    ...defined({ parse_mode: request.parse_mode }),
    ...defined({ entities }),
    ...defined({ reply_markup: replyMarkup }),
    ...defined({ link_preview_options: linkPreviewOptions }),
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


export function validateWorkspacePath(workspace: string, requestPath: string): void {
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

export const OUTBOX_PROMPT = `To send files or messages through Telegram, write one request per send under
/workspace/.tg-bot/outbox/. Request types:
{version:1,id,type:"send_file",path,caption?,kind?,reply_to_message_id?,disable_notification?}
sends the file at path (relative to /workspace or an absolute /workspace/... path)
with an optional caption; kind is "auto" (default: images are sent as photos,
audio as audio, video as video, other files as documents, and images over 10 MB
as documents) or an explicit "photo", "audio", "video", "voice", or "document".
{version:1,id,type:"send_message",text,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}
sends a text message, where parse_mode is "HTML" or "MarkdownV2" (omit for
plain text; malformed markup is resent as plain text; parse_mode and entities
are mutually exclusive), entities is a list of {type,offset,length} message
entities, link_preview_options is a Telegram LinkPreviewOptions object,
reply_markup is Telegram reply-markup JSON such as an inline_keyboard button
list, reply_to_message_id targets an earlier message, and
disable_notification sends silently.
{version:1,id,type:"send_location",latitude,longitude,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}
sends a location pin (venue {title,address} sends a named venue instead).
{version:1,id,type:"send_poll",question,options,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}
sends a poll: options has 2-10 choices, poll_type is "regular" or "quiz" (quiz
requires correct_option_id). Set is_anonymous:false to receive each vote as a
poll_answer event in events.jsonl; the matching send line in events.jsonl
records pollId.
{version:1,id,type:"stop_poll",message_id,reply_markup?} closes a poll early and
appends {id,result} with the final Poll to /workspace/.tg-bot/poll-results.jsonl
(latest 256 lines kept); result.id matches the poll_answer events' poll_id and
the matching send event's top-level pollId.
{version:1,id,type:"send_reaction",message_id,reaction} sets a Telegram reaction on any message in the chat (long-press style, e.g. a thumbs up on the user's message): reaction is an array of 1-3 {type:"emoji",emoji} or {type:"custom_emoji",custom_emoji_id} entries; [] removes your reaction. message_id is the numeric messageId of the target message from events.jsonl.
{version:1,id,type:"edit_message",message_id,text,parse_mode?,entities?,link_preview_options?,reply_markup?} edits one of your earlier messages (text is required; reply_markup and link_preview_options are optional additions; message_id is the numeric messageId of that message).
{version:1,id,type:"delete_message",message_id} deletes one of your earlier messages (message_id is the numeric messageId of that message).
id must be unique. Write each request to a temporary filename that does not
end in .json, then atomically rename it to the final unique *.json request name.
`;
