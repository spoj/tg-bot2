import path from "node:path";

export type Config = {
  token: string;
  dataDir: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required and must not be empty`);
  return value;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    token: required(env, "TG_BOT_TOKEN"),
    dataDir: path.resolve(required(env, "DATA_DIR")),
  };
}
