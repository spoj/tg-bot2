import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOutbox, type OutboxSendResult, type WorkspaceOutboxOptions } from "../src/outbox.js";
import { WorkspaceEventLog } from "../src/events.js";
import type { WorkspaceOutboxDispatcher, WorkspaceOutboxRequest } from "../src/outbox-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string; eventsLog: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "outbox-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const eventsLog = path.join(dataDir, "events.jsonl");
  await writeFile(eventsLog, "", "utf8");
  return { dataDir, workspace, eventsLog };
}

async function allowChat(workspace: string, chatId: number | number[]): Promise<void> {
  const ids = Array.isArray(chatId) ? chatId : [chatId];
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), JSON.stringify(ids), "utf8");
}

async function logEvents(eventsLog: string): Promise<Array<Record<string, unknown>>> {
  return new WorkspaceEventLog(eventsLog).readAll();
}

function setupOutbox(
  workspace: string,
  eventsLog: string,
  dispatch: WorkspaceOutboxDispatcher,
  options: Partial<WorkspaceOutboxOptions> = {},
): { outbox: WorkspaceOutbox } {
  const events = new WorkspaceEventLog(eventsLog);
  const outbox = new WorkspaceOutbox({ workspace, dispatch, events, ...options });
  return { outbox };
}

async function send(
  workspace: string,
  eventsLog: string,
  dispatch: WorkspaceOutboxDispatcher,
  request: unknown,
  origin?: string,
): Promise<OutboxSendResult> {
  return setupOutbox(workspace, eventsLog, dispatch).outbox.send(request, origin);
}

const valid = (filePath = "/workspace/report.txt") => ({
  type: "send_file",
  chat_id: 42,
  path: filePath,
  caption: "Report",
});

