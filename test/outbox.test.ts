import type { watch } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOutbox, type WorkspaceOutboxOptions } from "../src/outbox.js";
import type { AgentManager } from "../src/agent.js";
import type { WorkspaceOutboxDispatcher, WorkspaceOutboxRequest } from "../src/outbox-protocol.js";

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

async function writeRequest(workspace: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(workspace, ".tg-bot", "outbox", name), JSON.stringify(value), "utf8");
}

async function names(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}
async function chatEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "chat.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function systemEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "system.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function systemLogRecords(workspace: string, type: "outbox_sent" | "outbox_rejected"): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "system.jsonl"), "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === type);
}

function setupOutbox(
  dataDir: string,
  dispatch: WorkspaceOutboxDispatcher,
  options: Omit<WorkspaceOutboxOptions, "dataDir" | "dispatch" | "agent"> & { agent?: Pick<AgentManager, "followup"> } = {},
): WorkspaceOutbox {
  return new WorkspaceOutbox({ dataDir, dispatch, agent: { followup: async () => undefined }, ...options });
}

async function pollOutbox(
  dataDir: string,
  dispatch: WorkspaceOutboxDispatcher,
  options: Omit<WorkspaceOutboxOptions, "dataDir" | "dispatch" | "agent"> & { agent?: Pick<AgentManager, "followup"> } = {},
): Promise<void> {
  await setupOutbox(dataDir, dispatch, options).poll();
}

const valid = (filePath = "/workspace/report.txt") => ({
  version: 1,
  type: "send_file",
  path: filePath,
  caption: "Report",
});

function fakeInterval() {
  const callbacks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const setIntervalMock = vi.fn(((callback: () => void, _delay?: number) => {
    callbacks.push(callback);
    return callbacks.length;
  }) as typeof globalThis.setInterval);
  const setInterval = setIntervalMock as unknown as typeof globalThis.setInterval;
  const clearInterval = vi.fn(((timer: unknown) => {
    cleared.push(timer);
  }) as typeof globalThis.clearInterval);
  return { callbacks, cleared, setIntervalMock, setInterval, clearInterval };
}

interface FakeWatcher {
  closed: boolean;
  on(event: string, listener: (event: string, filename: string | null) => void): void;
  emit(event: string, filename?: string | null): void;
  close(): void;
}

function fakeWatch() {
  const watchers: Array<{ path: string; watcher: FakeWatcher }> = [];
  const watchMock = vi.fn((watchPath: string): FakeWatcher => {
    const listeners: Record<string, Array<(event: string, filename: string | null) => void>> = {};
    const watcher: FakeWatcher = {
      closed: false,
      on(event, listener) {
        (listeners[event] ??= []).push(listener);
      },
      emit(event, filename = null) {
        for (const listener of listeners[event] ?? []) listener(event, filename);
      },
      close() {
        this.closed = true;
      },
    };
    watchers.push({ path: watchPath, watcher });
    return watcher;
  });
  return { watchers, watchMock: watchMock as unknown as typeof watch };
}

