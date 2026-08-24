import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationAgent } from "../src/agent-ref.js";
import { WorkspaceTimeline } from "../src/events.js";

type WriteResult = { bytesWritten: number; bytesRead: number; buffer: Uint8Array };
type HandleWrite = (buffer: Uint8Array, offset: number, length: number, position: number | null) => Promise<WriteResult>;

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
  it("finds a persisted notification identity after restart", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const timeline = new WorkspaceTimeline(filePath);

    const line = await timeline.publish({ type: "schedule_fired", id: "occurrence-1" });
    await expect(timeline.hasRecordId("occurrence-1")).resolves.toBe(true);
    await expect(timeline.hasRecordId("missing")).resolves.toBe(false);

    const restarted = new WorkspaceTimeline(filePath);
    await restarted.start();
    await expect(restarted.hasRecordId("occurrence-1")).resolves.toBe(true);
    await expect(readFile(filePath, "utf8")).resolves.toBe(`${line}\n`);
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

  it("appends attachment annotations without replacing the timeline inode", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const timeline = new WorkspaceTimeline(filePath);
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

    const mounted = await open(filePath, "r");
    try {
      const inode = (await mounted.stat()).ino;
      await expect(timeline.annotateAttachment(received, "Whiteboard sketch of the queue design")).resolves.toBe(1);
      await expect(timeline.annotateAttachment(sent, "Latency chart comparing two queue designs")).resolves.toBe(1);
      await expect(timeline.annotateAttachment(received, "Updated whiteboard description")).resolves.toBe(1);
      expect((await mounted.stat()).ino).toBe(inode);
      await expect(mounted.readFile("utf8")).resolves.toContain("Updated whiteboard description");
    } finally {
      await mounted.close();
    }

    const raw = await readFile(filePath, "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ attachments: [{ path: received }] });
    expect(records[0]).not.toMatchObject({ attachments: [{ description: "Updated whiteboard description" }] });
    expect(records[1]).toMatchObject({ attachments: [{ path: sent }] });
    expect(records.slice(2)).toMatchObject([
      { type: "attachment.annotated", payload: { path: received, description: "Whiteboard sketch of the queue design", occurrences: 1 } },
      { type: "attachment.annotated", payload: { path: sent, description: "Latency chart comparing two queue designs", occurrences: 1 } },
      { type: "attachment.annotated", payload: { path: received, description: "Updated whiteboard description", occurrences: 1 } },
    ]);
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
  it("rolls back a complete failed append before reusing its sequence", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const timeline = new WorkspaceTimeline(filePath);
    const handle = await open(filePath, "a");
    try {
      const prototype = Object.getPrototypeOf(handle) as unknown as { write: HandleWrite };
      const originalWrite = prototype.write.bind(handle);
      let calls = 0;
      const writeSpy = vi.spyOn(prototype, "write").mockImplementation(async (buffer, offset, length, position) => {
        calls += 1;
        if (calls === 1) {
          const completeRecordBytes = length - 1;
          const result = await originalWrite(buffer, offset, completeRecordBytes, position);
          return { ...result, bytesWritten: completeRecordBytes };
        }
        return { bytesWritten: 0, bytesRead: 0, buffer: Buffer.alloc(0) };
      });

      await expect(timeline.publish({ type: "custom.failed" })).rejects.toThrow("Failed to persist timeline event");
      writeSpy.mockRestore();
      const line = await timeline.publish({ type: "custom.next" });

      expect(JSON.parse(line)).toMatchObject({ type: "custom.next", seq: 1 });
      await expect(readFile(filePath, "utf8")).resolves.toBe(`${line}\n`);
    } finally {
      await handle.close().catch(() => {});
    }
  });

  it("starts past an unterminated tail and keeps subsequent appends valid", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const existing = JSON.stringify({ v: 2, id: "existing", seq: 4, t: "2026-08-24T00:00:00.000Z", type: "custom.event" });
    await writeFile(filePath, `${existing}\n{"v":2,"id":"torn"`, "utf8");
    const timeline = new WorkspaceTimeline(filePath);

    await timeline.start();
    const line = await timeline.publish({ type: "custom.next" });

    await expect(readFile(filePath, "utf8")).resolves.toBe(`${existing}\n${line}\n`);
  });

  it("still rejects a malformed newline-terminated record", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    await writeFile(filePath, "{\"v\":2,\n", "utf8");

    await expect(new WorkspaceTimeline(filePath).start()).rejects.toThrow(SyntaxError);
  });

  it("releases persistence for later events while a listener is waiting", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "timeline.jsonl");
    const timeline = new WorkspaceTimeline(filePath);
    let release!: () => void;
    let entered!: () => void;
    const listenerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const listenerRelease = new Promise<void>((resolve) => { release = resolve; });
    const seen: number[] = [];
    timeline.subscribe(async (record) => {
      seen.push(record.seq);
      if (record.seq === 1) {
        entered();
        await listenerRelease;
      }
    });

    const first = timeline.publish({ type: "custom.first" });
    await listenerEntered;
    const second = timeline.publish({ type: "custom.second" });
    await vi.waitFor(async () => {
      const raw = await readFile(filePath, "utf8");
      expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    });
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
  });
});
