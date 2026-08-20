import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOutbox, type WorkspaceOutboxOptions } from "../src/outbox.js";
import type { AgentManager } from "../src/agent.js";
import type { WorkspaceOutboxDispatcher, WorkspaceOutboxRequest } from "../src/outbox-protocol.js";
import type { SessionToolCall } from "../src/session-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-outbox-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "chats", "42", "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  return { dataDir, workspace };
}

async function chatEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "chat.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function systemEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "system.jsonl"), "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const callRef = (index = 0) => ({ sessionId: "11111111-1111-4111-8111-111111111111", recordId: "a1b2c3d4", index });
function sendCall(args: unknown, index = 0): SessionToolCall {
  return { ref: callRef(index), name: "send", args: args as Record<string, unknown> };
}

function setupOutbox(
  dispatch: WorkspaceOutboxDispatcher,
  options: Omit<WorkspaceOutboxOptions, "dispatch" | "agent"> & { agent?: Pick<AgentManager, "followup"> } = {},
): WorkspaceOutbox {
  return new WorkspaceOutbox({ dispatch, agent: { followup: async () => undefined }, ...options });
}

const valid = (filePath = "/workspace/report.txt") => ({
  type: "send_file",
  path: filePath,
  caption: "Report",
});

async function send(
  workspace: string,
  dispatch: WorkspaceOutboxDispatcher,
  args: unknown,
  options: Omit<WorkspaceOutboxOptions, "dispatch" | "agent"> & { agent?: Pick<AgentManager, "followup"> } = {},
  resume?: { requestId: string },
): Promise<void> {
  await setupOutbox(dispatch, options).handleSend(sendCall(args), 42, workspace, resume);
}

