import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationAgentRef } from "./agent-ref.js";
import { SerialQueue } from "./queue.js";
import { closeQuietly, isMissing, readFileBounded } from "./util.js";

export type ResourceKind = "message" | "poll";
export type ResourceOwnership = {
  connectorId: string;
  kind: ResourceKind;
  key: string;
  owner: ConversationAgentRef;
};

type ResourceStateFile = {
  version: 1;
  resources: ResourceOwnership[];
};

const MAX_RESOURCE_STATE_BYTES = 4 * 1024 * 1024;
const READ_FILE = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

function mapKey(connectorId: string, kind: ResourceKind, key: string): string {
  return JSON.stringify([connectorId, kind, key]);
}

function validateConversation(value: unknown): ConversationAgentRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resource owner");
  const owner = value as Record<string, unknown>;
  if (owner.kind !== "conversation" || typeof owner.connectorId !== "string" || typeof owner.conversationKey !== "string") {
    throw new Error("Invalid resource owner");
  }
  if (owner.address === null || typeof owner.address !== "object" || Array.isArray(owner.address)) throw new Error("Invalid resource owner address");
  return {
    kind: "conversation",
    connectorId: owner.connectorId,
    conversationKey: owner.conversationKey,
    address: owner.address as Record<string, unknown>,
  };
}

function validateState(value: unknown): ResourceStateFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resource state");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.resources)) throw new Error("Invalid resource state");
  const resources: ResourceOwnership[] = file.resources.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resource state row");
    const row = value as Record<string, unknown>;
    if (typeof row.connectorId !== "string" || row.connectorId.length === 0) throw new Error("Invalid resource connectorId");
    if (row.kind !== "message" && row.kind !== "poll") throw new Error("Invalid resource kind");
    if (typeof row.key !== "string" || row.key.length === 0) throw new Error("Invalid resource key");
    return { connectorId: row.connectorId, kind: row.kind, key: row.key, owner: validateConversation(row.owner) };
  });
  return { version: 1, resources };
}

export class WorkspaceResources {
  private readonly resources = new Map<string, ResourceOwnership>();
  private readonly writes = new SerialQueue();
  private loaded = false;

  constructor(readonly filePath: string) {}

  async start(seed: readonly ResourceOwnership[] = []): Promise<void> {
    await this.writes.run(async () => {
      if (this.loaded) return;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(this.filePath, READ_FILE);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (handle) {
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_RESOURCE_STATE_BYTES) throw new Error("Invalid resource state file");
          const parsed = validateState(JSON.parse((await readFileBounded(handle, MAX_RESOURCE_STATE_BYTES)).toString("utf8")) as unknown);
          for (const resource of parsed.resources) this.resources.set(mapKey(resource.connectorId, resource.kind, resource.key), resource);
        } finally {
          await closeQuietly(handle);
        }
      } else {
        for (const resource of seed) this.resources.set(mapKey(resource.connectorId, resource.kind, resource.key), resource);
        await this.save();
      }
      this.loaded = true;
    });
  }

  owner(connectorId: string, kind: ResourceKind, key: string): ConversationAgentRef | undefined {
    return this.resources.get(mapKey(connectorId, kind, key))?.owner;
  }

  async set(resource: ResourceOwnership): Promise<void> {
    await this.writes.run(async () => {
      this.resources.set(mapKey(resource.connectorId, resource.kind, resource.key), resource);
      await this.save();
    });
  }

  async setMany(resources: readonly ResourceOwnership[]): Promise<void> {
    if (resources.length === 0) return;
    await this.writes.run(async () => {
      for (const resource of resources) this.resources.set(mapKey(resource.connectorId, resource.kind, resource.key), resource);
      await this.save();
    });
  }

  async delete(connectorId: string, kind: ResourceKind, key: string): Promise<void> {
    await this.writes.run(async () => {
      if (!this.resources.delete(mapKey(connectorId, kind, key))) return;
      await this.save();
    });
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: 1, resources: [...this.resources.values()] } satisfies ResourceStateFile, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_RESOURCE_STATE_BYTES) throw new Error(`Resource state exceeds ${MAX_RESOURCE_STATE_BYTES} bytes`);
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
