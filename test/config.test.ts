import { describe, expect, it } from "vitest";
import { canonicalChatId, chatPaths, parseConfig } from "../src/config.js";

const base = { TG_BOT_TOKEN: "token", ALLOWED_USER_IDS: "123, 456", DATA_DIR: "/tmp/data" };

describe("configuration", () => {
  it.each([
    { ALLOWED_USER_IDS: undefined },
    { ALLOWED_USER_IDS: "" },
    { ALLOWED_USER_IDS: "1,x" },
    { ALLOWED_USER_IDS: "0" },
  ])(
    "fails closed for missing or malformed authorization: %j",
    (extra) => expect(() => parseConfig({ ...base, ...extra })).toThrow(),
  );

  it("parses explicit allowed users and defaults the session idle timeout", () => {
    const config = parseConfig(base);
    expect([...config.allowedUserIds]).toEqual([123, 456]);
    expect(config.sessionIdleTimeoutMs).toBe(3_600_000);
  });

  it("parses and validates the session idle timeout", () => {
    expect(parseConfig({ ...base, SESSION_IDLE_TIMEOUT_MS: "7200000" }).sessionIdleTimeoutMs).toBe(7_200_000);
    for (const value of ["0", "-1", "1.5", "nope"]) {
      expect(() => parseConfig({ ...base, SESSION_IDLE_TIMEOUT_MS: value })).toThrow(
        "SESSION_IDLE_TIMEOUT_MS must be a positive integer",
      );
    }
  });

  it("derives canonical paths from numeric chat IDs", () => {
    expect(canonicalChatId(-42)).toBe("-42");
    expect(chatPaths("/data", -42)).toEqual({
      workspace: "/data/chats/-42/workspace",
      sessions: "/data/chats/-42/sessions",
    });
    expect(() => canonicalChatId(Number.NaN)).toThrow();
  });
});
