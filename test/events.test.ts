import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationAgent } from "../src/agent-ref.js";
import { WorkspaceTimeline } from "../src/events.js";

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
  it("publishes generic connector envelopes, appends them, and broadcasts persisted records", async () => {
    const dataDir = await temporaryDirectory();
    const timeline = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
    const listener = vi.fn();
    const conversation = conversationAgent("matrix:primary", "!room:thread", { room_id: "!room", thread_id: "thread" });
    timeline.subscribe(listener);

    const firstLine = await timeline.publish({
      type: "matrix.message",
      connectorId: conversation.connectorId,
      conversation,
      payload: { event_id: "$one", body: "hello" },
      attachments: [],
    });
    const secondLine = await timeline.publish({
      type: "connector.sent",
      connectorId: conversation.connectorId,
      actor: conversation,
      conversation,
      request: { method: "send", text: "hi" },
      response: { event_id: "$two" },
    });
    const first = JSON.parse(firstLine) as Record<string, unknown>;
    const second = JSON.parse(secondLine) as Record<string, unknown>;

    expect(first).toMatchObject({
      v: 2,
      id: expect.any(String),
      seq: 1,
      t: expect.any(String),
      type: "matrix.message",
      connectorId: "matrix:primary",
      conversation,
      payload: { event_id: "$one", body: "hello" },
    });
    expect(second).toMatchObject({ v: 2, seq: 2, type: "connector.sent", connectorId: "matrix:primary", conversation });
    expect(listener).toHaveBeenNthCalledWith(1, first, firstLine);
    expect(listener).toHaveBeenNthCalledWith(2, second, secondLine);
    await expect(readFile(timeline.filePath, "utf8")).resolves.toBe(`${firstLine}\n${secondLine}\n`);
  });

  it("continues sequence numbers after existing v2 records", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    await writeFile(filePath, `${JSON.stringify({
      v: 2,
      id: "existing",
      seq: 8,
      t: "2026-08-23T10:00:00.000Z",
      type: "schedule_fired",
      payload: { scheduleId: "daily" },
    })}\n`);
    const timeline = new WorkspaceTimeline(filePath);

    await timeline.start();
    const line = await timeline.publish({ type: "schedule_fired", payload: { scheduleId: "weekly" } });

    expect(JSON.parse(line)).toMatchObject({ v: 2, seq: 9, type: "schedule_fired" });
  });

  it("retroactively annotates connector attachment records in place", async () => {
    const dataDir = await temporaryDirectory();
    const timeline = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
    const conversation = conversationAgent("files:primary", "channel-7", { channel: "channel-7" });
    const received = "/run/attachments/files-primary/received/photo.jpg";
    const sent = "/run/attachments/files-primary/sent/chart.png";
    await timeline.publish({
      type: "files.message",
      connectorId: conversation.connectorId,
      conversation,
      payload: { id: "message-1" },
      attachments: [{ type: "photo", path: received, mimeType: "image/jpeg" }],
    });
    await timeline.publish({
      type: "connector.sent",
      connectorId: conversation.connectorId,
      actor: conversation,
      conversation,
      request: { method: "sendFile" },
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
  });

  it("does not broadcast an event that could not be persisted", async () => {
    const dataDir = await temporaryDirectory();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const timeline = new WorkspaceTimeline(await blockedTimelinePath(dataDir));
    const listener = vi.fn();
    const conversation = conversationAgent("custom:primary", "room-1", { room: "room-1" });
    timeline.subscribe(listener);

    await expect(timeline.publish({
      type: "custom.message",
      connectorId: conversation.connectorId,
      conversation,
      payload: { text: "hello" },
    })).rejects.toThrow("Failed to persist timeline event");
    expect(listener).not.toHaveBeenCalled();
  });
});
