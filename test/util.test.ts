import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendJsonl, readJsonl } from "../src/util.js";

type WriteResult = { bytesWritten: number; bytesRead: number; buffer: Uint8Array };
type HandleWrite = (buffer: Uint8Array, offset: number, length: number, position: number | null) => Promise<WriteResult>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-util-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("appendJsonl", () => {
  it("appends and reads back records spanning multiple read chunks", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "store.jsonl");
    const records = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({ index, text: "x".repeat(60) }));
    await appendJsonl(filePath, records);

    const lines = await readJsonl(filePath);
    expect(lines).toHaveLength(5_000);
    expect(lines[0]).toBe(records[0]);
    expect(lines[4_999]).toBe(records[4_999]);
  });

  it("throws when the store reports zero write progress", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "store.jsonl");
    const handle = await open(filePath, "a");
    try {
      const prototype = Object.getPrototypeOf(handle) as unknown as { write: HandleWrite };
      vi.spyOn(prototype, "write").mockResolvedValue({ bytesWritten: 0, bytesRead: 0, buffer: Buffer.alloc(0) });
      await expect(appendJsonl(filePath, "line")).rejects.toThrow("accepted only 0 of 5 bytes");
    } finally {
      await handle.close().catch(() => {});
    }
  });

  it("loops until the full payload is written after a short write", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "store.jsonl");
    const handle = await open(filePath, "a");
    try {
      const prototype = Object.getPrototypeOf(handle) as unknown as { write: HandleWrite };
      const originalWrite = prototype.write.bind(handle);
      let calls = 0;
      vi.spyOn(prototype, "write").mockImplementation(async (buffer, offset, length, position) => {
        calls += 1;
        if (calls === 1) return { bytesWritten: 2, bytesRead: 0, buffer };
        const result = await originalWrite(buffer, offset, length, position);
        return { ...result, bytesRead: 0 };
      });
      await expect(appendJsonl(filePath, "hello")).resolves.toBeUndefined();
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await handle.close().catch(() => {});
    }
  });
});

describe("readJsonl", () => {
  it("throws a clear error instead of allocating an unbounded buffer for oversized stores", async () => {
    const dataDir = await temporaryDirectory();
    const filePath = path.join(dataDir, "big.jsonl");
    await writeFile(filePath, "line\n");
    const handle = await open(filePath, "r+");
    await handle.truncate(256 * 1024 * 1024 + 1);
    await handle.close();

    await expect(readJsonl(filePath)).rejects.toThrow("exceeds 268435456 byte cap");
  });
});