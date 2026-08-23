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

  it("retroactively annotates received and sent attachments in place", async () => {
    const dataDir = await temporaryDirectory();
    const timeline = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
    const received = "/run/attachments/1/2026-08-23/10/photo.jpg";
    const sent = "/run/attachments/1/2026-08-23/request-1/chart.png";
    await timeline.publish({
      type: "message",
      chat_id: 1,
      message: { message_id: 10 },
      attachments: [{ type: "photo", path: received, mimeType: "image/jpeg" }],
    });
    await timeline.publish({
      type: "sent",
      requestId: "request-1",
      actor: conversationAgent(1),
      target: conversationAgent(1),
      request: { method: "sendPhoto", photo: sent },
      attachments: [{ path: sent }],
    });

    await expect(timeline.annotateAttachment(received, "Whiteboard sketch of the queue design")).resolves.toBe(1);
    await expect(timeline.annotateAttachment(sent, "Latency chart comparing two queue designs")).resolves.toBe(1);
    await expect(timeline.annotateAttachment(received, "Updated whiteboard description")).resolves.toBe(1);

    const raw = await readFile(timeline.filePath, "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ attachments: [{ path: received, description: "Updated whiteboard description" }] });
    expect(records[1]).toMatchObject({ attachments: [{ path: sent, description: "Latency chart comparing two queue designs" }] });
    expect(raw).toContain("Latency chart comparing two queue designs");
  });

  it("rebuilds message and poll ownership from persisted timeline events", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const writer = new WorkspaceTimeline(filePath);
    const inboundOwner = conversationAgent(1, 7);
    const pollOwner = conversationAgent(2, 9);
    await writer.publish({
      type: "message",
      chat_id: 1,
      message: { message_id: 12, message_thread_id: 7 },
      attachments: [],
    });
    await writer.publish({
      type: "sent",
      requestId: "request-poll",
      actor: pollOwner,
      target: pollOwner,
      request: { method: "sendPoll", chat_id: 2, message_thread_id: 9 },
      messageId: 30,
      pollId: "poll-30",
    });

    const restored = new WorkspaceTimeline(filePath);
    await restored.loadOwnership();
    expect(restored.messageOwner(1, 12)).toEqual(inboundOwner);
    expect(restored.messageOwner(2, 30)).toEqual(pollOwner);
    expect(restored.pollOwner("poll-30")).toEqual(pollOwner);
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
