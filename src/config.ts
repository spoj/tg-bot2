import path from "node:path";

export type Config = {
  token: string;
  allowedUserIds: ReadonlySet<number>;
  dataDir: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required and must not be empty`);
  return value;
}

function parseAllowedUserIds(value: string): ReadonlySet<number> {
  if (!value.trim()) throw new Error("ALLOWED_USER_IDS must not be empty");
  const ids = new Set<number>();
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!/^[1-9]\d*$/.test(item)) throw new Error(`Invalid Telegram user ID: ${JSON.stringify(raw)}`);
    const id = Number(item);
    if (!Number.isSafeInteger(id)) throw new Error(`Telegram user ID is outside the safe integer range: ${item}`);
    ids.add(id);
  }
  return ids;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    token: required(env, "TG_BOT_TOKEN"),
    allowedUserIds: parseAllowedUserIds(required(env, "ALLOWED_USER_IDS")),
    dataDir: path.resolve(required(env, "DATA_DIR")),
  };
}