describe("WorkspaceOutbox", () => {
  it("delivers valid sends and records claimed then sent", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, valid());
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed", requestId: expect.any(String), callRef: callRef(), request: { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" } },
      { type: "outbox_sent", requestId: expect.any(String), callRef: callRef(), request: { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" } },
    ]);
  });

  it("resumes an open claim without claiming again", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    const requestId = "00000000-0000-0000-0000-000000000000";
    await send(workspace, dispatch, valid(), {}, { requestId });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const events = await systemEvents(workspace);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "outbox_sent", requestId, callRef: callRef() });
  });

  it("records a send event in chat.jsonl for each returned message id", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async (_chatId: number, request: WorkspaceOutboxRequest) => ({ messageId: (request as { path: string }).path === "/workspace/report.txt" ? 100 : 200 }));
    await send(workspace, dispatch, valid());
    await send(workspace, dispatch, valid("/workspace/report-two.txt"));
    const recorded = await chatEvents(workspace);
    expect(recorded).toMatchObject([
      { type: "send", kind: "send_file", messageId: 100 },
      { type: "send", kind: "send_file", messageId: 200 },
    ]);
  });

  it("skips the chat event when the dispatcher reports no message id", async () => {
    const { workspace } = await fixture();
    await send(workspace, vi.fn(async () => undefined), valid());
    await expect(readFile(path.join(workspace, ".tg-bot", "chat.jsonl"), "utf8")).rejects.toThrow();
    expect(await systemEvents(workspace)).toMatchObject([{ type: "outbox_claimed" }, { type: "outbox_sent" }]);
  });

  it("writes dispatcher data onto the send event in chat.jsonl", async () => {
    const { workspace } = await fixture();
    await send(workspace, vi.fn(async () => ({ data: 777 })), { type: "stop_poll", message_id: 77 });
    expect(await chatEvents(workspace)).toMatchObject([{ type: "send", kind: "stop_poll", data: 777 }]);
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed" },
      { type: "outbox_sent", data: 777 },
    ]);
  });

  it("records stopped poll results as data on the send event", async () => {
    const { workspace } = await fixture();
    const poll = { id: "poll-xyz", question: "Q", options: [{ text: "a", voter_count: 2 }], total_voter_count: 2, is_closed: true };
    await send(workspace, vi.fn(async () => ({ messageId: 77, data: poll })), { type: "stop_poll", message_id: 77 });
    expect(await chatEvents(workspace)).toMatchObject([{ type: "send", kind: "stop_poll", messageId: 77, data: poll }]);
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed" },
      { type: "outbox_sent", messageId: 77, data: poll },
    ]);
  });

  it("dispatches send_message requests with their message fields", async () => {
    const { workspace } = await fixture();
    const request = {
      type: "send_message",
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    };
    const dispatch = vi.fn(async () => ({ messageId: 9_001 }));
    await send(workspace, dispatch, request);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...request });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed" },
      { type: "outbox_sent", messageId: 9001 },
    ]);
  });

  it("forwards send_message requests without host-side semantic validation", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "send_message", text: "x", parse_mode: "Markdown" });
    await send(workspace, dispatch, { type: "send_message", text: "x", reply_markup: [1] });
    await send(workspace, dispatch, { type: "send_message", text: "x", reply_to_message_id: -3 });
    await send(workspace, dispatch, { type: "send_message", text: "x".repeat(4_097) });
    await send(workspace, dispatch, { type: "send_message", text: "hello", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 5 }] });
    await send(workspace, dispatch, { type: "send_message", text: "x", entities: ["bold"] });
    await send(workspace, dispatch, { type: "send_message", text: "x", entities: [{ type: "bold", offset: 0 }] });
    await send(workspace, dispatch, { type: "send_message", text: "x", link_preview_options: { url: "x".repeat(8_193) } });
    await send(workspace, dispatch, { type: "send_message", text: "x", reply_markup: { inline_keyboard: [[{ text: "漢".repeat(3000), callback_data: "cjk" }]] } });
    expect(dispatch).toHaveBeenCalledTimes(9);
    expect((await systemEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(9);
  });

  it("dispatches location, poll, and reaction requests and records poll ids", async () => {
    const { workspace } = await fixture();
    const location = {
      type: "send_location",
      latitude: 52.52, longitude: 13.405, heading: 90,
      venue: { title: "Gate", address: "Platz 1" },
    };
    const poll = {
      type: "send_poll",
      question: "Pick one", options: ["a", "b", "c"],
      is_anonymous: false, allows_multiple_answers: true, poll_type: "regular",
    };
    const reaction = {
      type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" }],
    };
    const dispatch = vi.fn(async (_chatId: number, request: WorkspaceOutboxRequest) => {
      if ((request as { latitude: number }).latitude === 52.52) return { messageId: 301 };
      if ((request as { question: string }).question === "Pick one") return { messageId: 302, pollId: "poll-abc" };
      return undefined;
    });
    await send(workspace, dispatch, location);
    await send(workspace, dispatch, poll);
    await send(workspace, dispatch, reaction);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...location });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...poll });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...reaction });
    expect(await chatEvents(workspace)).toMatchObject([
      { type: "send", kind: "send_location", messageId: 301 },
      { type: "send", kind: "send_poll", messageId: 302, pollId: "poll-abc" },
    ]);
    const sent = (await systemEvents(workspace)).filter((event) => event.type === "outbox_sent");
    expect(sent).toMatchObject([
      { messageId: 301 },
      { messageId: 302, pollId: "poll-abc" },
      {},
    ]);
  });

  it("forwards location, poll, and reaction requests without host-side semantic validation", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "send_location", latitude: 91, longitude: 0 });
    await send(workspace, dispatch, { type: "send_location", latitude: 1, longitude: 2, venue: { title: "x" } });
    await send(workspace, dispatch, { type: "send_poll", question: "q", options: ["only"] });
    await send(workspace, dispatch, { type: "send_poll", question: "q", options: ["a", "b"], poll_type: "quiz" });
    await send(workspace, dispatch, { type: "send_poll", question: "q", options: ["a", "b"], poll_type: "quiz", correct_option_id: 5 });
    await send(workspace, dispatch, { type: "send_reaction", message_id: 3, reaction: [{ type: "custom_emoji", custom_emoji_id: "" }] });
    await send(workspace, dispatch, { type: "stop_poll", message_id: 0 });
    expect(dispatch).toHaveBeenCalledTimes(7);
    expect((await systemEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(7);
  });

  it("dispatches send_media_group requests with their media payload", async () => {
    const { workspace } = await fixture();
    const group = {
      type: "send_media_group",
      media: [
        { type: "photo", media: "/workspace/a.png", caption: "first" },
        { type: "video", media: "b.mp4" },
      ],
    };
    const dispatch = vi.fn(async () => ({ messageId: 7 }));
    await send(workspace, dispatch, group);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...group });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed" },
      { type: "outbox_sent", messageId: 7 },
    ]);
  });

  it("rejects send_media_group requests with fewer than two items or wrong item types", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "send_media_group", media: [{ type: "photo", media: "a.png" }] }, { agent: { followup } });
    await send(workspace, dispatch, { type: "send_media_group", media: [{ type: "document", media: "a.pdf" }, { type: "photo", media: "b.png" }] }, { agent: { followup } });
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    expect(followup).toHaveBeenCalledWith(42, "Send rejected: Outbox request media must be an array of 2 to 10 items. Request: {\"type\":\"send_media_group\",\"media\":[{\"type\":\"photo\",\"media\":\"a.png\"}]}");
    expect(followup).toHaveBeenCalledWith(42, "Send rejected: Outbox request media item type must be photo or video. Request: {\"type\":\"send_media_group\",\"media\":[{\"type\":\"document\",\"media\":\"a.pdf\"},{\"type\":\"photo\",\"media\":\"b.png\"}]}");
    const rejected = (await systemEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toMatchObject({ type: "outbox_rejected", callRef: callRef(), detail: expect.stringContaining("2 to 10 items"), raw: expect.any(String) });
  });

  it("discards structurally invalid sends and notifies the agent", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "send_file", path: "x", kind: "weird" }, { agent: { followup } });
    await send(workspace, dispatch, { type: "send_file", path: 7 }, { agent: { followup } });
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await systemEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([
      { detail: expect.stringContaining("must be auto, photo"), raw: expect.any(String) },
      { detail: expect.stringContaining("must be a non-empty string"), raw: expect.any(String) },
    ]);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
    expect(followup).toHaveBeenCalledWith(42, "Send rejected: Outbox request kind must be auto, photo, audio, video, voice, or document. Request: {\"type\":\"send_file\",\"path\":\"x\",\"kind\":\"weird\"}");
    expect(followup).toHaveBeenCalledWith(42, "Send rejected: Outbox request path must be a non-empty string. Request: {\"type\":\"send_file\",\"path\":7}");
  });

  it("discards oversized sends without delivering them", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "send_file", path: "x".repeat(1024 * 1024) }, { agent: { followup } });
    expect(dispatch).not.toHaveBeenCalled();
    const rejected = (await systemEvents(workspace)).filter((event) => event.type === "outbox_rejected");
    expect(rejected).toMatchObject([{ detail: expect.stringContaining("exceeds 1048576 bytes"), raw: expect.any(String) }]);
    expect(followup).toHaveBeenCalledTimes(1);
  });

  it("notifies the agent when the dispatcher throws, without logging a chat event", async () => {
    const { workspace } = await fixture();
    const followup = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await send(workspace, dispatch, valid(), { agent: { followup } });
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce());
    expect(followup).toHaveBeenCalledWith(42, "Send rejected: upload failed. Request: {\"type\":\"send_file\",\"path\":\"/workspace/report.txt\",\"caption\":\"Report\",\"version\":1}");
    const events = await systemEvents(workspace);
    expect(events).toMatchObject([
      { type: "outbox_claimed", request: { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" } },
      { type: "outbox_rejected", detail: expect.stringContaining("upload failed"), request: { version: 1, type: "send_file", path: "/workspace/report.txt", caption: "Report" } },
    ]);
    await expect(readFile(path.join(workspace, ".tg-bot", "chat.jsonl"), "utf8")).rejects.toThrow();
  });

  it("dispatches an empty reaction array to remove a reaction", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "send_reaction", message_id: 12, reaction: [] });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "send_reaction", message_id: 12, reaction: [] });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed" },
      { type: "outbox_sent" },
    ]);
  });

  it("forwards reaction requests with too many or invalid entries", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, {
      type: "send_reaction", message_id: 3,
      reaction: [
        { type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "🔥" },
      ],
    });
    await send(workspace, dispatch, { type: "send_reaction", message_id: 3, reaction: [{ type: "emoji", emoji: "" }] });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await systemEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("accepts a reaction mixing emoji and custom_emoji entries", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    const request = {
      type: "send_reaction", message_id: 12,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "1234567890123456" }],
    };
    await send(workspace, dispatch, request);
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...request });
    expect(await systemEvents(workspace)).toMatchObject([
      { type: "outbox_claimed" },
      { type: "outbox_sent" },
    ]);
  });

  it("dispatches edit_message and delete_message requests with their fields", async () => {
    const { workspace } = await fixture();
    const edit = {
      type: "edit_message", message_id: 55,
      text: "updated text", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      link_preview_options: { is_disabled: true },
    };
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, edit);
    await send(workspace, dispatch, { type: "delete_message", message_id: 56 });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, ...edit });
    expect(dispatch).toHaveBeenCalledWith(42, { version: 1, type: "delete_message", message_id: 56 });
    expect((await systemEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });

  it("forwards edit_message requests without host-side semantic validation", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, { type: "edit_message", message_id: 7, text: "x".repeat(4_097) });
    await send(workspace, dispatch, { type: "edit_message", message_id: 9 });
    await send(workspace, dispatch, { type: "edit_message", message_id: 9, text: "x", parse_mode: "HTML", entities: [{ type: "bold", offset: 0, length: 1 }] });
    await send(workspace, dispatch, { type: "edit_message", message_id: 9, reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect((await systemEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(4);
  });

  it("forwards send_file requests with unconfined paths to the dispatcher", async () => {
    const { workspace } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, dispatch, valid("/workspace/../outside.txt"));
    await send(workspace, dispatch, valid("/workspace/"));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await systemEvents(workspace)).filter((event) => event.type === "outbox_sent")).toHaveLength(2);
  });
});
