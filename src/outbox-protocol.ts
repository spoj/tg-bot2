export const TELEGRAM_METHODS = [
  "sendMessage",
  "sendPhoto",
  "sendAudio",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendVideoNote",
  "sendDocument",
  "sendMediaGroup",
  "sendLocation",
  "sendVenue",
  "sendContact",
  "sendDice",
  "sendPoll",
  "stopPoll",
  "setMessageReaction",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "deleteMessage",
  "createForumTopic",
  "editForumTopic",
  "closeForumTopic",
  "reopenForumTopic",
  "deleteForumTopic",
] as const;

export type TelegramMethod = typeof TELEGRAM_METHODS[number];

export type WorkspaceOutboxRequest = {
  method: TelegramMethod;
  chat_id: number;
  message_thread_id?: number;
  topic_name?: string;
  [key: string]: unknown;
};

export type WorkspaceOutboxDispatchResult = {
  messageId?: number;
  pollId?: string;
  messageThreadId?: number;
  request?: WorkspaceOutboxRequest;
  data?: unknown;
};

export type WorkspaceOutboxDispatcher = (
  chatId: number,
  requestId: string,
  request: WorkspaceOutboxRequest,
) => Promise<WorkspaceOutboxDispatchResult | undefined>;

const METHODS = new Set<string>(TELEGRAM_METHODS);

export function validateRequest(value: unknown): WorkspaceOutboxRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telegram request must be a JSON object");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.method !== "string" || !METHODS.has(request.method)) {
    throw new Error(`Unsupported Telegram Bot API method: ${String(request.method)}`);
  }
  if (typeof request.chat_id !== "number" || !Number.isSafeInteger(request.chat_id)) {
    throw new Error("Telegram request chat_id must be a safe integer");
  }
  if (request.message_thread_id !== undefined && (typeof request.message_thread_id !== "number" || !Number.isSafeInteger(request.message_thread_id))) {
    throw new Error("Telegram request message_thread_id must be a safe integer");
  }
  if (request.topic_name !== undefined) {
    if (request.method !== "sendMessage") throw new Error("topic_name is only valid with sendMessage");
    if (typeof request.topic_name !== "string" || request.topic_name.trim().length === 0) throw new Error("topic_name must be a non-empty string");
    if (request.message_thread_id === undefined) throw new Error("topic_name requires message_thread_id");
  }
  return request as WorkspaceOutboxRequest;
}

export const OUTBOX_PROMPT = `Use send as a thin Telegram Bot API client. Set method to an allowed Bot API method and put its documented snake_case parameters beside it. Conversation agents default chat_id and message_thread_id to the current conversation; task agents must set chat_id.
Allowed methods: ${TELEGRAM_METHODS.join(", ")}.
Host conveniences:
- For upload methods, use an absolute /workspace/... path in the normal Telegram media field (photo, audio, video, animation, voice, video_note, or document). The host copies it into read-only /run/attachments before delivery and records that stable path.
- sendMediaGroup applies the same substitution to each media item.
- sendMessage may include topic_name; after delivering the message, the host renames that topic in the same tool call.
All other parameters, including reply_markup keyboards and request_location/contact/poll/web_app buttons, pass through unchanged. The host validates routing and local files, delivers synchronously, and records successful calls in /run/timeline.jsonl.
`;
