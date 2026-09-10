import { describe, expect, it } from "vitest";
import { conversationAgent, parseConversationRef } from "../src/agent-ref.js";

describe("parseConversationRef", () => {
  const target = conversationAgent("custom:primary", "room:thread", { room: "room", thread: 7 });

  it("preserves the connector-specific address and drops unrelated envelope fields", () => {
    expect(parseConversationRef({ ...target, extra: true }, "Invalid target")).toEqual(target);
  });

  it("rejects malformed envelopes with the caller's error", () => {
    for (const value of [
      null, undefined, [], "room", 7,
      { ...target, kind: "other" },
      { ...target, connectorId: undefined },
      { ...target, conversationKey: 7 },
      { ...target, address: undefined },
      { ...target, address: null },
      { ...target, address: [] },
      { ...target, address: "room" },
    ]) {
      expect(() => parseConversationRef(value, "Invalid target")).toThrow("Invalid target");
    }
  });
});
