import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as realSetTimeout } from "node:timers";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationAgent, type AgentRef } from "../src/agent-ref.js";
import { AgentEventRouter } from "../src/agent.js";
import { WorkspaceOutbox, type OutboxSendResult, type WorkspaceOutboxOptions } from "../src/outbox.js";
import { WorkspaceTimeline } from "../src/events.js";
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
  const eventsLog = path.join(dataDir, "timeline.jsonl");
  await writeFile(eventsLog, "", "utf8");
  return { dataDir, workspace, eventsLog };
}

async function allowChat(workspace: string, chatId: number | number[]): Promise<void> {
  const ids = Array.isArray(chatId) ? chatId : [chatId];
  await writeFile(path.join(workspace, ".allowed.json"), JSON.stringify(ids), "utf8");
}

async function logEvents(timelinePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(timelinePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function setupOutbox(
  workspace: string,
  eventsLog: string,
  dispatch: WorkspaceOutboxDispatcher,
  options: Partial<WorkspaceOutboxOptions> = {},
): { outbox: WorkspaceOutbox } {
  const timeline = new WorkspaceTimeline(eventsLog);
  const outbox = new WorkspaceOutbox({ workspace, dispatch, timeline, ...options });
  return { outbox };
}

async function send(
  workspace: string,
  eventsLog: string,
  dispatch: WorkspaceOutboxDispatcher,
  request: unknown,
  actor: AgentRef = conversationAgent(42),
  options: Partial<WorkspaceOutboxOptions> = {},
): Promise<OutboxSendResult> {
  return setupOutbox(workspace, eventsLog, dispatch, options).outbox.send(request, actor);
}

function rateLimitError(retryAfter: number): Error {
  return Object.assign(new Error(`Too Many Requests: retry after ${retryAfter}`), {
    error_code: 429,
    parameters: { retry_after: retryAfter },
  });
}

/** Yields to the real event loop until the fake clock has a pending retry timer. */
async function waitForRetryTimer(): Promise<void> {
  for (let attempts = 0; attempts < 500; attempts++) {
    if (vi.getTimerCount() > 0) return;
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for a retry timer to be scheduled");
}

const valid = (filePath = "/workspace/report.txt") => ({
  method: "sendDocument",
  chat_id: 42,
  document: filePath,
  caption: "Report",
});

describe("WorkspaceOutbox", () => {
  it("delivers valid sends, records the completed action, and returns the outcome", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    const result = await send(workspace, eventsLog, dispatch, valid());
    expect(result).toMatchObject({ method: "sendDocument" });
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), valid());
    expect(await logEvents(eventsLog)).toMatchObject([{
      type: "sent",
      requestId: expect.any(String),
      actor: conversationAgent(42),
      target: conversationAgent(42),
      request: valid(),
    }]);
  });

  it("dispatches Bot API requests with their payload fields", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const request = {
      method: "sendMessage",
      chat_id: 42,
      text: "hello <b>world</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 42,
    };
    const dispatch = vi.fn(async () => ({ messageId: 9_001 }));
    expect(await send(workspace, eventsLog, dispatch, request)).toMatchObject({ messageId: 9001, method: "sendMessage" });
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), request);
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "sent", target: conversationAgent(42), messageId: 9001, request: { text: "hello <b>world</b>" } },
    ]);
  });

  it("attaches incidental topic names to the current conversation thread", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => ({ messageId: 9 }));

    await send(workspace, eventsLog, dispatch, { method: "sendMessage", text: "Update", topic_name: "Planning the trip" }, conversationAgent(42, 7));

    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), {
      method: "sendMessage",
      chat_id: 42,
      message_thread_id: 7,
      text: "Update",
      topic_name: "Planning the trip",
    });
    await expect(send(workspace, eventsLog, dispatch, { method: "sendMessage", chat_id: 42, text: "Update", topic_name: "Planning" }))
      .rejects.toThrow("topic_name requires message_thread_id");
  });

  it("dispatches forum topic requests", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, -100);
    const dispatch = vi.fn(async () => ({ messageThreadId: 105, data: { message_thread_id: 105, name: "Japan 2026" } }));
    const create = { method: "createForumTopic", chat_id: -100, name: "Japan 2026" };
    await send(workspace, eventsLog, dispatch, create);
    expect(dispatch).toHaveBeenCalledWith(-100, expect.any(String), create);
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "sent", target: conversationAgent(-100, 105), request: { method: "createForumTopic", name: "Japan 2026" } },
    ]);

    const closeDispatch = vi.fn(async () => ({ messageThreadId: 105 }));
    const close = { method: "closeForumTopic", chat_id: -100, message_thread_id: 105 };
    await send(workspace, eventsLog, closeDispatch, close);
    expect(closeDispatch).toHaveBeenCalledWith(-100, expect.any(String), close);
  });

  it("forwards Bot API payloads without host-side semantic validation", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, { method: "sendMessage", chat_id: 42, text: "x", parse_mode: "Markdown" });
    await send(workspace, eventsLog, dispatch, { method: "sendMessage", chat_id: 42, text: "x", reply_markup: [1] });
    await send(workspace, eventsLog, dispatch, { method: "sendLocation", chat_id: 42, latitude: 91, longitude: 0 });
    await send(workspace, eventsLog, dispatch, { method: "sendPoll", chat_id: 42, question: "q", options: ["only"] });
    await send(workspace, eventsLog, dispatch, { method: "setMessageReaction", chat_id: 42, message_id: 3, reaction: [{ type: "custom_emoji", custom_emoji_id: "" }] });
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "sent")).toHaveLength(5);
  });

  it("records response identifiers from raw Bot API results", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const location = { method: "sendLocation", chat_id: 42, latitude: 52.52, longitude: 13.405 };
    const poll = { method: "sendPoll", chat_id: 42, question: "Pick one", options: ["a", "b", "c"] };
    const dispatch = vi.fn(async (_chatId: number, _requestId: string, request: WorkspaceOutboxRequest) => {
      if (request.method === "sendLocation") return { messageId: 301 };
      if (request.method === "sendPoll") return { messageId: 302, pollId: "poll-abc" };
      return undefined;
    });
    await send(workspace, eventsLog, dispatch, location);
    expect(await send(workspace, eventsLog, dispatch, poll)).toMatchObject({ pollId: "poll-abc", messageId: 302 });
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), location);
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), poll);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "sent")).toMatchObject([
      { messageId: 301 },
      { messageId: 302, pollId: "poll-abc" },
    ]);
  });

  it("dispatches sendMediaGroup requests with their media payload", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const group = {
      method: "sendMediaGroup",
      chat_id: 42,
      media: [
        { type: "photo", media: "/workspace/a.png", caption: "first" },
        { type: "video", media: "b.mp4" },
      ],
    };
    const dispatch = vi.fn(async () => ({ messageId: 7 }));
    await send(workspace, eventsLog, dispatch, group);
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), group);
    expect(await logEvents(eventsLog)).toMatchObject([
      { type: "sent", target: conversationAgent(42), messageId: 7 },
    ]);
  });

  it("discards structurally invalid sends", async () => {
    const { workspace, eventsLog } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, { chat_id: 42, text: "missing method" }))
      .rejects.toThrow("Unsupported Telegram Bot API method: undefined");
    await expect(send(workspace, eventsLog, dispatch, "not-an-object"))
      .rejects.toThrow("must be a JSON object");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await logEvents(eventsLog)).toEqual([]);
  });

  it("discards oversized sends without delivering them", async () => {
    const { workspace, eventsLog } = await fixture();
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, { method: "sendMessage", chat_id: 42, text: "🙂".repeat(262_145) }))
      .rejects.toThrow("exceeds 1048576 bytes");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await logEvents(eventsLog)).toEqual([]);
  });

  it("does not add failed dispatches to the shared timeline", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => { throw new Error("upload failed"); });
    await expect(send(workspace, eventsLog, dispatch, valid())).rejects.toThrow("upload failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await logEvents(eventsLog)).toEqual([]);
  });

  it("does not add thread-targeted dispatch failures to the shared timeline", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => { throw new Error("topic upload failed"); });
    await expect(send(workspace, eventsLog, dispatch, { ...valid(), message_thread_id: 1234 })).rejects.toThrow("topic upload failed");
    expect(await logEvents(eventsLog)).toEqual([]);
  });

  it("dispatches message mutations and unconfined upload paths to the dispatcher", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    const reaction = { method: "setMessageReaction", chat_id: 42, message_id: 12, reaction: [] };
    const edit = {
      method: "editMessageText",
      chat_id: 42,
      message_id: 55,
      text: "updated text",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    };
    await send(workspace, eventsLog, dispatch, reaction);
    await send(workspace, eventsLog, dispatch, edit);
    await send(workspace, eventsLog, dispatch, { method: "deleteMessage", chat_id: 42, message_id: 56 });
    await send(workspace, eventsLog, dispatch, valid("/workspace/../outside.txt"));
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), reaction);
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), edit);
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect((await logEvents(eventsLog)).filter((event) => event.type === "sent")).toHaveLength(4);
  });

  it("rejects sends to chats not on the allow list", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 99);
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, valid())).rejects.toThrow("Chat 42 is not on the allow list");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await logEvents(eventsLog)).toEqual([]);
  });

  it("defaults conversation targets and requires explicit task targets", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => undefined);
    await send(workspace, eventsLog, dispatch, { method: "sendMessage", text: "hi" }, conversationAgent(42, 7));
    expect(dispatch).toHaveBeenCalledWith(42, expect.any(String), { method: "sendMessage", chat_id: 42, message_thread_id: 7, text: "hi" });
    await expect(send(workspace, eventsLog, dispatch, { method: "sendMessage", text: "hi" }, { kind: "task", runId: "run-1" }))
      .rejects.toThrow("chat_id is required");
    await expect(send(workspace, eventsLog, dispatch, { method: "sendMessage", chat_id: 1.5, text: "hi" }))
      .rejects.toThrow("chat_id must be a safe integer");
  });

  it("fails closed when allowed.json is malformed", async () => {
    const { workspace, eventsLog } = await fixture();
    await writeFile(path.join(workspace, ".allowed.json"), "{ not valid json", "utf8");
    const dispatch = vi.fn(async () => undefined);
    await expect(send(workspace, eventsLog, dispatch, valid())).rejects.toThrow("Chat 42 is not on the allow list");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await logEvents(eventsLog)).toEqual([]);
  });

  it("records the authenticated actor and resolved target only for successful sends", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const dispatch = vi.fn(async () => ({ messageId: 999 }));
    const actor = conversationAgent(42, 100);

    await send(workspace, eventsLog, dispatch, valid(), actor);
    await expect(send(workspace, eventsLog, dispatch, { method: "sendMessage", chat_id: 999, text: "blocked" }, actor))
      .rejects.toThrow("not on the allow list");

    expect(await logEvents(eventsLog)).toMatchObject([{
      type: "sent",
      actor,
      target: conversationAgent(42),
      request: { chat_id: 42 },
    }]);
  });

  it("wakes the responsible conversation after a task writes to it", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    const timeline = new WorkspaceTimeline(eventsLog);
    const followup = vi.fn(async () => undefined);
    const router = new AgentEventRouter({ followup, interrupt: vi.fn(async () => undefined) });
    timeline.subscribe((record, rawLine) => router.onEvent(record, rawLine));
    const outbox = new WorkspaceOutbox({ workspace, timeline, dispatch: vi.fn(async () => ({ messageId: 100 })) });

    await outbox.send({ method: "sendMessage", chat_id: 42, message_thread_id: 7, text: "task result" }, { kind: "task", runId: "run-1" });

    expect(followup).toHaveBeenCalledWith(expect.stringContaining("task result"), conversationAgent(42, 7));
  });

  it("retries on 429 and emits a single outbox_sent once a retry succeeds", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn<WorkspaceOutboxDispatcher>()
        .mockRejectedValueOnce(rateLimitError(5))
        .mockRejectedValueOnce(rateLimitError(1))
        .mockResolvedValueOnce({ messageId: 9001 });
      const pending = send(workspace, eventsLog, dispatch, valid());
      await waitForRetryTimer();
      await vi.advanceTimersByTimeAsync(5_100);
      await waitForRetryTimer();
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(pending).resolves.toMatchObject({ messageId: 9001, method: "sendDocument" });
      expect(dispatch).toHaveBeenCalledTimes(3);
      const events = await logEvents(eventsLog);
      expect(events.filter((e) => e.type === "sent")).toHaveLength(1);
      expect(events.filter((e) => e.type === "outbox_rejected")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record a failed rate-limited send", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn<WorkspaceOutboxDispatcher>().mockRejectedValue(rateLimitError(5));
      const pending = send(workspace, eventsLog, dispatch, valid());
      const rejection = expect(pending).rejects.toThrow("Too Many Requests");
      await waitForRetryTimer();
      await vi.advanceTimersByTimeAsync(5_100);
      await waitForRetryTimer();
      await vi.advanceTimersByTimeAsync(5_100);
      await rejection;
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(await logEvents(eventsLog)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the retry_after backoff at 60 seconds per retry", async () => {
    const { workspace, eventsLog } = await fixture();
    await allowChat(workspace, 42);
    vi.useFakeTimers();
    try {
      const delays: number[] = [];
      const fakeSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, ms?: number) => {
        if (ms !== undefined) delays.push(ms);
        return fakeSetTimeout(callback, ms);
      }) as typeof setTimeout);
      const dispatch = vi.fn<WorkspaceOutboxDispatcher>().mockRejectedValue(rateLimitError(300));
      const pending = send(workspace, eventsLog, dispatch, valid());
      const rejection = expect(pending).rejects.toThrow("Too Many Requests");
      await waitForRetryTimer();
      await vi.advanceTimersByTimeAsync(61_000);
      await waitForRetryTimer();
      await vi.advanceTimersByTimeAsync(61_000);
      await rejection;
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(delays).toEqual([60_000, 60_000]);
    } finally {
      vi.useRealTimers();
    }
  });

});