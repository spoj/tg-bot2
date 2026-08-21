import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOutbox, type WorkspaceOutboxOptions } from "../src/outbox.js";
import { EventSink, type EventNotifier } from "../src/events.js";
import type { WorkspaceOutboxDispatcher, WorkspaceOutboxRequest } from "../src/outbox-protocol.js";
import type { SendRequest } from "../src/request-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-outbox-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  return { dataDir, workspace };
}

async function allowChat(workspace: string, chatId: number): Promise<void> {
  const allowFile = path.join(workspace, ".tg-bot", "allowed.json");
  await writeFile(allowFile, JSON.stringify({
    version: 1,
    chats: [{ chat_id: chatId, added_by: "agent", added_at: "2026-01-01T00:00:00.000Z" }],
  }, null, 2) + "\n", "utf8");
}

async function logEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "events.jsonl"), "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function setupOutbox(
  workspace: string,
  dispatch: WorkspaceOutboxDispatcher,
  options: Partial<WorkspaceOutboxOptions> & { notifier?: EventNotifier } = {},
): { outbox: WorkspaceOutbox; events: EventSink } {
  const events = new EventSink(workspace, options.notifier ?? { followup: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) });
  const outbox = new WorkspaceOutbox({
    workspace,
    dispatch,
    events,
    ...options,
  });
  return { outbox, events };
}

const valid = (filePath = "/workspace/report.txt") => ({
  type: "send_file",
  chat_id: 42,
  path: filePath,
  caption: "Report",
});

function sendRecord(requestId: string, request: unknown): SendRequest {
  return { requestId, request };
}

async function send(
  workspace: string,
  dispatch: WorkspaceOutboxDispatcher,
  record: SendRequest,
  options: Partial<WorkspaceOutboxOptions> & { notifier?: EventNotifier } = {},
): Promise<void> {
  await setupOutbox(workspace, dispatch, options).outbox.handleSendRequest(record, workspace);
}

