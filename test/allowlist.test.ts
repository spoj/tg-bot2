import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAllowedFile, resetAllowlistCache, syncAllowlist } from "../src/allowlist.js";
import { EventSink } from "../src/events.js";

describe("allowlist", () => {
  it("parses a bare array of chat IDs", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), JSON.stringify([875253145, 829096380, -5578614334]));

      const result = await readAllowedFile(workspace);
      expect(result).toEqual({
        status: "ready",
        chats: [-5578614334, 829096380, 875253145],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("parses object with chats array and deduplicates IDs", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), JSON.stringify({
        version: 1,
        chats: [100, 200, 100, { chat_id: 300 }],
      }));

      const result = await readAllowedFile(workspace);
      expect(result).toEqual({
        status: "ready",
        chats: [100, 200, 300],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns status missing when file does not exist", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const result = await readAllowedFile(workspace);
    expect(result).toEqual({ status: "missing" });
  });

  it("returns status malformed on invalid JSON or invalid IDs", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), "[123, 'not-an-id']");
      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });

      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), "{ invalid json");
      expect(await readAllowedFile(workspace)).toEqual({ status: "malformed" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits allowlist_updated only when the chat list changes", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    resetAllowlistCache(workspace);
    try {
      await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
      const events: Record<string, unknown>[] = [];
      const fakeEvents = {
        emit: (event: Record<string, unknown>) => {
          events.push(event);
          return Promise.resolve();
        },
      } as unknown as EventSink;

      // Missing file -> returns null, no event
      expect(await syncAllowlist(workspace, fakeEvents)).toBeNull();
      expect(events).toHaveLength(0);

      // Create file -> emits allowlist_updated
      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), JSON.stringify([10, 20]));
      expect(await syncAllowlist(workspace, fakeEvents)).toEqual([10, 20]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "allowlist_updated", chats: [10, 20] });

      // Call again with same content -> no duplicate event
      expect(await syncAllowlist(workspace, fakeEvents)).toEqual([10, 20]);
      expect(events).toHaveLength(1);

      // Update content -> emits allowlist_updated
      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), JSON.stringify([10, 20, 30]));
      expect(await syncAllowlist(workspace, fakeEvents)).toEqual([10, 20, 30]);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ type: "allowlist_updated", chats: [10, 20, 30] });
    } finally {
      resetAllowlistCache(workspace);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("seeds from events.jsonl across reboots and does not re-emit if unchanged", async () => {
    const workspace = path.join(os.tmpdir(), `allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    resetAllowlistCache(workspace);
    try {
      await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
      await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), JSON.stringify([10, 20]));

      const eventsFile = path.join(workspace, ".tg-bot", "events.jsonl");
      // Pre-seed events.jsonl with matching allowlist_updated event
      await writeFile(eventsFile, `${JSON.stringify({ v: 1, t: new Date().toISOString(), type: "allowlist_updated", chats: [10, 20] })}\n`);

      const events: Record<string, unknown>[] = [];
      const fakeEvents = {
        emit: (event: Record<string, unknown>) => {
          events.push(event);
          return Promise.resolve();
        },
      } as unknown as EventSink;

      // Reset in-memory cache to simulate fresh process boot
      resetAllowlistCache(workspace);

      expect(await syncAllowlist(workspace, fakeEvents)).toEqual([10, 20]);
      expect(events).toHaveLength(0); // No event emitted because log already has [10, 20]
    } finally {
      resetAllowlistCache(workspace);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
