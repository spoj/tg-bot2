import { conversationAgent, type ConversationAgentRef } from "./agent-ref.js";

export type TelegramAddress = {
  chat_id: number;
  message_thread_id?: number | undefined;
};

export function telegramConnectorId(botId: number): string {
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error("Telegram bot ID must be a positive safe integer");
  return `telegram:${botId}`;
}

export function telegramConversation(connectorId: string, chatId: number, threadId = 0): ConversationAgentRef {
  if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be a safe integer");
  if (!Number.isSafeInteger(threadId)) throw new Error("Telegram thread ID must be a safe integer");
  return conversationAgent(
    connectorId,
    `${chatId}:${threadId}`,
    { chat_id: chatId, ...(threadId === 0 ? {} : { message_thread_id: threadId }) },
  );
}

export function telegramAddress(conversation: ConversationAgentRef, connectorId?: string): Required<TelegramAddress> {
  if (connectorId !== undefined && conversation.connectorId !== connectorId) {
    throw new Error(`Conversation belongs to ${conversation.connectorId}, not ${connectorId}`);
  }
  const chatId = conversation.address.chat_id;
  const threadId = conversation.address.message_thread_id ?? 0;
  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) throw new Error("Conversation has an invalid Telegram chat_id");
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId)) throw new Error("Conversation has an invalid Telegram message_thread_id");
  return { chat_id: chatId, message_thread_id: threadId };
}
