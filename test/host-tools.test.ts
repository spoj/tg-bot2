import { describe, expect, it } from "vitest";
import { resolveSendTarget } from "../extensions/host-tools.js";

describe("resolveSendTarget", () => {
  it("resolves an explicit safe-integer chat_id", () => {
    expect(resolveSendTarget({ chat_id: 42 }, undefined)).toEqual({ chatId: 42 });
    expect(resolveSendTarget({ chat_id: 42, message_thread_id: 7 }, undefined)).toEqual({ chatId: 42, threadId: 7 });
  });

  it("defaults to the origin chat only when chat_id is absent", () => {
    const origin = { chatId: -100, threadId: 5 };
    expect(resolveSendTarget({}, origin)).toEqual({ chatId: -100, threadId: 5 });
    expect(resolveSendTarget({ message_thread_id: 9 }, origin)).toEqual({ chatId: -100, threadId: 9 });
    expect(resolveSendTarget({}, undefined)).toEqual({
      error: "chat_id is required when calling send from a background task or without an active chat session.",
    });
  });

  it("rejects an explicitly supplied non-safe-integer chat_id instead of defaulting", () => {
    const origin = { chatId: -100, threadId: 5 };
    for (const bad of [42.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "42"]) {
      const result = resolveSendTarget({ chat_id: bad }, origin);
      expect("error" in result).toBe(true);
      expect("chatId" in result).toBe(false);
    }
    expect(resolveSendTarget({ chat_id: 42.5 }, origin)).toEqual({ error: "chat_id must be a safe integer (got 42.5)" });
  });

  it("drops an invalid message_thread_id alongside an explicit chat_id", () => {
    expect(resolveSendTarget({ chat_id: 42, message_thread_id: 1.5 }, undefined)).toEqual({ chatId: 42 });
  });
});