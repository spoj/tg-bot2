import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataDir, loadConfig, parseAuthToken, parseBotId } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function connectorFile(dataDir: string, workspaceId: string, name: string, token: string): Promise<void> {
  const connectorsDir = path.join(dataDir, "workspaces", workspaceId, "connectors");
  await mkdir(connectorsDir, { recursive: true });
  await writeFile(path.join(connectorsDir, `${name}.json`), JSON.stringify({ token }));
}

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

  describe("parseAuthToken", () => {
    it.each([
      [JSON.stringify({ token: "123:abc" }), "123:abc"],
      [JSON.stringify({ key: "456:def" }), "456:def"],
      ["789:ghi\n", "789:ghi"],
    ])("reads supported auth file format", async (contents, expected) => {
      const dataDir = await temporaryDirectory();
      const filePath = path.join(dataDir, "auth.json");
      await writeFile(filePath, contents);
      await expect(parseAuthToken(filePath)).resolves.toBe(expected);
    });

    it("rejects an auth file without a token", async () => {
      const dataDir = await temporaryDirectory();
      const filePath = path.join(dataDir, "auth.json");
      await writeFile(filePath, JSON.stringify({ other: "value" }));
      await expect(parseAuthToken(filePath)).rejects.toThrow("No token or key found");
    });
  });

  describe("loadConfig", () => {
    it("loads and sorts workspace connector files", async () => {
      const dataDir = await temporaryDirectory();
      await connectorFile(dataDir, "zeta", "telegram", "300:token300");
      await connectorFile(dataDir, "alpha", "secondary", "200:token200");
      await connectorFile(dataDir, "alpha", "primary", "100:token100");

      const config = await loadConfig({ dataDir });

      expect(config.dataDir).toBe(dataDir);
      expect(config.workspaces.map((workspace) => workspace.id)).toEqual(["alpha", "zeta"]);
      expect(config.workspaces[0]?.paths).toEqual({
        root: path.join(dataDir, "workspaces", "alpha"),
        workspace: path.join(dataDir, "workspaces", "alpha", "workspace"),
        attachments: path.join(dataDir, "workspaces", "alpha", "attachments"),
        timeline: path.join(dataDir, "workspaces", "alpha", "timeline.jsonl"),
        notifications: path.join(dataDir, "workspaces", "alpha", "notifications.jsonl"),
        schedules: path.join(dataDir, "workspaces", "alpha", "run", "schedules.json"),
        resources: path.join(dataDir, "workspaces", "alpha", "run", "resources.json"),
        runDir: path.join(dataDir, "workspaces", "alpha", "run"),
        connectorsDir: path.join(dataDir, "workspaces", "alpha", "connectors"),
      });
      expect(config.workspaces[0]?.connectors).toEqual([
        {
          type: "telegram",
          id: "telegram:100",
          token: "100:token100",
          botId: 100,
          workspaceId: "alpha",
          dataDir,
          workspace: path.join(dataDir, "workspaces", "alpha", "workspace"),
          attachments: path.join(dataDir, "workspaces", "alpha", "attachments", Buffer.from("telegram:100").toString("base64url")),
          attachmentPrefix: Buffer.from("telegram:100").toString("base64url"),
        },
        expect.objectContaining({ id: "telegram:200", botId: 200, workspaceId: "alpha" }),
      ]);
      expect(config.workspaces[1]?.connectors).toEqual([
        expect.objectContaining({ id: "telegram:300", botId: 300, workspaceId: "zeta" }),
      ]);
    });
    it("rejects a Telegram bot configured in multiple workspaces", async () => {
      const dataDir = await temporaryDirectory();
      await connectorFile(dataDir, "alpha", "primary", "100:token-alpha");
      await connectorFile(dataDir, "beta", "primary", "100:token-beta");
      const alphaPath = path.join(dataDir, "workspaces", "alpha", "connectors", "primary.json");
      const betaPath = path.join(dataDir, "workspaces", "beta", "connectors", "primary.json");

      await expect(loadConfig({ dataDir })).rejects.toThrow(
        new RegExp(`Duplicate Telegram bot telegram:100.*(?:${alphaPath}|${betaPath}).*(?:${alphaPath}|${betaPath})`, "u"),
      );
    });



    it("rejects symlinked workspace directories", async () => {
      const dataDir = await temporaryDirectory();
      const target = path.join(dataDir, "outside");
      await mkdir(path.join(target, "connectors"), { recursive: true });
      await writeFile(path.join(target, "connectors", "telegram.json"), JSON.stringify({ token: "100:token100" }));
      await mkdir(path.join(dataDir, "workspaces"), { recursive: true });
      await symlink(target, path.join(dataDir, "workspaces", "linked"), "dir");

      await expect(loadConfig({ dataDir })).rejects.toThrow(/Workspace directory.*real directory/u);
    });

    it("throws if no workspaces are configured", async () => {
      const dataDir = await temporaryDirectory();
      await expect(loadConfig({ dataDir })).rejects.toThrow("No configured workspaces found");
    });

    it("defaults data directory to ~/.local/share/tg-bot2", () => {
      expect(defaultDataDir()).toBe(path.join(os.homedir(), ".local", "share", "tg-bot2"));
    });
  });
});
