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

export function parseConversationRef(value: unknown, message: string): ConversationAgentRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "conversation" || typeof raw.connectorId !== "string" || typeof raw.conversationKey !== "string") {
    throw new Error(message);
  }
  if (raw.address === null || typeof raw.address !== "object" || Array.isArray(raw.address)) throw new Error(message);
  return {
    kind: "conversation",
    connectorId: raw.connectorId,
    conversationKey: raw.conversationKey,
    address: raw.address as Record<string, unknown>,
  };
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
