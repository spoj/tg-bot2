import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceEventLog } from "../src/events.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-events-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** An append target that can never be created: its parent path is a regular file. */
async function blockedLogPath(dataDir: string): Promise<string> {
  const blocked = path.join(dataDir, "blocked");
  await writeFile(blocked, "not a directory", "utf8");
  return path.join(blocked, "events.jsonl");
}

describe("WorkspaceEventLog", () => {
  it("publishes to listeners only when the append persisted", async () => {
    const dataDir = await temporaryDirectory();
    const events = new WorkspaceEventLog(path.join(dataDir, "events.jsonl"));
    const listener = vi.fn();
    events.subscribe(listener);

    const line = await events.publish({ type: "allowlist_updated", chats: [1, 2] });
    expect(line).toEqual(expect.any(String));
    expect(listener).toHaveBeenCalledTimes(1);

    const blocked = new WorkspaceEventLog(await blockedLogPath(dataDir), () => {});
    const blockedListener = vi.fn();
    blocked.subscribe(blockedListener);

    const failedLine = await blocked.publish({ type: "allowlist_updated", chats: [3] });
    expect(failedLine).toBeUndefined();
    expect(blockedListener).not.toHaveBeenCalled();
  });

  it("readAll and findLast log read failures instead of silently returning an empty log", async () => {
    const dataDir = await temporaryDirectory();
    const logged: unknown[] = [];
    const events = new WorkspaceEventLog(await blockedLogPath(dataDir), (error) => logged.push(error));

    expect(await events.readAll()).toEqual([]);
    expect(await events.findLast(() => true)).toBeUndefined();
    expect(logged).toHaveLength(2);
  });
});