describe("WorkspaceOutbox", () => {
  it("delivers valid sends and records outbox_sent directly in events.jsonl", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", valid()));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", chat_id: 42, path: "/workspace/report.txt", caption: "Report" });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "outbox_sent", requestId: "req-1", chat_id: 42 },
    ]);
  });

  it("dispatches send_message requests with their message fields", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const request = {
      type: "send_message",
      chat_id: 42,
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    };
    const dispatch = vi.fn(async () => ({ messageId: 9_001 }));
    await send(workspace, dispatch, sendRecord("req-1", request));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...request });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "outbox_sent", requestId: "req-1", chat_id: 42, messageId: 9001 },
    ]);
  });

  it("forwards send_message requests without host-side semantic validation", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_message", chat_id: 42, text: "x", parse_mode: "Markdown" }));
    await send(workspace, dispatch, sendRecord("req-2", { type: "send_message", chat_id: 42, text: "x", reply_markup: [1] }));
    await send(workspace, dispatch, sendRecord("req-3", { type: "send_message", chat_id: 42, text: "x", reply_to_message_id: -3 }));
    await send(workspace, dispatch, sendRecord("req-4", { type: "send_message", chat_id: 42, text: "x".repeat(4_097) }));
    await send(workspace, dispatch, sendRecord("req-5", { type: "send_message", chat_id: 42, text: "hello", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 5 }] }));
    await send(workspace, dispatch, sendRecord("req-6", { type: "send_message", chat_id: 42, text: "x", entities: ["bold"] }));
    await send(workspace, dispatch, sendRecord("req-7", { type: "send_message", chat_id: 42, text: "x", entities: [{ type: "bold", offset: 0 }] }));
    await send(workspace, dispatch, sendRecord("req-8", { type: "send_message", chat_id: 42, text: "x", link_preview_options: { url: "x".repeat(8_193) } }));
    expect(dispatch).toHaveBeenCalledTimes(8);
    expect((await logEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(8);
  });

  it("dispatches location, poll, and reaction requests and records poll ids", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const location = {
      type: "send_location",
      chat_id: 42,
      latitude: 52.52, longitude: 13.405, heading: 90,
      venue: { title: "Gate", address: "Platz 1" },
    };
    const poll = {
      type: "send_poll",
      chat_id: 42,
      question: "Pick one", options: ["a", "b", "c"],
      is_anonymous: false, allows_multiple_answers: true, poll_type: "regular",
    };
    const reaction = {
      type: "send_reaction",
      chat_id: 42,
      message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" }],
    };
    const dispatch = vi.fn(async (_chatId: number, request: WorkspaceOutboxRequest) => {
      if ("latitude" in request && request.latitude === 52.52) return { messageId: 301 };
      if ("question" in request && request.question === "Pick one") return { messageId: 302, pollId: "poll-abc" };
      return undefined;
    });
    await send(workspace, dispatch, sendRecord("req-1", location));
    await send(workspace, dispatch, sendRecord("req-2", poll));
    await send(workspace, dispatch, sendRecord("req-3", reaction));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...location });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...poll });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...reaction });
    const sent = (await logEvents(workspace)).filter((event) => event.type === "outbox_sent");
    expect(sent).toMatchObject([
      { requestId: "req-1", chat_id: 42, messageId: 301 },
      { requestId: "req-2", chat_id: 42, messageId: 302, pollId: "poll-abc" },
      { requestId: "req-3", chat_id: 42 },
    ]);
  });

  it("forwards location, poll, and reaction requests without host-side semantic validation", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_location", chat_id: 42, latitude: 91, longitude: 0 }));
    await send(workspace, dispatch, sendRecord("req-2", { type: "send_location", chat_id: 42, latitude: 1, longitude: 2, venue: { title: "x" } }));
    await send(workspace, dispatch, sendRecord("req-3", { type: "send_poll", chat_id: 42, question: "q", options: ["only"] }));
    await send(workspace, dispatch, sendRecord("req-4", { type: "send_poll", chat_id: 42, question: "q", options: ["a", "b"], poll_type: "quiz" }));
    await send(workspace, dispatch, sendRecord("req-5", { type: "send_poll", chat_id: 42, question: "q", options: ["a", "b"], poll_type: "quiz", correct_option_id: 5 }));
    await send(workspace, dispatch, sendRecord("req-6", { type: "send_reaction", chat_id: 42, message_id: 3, reaction: [{ type: "custom_emoji", custom_emoji_id: "" }] }));
    await send(workspace, dispatch, sendRecord("req-7", { type: "stop_poll", chat_id: 42, message_id: 0 }));
    expect(dispatch).toHaveBeenCalledTimes(7);
    expect((await logEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(7);
  });

  it("dispatches send_media_group requests with their media payload", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const group = {
      type: "send_media_group",
      chat_id: 42,
      media: [
        { type: "photo", media: "/workspace/a.png", caption: "first" },
        { type: "video", media: "b.mp4" },
      ],
    };
    const dispatch = vi.fn(async () => ({ messageId: 7 }));
    await send(workspace, dispatch, sendRecord("req-1", group));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...group });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "outbox_sent", requestId: "req-1", chat_id: 42, messageId: 7 },
    ]);
  });

  it("rejects send_media_group requests with fewer than two items or wrong item types", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_media_group", chat_id: 42, media: [{ type: "photo", media: "a.png" }] }), { notifier: { followup, interrupt: vi.fn() } });
    await send(workspace, dispatch, sendRecord("req-2", { type: "send_media_group", chat_id: 42, media: [{ type: "document", media: "a.pdf" }, { type: "photo", media: "b.png" }] }), { notifier: { followup, interrupt: vi.fn() } });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    expect(followup).toHaveBeenCalledWith("Send req-1 rejected: Outbox request media must be an array of 2 to 10 items");
    expect(followup).toHaveBeenCalledWith("Send req-2 rejected: Outbox request media item type must be photo or video");
    const rejected = (await logEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { requestId: "req-1", detail: expect.stringContaining("2 to 10 items") },
      { requestId: "req-2", detail: expect.stringContaining("photo or video") },
    ]);
  });

  it("discards structurally invalid sends and notifies the agent", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_file", chat_id: 42, path: "x", kind: "weird" }), { notifier: { followup, interrupt: vi.fn() } });
    await send(workspace, dispatch, sendRecord("req-2", { type: "send_file", chat_id: 42, path: 7 }), { notifier: { followup, interrupt: vi.fn() } });
    await send(workspace, dispatch, sendRecord("req-3", "not-an-object"), { notifier: { followup, interrupt: vi.fn() } });
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { requestId: "req-1", detail: expect.stringContaining("must be auto, photo") },
      { requestId: "req-2", detail: expect.stringContaining("must be a non-empty string") },
      { requestId: "req-3", detail: expect.stringContaining("must be a JSON object") },
    ]);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(3));
    expect(followup).toHaveBeenCalledWith("Send req-1 rejected: Outbox request kind must be auto, photo, audio, video, voice, or document");
    expect(followup).toHaveBeenCalledWith("Send req-3 rejected: Outbox request must be a JSON object");
  });

  it("discards oversized sends without delivering them", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_file", chat_id: 42, path: "x".repeat(1024 * 1024) }), { notifier: { followup, interrupt: vi.fn() } });
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([{ requestId: "req-1", detail: expect.stringContaining("exceeds 1048576 bytes") }]);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it("notifies the agent when the dispatcher throws, logging outbox_rejected", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await send(workspace, dispatch, sendRecord("req-1", valid()), { notifier: { followup, interrupt: vi.fn() } });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(followup).toHaveBeenCalledWith("Send req-1 rejected: upload failed");
    const events = await logEvents(workspace);
    expect(events).toMatchObject([
      { type: "outbox_rejected", requestId: "req-1", chat_id: 42, detail: expect.stringContaining("upload failed") },
    ]);
  });

  it("dispatches an empty reaction array to remove a reaction", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_reaction", chat_id: 42, message_id: 12, reaction: [] }));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_reaction", chat_id: 42, message_id: 12, reaction: [] });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "outbox_sent", requestId: "req-1", chat_id: 42 },
    ]);
  });

  it("forwards reaction requests with too many or invalid entries", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", {
      type: "send_reaction", chat_id: 42, message_id: 3,
      reaction: [
        { type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" },
        { type: "emoji", emoji: "😀" }, { type: "emoji", emoji: "😎" },
      ],
    }));
    await send(workspace, dispatch, sendRecord("req-2", { type: "send_reaction", chat_id: 42, message_id: 3, reaction: [{ type: "emoji", emoji: "" }] }));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await logEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("accepts a reaction mixing emoji and custom_emoji entries", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    const request = {
      type: "send_reaction",
      chat_id: 42,
      message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    };
    await send(workspace, dispatch, sendRecord("req-1", request));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...request });
    expect(await logEvents(workspace)).toMatchObject([
      { type: "outbox_sent", requestId: "req-1", chat_id: 42 },
    ]);
  });

  it("dispatches edit_message and delete_message requests with their fields", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const edit = {
      type: "edit_message",
      chat_id: 42,
      message_id: 55,
      text: "updated text", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      link_preview_options: { is_disabled: true },
    };
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", edit));
    await send(workspace, dispatch, sendRecord("req-2", { type: "delete_message", chat_id: 42, message_id: 56 }));
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...edit });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "delete_message", chat_id: 42, message_id: 56 });
    expect((await logEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("forwards edit_message requests without host-side semantic validation", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "edit_message", chat_id: 42, message_id: 7, text: "x".repeat(4_097) }));
    await send(workspace, dispatch, sendRecord("req-2", { type: "edit_message", chat_id: 42, message_id: 9 }));
    await send(workspace, dispatch, sendRecord("req-3", { type: "edit_message", chat_id: 42, message_id: 9, text: "x", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 1 }] }));
    await send(workspace, dispatch, sendRecord("req-4", { type: "edit_message", chat_id: 42, message_id: 9, reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } }));
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect((await logEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(4);
  });

  it("forwards send_file requests with unconfined paths to the dispatcher", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", valid("/workspace/../outside.txt")));
    await send(workspace, dispatch, sendRecord("req-2", valid("/workspace/")));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await logEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("rejects sends to chats not on the allow list", async () => {
    const { workspace } = await fixture();
    await allowChat(workspace, 99);
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", valid()), { notifier: { followup, interrupt: vi.fn() } });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(followup).toHaveBeenCalledWith("Send req-1 rejected: Chat 42 is not on the allow list");
    const rejected = (await logEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { requestId: "req-1", chat_id: 42, detail: expect.stringContaining("not on the allow list") },
    ]);
  });

  it("rejects requests with a missing or non-safe-integer chat_id", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", { type: "send_message", text: "hi" }), { notifier: { followup, interrupt: vi.fn() } });
    await send(workspace, dispatch, sendRecord("req-2", { type: "send_message", chat_id: 1.5, text: "hi" }), { notifier: { followup, interrupt: vi.fn() } });
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { requestId: "req-1", detail: expect.stringContaining("chat_id must be a safe integer") },
      { requestId: "req-2", detail: expect.stringContaining("chat_id must be a safe integer") },
    ]);
  });

  it("fails closed when allowed.json is malformed", async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), "{ not valid json", "utf8");
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, sendRecord("req-1", valid()), { notifier: { followup, interrupt: vi.fn() } });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(followup).toHaveBeenCalledWith("Send req-1 rejected: Chat 42 is not on the allow list");
    const rejected = (await logEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { requestId: "req-1", chat_id: 42, detail: expect.stringContaining("not on the allow list") },
    ]);
  });
});
