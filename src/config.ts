import os from "node:os";
import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { telegramConnectorId } from "./telegram-ref.js";
import { isMissing, workspacePaths, type WorkspacePaths } from "./util.js";

export type TelegramConnectorConfig = {
  type: "telegram";
  id: string;
  token: string;
  botId: number;
  workspaceId: string;
  dataDir: string;
  attachmentPrefix: string;
  workspace: string;
  attachments: string;
};

export type Config = TelegramConnectorConfig;

export type WorkspaceConfig = {
  id: string;
  paths: WorkspacePaths;
  connectors: TelegramConnectorConfig[];
};

export type AppConfig = {
  dataDir: string;
  workspaces: WorkspaceConfig[];
};

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".local", "share", "tg-bot2");
}

export function parseBotId(token: string): number {
  const [prefix] = token.split(":");
  if (!prefix || !/^[1-9]\d*$/u.test(prefix)) {
    throw new Error("Invalid Telegram bot token: must start with a numeric bot ID (e.g. 123456:ABC-DEF...)");
  }
  const id = Number(prefix);
  if (!Number.isSafeInteger(id)) throw new Error("Telegram bot ID is outside the safe integer range");
  return id;
}

export async function parseAuthToken(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  let token: string | undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.token === "string") token = record.token.trim();
      else if (typeof record.key === "string") token = record.key.trim();
    }
  } catch {
    token = raw.trim();
  }
  if (!token) throw new Error(`No token or key found in ${filePath}`);
  return token;
}

async function entries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function assertRealDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${directory}`);
}


async function loadTelegramConnectors(dataDir: string, workspaceId: string, paths: WorkspacePaths): Promise<TelegramConnectorConfig[]> {
  const connectors: TelegramConnectorConfig[] = [];
  for (const entry of await entries(paths.connectorsDir)) {
    if (!entry.name.endsWith(".json")) continue;
    const filePath = path.join(paths.connectorsDir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Connector configuration must be a regular file: ${filePath}`);
    const token = await parseAuthToken(filePath);
    const botId = parseBotId(token);
    connectors.push({
      type: "telegram",
      id: telegramConnectorId(botId),
      token,
      botId,
      workspaceId,
      dataDir,
      workspace: paths.workspace,
      attachments: path.join(paths.attachments, Buffer.from(telegramConnectorId(botId)).toString("base64url")),
      attachmentPrefix: Buffer.from(telegramConnectorId(botId)).toString("base64url"),
    });
  }
  connectors.sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const connector of connectors) {
    if (ids.has(connector.id)) throw new Error(`Duplicate connector ${connector.id} in workspace ${workspaceId}`);
    ids.add(connector.id);
  }
  return connectors;
}

export async function loadConfig(options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const requestedDataDir = options.dataDir ?? env.DATA_DIR;
  const dataDir = path.resolve(requestedDataDir?.trim() || defaultDataDir());

  const workspaces: WorkspaceConfig[] = [];
  const workspacesDir = path.join(dataDir, "workspaces");
  for (const entry of await entries(workspacesDir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const paths = workspacePaths(dataDir, entry.name);
    await assertRealDirectory(paths.root, "Workspace directory");
    const connectors = await loadTelegramConnectors(dataDir, entry.name, paths);
    if (connectors.length > 0) workspaces.push({ id: entry.name, paths, connectors });
  }
  workspaces.sort((left, right) => left.id.localeCompare(right.id));

  if (workspaces.length === 0) {
    throw new Error(`No configured workspaces found in ${workspacesDir}`);
  }
  return { dataDir, workspaces };
}
