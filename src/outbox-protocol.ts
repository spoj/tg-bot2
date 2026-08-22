export type WorkspaceOutboxFileKind = "auto" | "photo" | "audio" | "video" | "voice" | "document";
type WorkspaceOutboxMessageEntity = {
  type: string;
  offset: number;
  length: number;
  [key: string]: unknown;
};

type WorkspaceOutboxSendFileRequest = {
  version: 1;
  type: "send_file";
  chat_id: number;
  message_thread_id?: number;
  path: string;
  caption?: string;
  kind?: WorkspaceOutboxFileKind;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendMessageRequest = {
  version: 1;
  type: "send_message";
  chat_id: number;
  message_thread_id?: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: unknown;
  reply_to_message_id?: number;
  entities?: WorkspaceOutboxMessageEntity[];
  link_preview_options?: unknown;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendMediaGroupRequest = {
  version: 1;
  type: "send_media_group";
  chat_id: number;
  message_thread_id?: number;
  /** 2-10 items; each matches Telegram's InputMediaPhoto/InputMediaVideo with a workspace path for `media`. */
  media: Array<{
    type: "photo" | "video";
    media: string;
    caption?: string;
    parse_mode?: "HTML" | "MarkdownV2";
    caption_entities?: WorkspaceOutboxMessageEntity[];
    show_caption_above_media?: boolean;
    has_spoiler?: boolean;
    width?: number;
    height?: number;
    duration?: number;
    supports_streaming?: boolean;
  }>;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendLocationRequest = {
  version: 1;
  type: "send_location";
  chat_id: number;
  message_thread_id?: number;
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
  type: "send_poll";
  chat_id: number;
  message_thread_id?: number;
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
  type: "stop_poll";
  chat_id: number;
  message_id: number;
  reply_markup?: unknown;
};

export type WorkspaceOutboxReaction =
  | { type: "emoji"; emoji: string }
  | { type: "custom_emoji"; custom_emoji_id: string };

type WorkspaceOutboxSendReactionRequest = {
  version: 1;
  type: "send_reaction";
  chat_id: number;
  message_id: number;
  reaction: WorkspaceOutboxReaction[];
};

export type WorkspaceOutboxEditMessageRequest = {
  version: 1;
  type: "edit_message";
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  entities?: WorkspaceOutboxMessageEntity[];
  link_preview_options?: unknown;
  reply_markup?: unknown;
};

type WorkspaceOutboxDeleteMessageRequest = {
  version: 1;
  type: "delete_message";
  chat_id: number;
  message_id: number;
};

export type WorkspaceOutboxCreateForumTopicRequest = {
  version: 1;
  type: "create_forum_topic";
  chat_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
};

export type WorkspaceOutboxEditForumTopicRequest = {
  version: 1;
  type: "edit_forum_topic";
  chat_id: number;
  message_thread_id: number;
  name?: string;
  icon_custom_emoji_id?: string;
};

export type WorkspaceOutboxCloseForumTopicRequest = {
  version: 1;
  type: "close_forum_topic";
  chat_id: number;
  message_thread_id: number;
};

export type WorkspaceOutboxReopenForumTopicRequest = {
  version: 1;
  type: "reopen_forum_topic";
  chat_id: number;
  message_thread_id: number;
};

export type WorkspaceOutboxDeleteForumTopicRequest = {
  version: 1;
  type: "delete_forum_topic";
  chat_id: number;
  message_thread_id: number;
};


export type WorkspaceOutboxRequest =
  | WorkspaceOutboxSendFileRequest
  | WorkspaceOutboxSendMessageRequest
  | WorkspaceOutboxSendMediaGroupRequest
  | WorkspaceOutboxSendLocationRequest
  | WorkspaceOutboxSendPollRequest
  | WorkspaceOutboxStopPollRequest
  | WorkspaceOutboxSendReactionRequest
  | WorkspaceOutboxEditMessageRequest
  | WorkspaceOutboxDeleteMessageRequest
  | WorkspaceOutboxCreateForumTopicRequest
  | WorkspaceOutboxEditForumTopicRequest
  | WorkspaceOutboxCloseForumTopicRequest
  | WorkspaceOutboxReopenForumTopicRequest
  | WorkspaceOutboxDeleteForumTopicRequest

export type WorkspaceOutboxDispatchResult = {
  messageId?: number;
  pollId?: string;
  messageThreadId?: number;
  data?: unknown;
};

export type WorkspaceOutboxDispatcher = (
  chatId: number,
  request: WorkspaceOutboxRequest,
) => Promise<WorkspaceOutboxDispatchResult | undefined>;

const FILE_KINDS: Record<string, true> = {
  auto: true, photo: true, audio: true, video: true, voice: true, document: true,
};

// Host-side checks are limited to what dispatch itself needs (routing,
// bookkeeping, file safety). Telegram validates everything else and its
// rejection message is relayed to the agent directly.
// eslint-disable-next-line complexity -- one branch per send type; the validator shape is inherent
export function validateRequest(value: unknown): WorkspaceOutboxRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox request must be a JSON object");
  }
  const request = value as Record<string, unknown>;
  if (request.version !== 1) throw new Error("Outbox request version must be 1");
  if (typeof request.chat_id !== "number" || !Number.isSafeInteger(request.chat_id)) {
    throw new Error("Outbox request chat_id must be a safe integer");
  }
  if (request.message_thread_id !== undefined && (typeof request.message_thread_id !== "number" || !Number.isSafeInteger(request.message_thread_id))) {
    throw new Error("Outbox request message_thread_id must be a safe integer");
  }
  if (request.type === "send_file") {
    if (typeof request.path !== "string" || request.path.length === 0) {
      throw new Error("Outbox request path must be a non-empty string");
    }
    if (request.caption !== undefined && typeof request.caption !== "string") {
      throw new Error("Outbox request caption must be a string");
    }
    if (request.kind !== undefined && FILE_KINDS[request.kind as string] !== true) {
      throw new Error("Outbox request kind must be auto, photo, audio, video, voice, or document");
    }
  } else if (request.type === "send_media_group") {
    if (!Array.isArray(request.media) || request.media.length < 2 || request.media.length > 10) {
      throw new Error("Outbox request media must be an array of 2 to 10 items");
    }
    for (const item of request.media) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Outbox request media items must be objects");
      }
      const media = item as Record<string, unknown>;
      if (media.type !== "photo" && media.type !== "video") {
        throw new Error("Outbox request media item type must be photo or video");
      }
      if (typeof media.media !== "string" || media.media.length === 0) {
        throw new Error("Outbox request media item path must be a non-empty string");
      }
    }
  } else if (request.type === "create_forum_topic") {
    if (typeof request.name !== "string" || request.name.trim().length === 0) {
      throw new Error("Outbox request name must be a non-empty string");
    }
  } else if (
    request.type === "edit_forum_topic" ||
    request.type === "close_forum_topic" ||
    request.type === "reopen_forum_topic" ||
    request.type === "delete_forum_topic"
  ) {
    if (typeof request.message_thread_id !== "number" || !Number.isSafeInteger(request.message_thread_id)) {
      throw new Error("Outbox request message_thread_id must be a safe integer");
    }
  } else if (
    request.type !== "send_message" && request.type !== "send_location" &&
    request.type !== "send_poll" && request.type !== "stop_poll" &&
    request.type !== "send_reaction" && request.type !== "edit_message" &&
    request.type !== "delete_message"
  ) {
    throw new Error("Outbox request type must be send_file, send_media_group, send_message, send_location, send_poll, stop_poll, send_reaction, edit_message, delete_message, create_forum_topic, edit_forum_topic, close_forum_topic, reopen_forum_topic, or delete_forum_topic");
  }
  return { ...request, version: 1, type: request.type } as WorkspaceOutboxRequest;
}

