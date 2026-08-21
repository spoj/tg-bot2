import os from "node:os";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { botPaths, isMissing } from "./util.js";

export type BotConfig = {
  token: string;
  botId: number;
  dataDir: string;
  botDir?: string;
  workspace?: string;
};

export type Config = BotConfig;

export type AppConfig = {
  dataDir: string;
  bots: BotConfig[];
};

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".local", "share", "tg-bot2");
}

export function parseBotId(token: string): number {
  const [prefix] = token.split(":");
  if (!prefix || !/^[1-9]\d*$/.test(prefix)) {
    throw new Error("Invalid Telegram bot token: must start with a numeric bot ID (e.g. 123456:ABC-DEF...)");
  }
  const id = Number(prefix);
  if (!Number.isSafeInteger(id)) {
    throw new Error("Telegram bot ID is outside the safe integer range");
  }
  return id;
}

export async function parseAuthToken(filePath: string): Promise<string> {
  const raw = await readFile(filePath, "utf8");
  let token: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.token === "string" && record.token.trim()) {
        token = record.token.trim();
      } else if (typeof record.key === "string" && record.key.trim()) {
        token = record.key.trim();
      }
    } else if (typeof parsed === "string" && parsed.trim()) {
      token = parsed.trim();
    }
  } catch {
    const trimmed = raw.trim();
    if (trimmed) token = trimmed;
  }
  if (!token) {
    throw new Error(`No token or key found in ${filePath}`);
  }
  return token;
}

export async function loadConfig(options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const requestedDataDir = options.dataDir ?? env.DATA_DIR;
  const dataDir = path.resolve(requestedDataDir?.trim() || defaultDataDir());
  const botsDir = path.join(dataDir, "bots");

  let entries: Dirent[] = [];
  try {
    entries = await readdir(botsDir, { withFileTypes: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const bots: BotConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!/^[1-9]\d*$/.test(entry.name)) continue;

    const dirBotId = Number(entry.name);
    if (!Number.isSafeInteger(dirBotId)) continue;

    const authFile = path.join(botsDir, entry.name, "auth.json");
    let token: string;
    try {
      token = await parseAuthToken(authFile);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    const tokenBotId = parseBotId(token);
    if (tokenBotId !== dirBotId) {
      throw new Error(`Bot ID in token (${tokenBotId}) does not match directory name (${dirBotId}) in ${authFile}`);
    }

    const { botDir, workspace } = botPaths(dataDir, tokenBotId);
    bots.push({
      token,
      botId: tokenBotId,
      dataDir,
      botDir,
      workspace,
    });
  }

  if (bots.length === 0) {
    throw new Error(
      `No configured bots found in ${botsDir}. Create ${path.join(botsDir, "<botId>", "auth.json")} containing {"token": "<bot_token>"}.`,
    );
  }

  bots.sort((a, b) => a.botId - b.botId);

  return {
    dataDir,
    bots,
  };
}
