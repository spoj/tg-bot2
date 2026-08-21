import { describe, expect, it } from "vitest";
import { parseBotId, parseConfig } from "../src/config.js";
import { botPaths } from "../src/util.js";

const base = { TG_BOT_TOKEN: "123:token", DATA_DIR: "/tmp/data" };

describe("configuration", () => {
  it.each([
    { TG_BOT_TOKEN: undefined },
    { TG_BOT_TOKEN: "" },
    { TG_BOT_TOKEN: "not-a-token" },
    { TG_BOT_TOKEN: "0:token" },
    { TG_BOT_TOKEN: "-1:token" },
    { DATA_DIR: undefined },
    { DATA_DIR: "" },
  ])(
    "fails closed for missing or invalid required configuration: %j",
    (extra) => expect(() => parseConfig({ ...base, ...extra })).toThrow(),
  );

  it("parses the token, botId, and data directory with the exact shape", () => {
    const config = parseConfig(base);
    expect(config.token).toBe("123:token");
    expect(config.botId).toBe(123);
    expect(config.dataDir).toBe("/tmp/data");
    expect(Object.keys(config)).toEqual(["token", "botId", "dataDir"]);
  });

  it("parses bot ID from valid token prefixes", () => {
    expect(parseBotId("42:secret_token")).toBe(42);
    expect(parseBotId("8442941973:AAH_random_secret")).toBe(8442941973);
  });

  it("derives bot directory and workspace paths from safe-integer bot IDs", () => {
    expect(botPaths("/data", 123)).toEqual({
      botDir: "/data/bots/123",
      workspace: "/data/bots/123/workspace",
    });
    expect(() => botPaths("/data", Number.NaN)).toThrow();
  });
});