export const OUTBOX_PROMPT = `To communicate with Telegram users, call the send tool with request parameters (chat_id and message_thread_id default to your current chat/topic for chat agents).
Request types:
- send_message: {chat_id,text,message_thread_id?,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?} (prefer parse_mode:"HTML" with <b>, <i>, <code>, <pre>, <blockquote>, <a>, •)
- send_file: {chat_id,path,message_thread_id?,caption?,kind?,parse_mode?,reply_to_message_id?} (kind: auto, photo, audio, video, voice, document)
- send_media_group: {chat_id,media:[{type:"photo"|"video",media:path,caption?,parse_mode?}],message_thread_id?} (2-10 items)
- send_location: {chat_id,latitude,longitude,message_thread_id?,venue?:{title,address}}
- send_poll: {chat_id,question,options,message_thread_id?,is_anonymous?,poll_type?,correct_option_id?}
- stop_poll: {chat_id,message_id} (closes poll; closed Poll returned in outbox_sent data)
- send_reaction: {chat_id,message_id,reaction:[{type:"emoji",emoji}]} ([] removes reaction)
- edit_message: {chat_id,message_id,text,parse_mode?,reply_markup?}
- delete_message: {chat_id,message_id}
- create_forum_topic / edit_forum_topic / close_forum_topic / reopen_forum_topic / delete_forum_topic: {chat_id,name?,message_thread_id?}
The host validates and delivers each request synchronously, returning the outcome (messageId/pollId or the failure detail) in the tool result and recording outbox_sent (echoing messageId/pollId) or outbox_rejected in events.jsonl.
`;
