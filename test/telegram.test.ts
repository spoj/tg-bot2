import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as realSetTimeout } from "node:timers";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { InputFile, type Bot } from "grammy";
import { AgentEventRouter } from "../src/agent-router.js";
import { ConnectorRegistry } from "../src/connector.js";
import type { TelegramConnectorConfig } from "../src/config.js";
import { WorkspaceTimeline } from "../src/events.js";
import { WorkspaceResources } from "../src/resource-state.js";
import { TelegramConnector } from "../src/telegram-connector.js";
import { telegramConversation } from "../src/telegram-ref.js";
import {
  attachmentSource,
  dispatchOutboxRequest,
  isBotGroupAdd,
  isMessageDirectedToBot,
  registerBotCommands,
  TelegramDeliveryQueue,
} from "../src/telegram.js";
import { connectorPathSegment, workspacePaths, type WorkspacePaths } from "../src/util.js";

const CONNECTOR_ID = "telegram:999";
const WORKSPACE_ID = "primary";
const ATTACHMENT_PREFIX = connectorPathSegment(CONNECTOR_ID);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function connectorConfig(dataDir: string): TelegramConnectorConfig {
  const paths = workspacePaths(dataDir, WORKSPACE_ID);
  return {
    type: "telegram",
    id: CONNECTOR_ID,
    token: "999:test-token",
    botId: 999,
    workspaceId: WORKSPACE_ID,
    dataDir,
    workspace: paths.workspace,
    attachments: path.join(paths.attachments, ATTACHMENT_PREFIX),
    attachmentPrefix: ATTACHMENT_PREFIX,
  };
}

async function writeAllowedChats(config: TelegramConnectorConfig, chatIds: number[]): Promise<void> {
  await mkdir(config.workspace, { recursive: true });
  await writeFile(path.join(config.workspace, ".allowed.json"), `${JSON.stringify(chatIds, null, 2)}\n`, "utf8");
}

type TelegramFixture = {
  dataDir: string;
  paths: WorkspacePaths;
  config: TelegramConnectorConfig;
  timeline: WorkspaceTimeline;
  resources: WorkspaceResources;
  connector: TelegramConnector;
  bot: Bot;
  interrupt: Mock;
  followup: Mock;
  restartAll: Mock;
  requests: Array<{ url: string; body: string }>;
};

async function fixture(options: { allowed?: number[]; fetchResult?: unknown; responses?: Array<Record<string, unknown>> } = {}): Promise<TelegramFixture> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-connector-"));
  temporaryDirectories.push(dataDir);
  const paths = workspacePaths(dataDir, WORKSPACE_ID);
  const config = connectorConfig(dataDir);
  await mkdir(config.attachments, { recursive: true });
  await writeAllowedChats(config, options.allowed ?? [42]);
  await writeFile(paths.timeline, "", "utf8");
  const timeline = new WorkspaceTimeline(paths.timeline);
  await timeline.start();
  const resources = new WorkspaceResources(paths.resources);
  await resources.start();
  const connector = new TelegramConnector(config, timeline, resources);
  const restartAll = vi.fn(async () => undefined);
  connector.setAgent({ restartAll });
  const connectors = new ConnectorRegistry();
  connectors.register(connector);
  const interrupt = vi.fn(async () => undefined);
  const followup = vi.fn(async () => undefined);
  const router = new AgentEventRouter(
    { interrupt, followup },
    { workspace: config.workspace, connectors },
  );
  timeline.subscribe((record, rawLine) => router.onEvent(record, rawLine));
  const requests: Array<{ url: string; body: string }> = [];
  connector.bot.api.config.use(async (_previous, method, payload) => {
    requests.push({ url: `/${method}`, body: JSON.stringify(payload) });
    return (options.responses?.shift() ?? { ok: true, result: options.fetchResult ?? {} }) as never;
  });
  (connector.bot as unknown as { botInfo: unknown }).botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
  };
  return { dataDir, paths, config, timeline, resources, connector, bot: connector.bot, interrupt, followup, restartAll, requests };
}

async function timelineEvents(paths: WorkspacePaths): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(paths.timeline, "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForInterrupt(interrupt: Mock, calls: number): Promise<void> {
  await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(calls));
}

function interruptEnvelope(interrupt: Mock, call = 0): Record<string, unknown> {
  return JSON.parse(interrupt.mock.calls[call]?.[0] as string) as Record<string, unknown>;
}

function messageUpdate(chatId: number, text = "hello", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: chatId, type: chatId > 0 ? "private" : "group", title: chatId > 0 ? undefined : "Work" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text,
      ...extra,
    },
  };
}


