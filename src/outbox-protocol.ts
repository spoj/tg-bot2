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
  path: string;
  caption?: string;
  kind?: WorkspaceOutboxFileKind;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export type WorkspaceOutboxSendMessageRequest = {
  version: 1;
  type: "send_message";
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
  message_id: number;
  reply_markup?: unknown;
};

export type WorkspaceOutboxReaction =
  | { type: "emoji"; emoji: string }
  | { type: "custom_emoji"; custom_emoji_id: string };

type WorkspaceOutboxSendReactionRequest = {
  version: 1;
  type: "send_reaction";
  message_id: number;
  reaction: WorkspaceOutboxReaction[];
};

export type WorkspaceOutboxEditMessageRequest = {
  version: 1;
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
  type: "delete_message";
  message_id: number;
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
  } else if (
    request.type !== "send_message" && request.type !== "send_location" &&
    request.type !== "send_poll" && request.type !== "stop_poll" &&
    request.type !== "send_reaction" && request.type !== "edit_message" &&
    request.type !== "delete_message"
  ) {
    throw new Error("Outbox request type must be send_file, send_media_group, send_message, send_location, send_poll, stop_poll, send_reaction, edit_message, or delete_message");
  }
  return { ...request, version: 1, type: request.type } as WorkspaceOutboxRequest;
}

export const OUTBOX_PROMPT = `To send files or messages through Telegram, write one request per send under
/workspace/.tg-bot/outbox/. Request types:
{version:1,type:"send_file",path,caption?,kind?,reply_to_message_id?,disable_notification?}
sends the file at path (relative to /workspace or an absolute /workspace/... path)
with an optional caption; kind is "auto" (default: images are sent as photos,
audio as audio, video as video, other files as documents, and images over 10 MB
as documents) or an explicit "photo", "audio", "video", "voice", or "document".
{version:1,type:"send_media_group",media,reply_to_message_id?,disable_notification?}
sends an album: media is an array of 2-10 items, each {type:"photo"|"video",media,caption?,parse_mode?,caption_entities?,show_caption_above_media?,has_spoiler?,width?,height?,duration?,supports_streaming?} where
media is the workspace path and type picks InputMediaPhoto or InputMediaVideo. The
matching send event's messageId is the first message of the album.
{version:1,type:"send_message",text,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}
sends a text message, where parse_mode is "HTML" or "MarkdownV2" (omit for
plain text; malformed markup is resent as plain text; parse_mode and entities
are mutually exclusive), entities is a list of {type,offset,length} message
entities, link_preview_options is a Telegram LinkPreviewOptions object,
reply_markup is Telegram reply-markup JSON such as an inline_keyboard button
list, reply_to_message_id targets an earlier message, and
disable_notification sends silently.
{version:1,type:"send_location",latitude,longitude,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}
sends a location pin (venue {title,address} sends a named venue instead).
{version:1,type:"send_poll",question,options,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}
sends a poll: options has 2-10 choices, poll_type is "regular" or "quiz" (quiz
requires correct_option_id). Set is_anonymous:false to receive each vote as a
poll_answer event in chat.jsonl; the matching send line in chat.jsonl
records pollId.
{version:1,type:"stop_poll",message_id,reply_markup?} closes a poll early. Telegram's
final closed Poll arrives as the data field of the matching send event in chat.jsonl;
its id matches the poll_answer events' poll_id and the matching send event's pollId.
{version:1,type:"send_reaction",message_id,reaction} sets a Telegram reaction on any message in the chat (long-press style, e.g. a thumbs up on the user's message): reaction is an array of 1-3 {type:"emoji",emoji} or {type:"custom_emoji",custom_emoji_id} entries; [] removes your reaction. message_id is the numeric messageId of the target message from chat.jsonl.
{version:1,type:"edit_message",message_id,text,parse_mode?,entities?,link_preview_options?,reply_markup?} edits one of your earlier messages (text is required; reply_markup and link_preview_options are optional additions; message_id is the numeric messageId of that message).
{version:1,type:"delete_message",message_id} deletes one of your earlier messages (message_id is the numeric messageId of that message).
The request's filename is its name: the host assigns a unique UUID id upon claim,
echoes both id and name in matching send and system events, and names it in rejection reports.
Filenames must be unique per send but their content never matters beyond that: no id field
exists inside the request. Write each request to a temporary filename that does not end in .json,
then atomically rename it to the final unique *.json request name.
Every request is reported in .tg-bot/system.jsonl as outbox_claimed followed by one terminal
outbox_sent or outbox_rejected event. Requests leave no other trace in the outbox directory.
`;
