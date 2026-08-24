export type ConversationAddress = Record<string, unknown>;

export type ConversationAgentRef = {
  kind: "conversation";
  connectorId: string;
  conversationKey: string;
  address: ConversationAddress;
};

export type AgentRef = ConversationAgentRef;

export function conversationAgent(
  connectorId: string,
  conversationKey: string,
  address: ConversationAddress,
): ConversationAgentRef {
  if (connectorId.length === 0) throw new Error("connectorId must not be empty");
  if (conversationKey.length === 0) throw new Error("conversationKey must not be empty");
  return { kind: "conversation", connectorId, conversationKey, address };
}

export function sameConversation(left: ConversationAgentRef, right: ConversationAgentRef): boolean {
  return left.connectorId === right.connectorId && left.conversationKey === right.conversationKey;
}

export function conversationId(conversation: ConversationAgentRef): string {
  return JSON.stringify([conversation.connectorId, conversation.conversationKey]);
}

export function conversationSessionPath(conversation: ConversationAgentRef): string {
  return `${Buffer.from(conversation.connectorId).toString("base64url")}/${Buffer.from(conversation.conversationKey).toString("base64url")}`;
}
