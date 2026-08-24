import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