async function waitForRetryTimer(): Promise<void> {
  for (let attempts = 0; attempts < 500; attempts++) {
    if (vi.getTimerCount() > 0) return;
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for Telegram retry timer");
}

function fakeBot() {
  const raw = {
    sendMessage: vi.fn(async () => ({ message_id: 123 })),
    sendDocument: vi.fn(async () => ({ message_id: 123 })),
    editForumTopic: vi.fn(async () => true),
  };
  return { api: { raw } } as unknown as Bot;
}

describe("Telegram identity and attachment source", () => {
  const base = { message_id: 1, date: 1_700_000_000, chat: { id: 42, type: "private" } };
  const file = { file_id: "f-1", file_size: 10, mime_type: "custom/x", file_name: "orig.bin" };
  const cases: Array<{ name: string; message: Record<string, unknown>; expected: Record<string, unknown> }> = [
    { name: "animation", message: { animation: file }, expected: { type: "animation", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "audio", message: { audio: file }, expected: { type: "audio", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "document", message: { document: file }, expected: { type: "document", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "photo", message: { photo: [{ file_id: "small", file_size: 5 }, { file_id: "large", file_size: 20 }] }, expected: { type: "photo", fileId: "large", mimeType: "image/jpeg" } },
    { name: "sticker", message: { sticker: { file_id: "sticker", is_video: true } }, expected: { type: "sticker", fileId: "sticker", mimeType: "video/webm" } },
    { name: "video", message: { video: file }, expected: { type: "video", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "voice", message: { voice: file }, expected: { type: "voice", fileId: "f-1", mimeType: "custom/x" } },
  ];

  for (const testCase of cases) {
    it(`selects the ${testCase.name} attachment`, () => {
      expect(attachmentSource({ ...base, ...testCase.message } as never)).toMatchObject(testCase.expected);
    });
  }

  it("uses a connector-scoped generic conversation identity", () => {
    expect(telegramConversation(CONNECTOR_ID, -100, 7)).toEqual({
      kind: "conversation",
      connectorId: CONNECTOR_ID,
      conversationKey: "-100:7",
      address: { chat_id: -100, message_thread_id: 7 },
    });
  });
});

describe("TelegramDeliveryQueue", () => {
  it("serializes one chat while allowing another chat to proceed", async () => {
    const queue = new TelegramDeliveryQueue();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue(1, async () => {
      order.push("one:start");
      await blocked;
      order.push("one:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["one:start"]));
    const second = queue.enqueue(1, () => { order.push("one:second"); });
    await queue.enqueue(2, () => { order.push("two"); });
    expect(order).toEqual(["one:start", "two"]);
    release();
    await Promise.all([first, second, queue.drain()]);
    expect(order).toEqual(["one:start", "two", "one:end", "one:second"]);
  });

  it("continues after a rejected operation", async () => {
    const queue = new TelegramDeliveryQueue();
    const failed = queue.enqueue(3, () => { throw new Error("failed"); });
    const next = queue.enqueue(3, () => "delivered");
    await expect(failed).rejects.toThrow("failed");
    await expect(next).resolves.toBe("delivered");
  });
});

describe("raw Telegram Bot API dispatch", () => {
  it("passes connector-native payload fields through unchanged", async () => {
    const test = await fixture();
    const bot = fakeBot();
    const replyMarkup = { keyboard: [[{ text: "Share location", request_location: true }]], resize_keyboard: true };

    await dispatchOutboxRequest(bot, test.config, 42, "req-1", {
      method: "sendMessage",
      chat_id: 42,
      text: "Where are you?",
      reply_markup: replyMarkup,
      protect_content: true,
    });

    expect(bot.api.raw.sendMessage).toHaveBeenCalledWith({
      chat_id: 42,
      text: "Where are you?",
      reply_markup: replyMarkup,
      protect_content: true,
    });
  });

  it("stages workspace uploads under the connector-prefixed attachment mount", async () => {
    const test = await fixture();
    await writeFile(path.join(test.config.workspace, "report.txt"), "report", "utf8");
    const bot = fakeBot();

    const result = await dispatchOutboxRequest(bot, test.config, 42, "req-file", {
      method: "sendDocument",
      chat_id: 42,
      document: "/workspace/report.txt",
      caption: "Report",
    });

    const managed = result.request?.document;
    expect(managed).toMatch(new RegExp(`^/run/attachments/${ATTACHMENT_PREFIX}/42/\\d{4}-\\d{2}-\\d{2}/req-file/report\\.txt$`));
    expect(result.attachmentPaths).toEqual([managed]);
    const relative = String(managed).slice(`/run/attachments/${ATTACHMENT_PREFIX}/`.length);
    expect(await readFile(path.join(test.config.attachments, relative), "utf8")).toBe("report");
    expect(bot.api.raw.sendDocument).toHaveBeenCalledWith({ chat_id: 42, document: expect.any(InputFile), caption: "Report" });
  });

  it("resolves connector-managed paths without duplicating their prefix", async () => {
    const test = await fixture();
    const relative = path.join("42", "2024-01-02", "7", "managed.txt");
    await mkdir(path.dirname(path.join(test.config.attachments, relative)), { recursive: true });
    await writeFile(path.join(test.config.attachments, relative), "managed", "utf8");
    const managed = `/run/attachments/${ATTACHMENT_PREFIX}/${relative.split(path.sep).join("/")}`;

    const result = await dispatchOutboxRequest(fakeBot(), test.config, 42, "req-managed", {
      method: "sendDocument",
      chat_id: 42,
      document: managed,
    });

    expect(result.request?.document).toBe(managed);
    expect(result.attachmentPaths).toEqual([managed]);
  });

  it("removes staged workspace uploads when Telegram rejects delivery", async () => {
    const test = await fixture();
    await writeFile(path.join(test.config.workspace, "report.txt"), "report", "utf8");
    const sendDocument = vi.fn(async () => { throw new Error("Telegram rejected the document"); });
    const bot = { api: { raw: { sendDocument } } } as unknown as Bot;

    await expect(dispatchOutboxRequest(bot, test.config, 42, "req-failed", {
      method: "sendDocument",
      chat_id: 42,
      document: "/workspace/report.txt",
    })).rejects.toThrow("Telegram rejected the document");

    const chatAttachments = path.join(test.config.attachments, "42");
    const files = await readdir(chatAttachments, { recursive: true });
    expect(files.some((file) => file.endsWith("report.txt"))).toBe(false);
  });

  it("limits attachment storage per chat by removing the oldest files", async () => {
    const test = await fixture();
    const oldFiles: string[] = [];
    for (let index = 0; index < 4; index++) {
      const filePath = path.join(test.config.attachments, "42", "2020-01-01", String(index), "old.bin");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "", "utf8");
      await truncate(filePath, 2 * 1024 * 1024 * 1024);
      const old = new Date(Date.UTC(2020, 0, index + 1));
      await utimes(filePath, old, old);
      oldFiles.push(filePath);
    }
    await writeFile(path.join(test.config.workspace, "report.txt"), "report", "utf8");

    await dispatchOutboxRequest(fakeBot(), test.config, 42, "req-quota", {
      method: "sendDocument",
      chat_id: 42,
      document: "/workspace/report.txt",
    });

    await expect(stat(oldFiles[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(oldFiles[3]!)).resolves.toMatchObject({ size: 2 * 1024 * 1024 * 1024 });
  });

  it("rejects symlinked intermediate workspace paths", async () => {
    const test = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "telegram-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(test.config.workspace, "linked"), "dir");

    await expect(dispatchOutboxRequest(fakeBot(), test.config, 42, "req-link", {
      method: "sendDocument",
      chat_id: 42,
      document: "/workspace/linked/secret.txt",
    })).rejects.toThrow();
  });

  it("rejects local files outside the workspace", async () => {
    const test = await fixture();
    await expect(dispatchOutboxRequest(fakeBot(), test.config, 42, "req-bad", {
      method: "sendDocument",
      chat_id: 42,
      document: "/etc/passwd",
    })).rejects.toThrow("under /workspace");
  });
});

describe("TelegramConnector send", () => {
  it("owns target derivation, allowlist enforcement, and response resources", async () => {
    const test = await fixture({ fetchResult: { message_id: 9001 } });
    const owner = telegramConversation(CONNECTOR_ID, 42, 7);

    const result = await test.connector.send({ method: "sendMessage", text: "hello" }, owner);

    expect(JSON.parse(test.requests.find((request) => request.url.endsWith("/sendMessage"))!.body)).toEqual({ chat_id: 42, message_thread_id: 7, text: "hello" });
    expect(result).toMatchObject({
      request: { method: "sendMessage", chat_id: 42, message_thread_id: 7, text: "hello" },
      response: { message_id: 9001 },
      summary: { method: "sendMessage", messageId: 9001 },
    });
    expect(test.resources.owner(CONNECTOR_ID, "message", "42:9001")).toEqual(owner);
  });

  it("rejects cross-conversation and unlisted sends before delivery", async () => {
    const test = await fixture({ allowed: [42], fetchResult: { message_id: 1 } });
    const owner = telegramConversation(CONNECTOR_ID, 42, 7);

    await expect(test.connector.send({ method: "sendMessage", chat_id: 99, text: "no" }, owner))
      .rejects.toThrow("cannot target another conversation's chat");
    await expect(test.connector.send({ method: "sendMessage", message_thread_id: 8, text: "no" }, owner))
      .rejects.toThrow("cannot target another conversation's thread");
    await expect(test.connector.send({ method: "sendMessage", text: "no" }, telegramConversation(CONNECTOR_ID, 99)))
      .rejects.toThrow("Chat 99 is not on the allow list");
    expect(test.requests).toHaveLength(0);
  });

  it("allows mutations only for connector resources owned by the conversation", async () => {
    const test = await fixture({ fetchResult: { message_id: 55 } });
    const owner = telegramConversation(CONNECTOR_ID, 42, 7);
    const otherThread = telegramConversation(CONNECTOR_ID, 42, 8);
    await test.resources.set({ connectorId: CONNECTOR_ID, kind: "message", key: "42:55", owner });
    await test.resources.set({ connectorId: CONNECTOR_ID, kind: "message", key: "42:99", owner: otherThread });

    await test.connector.send({ method: "editMessageText", message_id: 55, text: "updated" }, owner);
    await expect(test.connector.send({ method: "deleteMessage", message_id: 99 }, owner))
      .rejects.toThrow("Message 99 is not owned by this conversation");
    await expect(test.connector.send({ method: "editMessageText", inline_message_id: "inline", text: "x" }, owner))
      .rejects.toThrow("requires an owned message_id");
    expect(test.requests.filter((request) => request.url.endsWith("/editMessageText"))).toHaveLength(1);
  });

  it("omits forum thread targets from methods that do not accept them", async () => {
    const test = await fixture();
    const owner = telegramConversation(CONNECTOR_ID, 42, 7);
    const mutations = [
      "editMessageText", "editMessageCaption", "editMessageReplyMarkup", "deleteMessage", "setMessageReaction", "stopPoll",
    ] as const;
    for (const [index, method] of mutations.entries()) {
      await test.resources.set({ connectorId: CONNECTOR_ID, kind: "message", key: `42:${100 + index}`, owner });
      await test.connector.send({
        method,
        message_id: 100 + index,
        ...(method === "editMessageText" ? { text: "updated" } : {}),
        ...(method === "editMessageCaption" ? { caption: "updated" } : {}),
        ...(method === "setMessageReaction" ? { reaction: [] } : {}),
      }, owner);
    }
    await test.connector.send({ method: "createForumTopic", name: "new topic", message_thread_id: 7 }, owner);

    for (const request of test.requests.filter((request) => mutations.some((method) => request.url.endsWith(`/${method}`)) || request.url.endsWith("/createForumTopic"))) {
      expect(JSON.parse(request.body)).not.toHaveProperty("message_thread_id");
    }
  });

  it("returns and owns every message from a media group", async () => {
    const test = await fixture({
      responses: [{ ok: true, result: [{ message_id: 9101 }, { message_id: 9102 }, { message_id: 9103 }] }],
    });
    const owner = telegramConversation(CONNECTOR_ID, 42, 7);

    const result = await test.connector.send({
      method: "sendMediaGroup",
      media: [
        { type: "photo", media: "telegram-file-1" },
        { type: "photo", media: "telegram-file-2" },
        { type: "video", media: "telegram-file-3" },
      ],
    }, owner);

    expect(result).toMatchObject({
      response: [{ message_id: 9101 }, { message_id: 9102 }, { message_id: 9103 }],
      summary: { method: "sendMediaGroup", messageIds: [9101, 9102, 9103] },
    });
    for (const messageId of [9101, 9102, 9103]) {
      expect(test.resources.owner(CONNECTOR_ID, "message", `42:${messageId}`)).toEqual(owner);
    }
  });

  it("reports uncertain delivery when ownership persistence fails after Telegram accepts a send", async () => {
    const test = await fixture({ fetchResult: { message_id: 9104 } });
    vi.spyOn(test.resources, "setMany").mockRejectedValue(new Error("resource state unavailable"));

    const result = await test.connector.send({ method: "sendMessage", text: "delivered" }, telegramConversation(CONNECTOR_ID, 42));

    expect(result).toMatchObject({
      summary: {
        uncertain: true,
        deliveryStatus: "delivered_persistence_failed",
        persistenceError: expect.stringContaining("resource state unavailable"),
      },
    });
    expect(test.requests.filter((request) => request.url.endsWith("/sendMessage"))).toHaveLength(1);
  });

  it("retries Telegram rate limits and returns one successful result", async () => {
    const test = await fixture({
      responses: [
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } },
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } },
        { ok: true, result: { message_id: 9001 } },
      ],
    });
    vi.useFakeTimers();

    const pending = test.connector.send({ method: "sendMessage", text: "hello" }, telegramConversation(CONNECTOR_ID, 42));
    await waitForRetryTimer();
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForRetryTimer();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({ summary: { messageId: 9001 } });
    expect(test.requests.filter((request) => request.url.endsWith("/sendMessage"))).toHaveLength(3);
  });

  it("rechecks the allowlist when a send leaves the per-chat queue", async () => {
    const test = await fixture();
    let release!: () => void;
    let started = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = test.connector.delivery.enqueue(42, async () => {
      started = true;
      await blocked;
    });
    const pending = test.connector.send({ method: "sendMessage", text: "queued" }, telegramConversation(CONNECTOR_ID, 42));

    await vi.waitFor(() => expect(started).toBe(true));
    await vi.waitFor(() => expect(test.requests).toHaveLength(0));
    await writeAllowedChats(test.config, []);
    release();

    await first;
    await expect(pending).rejects.toThrow("Chat 42 is not on the allow list");
    expect(test.requests).toHaveLength(0);
  });

  it("rechecks the allowlist before a rate-limit retry", async () => {
    const test = await fixture({
      responses: [
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } },
        { ok: true, result: { message_id: 9002 } },
      ],
    });
    vi.useFakeTimers();

    const pending = test.connector.send({ method: "sendMessage", text: "retry" }, telegramConversation(CONNECTOR_ID, 42));
    await waitForRetryTimer();
    await writeAllowedChats(test.config, []);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).rejects.toThrow("Chat 42 is not on the allow list");
    expect(test.requests.filter((request) => request.url.endsWith("/sendMessage"))).toHaveLength(1);
  });
  it("keeps later same-chat sends behind retry backoff and drains sleeping retries", async () => {
    const test = await fixture({
      responses: [
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } },
        { ok: true, result: { message_id: 9201 } },
        { ok: true, result: { message_id: 9202 } },
      ],
    });
    vi.useFakeTimers();

    const first = test.connector.send({ method: "sendMessage", text: "first" }, telegramConversation(CONNECTOR_ID, 42));
    await waitForRetryTimer();
    const second = test.connector.send({ method: "sendMessage", text: "second" }, telegramConversation(CONNECTOR_ID, 42));
    for (let attempts = 0; attempts < 10; attempts++) await Promise.resolve();
    expect(test.requests.filter((request) => request.url.endsWith("/sendMessage"))).toHaveLength(1);

    let drained = false;
    const drain = test.connector.delivery.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toMatchObject({ summary: { messageId: 9201 } });
    await expect(second).resolves.toMatchObject({ summary: { messageId: 9202 } });
    await drain;
    expect(drained).toBe(true);
    expect(test.requests.filter((request) => request.url.endsWith("/sendMessage"))).toHaveLength(3);
  });
});

