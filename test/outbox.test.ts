import type { watch } from "node:fs";
import { link, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOutbox } from "../src/outbox.js";

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

async function chatEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "events.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const valid = (id = "one", filePath = "/workspace/report.txt") => ({
  version: 1,
  id,
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
      pollIntervalMs: 2_147_483_648,
    })).toThrow("positive timer-safe integer");
  });
  it("delivers valid requests and moves them to processed", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "one.json", valid());
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "one", type: "send_file", path: "/workspace/report.txt", caption: "Report" });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["one.json"]);
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual([]);
  });
  it("retries a stale claim left by a crashed process", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-crashed";
    await request(workspace, claimName, valid("crashed"));
    const dispatch = vi.fn(async () => undefined);

    await new WorkspaceOutbox({ dataDir, dispatch, now: () => 5 * 60_000 }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "crashed", type: "send_file", path: "/workspace/report.txt", caption: "Report" });
    expect(await names(path.join(outbox, "processed"))).toEqual([claimName]);
  });
  it("skips and cleans a stale claim whose inode is already processed", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-archived";
    const claimPath = path.join(outbox, claimName);
    await request(workspace, claimName, valid("archived"));
    await mkdir(path.join(outbox, "processed"), { recursive: true });
    await link(claimPath, path.join(outbox, "processed", "archived.json"));
    const dispatch = vi.fn(async () => undefined);

    await new WorkspaceOutbox({ dataDir, dispatch, now: () => 5 * 60_000 }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "processed"))).toEqual(["archived.json"]);
    expect(await names(outbox)).not.toContain(claimName);
  });

  it("does not retry a sent request when archiving the claim fails", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const dispatch = vi.fn(async () => {
      const claim = (await readdir(outbox)).find((name) => name.startsWith(".in-progress-"));
      if (claim) await rm(path.join(outbox, claim), { force: true });
      return undefined;
    });
    await request(workspace, "sent.json", valid("sent"));
    const instance = new WorkspaceOutbox({ dataDir, dispatch });

    await instance.poll();
    await instance.poll();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await names(path.join(outbox, "failed"))).toEqual([]);
  });


  it("leaves recent claims untouched while another process may be sending", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-299999-recent";
    await request(workspace, claimName, valid("recent"));
    const dispatch = vi.fn(async () => undefined);

    await new WorkspaceOutbox({ dataDir, dispatch, now: () => 300_000 }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "processed"))).toEqual([]);
    expect(await names(outbox)).toContain(claimName);
  });

  it("quarantines malformed stale claims without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const claimName = ".in-progress-0-malformed";
    await writeFile(path.join(outbox, claimName), "{not json", "utf8");
    const dispatch = vi.fn(async () => undefined);

    await new WorkspaceOutbox({ dataDir, dispatch, now: () => 5 * 60_000 }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual([claimName]);
  });

  it("quarantines malformed JSON and invalid schemas without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeFile(path.join(outbox, "malformed.json"), "{not json", "utf8");
    await request(workspace, "invalid.json", { version: 2, id: "bad", type: "send_file", path: "x" });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["invalid.json", "malformed.json"]);
  });

  it("quarantines oversized requests without delivering them", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await writeFile(path.join(outbox, "oversized.json"), `${JSON.stringify(valid())}${"x".repeat(64 * 1024)}`, "utf8");
    const dispatch = vi.fn(async () => undefined);

    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["oversized.json"]);
  });


  it("rejects traversal before invoking the host callback", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "escape.json", valid("escape", "/workspace/../outside.txt"));
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["escape.json"]);
  });

  it("rejects workspace directory aliases before invoking the host callback", async () => {
    const { dataDir, workspace } = await fixture();
    const aliases = ["/workspace/", "/workspace/.", "/workspace/./"];
    for (const [index, requestPath] of aliases.entries()) {
      await request(workspace, `alias-${index}.json`, valid(`alias-${index}`, requestPath));
    }
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual([
      "alias-0.json", "alias-1.json", "alias-2.json",
    ]);
  });

  it("rejects symlinked request files without following them", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    const target = path.join(workspace, "outside.json");
    await writeFile(target, JSON.stringify(valid()), "utf8");
    await symlink(target, path.join(outbox, "link.json"));
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["link.json"]);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(valid());
  });

  it("moves host failures to failed and ignores temporary or non-JSON entries", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await request(workspace, "failed.json", valid());
    await writeFile(path.join(outbox, "partial.json.tmp"), JSON.stringify(valid()), "utf8");
    await writeFile(path.join(outbox, "notes.txt"), JSON.stringify(valid()), "utf8");
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
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
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "one", type: "send_file", path: "/workspace/report.txt", caption: "Report" });
  });
  it("bounds a flooded chat while still processing later chats", async () => {
    const { dataDir, workspace } = await fixture();
    const laterWorkspace = path.join(dataDir, "chats", "43", "workspace");
    await mkdir(path.join(laterWorkspace, ".tg-bot", "outbox"), { recursive: true });
    await request(laterWorkspace, "later.json", valid("later", "/workspace/later.txt"));
    for (let index = 0; index < 300; index += 1) {
      const id = String(index).padStart(4, "0");
      await request(workspace, `${id}.json`, valid(id, `/workspace/${id}.txt`));
    }

    const chats: number[] = [];
    const dispatch = vi.fn(async (chatId: number) => {
      chats.push(chatId);
      return undefined;
    });
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();

    const floodedChatSends = chats.filter((chatId) => chatId === 42).length;
    expect(floodedChatSends).toBeLessThanOrEqual(256);
    expect(floodedChatSends).toBeLessThan(300);
    expect(chats).toContain(43);
  });


  it("serializes overlapping polls and requests within a chat", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "a.json", valid("a"));
    await request(workspace, "b.json", valid("b"));
    let active = 0;
    let maximum = 0;
    const dispatch = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return undefined;
    });
    const outbox = new WorkspaceOutbox({ dataDir, dispatch });
    await Promise.all([outbox.poll(), outbox.poll(), outbox.processChat(42)]);
    expect(maximum).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("renews a live claim before stale recovery can reclaim a long send", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "long.json", valid("long"));
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
    const first = new WorkspaceOutbox({ dataDir, dispatch, now: () => now, setInterval, clearInterval });
    const firstPoll = first.poll();

    await sendStarted;
    now = 5 * 60_000;
    callbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const duplicateSend = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch: duplicateSend, now: () => now }).poll();
    expect(duplicateSend).not.toHaveBeenCalled();

    finishSend();
    await firstPoll;
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["long.json"]);
  });


  it("stops and clears its polling timer", async () => {
    const { dataDir } = await fixture();
    const { callbacks, cleared, setIntervalMock, setInterval, clearInterval } = fakeInterval();
    const outbox = new WorkspaceOutbox({ dataDir, dispatch: async () => undefined, setInterval, clearInterval });
    await outbox.start();
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5_000);
    await outbox.stop();
    expect(cleared).toEqual([1]);
    expect(callbacks).toHaveLength(1);
  });
  it("dispatches send_message requests with their message fields", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "msg.json", {
      version: 1,
      id: "msg",
      type: "send_message",
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    });
    const dispatch = vi.fn(async () => ({ messageId: 9_001 }));
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1,
      id: "msg",
      type: "send_message",
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["msg.json"]);
  });

  it("records a send event for each sent message id", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "one.json", valid());
    await request(workspace, "two.json", valid("two"));
    const dispatch = vi.fn(async (_chatId: number, request: { id: string }) => ({ messageId: request.id === "one" ? 100 : 200 }));
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    await vi.waitFor(async () => {
      const recorded = await chatEvents(workspace);
      recorded.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      expect(recorded).toMatchObject([
        { type: "send", kind: "send_file", id: "one", messageId: 100, ok: true },
        { type: "send", kind: "send_file", id: "two", messageId: 200, ok: true },
      ]);
    });
  });

  it("skips send events when the dispatcher reports no message id", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "one.json", valid());
    await new WorkspaceOutbox({ dataDir, dispatch: vi.fn(async () => undefined) }).poll();
    await expect(readFile(path.join(workspace, ".tg-bot", "events.jsonl"), "utf8")).rejects.toThrow();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["one.json"]);
  });

  it("bounds the poll results file to the latest lines", async () => {
    const { dataDir, workspace } = await fixture();
    const resultsPath = path.join(workspace, ".tg-bot", "poll-results.jsonl");
    const oldLines = Array.from({ length: 300 }, (_unused, index) => JSON.stringify({ id: `old-${index}`, result: index }));
    await writeFile(resultsPath, `${oldLines.join("\n")}\n`, "utf8");
    await request(workspace, "stop.json", { version: 1, id: "stop", type: "stop_poll", message_id: 77 });
    await new WorkspaceOutbox({ dataDir, dispatch: vi.fn(async () => ({ data: 777 })) }).poll();
    const lines = (await readFile(resultsPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(256);
    expect(lines.at(-1)).toBe('{"id":"stop","result":777}');
    expect(lines.at(-2)).toBe('{"id":"old-299","result":299}');
  });

  it("quarantines invalid send_message requests without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await request(workspace, "bad-mode.json", { version: 1, id: "bad-mode", type: "send_message", text: "x", parse_mode: "Markdown" });
    await request(workspace, "bad-markup.json", { version: 1, id: "bad-markup", type: "send_message", text: "x", reply_markup: [1] });
    await request(workspace, "bad-reply.json", { version: 1, id: "bad-reply", type: "send_message", text: "x", reply_to_message_id: -3 });
    await request(workspace, "long-text.json", { version: 1, id: "long-text", type: "send_message", text: "x".repeat(4_097) });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["bad-markup.json", "bad-mode.json", "bad-reply.json", "long-text.json"]);
  });

  it("dispatches location, poll, and reaction requests and records poll ids", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "loc.json", {
      version: 1, id: "loc", type: "send_location",
      latitude: 52.52, longitude: 13.405, heading: 90,
      venue: { title: "Gate", address: "Platz 1" },
    });
    await request(workspace, "poll.json", {
      version: 1, id: "poll", type: "send_poll",
      question: "Pick one", options: ["a", "b", "c"],
      is_anonymous: false, allows_multiple_answers: true, poll_type: "regular",
    });
    await request(workspace, "react.json", {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" }],
    });
    const dispatch = vi.fn(async (_chatId: number, request: { id: string }) => {
      if (request.id === "loc") return { messageId: 301 };
      if (request.id === "poll") return { messageId: 302, pollId: "poll-abc" };
      return undefined;
    });
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
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
      recorded.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      expect(recorded).toMatchObject([
        { type: "send", kind: "send_location", id: "loc", messageId: 301, ok: true },
        { type: "send", kind: "send_poll", id: "poll", messageId: 302, pollId: "poll-abc", ok: true },
      ]);
    });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["loc.json", "poll.json", "react.json"]);
  });

  it("records stopped poll results in poll-results.jsonl", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "stop.json", { version: 1, id: "stop", type: "stop_poll", message_id: 77 });
    const poll = { id: "poll-xyz", question: "Q", options: [{ text: "a", voter_count: 2 }], total_voter_count: 2, is_closed: true };
    const dispatch = vi.fn(async () => ({ data: poll }));
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "stop", type: "stop_poll", message_id: 77 });
    const results = (await readFile(path.join(workspace, ".tg-bot", "poll-results.jsonl"), "utf8")).trim();
    expect(JSON.parse(results)).toEqual({ id: "stop", result: poll });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["stop.json"]);
    await expect(readFile(path.join(workspace, ".tg-bot", "events.jsonl"), "utf8")).rejects.toThrow();
  });

  it("quarantines invalid location, poll, and reaction requests without delivery", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await request(workspace, "bad-kind.json", { version: 1, id: "bad-kind", type: "send_file", path: "x", kind: "weird" });
    await request(workspace, "bad-lat.json", { version: 1, id: "bad-lat", type: "send_location", latitude: 91, longitude: 0 });
    await request(workspace, "bad-venue.json", { version: 1, id: "bad-venue", type: "send_location", latitude: 1, longitude: 2, venue: { title: "x" } });
    await request(workspace, "few-options.json", { version: 1, id: "few-options", type: "send_poll", question: "q", options: ["only"] });
    await request(workspace, "quiz-no-answer.json", { version: 1, id: "quiz-no-answer", type: "send_poll", question: "q", options: ["a", "b"], poll_type: "quiz" });
    await request(workspace, "bad-answer-index.json", { version: 1, id: "bad-answer-index", type: "send_poll", question: "q", options: ["a", "b"], poll_type: "quiz", correct_option_id: 5 });
    await request(workspace, "bad-emoji.json", { version: 1, id: "bad-emoji", type: "send_reaction", message_id: 3, reaction: [{ type: "custom_emoji", custom_emoji_id: "" }] });
    await request(workspace, "bad-stop.json", { version: 1, id: "bad-stop", type: "stop_poll", message_id: 0 });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual([
      "bad-answer-index.json", "bad-emoji.json", "bad-kind.json", "bad-lat.json", "bad-stop.json", "bad-venue.json", "few-options.json", "quiz-no-answer.json",
    ]);
  });

  it("dispatches an empty reaction array to remove a reaction", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "react.json", { version: 1, id: "react", type: "send_reaction", message_id: 12, reaction: [] });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "react", type: "send_reaction", message_id: 12, reaction: [] });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["react.json"]);
  });

  it("rejects reaction requests with too many or invalid entries", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await request(workspace, "too-many.json", {
      version: 1, id: "too-many", type: "send_reaction", message_id: 3,
      reaction: [
        { type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" },
        { type: "emoji", emoji: "😀" }, { type: "emoji", emoji: "😎" },
      ],
    });
    await request(workspace, "bad-entry.json", {
      version: 1, id: "bad-entry", type: "send_reaction", message_id: 3,
      reaction: [{ type: "emoji", emoji: "" }],
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["bad-entry.json", "too-many.json"]);
  });

  it("records a failed send event when the dispatcher throws", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "one.json", valid());
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    await vi.waitFor(async () => {
      expect(await chatEvents(workspace)).toMatchObject([
        { type: "send", kind: "send_file", id: "one", ok: false, error: "upload failed" },
      ]);
    });
  });

  it("dispatches a queued request on a watcher event without waiting for the poll interval", async () => {
    vi.useFakeTimers();
    try {
      const { dataDir, workspace } = await fixture();
      const dispatch = vi.fn(async () => undefined);
      const { setInterval, clearInterval } = fakeInterval();
      const { watchMock, watchers } = fakeWatch();
      const outbox = new WorkspaceOutbox({ dataDir, dispatch, setInterval, clearInterval, watch: watchMock });
      await outbox.start();
      await request(workspace, "one.json", valid());

      const watcher = watchers.find(({ path: watcherPath }) => watcherPath === path.join(workspace, ".tg-bot", "outbox"))?.watcher;
      expect(watcher).toBeDefined();
      watcher?.emit("rename", "one.json");

      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "one", type: "send_file", path: "/workspace/report.txt", caption: "Report" });
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
      const outbox = new WorkspaceOutbox({ dataDir, dispatch, setInterval, clearInterval, watch: watchMock });
      await outbox.start();
      await request(workspace, "one.json", valid());

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
      const outbox = new WorkspaceOutbox({ dataDir, dispatch, setInterval, clearInterval, watch: watchMock });
      await outbox.start();

      const watcher = watchers.find(({ path: watcherPath }) => watcherPath === path.join(workspace, ".tg-bot", "outbox"))?.watcher;
      expect(watcher).toBeDefined();
      watcher?.emit("error");

      await request(workspace, "one.json", valid());
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
      const outbox = new WorkspaceOutbox({ dataDir, dispatch, setInterval, clearInterval, watch: watchMock });
      await outbox.start();
      await request(workspace, "one.json", valid());

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
    await request(workspace, "edit.json", {
      version: 1, id: "edit", type: "edit_message", message_id: 55,
      text: "updated text", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      link_preview_options: { is_disabled: true },
    });
    await request(workspace, "del.json", { version: 1, id: "del", type: "delete_message", message_id: 56 });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "edit", type: "edit_message", message_id: 55,
      text: "updated text", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      link_preview_options: { is_disabled: true },
    });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, id: "del", type: "delete_message", message_id: 56 });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["del.json", "edit.json"]);
  });

  it("rejects edit_message with text over 4096 characters", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "long-edit.json", {
      version: 1, id: "long-edit", type: "edit_message", message_id: 7, text: "x".repeat(4_097),
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["long-edit.json"]);
  });

  it("rejects send_message carrying both parse_mode and entities", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "both.json", {
      version: 1, id: "both", type: "send_message", text: "hello",
      parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 5 }],
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["both.json"]);
  });

  it("rejects entities with a non-object entry or a missing length", async () => {
    const { dataDir, workspace } = await fixture();
    const outbox = path.join(workspace, ".tg-bot", "outbox");
    await request(workspace, "bad-entity.json", {
      version: 1, id: "bad-entity", type: "send_message", text: "x", entities: ["bold"],
    });
    await request(workspace, "no-length.json", {
      version: 1, id: "no-length", type: "send_message", text: "x",
      entities: [{ type: "bold", offset: 0 }],
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(outbox, "failed"))).toEqual(["bad-entity.json", "no-length.json"]);
  });

  it("rejects oversized link_preview_options", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "big-preview.json", {
      version: 1, id: "big-preview", type: "send_message", text: "x",
      link_preview_options: { url: "x".repeat(8_193) },
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["big-preview.json"]);
  });

  it("accepts a reaction mixing emoji and custom_emoji entries", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "react.json", {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "react", type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["react.json"]);
  });

  it("rejects edit_message with no text, reply_markup, or link_preview_options", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "empty-edit.json", { version: 1, id: "empty-edit", type: "edit_message", message_id: 9 });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["empty-edit.json"]);
  });

  it("rejects edit_message carrying both parse_mode and entities", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "both-edit.json", {
      version: 1, id: "both-edit", type: "edit_message", message_id: 9,
      text: "x", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 1 }],
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "failed"))).toEqual(["both-edit.json"]);
  });

  it("dispatches edit_message without text using only reply_markup", async () => {
    const { dataDir, workspace } = await fixture();
    await request(workspace, "reply-edit.json", {
      version: 1, id: "reply-edit", type: "edit_message", message_id: 9,
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    });
    const dispatch = vi.fn(async () => undefined);
    await new WorkspaceOutbox({ dataDir, dispatch }).poll();
    expect(dispatch).toHaveBeenCalledWith(42, {
      version: 1, id: "reply-edit", type: "edit_message", message_id: 9,
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    });
    expect(await names(path.join(workspace, ".tg-bot", "outbox", "processed"))).toEqual(["reply-edit.json"]);
  });
});
