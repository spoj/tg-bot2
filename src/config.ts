import path from "node:path";

export type Config = {
  token: string;
  botId: number;
  dataDir: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required and must not be empty`);
  return value;
}

export function parseBotId(token: string): number {
  const [prefix] = token.split(":");
  if (!prefix || !/^[1-9]\d*$/.test(prefix)) {
    throw new Error("Invalid TG_BOT_TOKEN: must start with a numeric bot ID (e.g. 123456:ABC-DEF...)");
  }
  const id = Number(prefix);
  if (!Number.isSafeInteger(id)) {
    throw new Error("Telegram bot ID is outside the safe integer range");
  }
  return id;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = required(env, "TG_BOT_TOKEN");
  return {
    token,
    botId: parseBotId(token),
    dataDir: path.resolve(required(env, "DATA_DIR")),
  };
}