describe("Telegram ingress and native event preservation", () => {
  it("persists a timeline v2 message envelope and routes the exact native event", async () => {
    const test = await fixture();
    await test.bot.handleUpdate(messageUpdate(42, "hello") as never);
    await waitForInterrupt(test.interrupt, 1);

    const [event] = await timelineEvents(test.paths);
    expect(event).toMatchObject({
      v: 2,
      id: expect.any(String),
      seq: 1,
      t: expect.any(String),
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: telegramConversation(CONNECTOR_ID, 42),
      payload: { message_id: 7, text: "hello", from: { id: 42, first_name: "Alice" } },
      attachments: [],
      meta: { private: true, directed: false, user_content: true },
    });
    expect(interruptEnvelope(test.interrupt)).toEqual(event);
    expect(test.resources.owner(CONNECTOR_ID, "message", "42:7")).toEqual(telegramConversation(CONNECTOR_ID, 42));
  });

  it("persists channel posts and edited channel posts through message ingestion", async () => {
    const test = await fixture({ allowed: [-100] });
    await test.bot.handleUpdate({
      update_id: 30,
      channel_post: {
        message_id: 300,
        date: 1_700_000_000,
        chat: { id: -100, type: "channel", title: "News" },
        sender_chat: { id: -100, type: "channel", title: "News" },
        text: "channel post",
      },
    } as never);
    await test.bot.handleUpdate({
      update_id: 31,
      edited_channel_post: {
        message_id: 300,
        date: 1_700_000_000,
        edit_date: 1_700_000_100,
        chat: { id: -100, type: "channel", title: "News" },
        sender_chat: { id: -100, type: "channel", title: "News" },
        text: "edited channel post",
      },
    } as never);

    expect(await timelineEvents(test.paths)).toMatchObject([
      { type: "telegram.message", conversation: telegramConversation(CONNECTOR_ID, -100), payload: { message_id: 300, text: "channel post" } },
      { type: "telegram.edited_message", conversation: telegramConversation(CONNECTOR_ID, -100), payload: { message_id: 300, text: "edited channel post" } },
    ]);
    expect(test.resources.owner(CONNECTOR_ID, "message", "-100:300")).toEqual(telegramConversation(CONNECTOR_ID, -100));
  });

  it("preserves edited messages, callbacks, reactions, membership, and join requests as native payloads", async () => {
    const test = await fixture();
    await test.bot.handleUpdate({
      update_id: 2,
      edited_message: {
        message_id: 8,
        date: 1_700_000_000,
        edit_date: 1_700_000_050,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "edited",
      },
    } as never);
    await test.bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: { id: 42, is_bot: false, first_name: "Alice" },
        message: { message_id: 8, date: 1_700_000_000, chat: { id: 42, type: "private" } },
        chat_instance: "instance",
        data: "approve",
      },
    } as never);
    await test.bot.handleUpdate({
      update_id: 4,
      message_reaction: {
        chat: { id: 42, type: "private" },
        message_id: 8,
        user: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1_700_000_100,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    } as never);
    await test.bot.handleUpdate({
      update_id: 5,
      my_chat_member: {
        chat: { id: 42, type: "group", title: "Work" },
        from: { id: 42, is_bot: false, first_name: "Admin" },
        date: 1_700_000_200,
        old_chat_member: { status: "member", user: { id: 999, is_bot: true, first_name: "Bot" } },
        new_chat_member: { status: "administrator", user: { id: 999, is_bot: true, first_name: "Bot" } },
      },
    } as never);
    await test.bot.handleUpdate({
      update_id: 6,
      chat_join_request: {
        chat: { id: 42, type: "supergroup", title: "Work" },
        from: { id: 123, is_bot: false, first_name: "New User" },
        user_chat_id: 123,
        date: 1_700_000_300,
      },
    } as never);
    await waitForInterrupt(test.interrupt, 1);

    expect(await timelineEvents(test.paths)).toMatchObject([
      { type: "telegram.edited_message", connectorId: CONNECTOR_ID, conversation: telegramConversation(CONNECTOR_ID, 42), payload: { message_id: 8, text: "edited" } },
      { type: "telegram.callback", connectorId: CONNECTOR_ID, conversation: telegramConversation(CONNECTOR_ID, 42), payload: { id: "cb-1", data: "approve", message: { message_id: 8 } } },
      { type: "telegram.message_reaction", connectorId: CONNECTOR_ID, conversation: telegramConversation(CONNECTOR_ID, 42), payload: { message_id: 8, new_reaction: [{ emoji: "👍" }] } },
      { type: "telegram.my_chat_member", connectorId: CONNECTOR_ID, conversation: telegramConversation(CONNECTOR_ID, 42), payload: { new_chat_member: { status: "administrator" } } },
      { type: "telegram.chat_join_request", connectorId: CONNECTOR_ID, conversation: telegramConversation(CONNECTOR_ID, 42), payload: { user_chat_id: 123, from: { id: 123 } } },
    ]);
    expect(interruptEnvelope(test.interrupt)).toMatchObject({ type: "telegram.callback", payload: { data: "approve" } });
  });

  it("drops unauthorized updates and records one sanitized event per source and type", async () => {
    for (const mode of ["missing", "malformed", "unlisted"] as const) {
      const test = await fixture({ allowed: [42] });
      if (mode === "missing") await rm(path.join(test.config.workspace, ".allowed.json"));
      if (mode === "malformed") await writeFile(path.join(test.config.workspace, ".allowed.json"), "{ bad json\n", "utf8");
      const chatId = mode === "unlisted" ? 99 : 42;
      await test.bot.handleUpdate(messageUpdate(chatId, "secret content") as never);
      await test.bot.handleUpdate(messageUpdate(chatId, "different secret", { message_id: 8 }) as never);

      expect(test.interrupt).not.toHaveBeenCalled();
      const events = await timelineEvents(test.paths);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "telegram.access_request",
        connectorId: CONNECTOR_ID,
        payload: {
          reason: mode === "unlisted" ? "chat_not_allowed" : `allowlist_${mode}`,
          update_type: "message",
          chat: { id: chatId, type: "private" },
          requester: { id: 42, first_name: "Alice" },
        },
      });
      expect(events[0]).not.toHaveProperty("conversation");
      expect(JSON.stringify(events[0])).not.toContain("secret content");
      expect(JSON.stringify(events[0])).not.toContain("different secret");
    }
  });
  it("allows a later rejection event after an allowlist add and removal", async () => {
    const test = await fixture({ allowed: [42] });
    await test.bot.handleUpdate(messageUpdate(99, "first rejection") as never);
    await writeAllowedChats(test.config, [42, 99]);
    await test.bot.handleUpdate(messageUpdate(99, "now allowed", { message_id: 8 }) as never);
    await writeAllowedChats(test.config, [42]);
    await test.bot.handleUpdate(messageUpdate(99, "second rejection", { message_id: 9 }) as never);

    const events = await timelineEvents(test.paths);
    const accessRequests = events.filter((event) => event.type === "telegram.access_request");
    expect(accessRequests).toHaveLength(2);
    expect(accessRequests.map((event) => (event.payload as Record<string, unknown>).reason)).toEqual(["chat_not_allowed", "chat_not_allowed"]);
  });
  it("attributes forum reactions to the reacted message owner", async () => {
    const test = await fixture({ allowed: [-100] });
    const owner = telegramConversation(CONNECTOR_ID, -100, 77);
    await test.resources.set({ connectorId: CONNECTOR_ID, kind: "message", key: "-100:88", owner });

    await test.bot.handleUpdate({
      update_id: 8,
      message_reaction: {
        chat: { id: -100, type: "supergroup", title: "Work" },
        message_id: 88,
        user: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1_700_000_100,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    } as never);

    expect(await timelineEvents(test.paths)).toMatchObject([{
      type: "telegram.message_reaction",
      conversation: owner,
      payload: { message_id: 88 },
    }]);
  });

  it("retains an unlisted group identity without retaining its sender or message", async () => {
    const test = await fixture({ allowed: [42] });
    await test.bot.handleUpdate(messageUpdate(-100, "private group content") as never);

    const events = await timelineEvents(test.paths);
    expect(events).toMatchObject([{
      type: "telegram.access_request",
      connectorId: CONNECTOR_ID,
      payload: {
        reason: "chat_not_allowed",
        update_type: "message",
        chat: { id: -100, type: "group", title: "Work" },
      },
    }]);
    expect((events[0]?.payload as Record<string, unknown>)).not.toHaveProperty("requester");
    expect(JSON.stringify(events)).not.toContain("private group content");
    expect(JSON.stringify(events)).not.toContain("Alice");
  });

  it("records ambient group messages silently and interrupts for mentions and direct replies", async () => {
    const test = await fixture({ allowed: [-100] });
    await test.bot.handleUpdate(messageUpdate(-100, "general discussion") as never);
    expect(test.interrupt).not.toHaveBeenCalled();

    await test.bot.handleUpdate(messageUpdate(-100, "Hey @test_bot", {
      message_id: 8,
      entities: [{ type: "mention", offset: 4, length: 9 }],
    }) as never);
    await test.bot.handleUpdate(messageUpdate(-100, "yes", {
      message_id: 9,
      reply_to_message: {
        message_id: 2,
        date: 1_699_999_999,
        chat: { id: -100, type: "group" },
        from: { id: 999, is_bot: true, first_name: "Test" },
      },
    }) as never);
    await waitForInterrupt(test.interrupt, 2);

    const events = await timelineEvents(test.paths);
    expect(events).toHaveLength(3);
    expect(events.map((event) => (event.meta as { directed: boolean }).directed)).toEqual([false, true, true]);
  });

  it("records bounded group identity and its inviter without retaining the native add update", async () => {
    const test = await fixture({ allowed: [42] });
    const title = `Sensitive\u0000 Channel ${"x".repeat(200)}`;
    await test.bot.handleUpdate({
      update_id: 10,
      my_chat_member: {
        chat: { id: -100123, type: "channel", title },
        from: { id: 42, is_bot: false, username: "admin\u0007name", first_name: "Ad\u0000min", last_name: "User" },
        date: 1_700_000_000,
        old_chat_member: { status: "left", user: { id: 999, is_bot: true, first_name: "Bot" } },
        new_chat_member: { status: "administrator", user: { id: 999, is_bot: true, first_name: "Bot" } },
      },
    } as never);

    expect(test.interrupt).not.toHaveBeenCalled();
    const events = await timelineEvents(test.paths);
    expect(events).toMatchObject([{
      type: "telegram.access_request",
      connectorId: CONNECTOR_ID,
      payload: {
        reason: "chat_not_allowed",
        update_type: "my_chat_member",
        chat: { id: -100123, type: "channel", title: "Sensitive Channel " + "x".repeat(110) },
        requester: { id: 42, username: "admin name", first_name: "Ad min", last_name: "User" },
      },
    }]);
    expect(JSON.stringify(events)).not.toContain("administrator");
    expect(JSON.stringify(events)).not.toContain('"old_chat_member"');
    expect(JSON.stringify(events)).not.toContain('"new_chat_member"');
  });

  it("surfaces an allowed bot group add to its conversation owner", async () => {
    const test = await fixture({ allowed: [-100123] });
    await test.bot.handleUpdate({
      update_id: 10,
      my_chat_member: {
        chat: { id: -100123, type: "channel", title: "New Channel" },
        from: { id: 42, is_bot: false, first_name: "Admin" },
        date: 1_700_000_000,
        old_chat_member: { status: "left", user: { id: 999, is_bot: true, first_name: "Bot" } },
        new_chat_member: { status: "administrator", user: { id: 999, is_bot: true, first_name: "Bot" } },
      },
    } as never);
    await waitForInterrupt(test.interrupt, 1);

    expect(await timelineEvents(test.paths)).toMatchObject([{
      type: "telegram.my_chat_member",
      connectorId: CONNECTOR_ID,
      conversation: telegramConversation(CONNECTOR_ID, -100123),
      meta: { group_add: true },
    }]);
  });

  it("routes poll answers through WorkspaceResources without consulting timeline history", async () => {
    const test = await fixture();
    const owner = telegramConversation(CONNECTOR_ID, 42, 9);
    await test.resources.set({ connectorId: CONNECTOR_ID, kind: "poll", key: "poll-9", owner });
    await test.bot.handleUpdate({
      update_id: 11,
      poll_answer: {
        poll_id: "poll-9",
        user: { id: 42, is_bot: false, first_name: "Alice" },
        option_ids: [1, 2],
      },
    } as never);

    expect(await timelineEvents(test.paths)).toMatchObject([{
      type: "telegram.poll_answer",
      connectorId: CONNECTOR_ID,
      conversation: owner,
      payload: { poll_id: "poll-9", option_ids: [1, 2] },
    }]);
    expect(test.interrupt).not.toHaveBeenCalled();
  });

  it("downloads attachments into the connector-prefixed attachment namespace", async () => {
    const test = await fixture();
    test.bot.api.getFile = vi.fn(async () => ({ file_id: "file-id", file_path: "documents/remote.bin" })) as never;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello telegram", { status: 200 })));
    await test.bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        document: { file_id: "file-id", file_name: "report.txt", mime_type: "text/plain" },
      },
    } as never);

    const [event] = await timelineEvents(test.paths);
    const attachment = (event?.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment).toMatchObject({
      type: "document",
      path: `/run/attachments/${ATTACHMENT_PREFIX}/42/2023-11-14/7/report.txt`,
      mimeType: "text/plain",
      originalName: "report.txt",
    });
    expect(await readFile(path.join(test.config.attachments, "42", "2023-11-14", "7", "report.txt"), "utf8")).toBe("hello telegram");
  });
  it("wakes the owning agent for an ordinary allowed channel post", async () => {
    const test = await fixture({ allowed: [-100123] });
    await test.bot.handleUpdate({
      update_id: 13,
      channel_post: {
        message_id: 77,
        date: 1_700_000_000,
        chat: { id: -100123, type: "channel", title: "Announcements" },
        text: "release notes",
      },
    } as never);

    await waitForInterrupt(test.interrupt, 1);
    expect(await timelineEvents(test.paths)).toMatchObject([{
      type: "telegram.message",
      conversation: telegramConversation(CONNECTOR_ID, -100123),
      meta: { private: false, directed: false, channel: true, user_content: true },
      payload: { text: "release notes" },
    }]);
  });
});

