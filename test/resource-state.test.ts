import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationAgent } from "../src/agent-ref.js";
import { WorkspaceResources } from "../src/resource-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-resources-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("WorkspaceResources", () => {
  it("persists connector-scoped ownership and restores it independently of the timeline", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "run", "resources.json");
    const matrixOwner = conversationAgent("matrix:primary", "!room:thread", { room_id: "!room", thread_id: "thread" });
    const customOwner = conversationAgent("custom:secondary", "channel-7", { channel: "channel-7" });
    const resources = new WorkspaceResources(filePath);

    await resources.start([{ connectorId: matrixOwner.connectorId, kind: "message", key: "$event", owner: matrixOwner }]);
    await resources.set({ connectorId: customOwner.connectorId, kind: "message", key: "$event", owner: customOwner });

    expect(resources.owner(matrixOwner.connectorId, "message", "$event")).toEqual(matrixOwner);
    expect(resources.owner(customOwner.connectorId, "message", "$event")).toEqual(customOwner);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 1,
      resources: [
        { connectorId: "matrix:primary", kind: "message", key: "$event", owner: matrixOwner },
        { connectorId: "custom:secondary", kind: "message", key: "$event", owner: customOwner },
      ],
    });

    const restored = new WorkspaceResources(filePath);
    await restored.start();
    expect(restored.owner(matrixOwner.connectorId, "message", "$event")).toEqual(matrixOwner);
    expect(restored.owner(customOwner.connectorId, "message", "$event")).toEqual(customOwner);

    await restored.delete(matrixOwner.connectorId, "message", "$event");
    const reloaded = new WorkspaceResources(filePath);
    await reloaded.start();
    expect(reloaded.owner(matrixOwner.connectorId, "message", "$event")).toBeUndefined();
    expect(reloaded.owner(customOwner.connectorId, "message", "$event")).toEqual(customOwner);
  });

  it("retains only the newest ownership rows", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "run", "resources.json");
    const resources = new WorkspaceResources(filePath);
    const seed = Array.from({ length: 10_000 }, (_, index) => {
      const owner = conversationAgent("custom:owner", `channel-${index}`, { channel: `channel-${index}` });
      return { connectorId: owner.connectorId, kind: "message" as const, key: `message-${index}`, owner };
    });

    await resources.start(seed);

    expect(resources.owner("custom:owner", "message", "message-0")).toBeUndefined();
    expect(resources.owner("custom:owner", "message", "message-9999")).toEqual(seed.at(-1)!.owner);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { resources: unknown[] };
    expect(persisted.resources).toHaveLength(8_192);
  });

  it("treats the newest duplicate row as the newest ownership", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "run", "resources.json");
    await mkdir(path.dirname(filePath), { recursive: true });
    const oldOwner = conversationAgent("custom:duplicate", "old", { channel: "old" });
    const newestOwner = conversationAgent("custom:duplicate", "newest", { channel: "newest" });
    const resources = new WorkspaceResources(filePath);
    const rows = [
      { connectorId: oldOwner.connectorId, kind: "message" as const, key: "duplicate", owner: oldOwner },
      ...Array.from({ length: 8_192 }, (_, index) => {
        const owner = conversationAgent("custom:owner", `channel-${index}`, { channel: `channel-${index}` });
        return { connectorId: owner.connectorId, kind: "message" as const, key: `message-${index}`, owner };
      }),
      { connectorId: newestOwner.connectorId, kind: "message" as const, key: "duplicate", owner: newestOwner },
    ];

    await writeFile(filePath, `${JSON.stringify({ version: 1, resources: rows }, null, 2)}\n`);
    await resources.start();

    expect(resources.owner("custom:duplicate", "message", "duplicate")).toEqual(newestOwner);
    expect(resources.owner("custom:owner", "message", "message-0")).toBeUndefined();
    expect(JSON.parse(await readFile(filePath, "utf8")).resources).toHaveLength(8_192);
  });

  it("rolls back set when the serialized state exceeds its size limit", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "run", "resources.json");
    const original = conversationAgent("custom:original", "channel-1", { channel: "channel-1" });
    const resources = new WorkspaceResources(filePath);

    await resources.start([{ connectorId: original.connectorId, kind: "message", key: "message-1", owner: original }]);
    const before = await readFile(filePath, "utf8");
    const oversized = conversationAgent("custom:oversized", "channel-oversized", { value: "x".repeat(4 * 1024 * 1024) });

    await expect(resources.set({ connectorId: oversized.connectorId, kind: "message", key: "message-oversized", owner: oversized })).rejects.toThrow("Resource state exceeds");
    expect(resources.owner(original.connectorId, "message", "message-1")).toBe(original);
    expect(resources.owner(oversized.connectorId, "message", "message-oversized")).toBeUndefined();
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("rolls back setMany when the serialized state exceeds its size limit", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "run", "resources.json");
    const original = conversationAgent("custom:original", "channel-1", { channel: "channel-1" });
    const replacement = conversationAgent("custom:replacement", "channel-2", { channel: "channel-2" });
    const resources = new WorkspaceResources(filePath);

    await resources.start([{ connectorId: original.connectorId, kind: "message", key: "message-1", owner: original }]);
    const before = await readFile(filePath, "utf8");
    const oversized = conversationAgent("custom:oversized", "channel-oversized", { value: "x".repeat(4 * 1024 * 1024) });

    await expect(resources.setMany([
      { connectorId: original.connectorId, kind: "message", key: "message-1", owner: replacement },
      { connectorId: oversized.connectorId, kind: "message", key: "message-oversized", owner: oversized },
    ])).rejects.toThrow("Resource state exceeds");
    expect(resources.owner(original.connectorId, "message", "message-1")).toBe(original);
    expect(resources.owner(oversized.connectorId, "message", "message-oversized")).toBeUndefined();
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("rolls back delete when serialization fails", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "run", "resources.json");
    const retainedAddress: Record<string, unknown> = { channel: "retained" };
    const retained = conversationAgent("custom:retained", "channel-retained", retainedAddress);
    const deleted = conversationAgent("custom:deleted", "channel-deleted", { channel: "deleted" });
    const resources = new WorkspaceResources(filePath);

    await resources.start([
      { connectorId: retained.connectorId, kind: "message", key: "message-retained", owner: retained },
      { connectorId: deleted.connectorId, kind: "message", key: "message-deleted", owner: deleted },
    ]);
    const before = await readFile(filePath, "utf8");
    Object.defineProperty(retainedAddress, "channel", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("resource serialization failed"); },
    });

    await expect(resources.delete(deleted.connectorId, "message", "message-deleted")).rejects.toThrow("resource serialization failed");
    expect(resources.owner(retained.connectorId, "message", "message-retained")).toBe(retained);
    expect(resources.owner(deleted.connectorId, "message", "message-deleted")).toBe(deleted);
    expect(await readFile(filePath, "utf8")).toBe(before);
  });
});
