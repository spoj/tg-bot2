import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTimeline } from "../src/events.js";
import { conversationAgent } from "../src/agent-ref.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-timeline-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function blockedTimelinePath(dataDir: string): Promise<string> {
  const blocked = path.join(dataDir, "blocked");
  await writeFile(blocked, "not a directory", "utf8");
  return path.join(blocked, "timeline.jsonl");
}

describe("WorkspaceTimeline", () => {
  it("broadcasts and appends meaningful events", async () => {
    const dataDir = await temporaryDirectory();
    const timeline = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
    const listener = vi.fn();
    timeline.subscribe(listener);

    const line = await timeline.publish({ type: "message", chat_id: 1, message: { text: "hello" }, attachments: [] });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "message", chat_id: 1 }), line);
    expect(await readFile(timeline.filePath, "utf8")).toBe(`${line}\n`);
  });

  it("broadcasts even when persistence fails", async () => {
    const dataDir = await temporaryDirectory();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const timeline = new WorkspaceTimeline(await blockedTimelinePath(dataDir));
    const listener = vi.fn();
    timeline.subscribe(listener);

    const line = await timeline.publish({ type: "message", chat_id: 1, message: { text: "hello" }, attachments: [] });
    expect(line).toEqual(expect.any(String));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("delivers task progress without writing it to the timeline", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const timeline = new WorkspaceTimeline(filePath);
    const listener = vi.fn();
    timeline.subscribe(listener);

    timeline.notify({
      type: "task_progress",
      trigger: { kind: "agent", agent: conversationAgent(1) },
      tasks: [{ runId: "run-1", prompt: "work", runningMs: 10, idleMs: null }],
    });

    expect(listener).toHaveBeenCalledOnce();
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