describe("WorkspaceOutbox", () => {
  it("rejects poll intervals above the timer-safe limit", async () => {
    const { dataDir } = await fixture();
    expect(() => new WorkspaceOutbox({
      dataDir,
      dispatch: async () => undefined,
      agent: { followup: async () => undefined },
      pollIntervalMs: 2_147_483_648,
    })).toThrow("positive timer-safe integer");
  });
  it("delivers valid requests and records them to system.jsonl", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "one.json", valid());
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "one.json" }]);
    expect(await systemLogRecords(workspace, "outbox_rejected")).toEqual([]);
  });
  it("retries a stale claim left by a crashed process", async () => {
    const { dataDir, workspace } = await fixture();
    const claimName = ".in-progress-0-crashed";
    await writeRequest(workspace, claimName, valid());
    const dispatch = vi.fn(async () => undefined);

    await pollOutbox(dataDir, dispatch, { now: () => 5 * 60_000 });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: ".in-progress-0-crashed" }]);
  });
  it("skips and cleans a stale claim already recorded in system.jsonl", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-archived";
    await writeRequest(workspace, claimName, valid());
    const record = { v: 1, t: "2026-08-19T00:00:00.000Z", type: "outbox_sent", requestId: "00000000-0000-0000-0000-000000000000", name: claimName, request: valid() };
    await writeFile(path.join(workspace, ".tg-bot", "system.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    const dispatch = vi.fn(async () => undefined);

    await pollOutbox(dataDir, dispatch, { now: () => 5 * 60_000 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: claimName }]);
    expect(await names(outbox)).not.toContain(claimName);
  });

  it("does not retry a sent request when recording the claim in chat.jsonl fails", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const dispatch = vi.fn(async () => {
      const claim = (await readdir(outbox)).find((name) => name.startsWith(".in-progress-"));
      if (claim) await rm(path.join(outbox, claim), { force: true });
      return undefined;
    });
    await writeRequest(workspace, "sent.json", valid());
    const instance = setupOutbox(dataDir, dispatch);

    await instance.poll();
    await instance.poll();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await systemLogRecords(workspace, "outbox_rejected")).toEqual([]);
    expect(await names(outbox)).toEqual([]);
  });


  it("leaves recent claims untouched while another process may be sending", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-299999-recent";
    await writeRequest(workspace, claimName, valid());
    const dispatch = vi.fn(async () => undefined);

    await pollOutbox(dataDir, dispatch, { now: () => 300_000 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await systemLogRecords(workspace, "outbox_sent")).toEqual([]);
    expect(await names(outbox)).toContain(claimName);
  });

  it("discards malformed stale claims without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-malformed";
    await writeFile(path.join(outbox, claimName), "{not json", "utf8");
    const dispatch = vi.fn(async () => undefined);

    await pollOutbox(dataDir, dispatch, { now: () => 5 * 60_000 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await systemLogRecords(workspace, "outbox_rejected")).toMatchObject([{ name: claimName, detail: expect.stringContaining("malformed JSON") }]);
    expect(await names(outbox)).toEqual([]);
  });
  it("discards malformed JSON and invalid schemas without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeFile(path.join(outbox, "malformed.json"), "{not json", "utf8");
    await writeRequest(workspace, "invalid.json", { version: 2, id: "bad", type: "send_file", path: "x" });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = await systemLogRecords(workspace, "outbox_rejected");
    rejected.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(rejected).toMatchObject([
      { name: "invalid.json", detail: expect.stringContaining("version must be 1") },
      { name: "malformed.json", detail: expect.stringContaining("malformed JSON") },
    ]);
    expect(await names(outbox)).toEqual([]);
  });
  it("discards oversized requests without delivering them", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeFile(path.join(outbox, "oversized.json"), `${JSON.stringify(valid())}${"x".repeat(1024 * 1024)}`, "utf8");
    const dispatch = vi.fn(async () => undefined);

    await pollOutbox(dataDir, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await systemLogRecords(workspace, "outbox_rejected")).toMatchObject([{ name: "oversized.json", detail: expect.stringContaining("exceeds 1048576 bytes") }]);
    expect(await names(outbox)).toEqual([]);
  });

  it("forwards send_file requests with unconfined paths to the dispatcher", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "escape.json", valid("/workspace/../outside.txt"));
    await writeRequest(workspace, "alias.json", valid("/workspace/"));
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const records = await systemLogRecords(workspace, "outbox_sent");
    records.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(records).toMatchObject([{ name: "alias.json" }, { name: "escape.json" }]);
  });

  it("rejects symlinked request files without following them", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const target = path.join(workspace, "outside.json");
    await writeFile(target, JSON.stringify(valid()), "utf8");
    await symlink(target, path.join(outbox, "link.json"));
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await systemLogRecords(workspace, "outbox_rejected")).toMatchObject([{ name: "link.json", detail: expect.stringContaining("ELOOP") }]);
    expect(await names(outbox)).toEqual([]);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(valid());
  });
  it("records host failures to system.jsonl and ignores temporary or non-JSON entries", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeRequest(workspace, "failed.json", valid());
    await writeFile(path.join(outbox, "partial.json.tmp"), JSON.stringify(valid()), "utf8");
    await writeFile(path.join(outbox, "notes.txt"), JSON.stringify(valid()), "utf8");
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await pollOutbox(dataDir, dispatch);
    expect(await systemLogRecords(workspace, "outbox_rejected")).toMatchObject([{ name: "failed.json", detail: expect.stringContaining("upload failed") }]);
    expect(await names(outbox)).toEqual(["notes.txt", "partial.json.tmp"]);
  });

  it("filters chat directories to canonical numeric real directories", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "valid.json", valid());
    const aliasWorkspace = path.join(dataDir, "chats", "042", "workspace");
    await mkdir(path.join(aliasWorkspace, ".tg-bot", "outbox"), { recursive: true });
    await writeRequest(aliasWorkspace, "alias.json", valid());
    await mkdir(path.join(dataDir, "chats", "not-a-chat", "workspace", ".tg-bot", "outbox"), { recursive: true });
    await writeRequest(path.join(dataDir, "chats", "not-a-chat", "workspace"), "ignored.json", valid());
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" });
  });
  it("records claimed and sent lifecycle events with the full request and raw response", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "one.json", valid());
    const dispatch = vi.fn(async () => ({ messageId: 7, data: { message_id: 7 } }));
    await pollOutbox(dataDir, dispatch);
    await vi.waitFor(async () => {
      expect(await systemEvents(workspace)).toMatchObject([
        {
          type: "outbox_claimed",
          name: "one.json",
          request: { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" },
        },
        {
          type: "outbox_sent",
          name: "one.json",
          request: { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" },
          messageId: 7,
          data: { message_id: 7 },
        },
      ]);
    });
  });
  it("processes every request in a flooded chat without skipping later chats", async () => {
    const { dataDir, workspace } = await fixture();
    const laterWorkspace = path.join(dataDir, "chats", "43", "workspace");
    await mkdir(path.join(laterWorkspace, ".tg-bot", "outbox"), { recursive: true });
    await writeRequest(laterWorkspace, "later.json", valid("/workspace/later.txt"));
    for (let index = 0; index < 300; index += 1) {
      const id = String(index).padStart(4, "0");
      await writeRequest(workspace, `${id}.json`, valid(`/workspace/${id}.txt`));
    }

    const chats: number[] = [];
    const dispatch = vi.fn(async (chatId: number) => {
      chats.push(chatId);
      return undefined;
    });
    await pollOutbox(dataDir, dispatch);

    const floodedChatSends = chats.filter((chatId) => chatId === 42).length;
    expect(floodedChatSends).toBe(300);
    expect(chats).toContain(43);
  });


  it("serializes overlapping polls and requests within a chat", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "a.json", valid("a"));
    await writeRequest(workspace, "b.json", valid("b"));
    let active = 0;
    let maximum = 0;
    const dispatch = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return undefined;
    });
    const outbox = setupOutbox(dataDir, dispatch);
    await Promise.all([outbox.poll(), outbox.poll(), outbox.processChat(42)]);
    expect(maximum).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("renews a live claim before stale recovery can reclaim a long send", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "long.json", valid());
    const { callbacks, setInterval, clearInterval } = fakeInterval();
    let now = 0;
    let finishSend!: () => void;
    let markSendStarted!: () => void;
    const sendFinished = new Promise<void>((resolve) => { finishSend = resolve; });
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const dispatch = vi.fn(async () => {
      markSendStarted();
      await sendFinished;
      return undefined;
    });
    const first = setupOutbox(dataDir, dispatch, { now: () => now, setInterval, clearInterval });
    const firstPoll = first.poll();

    await sendStarted;
    now = 5 * 60_000;
    callbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const duplicateSend = vi.fn(async () => undefined);
    await pollOutbox(dataDir, duplicateSend, { now: () => now });
    expect(duplicateSend).not.toHaveBeenCalled();

    finishSend();
    await firstPoll;
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "long.json" }]);
  });


  it("stops and clears its polling timer", async () => {
    const { dataDir } = await fixture();
    const { callbacks, cleared, setIntervalMock, setInterval, clearInterval } = fakeInterval();
    const outbox = setupOutbox(dataDir, async () => undefined, { setInterval, clearInterval });
    await outbox.start();
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5_000);
    await outbox.stop();
    expect(cleared).toEqual([1]);
    expect(callbacks).toHaveLength(1);
  });
  it("dispatches send_message requests with their message fields", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "msg.json", {
      version: 1,
      type: "send_message",
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    });
    const dispatch = vi.fn(async () => ({ messageId: 9_001 }));
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1,
      type: "send_message",
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "msg.json", messageId: 9001 }]);
  });

  it("records a send event for each sent message id", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "one.json", valid());
    await writeRequest(workspace, "two.json", valid("/workspace/report-two.txt"));
    const dispatch = vi.fn(async (_chatId: number, request: WorkspaceOutboxRequest) => ({ messageId: (request as { path: string }).path === "/workspace/report.txt" ? 100 : 200 }));
    await pollOutbox(dataDir, dispatch);
    await vi.waitFor(async () => {
      const recorded = await chatEvents(workspace);
      recorded.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      expect(recorded).toMatchObject([
        { type: "send", kind: "send_file", name: "one.json", messageId: 100 },
        { type: "send", kind: "send_file", name: "two.json", messageId: 200 },
      ]);
    });
  });

  it("skips send events when the dispatcher reports no message id", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "one.json", valid());
    await pollOutbox(dataDir, vi.fn(async () => undefined));
    await expect(readFile(path.join(workspace, ".tg-bot", "chat.jsonl"), "utf8")).rejects.toThrow();
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "one.json" }]);
  });

  it("writes dispatcher data onto the send event in chat.jsonl", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "stop.json", { version: 1, type: "stop_poll", message_id: 77 });
    await pollOutbox(dataDir, vi.fn(async () => ({ data: 777 })));
    await vi.waitFor(async () => {
      const recorded = await chatEvents(workspace);
      expect(recorded).toMatchObject([{ type: "send", kind: "stop_poll", name: "stop.json", data: 777 }]);
    });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "stop.json", data: 777 }]);
  });

  it("forwards send_message requests without host-side semantic validation", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "bad-mode.json", { version: 1, type: "send_message", text: "x", parse_mode: "Markdown" });
    await writeRequest(workspace, "bad-markup.json", { version: 1, type: "send_message", text: "x", reply_markup: [1] });
    await writeRequest(workspace, "bad-reply.json", { version: 1, type: "send_message", text: "x", reply_to_message_id: -3 });
    await writeRequest(workspace, "long-text.json", { version: 1, type: "send_message", text: "x".repeat(4_097) });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(4);
    const records = await systemLogRecords(workspace, "outbox_sent");
    records.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(records).toMatchObject([
      { name: "bad-markup.json" }, { name: "bad-mode.json" }, { name: "bad-reply.json" }, { name: "long-text.json" },
    ]);
  });

  it("dispatches location, poll, and reaction requests and records poll ids", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "loc.json", {
      version: 1, id: "loc", type: "send_location",
      latitude: 52.52, longitude: 13.405, heading: 90,
      venue: { title: "Gate", address: "Platz 1" },
    });
    await writeRequest(workspace, "poll.json", {
      version: 1, id: "poll", type: "send_poll",
      question: "Pick one", options: ["a", "b", "c"],
      is_anonymous: false, allows_multiple_answers: true, poll_type: "regular",
    });
    await writeRequest(workspace, "react.json", {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" }],
    });
    const dispatch = vi.fn(async (_chatId: number, request: WorkspaceOutboxRequest) => {
      if ((request as { latitude: number }).latitude === 52.52) return { messageId: 301 };
      if ((request as { question: string }).question === "Pick one") return { messageId: 302, pollId: "poll-abc" };
      return undefined;
    });
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "loc", type: "send_location",
      latitude: 52.52, longitude: 13.405, heading: 90,
      venue: { title: "Gate", address: "Platz 1" },
    });
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "poll", type: "send_poll",
      question: "Pick one", options: ["a", "b", "c"],
      is_anonymous: false, allows_multiple_answers: true, poll_type: "regular",
    });
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" }],
    });
    await vi.waitFor(async () => {
      const recorded = await chatEvents(workspace);
      recorded.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      expect(recorded).toMatchObject([
        { type: "send", kind: "send_location", name: "loc.json", messageId: 301 },
        { type: "send", kind: "send_poll", name: "poll.json", messageId: 302, pollId: "poll-abc" },
      ]);
    });
    const sent = await systemLogRecords(workspace, "outbox_sent");
    sent.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(sent).toMatchObject([{ name: "loc.json", messageId: 301 }, { name: "poll.json", messageId: 302, pollId: "poll-abc" }, { name: "react.json" }]);
  });


  it("dispatches send_media_group requests with their media payload", async () => {
    const { dataDir, workspace } = await fixture();
    const group = {
      version: 1,
      type: "send_media_group",
      media: [
        { type: "photo", media: "/workspace/a.png", caption: "first" },
        { type: "video", media: "b.mp4" },
      ],
    };
    await writeRequest(workspace, "album.json", group);
    const dispatch = vi.fn(async () => ({ messageId: 7 }));
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, group);
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "album.json", messageId: 7 }]);
  });

  it("rejects send_media_group requests with fewer than two items or wrong item types", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "single.json", { version: 1, type: "send_media_group", media: [{ type: "photo", media: "a.png" }] });
    await writeRequest(workspace, "bad-kind.json", { version: 1, type: "send_media_group", media: [{ type: "document", media: "a.pdf" }, { type: "photo", media: "b.png" }] });
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch, { agent: { followup } });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    expect(followup).toHaveBeenCalledWith(42, "Outbox request single.json rejected: Outbox request media must be an array of 2 to 10 items");
    expect(followup).toHaveBeenCalledWith(42, "Outbox request bad-kind.json rejected: Outbox request media item type must be photo or video");
    await vi.waitFor(async () => expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_rejected", name: "bad-kind.json", detail: "Outbox request bad-kind.json rejected: Outbox request media item type must be photo or video" },
      { type: "outbox_rejected", name: "single.json", detail: "Outbox request single.json rejected: Outbox request media must be an array of 2 to 10 items" },
    ]));
    expect(await names(path.join(workspace, ".tg-bot", "outbox"))).toEqual([]);
  });
  it("records stopped poll results as data on the send event", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "stop.json", { version: 1, type: "stop_poll", message_id: 77 });
    const poll = { id: "poll-xyz", question: "Q", options: [{ text: "a", voter_count: 2 }], total_voter_count: 2, is_closed: true };
    const dispatch = vi.fn(async () => ({ messageId: 77, data: poll }));
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "stop_poll", message_id: 77 });
    await vi.waitFor(async () => {
      const recorded = await chatEvents(workspace);
      expect(recorded).toMatchObject([{ type: "send", kind: "stop_poll", name: "stop.json", messageId: 77, data: poll }]);
    });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "stop.json", messageId: 77, data: poll }]);
  });

  it("forwards location, poll, and reaction requests without host-side semantic validation", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "bad-lat.json", { version: 1, type: "send_location", latitude: 91, longitude: 0 });
    await writeRequest(workspace, "bad-venue.json", { version: 1, type: "send_location", latitude: 1, longitude: 2, venue: { title: "x" } });
    await writeRequest(workspace, "few-options.json", { version: 1, type: "send_poll", question: "q", options: ["only"] });
    await writeRequest(workspace, "quiz-no-answer.json", { version: 1, type: "send_poll", question: "q", options: ["a", "b"], poll_type: "quiz" });
    await writeRequest(workspace, "bad-answer-index.json", { version: 1, type: "send_poll", question: "q", options: ["a", "b"], poll_type: "quiz", correct_option_id: 5 });
    await writeRequest(workspace, "bad-emoji.json", { version: 1, type: "send_reaction", message_id: 3, reaction: [{ type: "custom_emoji", custom_emoji_id: "" }] });
    await writeRequest(workspace, "bad-stop.json", { version: 1, type: "stop_poll", message_id: 0 });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(7);
    const sent = await systemLogRecords(workspace, "outbox_sent");
    sent.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(sent).toMatchObject([
      { name: "bad-answer-index.json" }, { name: "bad-emoji.json" }, { name: "bad-lat.json" }, { name: "bad-stop.json" }, { name: "bad-venue.json" }, { name: "few-options.json" }, { name: "quiz-no-answer.json" },
    ]);
  });

  it("discards structurally invalid requests and notifies the agent", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeRequest(workspace, "bad-kind.json", { version: 1, type: "send_file", path: "x", kind: "weird" });
    await writeRequest(workspace, "bad-path.json", { version: 1, type: "send_file", path: 7 });
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch, { agent: { followup } });
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = await systemLogRecords(workspace, "outbox_rejected");
    rejected.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(rejected).toMatchObject([
      { name: "bad-kind.json", detail: expect.stringContaining("must be auto, photo") },
      { name: "bad-path.json", detail: expect.stringContaining("must be a non-empty string") },
    ]);
    expect(await names(outbox)).toEqual([]);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    expect(followup).toHaveBeenCalledWith(42, "Outbox request bad-kind.json rejected: Outbox request kind must be auto, photo, audio, video, voice, or document");
    expect(followup).toHaveBeenCalledWith(42, "Outbox request bad-path.json rejected: Outbox request path must be a non-empty string");
  });

  it("dispatches an empty reaction array to remove a reaction", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "react.json", { version: 1, type: "send_reaction", message_id: 12, reaction: [] });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_reaction", message_id: 12, reaction: [] });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "react.json" }]);
  });

  it("forwards reaction requests with too many or invalid entries", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "too-many.json", {
      version: 1, id: "too-many", type: "send_reaction", message_id: 3,
      reaction: [
        { type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" },
        { type: "emoji", emoji: "😀" }, { type: "emoji", emoji: "😎" },
      ],
    });
    await writeRequest(workspace, "bad-entry.json", {
      version: 1, id: "bad-entry", type: "send_reaction", message_id: 3,
      reaction: [{ type: "emoji", emoji: "" }],
    });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const sent = await systemLogRecords(workspace, "outbox_sent");
    sent.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(sent).toMatchObject([{ name: "bad-entry.json" }, { name: "too-many.json" }]);
  });

  it("notifies the agent when the dispatcher throws, without logging a chat event", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "one.json", valid());
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await pollOutbox(dataDir, dispatch, { agent: { followup } });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(followup).toHaveBeenCalledWith(42, "Outbox request one.json rejected: upload failed");
    expect(await systemLogRecords(workspace, "outbox_rejected")).toMatchObject([{ name: "one.json", detail: expect.stringContaining("upload failed") }]);
  });


  it("dispatches a queued request on a watcher event without waiting for the poll interval", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, workspace } = await fixture();
      const dispatch = vi.fn(async () => undefined);
      const { setInterval, clearInterval } = fakeInterval();
      const { watchMock, watchers } = fakeWatch();
      const outbox = setupOutbox(dataDir, dispatch, { setInterval, clearInterval, watch: watchMock });
      await outbox.start();
      await writeRequest(workspace, "one.json", valid());

      const watcher = watchers.find(({ path: watcherPath }) => watcherPath === path.join(workspace, ".tg-bot", "outbox"))?.watcher;
      expect(watcher).toBeDefined();
      watcher?.emit("rename", "one.json");

      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" });
      await outbox.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces a burst of watcher events into a single scan", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, workspace } = await fixture();
      const dispatch = vi.fn(async () => undefined);
      const { setInterval, clearInterval } = fakeInterval();
      const { watchMock, watchers } = fakeWatch();
      const outbox = setupOutbox(dataDir, dispatch, { setInterval, clearInterval, watch: watchMock });
      await outbox.start();
      await writeRequest(workspace, "one.json", valid());

      const watcher = watchers.find(({ path: watcherPath }) => watcherPath === path.join(workspace, ".tg-bot", "outbox"))?.watcher;
      watcher?.emit("rename", "one.json");
      watcher?.emit("change", "one.json");
      watcher?.emit("rename", "one.json");

      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      await outbox.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a watcher on error and re-arms it on the next poll", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, workspace } = await fixture();
      const dispatch = vi.fn(async () => undefined);
      const { callbacks, setInterval, clearInterval } = fakeInterval();
      const { watchMock, watchers } = fakeWatch();
      const outbox = setupOutbox(dataDir, dispatch, { setInterval, clearInterval, watch: watchMock });
      await outbox.start();

      const watcher = watchers.find(({ path: watcherPath }) => watcherPath === path.join(workspace, ".tg-bot", "outbox"))?.watcher;
      expect(watcher).toBeDefined();
      watcher?.emit("error");

      await writeRequest(workspace, "one.json", valid());
      callbacks[0]?.();
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(watchMock).toHaveBeenCalledTimes(2);
      await outbox.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop closes every watcher and clears pending debounce timers", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, workspace } = await fixture();
      const dispatch = vi.fn(async () => undefined);
      const { setInterval, clearInterval } = fakeInterval();
      const { watchMock, watchers } = fakeWatch();
      const outbox = setupOutbox(dataDir, dispatch, { setInterval, clearInterval, watch: watchMock });
      await outbox.start();
      await writeRequest(workspace, "one.json", valid());

      const watcher = watchers.find(({ path: watcherPath }) => watcherPath === path.join(workspace, ".tg-bot", "outbox"))?.watcher;
      expect(watcher).toBeDefined();
      expect(watcher?.closed).toBe(false);
      watcher?.emit("rename", "one.json");

      await outbox.stop();
      await vi.advanceTimersByTimeAsync(100);

      expect(watcher?.closed).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("dispatches edit_message and delete_message requests with their fields", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "edit.json", {
      version: 1, id: "edit", type: "edit_message", message_id: 55,
      text: "updated text", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      link_preview_options: { is_disabled: true },
    });
    await writeRequest(workspace, "del.json", { version: 1, type: "delete_message", message_id: 56 });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "edit", type: "edit_message", message_id: 55,
      text: "updated text", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      link_preview_options: { is_disabled: true },
    });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "delete_message", message_id: 56 });
    const sent = await systemLogRecords(workspace, "outbox_sent");
    sent.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(sent).toMatchObject([{ name: "del.json" }, { name: "edit.json" }]);
  });

  it("forwards edit_message requests without host-side semantic validation", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "long-edit.json", {
      version: 1, id: "long-edit", type: "edit_message", message_id: 7, text: "x".repeat(4_097),
    });
    await writeRequest(workspace, "empty-edit.json", { version: 1, type: "edit_message", message_id: 9 });
    await writeRequest(workspace, "both-edit.json", {
      version: 1, id: "both-edit", type: "edit_message", message_id: 9,
      text: "x", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 1 }],
    });
    await writeRequest(workspace, "reply-edit.json", {
      version: 1, id: "reply-edit", type: "edit_message", message_id: 9,
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(4);
    const sent = await systemLogRecords(workspace, "outbox_sent");
    sent.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(sent).toMatchObject([
      { name: "both-edit.json" }, { name: "empty-edit.json" }, { name: "long-edit.json" }, { name: "reply-edit.json" },
    ]);
  });

  it("forwards send_message payloads without host-side semantic validation", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "both.json", {
      version: 1, id: "both", type: "send_message", text: "hello",
      parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 5 }],
    });
    await writeRequest(workspace, "bad-entity.json", {
      version: 1, id: "bad-entity", type: "send_message", text: "x", entities: ["bold"],
    });
    await writeRequest(workspace, "no-length.json", {
      version: 1, id: "no-length", type: "send_message", text: "x",
      entities: [{ type: "bold", offset: 0 }],
    });
    await writeRequest(workspace, "big-preview.json", {
      version: 1, id: "big-preview", type: "send_message", text: "x",
      link_preview_options: { url: "x".repeat(8_193) },
    });
    await writeRequest(workspace, "cjk-markup.json", {
      version: 1, id: "cjk-markup", type: "send_message", text: "x",
      reply_markup: { inline_keyboard: [[{ text: "漢".repeat(3000), callback_data: "cjk" }]] },
    });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(5);
    const sent = await systemLogRecords(workspace, "outbox_sent");
    sent.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(sent).toMatchObject([
      { name: "bad-entity.json" }, { name: "big-preview.json" }, { name: "both.json" }, { name: "cjk-markup.json" }, { name: "no-length.json" },
    ]);
  });

  it("accepts a reaction mixing emoji and custom_emoji entries", async () => {
    const { dataDir, workspace } = await fixture();
    await writeRequest(workspace, "react.json", {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    });
    const dispatch = vi.fn(async () => undefined);
    await pollOutbox(dataDir, dispatch);
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    });
    expect(await systemLogRecords(workspace, "outbox_sent")).toMatchObject([{ name: "react.json" }]);
  });

});
