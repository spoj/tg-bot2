import path from "node:path";

export type Config = {
  token: string;
  allowedUserIds: ReadonlySet<number>;
  dataDir: string;
  model?: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  toolTimeoutMs: number;
  maxToolOutputBytes: number;
  sessionIdleTimeoutMs: number;
};

const THINKING_LEVELS = new Set<Config["thinking"]>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required and must not be empty`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}

export function parseAllowedUserIds(value: string): ReadonlySet<number> {
  if (!value.trim()) throw new Error("ALLOWED_USER_IDS must not be empty");
  const ids = new Set<number>();
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!/^[1-9]\d*$/.test(item)) throw new Error(`Invalid Telegram user ID: ${JSON.stringify(raw)}`);
    const id = Number(item);
    if (!Number.isSafeInteger(id)) throw new Error(`Telegram user ID is outside the safe integer range: ${item}`);
    ids.add(id);
  }
  if (ids.size === 0) throw new Error("ALLOWED_USER_IDS must contain at least one ID");
  return ids;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const thinking = (env.AGENT_THINKING?.trim() || "medium") as Config["thinking"];
  if (!THINKING_LEVELS.has(thinking)) throw new Error(`Invalid AGENT_THINKING: ${thinking}`);
  const model = env.AGENT_MODEL?.trim();
  return {
    token: required(env, "TG_BOT_TOKEN"),
    allowedUserIds: parseAllowedUserIds(required(env, "ALLOWED_USER_IDS")),
    dataDir: path.resolve(required(env, "DATA_DIR")),
    ...(model ? { model } : {}),
    thinking,
    toolTimeoutMs: positiveInteger(env, "TOOL_TIMEOUT_MS", 120_000),
    maxToolOutputBytes: positiveInteger(env, "MAX_TOOL_OUTPUT_BYTES", 50_000),
    sessionIdleTimeoutMs: positiveInteger(env, "SESSION_IDLE_TIMEOUT_MS", 3_600_000),
  };
}

export function canonicalChatId(chatId: number): string {
  if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be a safe integer");
  return String(chatId);
}

export function chatPaths(dataDir: string, chatId: number): { workspace: string; sessions: string } {
  const root = path.join(dataDir, "chats", canonicalChatId(chatId));
  return { workspace: path.join(root, "workspace"), sessions: path.join(root, "sessions") };
}
