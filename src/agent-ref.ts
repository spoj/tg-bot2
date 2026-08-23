export type ConversationAgentRef = {
  kind: "conversation";
  chatId: number;
  threadId: number;
};

export type TaskAgentRef = {
  kind: "task";
  runId: string;
};

export type AgentRef = ConversationAgentRef | TaskAgentRef;

export type TaskTrigger =
  | { kind: "agent"; agent: ConversationAgentRef }
  | { kind: "schedule"; occurrenceId: string };

export function conversationAgent(chatId: number, threadId = 0): ConversationAgentRef {
  return { kind: "conversation", chatId, threadId };
}

export function sameConversation(left: ConversationAgentRef, right: ConversationAgentRef): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}
