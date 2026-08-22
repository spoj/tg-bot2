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

export const OUTBOX_PROMPT = `To send files or messages through Telegram, call the send tool once per send with the
request object as its argument. Direct assistant text output is not delivered to Telegram
chats — calling the send tool is the only way to reply to users or send messages. Every
request object requires chat_id: the numeric Telegram chat to send to — the chat_id of the
chat event you are answering, or any other chat on your allow list
(/workspace/.tg-bot/allowed.json). The host rejects sends to chats that are not allowed.
Request types:
{type:"send_file",chat_id,path,message_thread_id?,caption?,kind?,reply_to_message_id?,disable_notification?}
sends the file at path (relative to /workspace or an absolute /workspace/... path)
with an optional caption; kind is "auto" (default: images are sent as photos,
audio as audio, video as video, other files as documents, and images over 10 MB
as documents) or an explicit "photo", "audio", "video", "voice", or "document".
{type:"send_media_group",chat_id,media,message_thread_id?,reply_to_message_id?,disable_notification?}
sends an album: media is an array of 2-10 items, each {type:"photo"|"video",media,caption?,parse_mode?,caption_entities?,show_caption_above_media?,has_spoiler?,width?,height?,duration?,supports_streaming?} where
media is the workspace path and type picks InputMediaPhoto or InputMediaVideo. The
matching send event's messageId is the first message of the album.
{type:"send_message",chat_id,text,message_thread_id?,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}
sends a text message, where parse_mode is "HTML" or "MarkdownV2" (omit for
plain text; parse_mode and entities are mutually exclusive), entities is a list of {type,offset,length} message
entities, link_preview_options is a Telegram LinkPreviewOptions object,
reply_markup is Telegram reply-markup JSON such as an inline_keyboard button
list, reply_to_message_id targets an earlier message, and
disable_notification sends silently.
{type:"send_location",chat_id,latitude,longitude,message_thread_id?,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}
sends a location pin (venue {title,address} sends a named venue instead).
{type:"send_poll",chat_id,question,options,message_thread_id?,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}
sends a poll: options has 2-10 choices, poll_type is "regular" or "quiz" (quiz
requires correct_option_id). Set is_anonymous:false to receive each vote as a
poll_answer event in events.jsonl; the matching outbox_sent event in events.jsonl
records pollId.
{type:"stop_poll",chat_id,message_id,reply_markup?} closes a poll early. Telegram's
final closed Poll arrives as the data field of the matching outbox_sent event in events.jsonl;
its id matches the poll_answer events' poll_id and the matching outbox_sent event's pollId.
{type:"send_reaction",chat_id,message_id,reaction} sets a Telegram reaction on any message in the chat (long-press style, e.g. a thumbs up on the user's message): reaction is an array of 1-3 {type:"emoji",emoji} or {type:"custom_emoji",custom_emoji_id} entries; [] removes your reaction. message_id is the numeric messageId of the target message (from a message event or an outbox_sent event in events.jsonl).
{type:"edit_message",chat_id,message_id,text,parse_mode?,entities?,link_preview_options?,reply_markup?} edits one of your earlier messages (text is required; reply_markup and link_preview_options are optional additions; message_id is the numeric messageId of that message from outbox_sent in events.jsonl).
{type:"delete_message",chat_id,message_id} deletes one of your earlier messages (message_id is the numeric messageId of that message from outbox_sent in events.jsonl).
{type:"create_forum_topic",chat_id,name,icon_color?,icon_custom_emoji_id?} creates a forum topic in a supergroup; outbox_sent returns message_thread_id.
{type:"edit_forum_topic",chat_id,message_thread_id,name?,icon_custom_emoji_id?} renames a topic or updates its icon.
{type:"close_forum_topic",chat_id,message_thread_id} closes a topic.
{type:"reopen_forum_topic",chat_id,message_thread_id} reopens a closed topic.
{type:"delete_forum_topic",chat_id,message_thread_id} permanently deletes a topic and its messages.
The send tool records one send_request command (with the requestId it returns to you) in
.tg-bot/events.jsonl; the host validates and delivers it, appending exactly one
outbox_sent or outbox_rejected event. outbox_sent echoes messageId/pollId for later
edits, reactions, or deletes. A rejected send arrives as a followup naming the requestId
and the rejection detail — fix and resend.
`;
