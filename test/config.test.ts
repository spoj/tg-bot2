import os from "node:os";
import path from "node:path";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultDataDir, loadConfig, parseAuthToken, parseBotId } from "../src/config.js";
import { botPaths } from "../src/util.js";

describe("configuration", () => {
  it("parses bot ID from valid token prefixes", () => {
    expect(parseBotId("42:secret_token")).toBe(42);
    expect(parseBotId("8442941973:AAH_random_secret")).toBe(8442941973);
  });

  it.each([
    "",
    "not-a-token",
    "0:token",
    "-1:token",
    ":token",
    "9007199254740992:token",
  ])("rejects invalid Telegram bot token: %s", (token) => {
    expect(() => parseBotId(token)).toThrow();
  });

  it("derives bot paths from safe-integer bot IDs", () => {
    expect(botPaths("/data", 123)).toEqual({
      botDir: "/data/bots/123",
      workspace: "/data/bots/123/workspace",
      attachments: "/data/bots/123/attachments",
      timeline: "/data/bots/123/timeline.jsonl",
      schedules: "/data/bots/123/run/schedules.json",
      schedulerState: "/data/bots/123/scheduler-state.json",
      runDir: "/data/bots/123/run",
    });
    expect(() => botPaths("/data", Number.NaN)).toThrow();
  });

  describe("parseAuthToken", () => {
    it("reads token from JSON token property", async () => {
      const tmp = path.join(os.tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      try {
        await writeFile(tmp, JSON.stringify({ token: "123:abc" }));
        expect(await parseAuthToken(tmp)).toBe("123:abc");
      } finally {
        await rm(tmp, { force: true });
      }
    });

    it("reads key property as alias", async () => {
      const tmp = path.join(os.tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      try {
        await writeFile(tmp, JSON.stringify({ key: "456:def" }));
        expect(await parseAuthToken(tmp)).toBe("456:def");
      } finally {
        await rm(tmp, { force: true });
      }
    });

    it("reads raw token string", async () => {
      const tmp = path.join(os.tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      try {
        await writeFile(tmp, "789:ghi\n");
        expect(await parseAuthToken(tmp)).toBe("789:ghi");
      } finally {
        await rm(tmp, { force: true });
      }
    });

    it("throws if auth file has empty or missing token", async () => {
      const tmp = path.join(os.tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      try {
        await writeFile(tmp, JSON.stringify({ other: "value" }));
        await expect(parseAuthToken(tmp)).rejects.toThrow("No token or key found");
      } finally {
        await rm(tmp, { force: true });
      }
    });
  });

  describe("loadConfig", () => {
    it("discovers multiple bots in DATA_DIR/bots", async () => {
      const dataDir = path.join(os.tmpdir(), `tg-bot2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await mkdir(path.join(dataDir, "bots", "100"), { recursive: true });
        await writeFile(path.join(dataDir, "bots", "100", "auth.json"), JSON.stringify({ token: "100:token100" }));

        await mkdir(path.join(dataDir, "bots", "200"), { recursive: true });
        await writeFile(path.join(dataDir, "bots", "200", "auth.json"), JSON.stringify({ token: "200:token200" }));

        const config = await loadConfig({ dataDir });
        expect(config.dataDir).toBe(dataDir);
        expect(config.bots).toHaveLength(2);
        expect(config.bots[0]).toEqual({
          token: "100:token100",
          botId: 100,
          dataDir,
          botDir: path.join(dataDir, "bots", "100"),
          workspace: path.join(dataDir, "bots", "100", "workspace"),
        });
        expect(config.bots[1]).toEqual({
          token: "200:token200",
          botId: 200,
          dataDir,
          botDir: path.join(dataDir, "bots", "200"),
          workspace: path.join(dataDir, "bots", "200", "workspace"),
        });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("throws if no bots are configured", async () => {
      const dataDir = path.join(os.tmpdir(), `tg-bot2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await expect(loadConfig({ dataDir })).rejects.toThrow("No configured bots found");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("throws if token bot ID does not match directory name", async () => {
      const dataDir = path.join(os.tmpdir(), `tg-bot2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await mkdir(path.join(dataDir, "bots", "123"), { recursive: true });
        await writeFile(path.join(dataDir, "bots", "123", "auth.json"), JSON.stringify({ token: "456:wrong_token" }));
        await expect(loadConfig({ dataDir })).rejects.toThrow("does not match directory name");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("rejects symlinked bot directories and still loads real ones", async () => {
      const dataDir = path.join(os.tmpdir(), `tg-bot2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await mkdir(path.join(dataDir, "bots"), { recursive: true });
        const target = path.join(dataDir, "real-bot-100");
        await mkdir(target);
        await writeFile(path.join(target, "auth.json"), JSON.stringify({ token: "100:token100" }));
        await symlink(target, path.join(dataDir, "bots", "100"), "dir");

        await expect(loadConfig({ dataDir })).rejects.toThrow(/bots\/100/);
        await expect(loadConfig({ dataDir })).rejects.toThrow(/symlink/);

        await rm(path.join(dataDir, "bots", "100"), { force: true });
        await mkdir(path.join(dataDir, "bots", "100"));
        await writeFile(path.join(dataDir, "bots", "100", "auth.json"), JSON.stringify({ token: "100:token100" }));

        const config = await loadConfig({ dataDir });
        expect(config.bots).toHaveLength(1);
        expect(config.bots[0]?.botDir).toBe(path.join(dataDir, "bots", "100"));
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("defaults data directory to ~/.local/share/tg-bot2", () => {
      expect(defaultDataDir()).toBe(path.join(os.homedir(), ".local", "share", "tg-bot2"));
    });
  });
});
