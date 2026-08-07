import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOutbox, type WorkspaceOutboxOptions } from "../src/outbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-outbox-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "chats", "42", "workspace");
  await mkdir(path.join(workspace, ".tg-bot", "outbox"), { recursive: true });
  return { dataDir, workspace };
}

async function request(workspace: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(workspace, ".tg-bot", "outbox", name), JSON.stringify(value), "utf8");
}

async function names(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

const valid = (id = "one", filePath = "/workspace/report.txt") => ({
  version: 1,
  id,
  type: "send_file",
  path: filePath,
  caption: "Report",
});

describe("WorkspaceOutbox", () => {
  it("delivers valid requests and moves them to processed", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "one.json", valid());
    const sendFile = vi.fn(async () => {});
    await new WorkspaceOutbox({ dataDir, sendFile }).poll();
    expect(sendFile).toHaveBeenCalledWith(42, "/workspace/report.txt", "Report");
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["one.json"]);
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual([]);
  });
  it("retries a stale claim left by a crashed process", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-crashed";
    await request(workspace, claimName, valid("crashed"));
    const sendFile = vi.fn(async () => {});

    await new WorkspaceOutbox({ dataDir, sendFile, now: () => 5 * 60_000 }).poll();
    expect(sendFile).toHaveBeenCalledWith(42, "/workspace/report.txt", "Report");
    expect(await names(path.join(outbox, "processed"))).toEqual([claimName]);
  });

  it("leaves recent claims untouched while another process may be sending", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-299999-recent";
    await request(workspace, claimName, valid("recent"));
    const sendFile = vi.fn(async () => {});

    await new WorkspaceOutbox({ dataDir, sendFile, now: () => 300_000 }).poll();
    expect(sendFile).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "processed"))).toEqual([]);
    expect(await names(outbox)).toContain(claimName);
  });

  it("quarantines malformed stale claims without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-malformed";
    await writeFile(path.join(outbox, claimName), "{not json", "utf8");
    const sendFile = vi.fn(async () => {});

    await new WorkspaceOutbox({ dataDir, sendFile, now: () => 5 * 60_000 }).poll();
    expect(sendFile).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual([claimName]);
  });

  it("quarantines malformed JSON and invalid schemas without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeFile(path.join(outbox, "malformed.json"), "{not json", "utf8");
    await request(workspace, "invalid.json", { version: 2, id: "bad", type: "send_file", path: "x" });
    const sendFile = vi.fn(async () => {});
    await new WorkspaceOutbox({ dataDir, sendFile }).poll();
    expect(sendFile).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["invalid.json", "malformed.json"]);
  });

  it("rejects traversal before invoking the host callback", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "escape.json", valid("escape", "/workspace/../outside.txt"));
    const sendFile = vi.fn(async () => {});
    await new WorkspaceOutbox({ dataDir, sendFile }).poll();
    expect(sendFile).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["escape.json"]);
  });

  it("rejects symlinked request files without following them", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const target = path.join(workspace, "outside.json");
    await writeFile(target, JSON.stringify(valid()), "utf8");
    await symlink(target, path.join(outbox, "link.json"));
    const sendFile = vi.fn(async () => {});
    await new WorkspaceOutbox({ dataDir, sendFile }).poll();
    expect(sendFile).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["link.json"]);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(valid());
  });

  it("moves host failures to failed and ignores temporary or non-JSON entries", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await request(workspace, "failed.json", valid());
    await writeFile(path.join(outbox, "partial.json.tmp"), JSON.stringify(valid()), "utf8");
    await writeFile(path.join(outbox, "notes.txt"), JSON.stringify(valid()), "utf8");
    const sendFile = vi.fn(async () => { throw new Error("upload failed"); });
    await new WorkspaceOutbox({ dataDir, sendFile }).poll();
    expect(await names(path.join(outbox, "failed"))).toEqual(["failed.json"]);
    expect(await names(outbox)).toEqual(["failed", "notes.txt", "partial.json.tmp", "processed"]);
  });

  it("filters chat directories to canonical numeric real directories", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "valid.json", valid());
    const aliasWorkspace = path.join(dataDir, "chats", "042", "workspace");
    await mkdir(path.join(aliasWorkspace, ".tg-bot", "outbox"), { recursive: true });
    await request(aliasWorkspace, "alias.json", valid("alias"));
    await mkdir(path.join(dataDir, "chats", "not-a-chat", "workspace", ".tg-bot", "outbox"), { recursive: true });
    await request(path.join(dataDir, "chats", "not-a-chat", "workspace"), "ignored.json", valid());
    const sendFile = vi.fn(async () => {});
    await new WorkspaceOutbox({ dataDir, sendFile }).poll();
    expect(sendFile).toHaveBeenCalledTimes(1);
    expect(sendFile).toHaveBeenCalledWith(42, "/workspace/report.txt", "Report");
  });

  it("serializes overlapping polls and requests within a chat", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "a.json", valid("a"));
    await request(workspace, "b.json", valid("b"));
    let active = 0;
    let maximum = 0;
    const sendFile = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    const outbox = new WorkspaceOutbox({ dataDir, sendFile });
    await Promise.all([outbox.poll(), outbox.poll(), outbox.processChat(42)]);
    expect(maximum).toBe(1);
    expect(sendFile).toHaveBeenCalledTimes(2);
  });

  it("stops and clears its polling timer", async () => {
    const { dataDir } = await fixture();
    const callbacks: (() => void)[] = [];
    const cleared: unknown[] = [];
    const setIntervalMock = vi.fn(((callback: Parameters<NonNullable<WorkspaceOutboxOptions["setInterval"]>>[0]) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<NonNullable<WorkspaceOutboxOptions["setInterval"]>>;
    }) as NonNullable<WorkspaceOutboxOptions["setInterval"]>);
    const setInterval = setIntervalMock as unknown as NonNullable<WorkspaceOutboxOptions["setInterval"]>;
    const clearInterval = vi.fn(((timer: unknown) => { cleared.push(timer); }) as typeof globalThis.clearInterval);
    const outbox = new WorkspaceOutbox({ dataDir, sendFile: async () => {}, setInterval, clearInterval });
    await outbox.start();
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5_000);
    await outbox.stop();
    expect(clearInterval).toHaveBeenCalledWith(1);
    expect(callbacks).toHaveLength(1);
  });
});