describe("WorkspaceOutbox", () => {
  it("delivers valid sends, records outbox_sent, and returns the outcome", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    const result = await send(workspace, eventsLog, dispatch, valid());
    expect(result).toMatchObject({ request_type: "send_file" });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", chat_id: 42, path: "/workspace/report.txt", caption: "Report" });
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "outbox_sent", requestId: expect.any(String), chat_id: 42 },
    ]);
  });

  it("dispatches send_message requests with their message fields", async () => {
    const { workspace, eventsLog } = await fixture();
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
    expect(await send(workspace, eventsLog, dispatch, request)).toMatchObject({ messageId: 9001, request_type: "send_message" });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...request });
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "outbox_sent", chat_id: 42, messageId: 9001 },
    ]);
  });

  it("dispatches create_forum_topic and close_forum_topic requests", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, -100);
    const dispatch = vi.fn(async () => ({ messageThreadId: 105, data: { message_thread_id: 105, name: "Japan 2026" } }));
    await send(workspace, eventsLog, dispatch, { type: "create_forum_topic", chat_id: -100, name: "Japan 2026" });
    expect(dispatch).toHaveBeenCalledWith(-100, { version: 1, type: "create_forum_topic", chat_id: -100, name: "Japan 2026" });
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "outbox_sent", chat_id: -100, message_thread_id: 105, summary: "Japan 2026" },
    ]);

    const closeDispatch = vi.fn(async () => ({ messageThreadId: 105 }));
    await send(workspace, eventsLog, closeDispatch, { type: "close_forum_topic", chat_id: -100, message_thread_id: 105 });
    expect(closeDispatch).toHaveBeenCalledWith(-100, { version: 1, type: "close_forum_topic", chat_id: -100, message_thread_id: 105 });
  });

  it("forwards send_message requests without host-side semantic validation", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x", parse_mode: "Markdown" });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x", reply_markup: [1] });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x", reply_to_message_id: -3 });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x".repeat(4_097) });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "hello", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 5 }] });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x", entities: ["bold"] });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x", entities: [{ type: "bold", offset: 0 }] });
    await send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 42, text: "x", link_preview_options: { url: "x".repeat(8_193) } });
    expect(dispatch).toHaveBeenCalledTimes(8);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent")).toHaveLength(8);
  });

  it("dispatches location, poll, and reaction requests and records poll ids", async () => {
    const { workspace, eventsLog } = await fixture();
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
    await send(workspace, eventsLog, dispatch, location);
    expect(await send(workspace, eventsLog, dispatch, poll)).toMatchObject({ pollId: "poll-abc", messageId: 302 });
    await send(workspace, eventsLog, dispatch, reaction);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...location });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...poll });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...reaction });
    const sent = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent");
    expect(sent).toMatchObject([
      { chat_id: 42, messageId: 301 },
      { chat_id: 42, messageId: 302, pollId: "poll-abc" },
      { chat_id: 42 },
    ]);
  });

  it("forwards location, poll, and reaction requests without host-side semantic validation", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, { type: "send_location", chat_id: 42, latitude: 91, longitude: 0 });
    await send(workspace, eventsLog, dispatch, { type: "send_location", chat_id: 42, latitude: 1, longitude: 2, venue: { title: "x" } });
    await send(workspace, eventsLog, dispatch, { type: "send_poll", chat_id: 42, question: "q", options: ["only"] });
    await send(workspace, eventsLog, dispatch, { type: "send_poll", chat_id: 42, question: "q", options: ["a", "b"], poll_type: "quiz" });
    await send(workspace, eventsLog, dispatch, { type: "send_poll", chat_id: 42, question: "q", options: ["a", "b"], poll_type: "quiz", correct_option_id: 5 });
    await send(workspace, eventsLog, dispatch, { type: "send_reaction", chat_id: 42, message_id: 3, reaction: [{ type: "custom_emoji", custom_emoji_id: "" }] });
    await send(workspace, eventsLog, dispatch, { type: "stop_poll", chat_id: 42, message_id: 0 });
    expect(dispatch).toHaveBeenCalledTimes(7);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent")).toHaveLength(7);
  });

  it("dispatches send_media_group requests with their media payload", async () => {
    const { workspace, eventsLog } = await fixture();
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
    await send(workspace, eventsLog, dispatch, group);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...group });
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "outbox_sent", chat_id: 42, messageId: 7 },
    ]);
  });

  it("rejects send_media_group requests with fewer than two items or wrong item types", async () => {
    const { workspace, eventsLog } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, { type: "send_media_group", chat_id: 42, media: [{ type: "photo", media: "a.png" }] }))
      .rejects.toThrow("must be an array of 2 to 10 items");
    await expect(send(workspace, eventsLog, dispatch, { type: "send_media_group", chat_id: 42, media: [{ type: "document", media: "a.pdf" }, { type: "photo", media: "b.png" }] }))
      .rejects.toThrow("media item type must be photo or video");
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { detail: expect.stringContaining("2 to 10 items") },
      { detail: expect.stringContaining("photo or video") },
    ]);
  });

  it("discards structurally invalid sends", async () => {
    const { workspace, eventsLog } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, { type: "send_file", chat_id: 42, path: "x", kind: "weird" }))
      .rejects.toThrow("kind must be auto, photo, audio, video, voice, or document");
    await expect(send(workspace, eventsLog, dispatch, { type: "send_file", chat_id: 42, path: 7 }))
      .rejects.toThrow("path must be a non-empty string");
    await expect(send(workspace, eventsLog, dispatch, "not-an-object"))
      .rejects.toThrow("must be a JSON object");
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { requestId: expect.any(String), detail: expect.stringContaining("must be auto, photo") },
      { requestId: expect.any(String), detail: expect.stringContaining("must be a non-empty string") },
      { requestId: expect.any(String), detail: expect.stringContaining("must be a JSON object") },
    ]);
  });

  it("discards oversized sends without delivering them", async () => {
    const { workspace, eventsLog } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, { type: "send_file", chat_id: 42, path: "x".repeat(1024 * 1024) }))
      .rejects.toThrow("exceeds 1048576 bytes");
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([{ detail: expect.stringContaining("exceeds 1048576 bytes") }]);
  });

  it("logs outbox_rejected and throws the dispatcher failure", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await expect(send(workspace, eventsLog, dispatch, valid(), "42:0")).rejects.toThrow("upload failed");
    const events = await logEvents(eventsLog);
    expect(events).toMatchObject([
      { type: "outbox_rejected", chat_id: 42, origin: "42:0", detail: expect.stringContaining("upload failed") },
    ]);
  });

  it("preserves message_thread_id in outbox_rejected", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => { throw new Error("topic upload failed"); });
    await expect(send(workspace, eventsLog, dispatch, { ...valid(), message_thread_id: 1234 })).rejects.toThrow("topic upload failed");
    const events = await logEvents(eventsLog);
    expect(events).toMatchObject([
      { type: "outbox_rejected", chat_id: 42, message_thread_id: 1234, detail: expect.stringContaining("topic upload failed") },
    ]);
  });

  it("dispatches an empty reaction array to remove a reaction", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, { type: "send_reaction", chat_id: 42, message_id: 12, reaction: [] });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_reaction", chat_id: 42, message_id: 12, reaction: [] });
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "outbox_sent", chat_id: 42 },
    ]);
  });

  it("forwards reaction requests with too many or invalid entries", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, {
      type: "send_reaction", chat_id: 42, message_id: 3,
      reaction: [
        { type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" },
        { type: "emoji", emoji: "😀" }, { type: "emoji", emoji: "😎" },
      ],
    });
    await send(workspace, eventsLog, dispatch, { type: "send_reaction", chat_id: 42, message_id: 3, reaction: [{ type: "emoji", emoji: "" }] });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("accepts a reaction mixing emoji and custom_emoji entries", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    const request = {
      type: "send_reaction",
      chat_id: 42,
      message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    };
    await send(workspace, eventsLog, dispatch, request);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...request });
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "outbox_sent", chat_id: 42 },
    ]);
  });

  it("dispatches edit_message and delete_message requests with their fields", async () => {
    const { workspace, eventsLog } = await fixture();
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
    await send(workspace, eventsLog, dispatch, edit);
    await send(workspace, eventsLog, dispatch, { type: "delete_message", chat_id: 42, message_id: 56 });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...edit });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "delete_message", chat_id: 42, message_id: 56 });
    expect((await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("forwards edit_message requests without host-side semantic validation", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, { type: "edit_message", chat_id: 42, message_id: 7, text: "x".repeat(4_097) });
    await send(workspace, eventsLog, dispatch, { type: "edit_message", chat_id: 42, message_id: 9 });
    await send(workspace, eventsLog, dispatch, { type: "edit_message", chat_id: 42, message_id: 9, text: "x", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 1 }] });
    await send(workspace, eventsLog, dispatch, { type: "edit_message", chat_id: 42, message_id: 9, reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent")).toHaveLength(4);
  });

  it("forwards send_file requests with unconfined paths to the dispatcher", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, valid("/workspace/../outside.txt"));
    await send(workspace, eventsLog, dispatch, valid("/workspace/"));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("rejects sends to chats not on the allow list", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 99);
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, valid())).rejects.toThrow("Chat 42 is not on the allow list");
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { chat_id: 42, detail: expect.stringContaining("not on the allow list") },
    ]);
  });

  it("rejects requests with a missing or non-safe-integer chat_id", async () => {
    const { workspace, eventsLog } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, { type: "send_message", text: "hi" })).rejects.toThrow("chat_id must be a safe integer");
    await expect(send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 1.5, text: "hi" })).rejects.toThrow("chat_id must be a safe integer");
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { detail: expect.stringContaining("chat_id must be a safe integer") },
      { detail: expect.stringContaining("chat_id must be a safe integer") },
    ]);
  });

  it("fails closed when allowed.json is malformed", async () => {
    const { workspace, eventsLog } = await fixture();
    await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
    await writeFile(path.join(workspace, ".tg-bot", "allowed.json"), "{ not valid json", "utf8");
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, valid())).rejects.toThrow("Chat 42 is not on the allow list");
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await logEvents(eventsLog)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { chat_id: 42, detail: expect.stringContaining("not on the allow list") },
    ]);
  });

  it("preserves origin in outbox_sent and outbox_rejected events", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => ({ messageId: 999 }));

    await send(workspace, eventsLog, dispatch, valid(), "42:100");
    await expect(send(workspace, eventsLog, dispatch, { type: "send_message", chat_id: 999, text: "blocked" }, "42:100"))
      .rejects.toThrow("not on the allow list");


    const events = await logEvents(eventsLog);
    const sent = events.find((e) => e.type === "outbox_sent");
    const rejected = events.find((e) => e.type === "outbox_rejected");

    expect(sent).toMatchObject({
      type: "outbox_sent",
      origin: "42:100",
      chat_id: 42,
    });
    expect(rejected).toMatchObject({
      type: "outbox_rejected",
      origin: "42:100",
      chat_id: 999,
    });
  });
});