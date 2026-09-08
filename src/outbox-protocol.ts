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
  attachmentPaths?: string[];
  data?: unknown;
};

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
export const OUTBOX_PROMPT = `Use send as a thin Telegram Bot API client for this conversation. Omit chat_id and message_thread_id: the host derives both from the authenticated owning session and rejects cross-conversation targets.
Allowed methods: ${TELEGRAM_METHODS.join(", ")}.
Host conveniences:
- For upload methods, use an absolute /workspace/... path in the normal Telegram media field (photo, audio, video, animation, voice, video_note, or document). The host copies it into read-only /run/attachments before delivery and records that stable path.
- sendMediaGroup applies the same substitution to each media item.
- sendMessage may include topic_name; after delivering the message, the host attempts to rename this conversation's topic. Rename failure does not fail the send.
For text and caption fields on methods that support Telegram's \`parse_mode\`, use Telegram HTML by default and include \`parse_mode: "HTML"\` in that request. For \`sendMediaGroup\`, put \`parse_mode: "HTML"\` on each media item that has a caption; there is no group-level parse mode. Use only Telegram-supported HTML tags such as \`<b>\`, \`<i>\`, \`<u>\`, \`<s>\`, \`<code>\`, \`<pre>\`, and \`<a href="...">\`. Escape inserted plain text (\`&\` as \`&amp;\`, \`<\` as \`&lt;\`, \`>\` as \`&gt;\`); escape HTML attribute values too. Use newline characters, not \`<br>\`. Example: \`send({method: "sendMessage", text: "<b>Today</b>\\n• Task — <i>Ted</i>", parse_mode: "HTML"})\`. Do not send raw Markdown markers as formatting. This is a thin native API client: write valid HTML yourself; the host does not convert Markdown, validate HTML, or silently fall back.
All other parameters, including reply_markup keyboards and request_location/contact/poll/web_app buttons, pass through unchanged. Message mutations are allowed only for messages recorded as owned by this conversation. The host validates ownership and local files, delivers synchronously, and records successful calls in /run/timeline.jsonl.
After changing Pi settings, packages, or instructions, tell the user to run /restart. This closes all workers in this workspace; the next input starts a fresh session with the updated profile. /model, /thinking, and other interactive Pi commands are not Telegram commands.
`;
