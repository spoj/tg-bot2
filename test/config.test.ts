import { describe, expect, it } from "vitest";
import { canonicalChatId, chatPaths, parseConfig } from "../src/config.js";

const base = { TG_BOT_TOKEN: "token", ALLOWED_USER_IDS: "123, 456", DATA_DIR: "/tmp/data" };

describe("configuration", () => {
  it.each([
    { TG_BOT_TOKEN: undefined },
    { TG_BOT_TOKEN: "" },
    { ALLOWED_USER_IDS: undefined },
    { ALLOWED_USER_IDS: "" },
    { ALLOWED_USER_IDS: "1,x" },
    { ALLOWED_USER_IDS: "0" },
    { ALLOWED_USER_IDS: "-1" },
    { ALLOWED_USER_IDS: "9007199254740992" },
    { DATA_DIR: undefined },
    { DATA_DIR: "" },
  ])(
    "fails closed for missing or malformed required configuration: %j",
    (extra) => expect(() => parseConfig({ ...base, ...extra })).toThrow(),
  );

  it("parses explicit allowed users with the exact runtime-independent shape", () => {
    const config = parseConfig(base);
    expect([...config.allowedUserIds]).toEqual([123, 456]);
    expect(config.token).toBe("token");
    expect(config.dataDir).toBe("/tmp/data");
    expect(Object.keys(config)).toEqual(["token", "allowedUserIds", "dataDir"]);
  });

  it("does not expose obsolete environment runtime fields", () => {
    const config = parseConfig({
      ...base,
      TOOL_TIMEOUT_MS: "not-a-number",
      MAX_TOOL_OUTPUT_BYTES: "not-a-number",
      SESSION_IDLE_TIMEOUT_MS: "not-a-number",
      AGENT_MODEL: "",
      AGENT_THINKING: "invalid",
    });
    expect(config).not.toHaveProperty("toolTimeoutMs");
    expect(config).not.toHaveProperty("maxToolOutputBytes");
    expect(config).not.toHaveProperty("sessionIdleTimeoutMs");
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("thinking");
  });

  it("derives canonical paths from numeric chat IDs", () => {
    expect(canonicalChatId(-42)).toBe("-42");
    expect(chatPaths("/data", -42)).toEqual({ workspace: "/data/chats/-42/workspace" });
    expect(chatPaths("/data", 42)).toEqual({ workspace: "/data/chats/42/workspace" });
    expect(() => canonicalChatId(Number.NaN)).toThrow();
  });
});