describe("Telegram gates and commands", () => {
  it("detects direct replies and Telegram mention entities", () => {
    const botInfo = { id: 999, username: "test_bot" };
    expect(isMessageDirectedToBot({
      message_id: 1,
      date: 100,
      chat: { id: -100, type: "group" },
      reply_to_message: { message_id: 2, date: 90, chat: { id: -100, type: "group" }, from: { id: 999, is_bot: true, first_name: "Bot" } },
    } as never, botInfo)).toBe(true);
    expect(isMessageDirectedToBot({
      message_id: 1,
      date: 100,
      chat: { id: -100, type: "group" },
      caption: "check @TEST_BOT",
      caption_entities: [{ type: "mention", offset: 6, length: 9 }],
    } as never, botInfo)).toBe(true);
    expect(isMessageDirectedToBot({
      message_id: 1,
      date: 100,
      chat: { id: -100, type: "group" },
      text: "hello everyone",
    } as never, botInfo)).toBe(false);
  });

  it("distinguishes bot additions from permission changes", () => {
    expect(isBotGroupAdd({ old_chat_member: { status: "left" }, new_chat_member: { status: "member" } })).toBe(true);
    expect(isBotGroupAdd({ old_chat_member: { status: "kicked" }, new_chat_member: { status: "administrator" } })).toBe(true);
    expect(isBotGroupAdd({ old_chat_member: { status: "member" }, new_chat_member: { status: "administrator" } })).toBe(false);
  });
  it("describes an allowed chat when the bot is added", async () => {
    const test = await fixture({ allowed: [-100123] });
    const record = {
      v: 2,
      id: "group-add",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.my_chat_member",
      connectorId: CONNECTOR_ID,
      conversation: telegramConversation(CONNECTOR_ID, -100123),
      meta: { group_add: true },
    } as never;

    const text = test.connector.notificationText(record, "raw event");

    expect(text).toContain("already allowed");
    expect(text).not.toContain("To allow");
  });
  it("requests channel post updates from Telegram", async () => {
    const test = await fixture();
    const start = vi.spyOn(test.bot, "start").mockResolvedValue(undefined);

    await test.connector.run();

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      allowed_updates: expect.arrayContaining(["channel_post", "edited_channel_post"]),
    }));
  });

  it("publishes only current commands", async () => {
    const setMyCommands = vi.fn(async () => true);
    await registerBotCommands({ api: { setMyCommands } } as unknown as Bot);
    expect(setMyCommands).toHaveBeenCalledWith([
      { command: "restart", description: "Restart all agents after settings changes" },
      { command: "start", description: "Introduction" },
    ]);
  });
  it("does not start polling when stopped during command registration", async () => {
    const test = await fixture();
    let releaseRegistration!: (value: true) => void;
    const registration = new Promise<true>((resolve) => { releaseRegistration = resolve; });
    vi.spyOn(test.bot.api, "setMyCommands").mockReturnValue(registration as never);
    const start = vi.spyOn(test.bot, "start").mockResolvedValue(undefined);
    const running = test.connector.run();
    await vi.waitFor(() => expect(test.bot.api.setMyCommands).toHaveBeenCalledOnce());
    const stopping = test.connector.stop();
    releaseRegistration(true);
    await Promise.all([running, stopping]);
    expect(start).not.toHaveBeenCalled();
  });

  it("handles /start and /restart through the connector-owned bot", async () => {
    const test = await fixture();
    const command = (text: string, updateId: number) => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.length }],
      },
    });
    await test.bot.handleUpdate(command("/start", 20) as never);
    await test.bot.handleUpdate(command("/restart", 21) as never);

    expect(test.restartAll).toHaveBeenCalledOnce();
    const replies = test.requests
      .filter((request) => request.url.endsWith("/sendMessage"))
      .map((request) => (JSON.parse(request.body) as { text: string }).text);
    expect(replies).toEqual([
      "Personal agent. Send text, attachments, or a location pin to continue your persistent session.",
      "Restarting all agents. They will resume on the next message.",
    ]);
  });
});
