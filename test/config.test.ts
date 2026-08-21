import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { workspacePath } from "../src/util.js";

const base = { TG_BOT_TOKEN: "token", DATA_DIR: "/tmp/data" };

describe("configuration", () => {
  it.each([
    { TG_BOT_TOKEN: undefined },
    { TG_BOT_TOKEN: "" },
    { DATA_DIR: undefined },
    { DATA_DIR: "" },
  ])(
    "fails closed for missing or empty required configuration: %j",
    (extra) => expect(() => parseConfig({ ...base, ...extra })).toThrow(),
  );

  it("parses the token and data directory with the exact runtime-independent shape", () => {
    const config = parseConfig(base);
    expect(config.token).toBe("token");
    expect(config.dataDir).toBe("/tmp/data");
    expect(Object.keys(config)).toEqual(["token", "dataDir"]);
  });

  it("derives the single workspace path from the data directory", () => {
    expect(workspacePath("/data")).toBe("/data/workspace");
  });
});
