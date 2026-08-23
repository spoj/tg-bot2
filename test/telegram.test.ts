import { execFileSync } from "node:child_process";
import { describe, expect, it, vi, type Mock } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { InputFile, type Bot } from "grammy";
import {
  createTelegramBot,
  dispatchOutboxRequest,
  attachmentSource,
  registerBotCommands,
  TelegramDeliveryQueue,
} from "../src/telegram.js";
import { AgentEventRouter } from "../src/agent.js";
import { appendTimelineEvents, WorkspaceTimeline } from "../src/events.js";
import { botPaths } from "../src/util.js";
import { isBotGroupAdd, isMessageDirectedToBot } from "../src/telegram.js";

function fakeBot() {
  const raw = {
    sendMessage: vi.fn(async () => ({ message_id: 123 })),
    sendPhoto: vi.fn(async () => ({ message_id: 123 })),
    sendAudio: vi.fn(async () => ({ message_id: 123 })),
    sendVideo: vi.fn(async () => ({ message_id: 123 })),
    sendVoice: vi.fn(async () => ({ message_id: 123 })),
    sendDocument: vi.fn(async () => ({ message_id: 123 })),
    sendMediaGroup: vi.fn(async () => [{ message_id: 11 }, { message_id: 12 }]),
    editMessageText: vi.fn(async () => ({ message_id: 123 })),
    editForumTopic: vi.fn(async () => true),
    createForumTopic: vi.fn(async () => ({ message_thread_id: 105, name: "topic" })),
  };
  return {
    api: {
      raw,
      sendMessage: vi.fn(async () => ({ message_id: 123 })),
      getFile: vi.fn(async () => ({ file_path: "documents/report.txt" })),
      setMyCommands: vi.fn(async () => true),
    },
  } as unknown as Bot;
}
async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "tg-bot-telegram-"));
  try {
    await writeAllowedChats(workspace, [42]);
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
function workspaceDir(dataDir: string): string {
  return botPaths(dataDir, 999).workspace;
}
async function readLogEvents(dataDir: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path.join(dataDir, "timeline.jsonl"), "utf8").catch(() => "");
  const result: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") {
        result.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Skip corrupt test lines
    }
  }
  return result;
}

async function writeAllowedChats(dataDir: string, chats: Array<{ chat_id: number; title?: string } | number>): Promise<void> {
  const workspace = workspaceDir(dataDir);
  await mkdir(workspace, { recursive: true });
  const ids = chats.map((chat) => (typeof chat === "number" ? chat : chat.chat_id));
  await writeFile(path.join(workspace, ".allowed.json"), `${JSON.stringify(ids, null, 2)}\n`);
}

async function waitForChatEvents(dataDir: string, predicate: (events: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
  let events: Record<string, unknown>[] = [];
  await vi.waitFor(async () => {
    events = await readLogEvents(dataDir);
    if (!predicate(events)) throw new Error("chat events not yet flushed");
  });
  return events;
}

async function messageEvent(dataDir: string): Promise<Record<string, unknown>> {
  const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "message"));
  return events.find((event) => event.type === "message") as Record<string, unknown>;
}

function wakeArg(prompt: Mock): Record<string, unknown> {
  return JSON.parse(prompt.mock.calls[0]?.[0] as string) as Record<string, unknown>;
}

async function firstMessageAttachment(dataDir: string): Promise<Record<string, unknown>> {
  const message = await messageEvent(dataDir);
  return (message.attachments as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
}

let sentRequests: Array<{ url: string; body: string }> = [];

async function makeTestBot(
  dataDir: string,
  agents: { interrupt: Mock<(text: string) => Promise<void>>; followup?: Mock<(text: string) => Promise<void>>; restartAll?: Mock<() => Promise<void>> },
  { fetchResult, recordRequests = false, pollOwners }: { fetchResult?: Record<string, unknown>; recordRequests?: boolean; pollOwners?: Map<string, number> } = {},
): Promise<Bot> {
  if (recordRequests) sentRequests = [];
  const followup = agents.followup ?? vi.fn(async () => undefined);
  const events = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
  const agentAccess = agents.restartAll ? { restartAll: agents.restartAll } : undefined;
  const bot = createTelegramBot(
    { token: "999:test-token", botId: 999, dataDir },
    events,
    undefined,
    agentAccess,
    pollOwners,
  );
  const router = new AgentEventRouter(
    { interrupt: agents.interrupt, followup },
    { botInfo: () => (bot as unknown as { botInfo?: { id: number; username?: string } }).botInfo },
  );
  events.subscribe((record, rawLine) => router.onEvent(record, rawLine));
  (bot as unknown as { botInfo: unknown }).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot" };
  const fakeFetch: typeof fetch = async (input, init) => {
    if (recordRequests) {
      sentRequests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
    }
    return new Response(JSON.stringify({ ok: true, result: fetchResult ?? {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  Object.assign(bot, { clientConfig: { fetch: fakeFetch } });
  return bot;
}

async function runAttachmentFixture(
  dataDir: string,
  fetchImplementation: typeof fetch,
  fileName = "report.txt",
  getFileImplementation: () => Promise<{ file_id: string; file_path?: string }> = async () => ({ file_id: "file-id", file_path: "documents/remote.bin" }),
  beforeUpdate?: (bot: Bot) => void,
): Promise<Mock> {
  const prompt = vi.fn(async () => undefined);
  const events = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
  const router = new AgentEventRouter({ interrupt: prompt, followup: vi.fn(async () => undefined) });
  events.subscribe((record, rawLine) => router.onEvent(record, rawLine));
  const bot = createTelegramBot({
    token: "999:test-token",
    botId: 999,
    dataDir,
  }, events);
  (bot as unknown as { botInfo: Record<string, unknown> }).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot" };
  bot.api.getFile = vi.fn(getFileImplementation) as unknown as typeof bot.api.getFile;
  (bot.api as unknown as { sendChatAction: ReturnType<typeof vi.fn> }).sendChatAction = vi.fn(async () => ({}));
  vi.stubGlobal("fetch", fetchImplementation);
  beforeUpdate?.(bot);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Test" },
      document: { file_id: "file-id", file_name: fileName, mime_type: "text/plain" },
    },
  } as never);
  return prompt;
}

describe("attachmentSource table", () => {
  const base = { message_id: 1, date: 1_700_000_000, chat: { id: 42, type: "private" } };
  const file = { file_id: "f-1", file_size: 10, mime_type: "custom/x", file_name: "orig.bin" };
  const cases: Array<{ name: string; message: Record<string, unknown>; expected: Record<string, unknown> }> = [
    { name: "animation", message: { animation: file }, expected: { type: "animation", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "audio", message: { audio: file }, expected: { type: "audio", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "document", message: { document: file }, expected: { type: "document", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "photo", message: { photo: [{ file_id: "f-small", file_size: 5 }, { file_id: "f-large", file_size: 20 }] }, expected: { type: "photo", fileId: "f-large", mimeType: "image/jpeg" } },
    { name: "animated sticker", message: { sticker: { file_id: "f-a", file_size: 3, is_animated: true } }, expected: { type: "sticker", fileId: "f-a", mimeType: "application/x-tgsticker" } },
    { name: "video sticker", message: { sticker: { file_id: "f-v", file_size: 3, is_video: true } }, expected: { type: "sticker", fileId: "f-v", mimeType: "video/webm" } },
    { name: "static sticker", message: { sticker: { file_id: "f-s", file_size: 3 } }, expected: { type: "sticker", fileId: "f-s", mimeType: "image/webp" } },
    { name: "video", message: { video: file }, expected: { type: "video", fileId: "f-1", mimeType: "custom/x", originalName: "orig.bin" } },
    { name: "video note", message: { video_note: file }, expected: { type: "video_note", fileId: "f-1", mimeType: "video/mp4" } },
    { name: "voice", message: { voice: file }, expected: { type: "voice", fileId: "f-1", mimeType: "custom/x" } },
  ];
  for (const { name, message, expected } of cases) {
    it(`picks the ${name} source`, () => {
      expect(attachmentSource({ ...base, ...message } as never)).toMatchObject(expected);
    });
  }
  it("returns undefined without media", () => {
    expect(attachmentSource({ ...base, text: "hello" } as never)).toBeUndefined();
    expect(attachmentSource({ ...base, photo: [] } as never)).toBeUndefined();
  });
});

function chunkedResponse(chunks: readonly Uint8Array[], headers?: HeadersInit): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, ...(headers === undefined ? {} : { headers }) });
}



describe("TelegramDeliveryQueue", () => {
  it("delivers operations FIFO within one chat", async () => {
    const queue = new TelegramDeliveryQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue(7, async () => {
      events.push("first:start");
      resolveFirstStarted();
      await firstFinished;
      events.push("first:end");
    });
    await firstStarted;
    const second = queue.enqueue(7, async () => {
      events.push("second");
    });
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different chats to deliver concurrently", async () => {
    const queue = new TelegramDeliveryQueue();
    let releaseFirst!: () => void;
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstDone = false;
    const first = queue.enqueue(1, async () => {
      resolveFirstStarted();
      await firstFinished;
      firstDone = true;
    });
    await firstStarted;
    await queue.enqueue(2, () => "chat-two");
    expect(firstDone).toBe(false);
    releaseFirst();
    await first;
    expect(firstDone).toBe(true);
  });

  it("continues a chat after a rejected operation", async () => {
    const queue = new TelegramDeliveryQueue();
    const events: string[] = [];
    const failure = queue.enqueue(3, () => {
      events.push("failed");
      throw new Error("send failed");
    });
    const later = queue.enqueue(3, () => {
      events.push("later");
      return "delivered";
    });
    await expect(failure).rejects.toThrow("send failed");
    await expect(later).resolves.toBe("delivered");
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(events).toEqual(["failed", "later"]);
  });

  it("drains operations accepted while a drain is already waiting", async () => {
    const queue = new TelegramDeliveryQueue();
    const events: string[] = [];
    const first = queue.enqueue(4, () => {
      events.push("first");
    });
    const draining = queue.drain();
    await first;
    queue.enqueue(4, () => {
      events.push("second");
    });
    await draining;
    expect(events).toEqual(["first", "second"]);
    await queue.drain();
  });
});

describe("raw Telegram Bot API dispatch", () => {
  it("passes Bot API payloads and request-location keyboards through unchanged", async () => {
    await withWorkspace(async (dataDir) => {
      const paths = botPaths(dataDir, 999);
      await mkdir(paths.attachments, { recursive: true });
      const bot = fakeBot();
      const replyMarkup = { keyboard: [[{ text: "Share location", request_location: true }]], resize_keyboard: true };
      await expect(dispatchOutboxRequest(bot, paths, 42, "req-1", {
        method: "sendMessage",
        chat_id: 42,
        text: "Where are you?",
        reply_markup: replyMarkup,
        protect_content: true,
      })).resolves.toMatchObject({ messageId: 123 });
      expect(bot.api.raw.sendMessage).toHaveBeenCalledWith({
        chat_id: 42,
        text: "Where are you?",
        reply_markup: replyMarkup,
        protect_content: true,
      });
    });
  });

  it("copies workspace uploads into host attachments before delivery", async () => {
    await withWorkspace(async (dataDir) => {
      const paths = botPaths(dataDir, 999);
      await mkdir(paths.attachments, { recursive: true });
      await writeFile(path.join(paths.workspace, "report.txt"), "report", "utf8");
      const bot = fakeBot();
      const result = await dispatchOutboxRequest(bot, paths, 42, "req-file", {
        method: "sendDocument",
        chat_id: 42,
        document: "/workspace/report.txt",
        caption: "Report",
      });
      const managed = result.request?.document;
      expect(managed).toMatch(/^\/run\/attachments\/42\/\d{4}-\d{2}-\d{2}\/req-file\/report\.txt$/);
      expect(await readFile(path.join(paths.attachments, String(managed).slice("/run/attachments/".length)), "utf8")).toBe("report");
      expect(bot.api.raw.sendDocument).toHaveBeenCalledWith({
        chat_id: 42,
        document: expect.any(InputFile),
        caption: "Report",
      });
    });
  });

  it("reuses the staged copy when Telegram retries the same request", async () => {
    await withWorkspace(async (dataDir) => {
      const paths = botPaths(dataDir, 999);
      await mkdir(paths.attachments, { recursive: true });
      await writeFile(path.join(paths.workspace, "report.txt"), "report", "utf8");
      const bot = fakeBot();
      const request = { method: "sendDocument" as const, chat_id: 42, document: "/workspace/report.txt" };

      const first = await dispatchOutboxRequest(bot, paths, 42, "req-retry", request);
      const second = await dispatchOutboxRequest(bot, paths, 42, "req-retry", request);

      expect(second.request?.document).toBe(first.request?.document);
      expect(bot.api.raw.sendDocument).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(paths.attachments, String(first.request?.document).slice("/run/attachments/".length)), "utf8")).toBe("report");
    });
  });

  it("rejects local files outside the exposed roots", async () => {
    await withWorkspace(async (dataDir) => {
      const paths = botPaths(dataDir, 999);
      await mkdir(paths.attachments, { recursive: true });
      await expect(dispatchOutboxRequest(fakeBot(), paths, 42, "req-bad", {
        method: "sendDocument",
        chat_id: 42,
        document: "/etc/passwd",
      })).rejects.toThrow("under /workspace");
    });
  });

  it("applies incidental topic names after message delivery", async () => {
    await withWorkspace(async (dataDir) => {
      const paths = botPaths(dataDir, 999);
      await mkdir(paths.attachments, { recursive: true });
      const bot = fakeBot();
      await dispatchOutboxRequest(bot, paths, 42, "req-topic", {
        method: "sendMessage",
        chat_id: 42,
        message_thread_id: 7,
        text: "The itinerary is taking shape.",
        topic_name: "Japan itinerary",
      });
      expect(bot.api.raw.sendMessage).toHaveBeenCalledWith({ chat_id: 42, message_thread_id: 7, text: "The itinerary is taking shape." });
      expect(bot.api.raw.editForumTopic).toHaveBeenCalledWith({ chat_id: 42, message_thread_id: 7, name: "Japan itinerary" });
    });
  });
});

describe("Telegram attachment downloads", () => {
  it("bounds a stalled Telegram getFile call with the attachment deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withWorkspace(async (dataDir) => {
        const getFile = vi.fn(() => new Promise<{ file_id: string; file_path?: string }>(() => {}));
        const fixture = runAttachmentFixture(
          dataDir,
          vi.fn(async () => chunkedResponse([new TextEncoder().encode("unused")])) as unknown as typeof fetch,
          "report.txt",
          getFile,
        );
        await vi.waitFor(() => expect(getFile).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(30_000);
        await fixture;
        expect(getFile).toHaveBeenCalledOnce();
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/download timed out/);
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("aborts and cancels bodies rejected by response headers", async () => {
    try {
      for (const testCase of [
        { status: 503, headers: undefined, failure: /HTTP 503/ },
        { status: 200, headers: { "content-length": String(20 * 1024 * 1024 + 1) }, failure: /20 MB/ },
      ]) {
        await withWorkspace(async (dataDir) => {
          let cancelled = false;
          let signal: AbortSignal | null | undefined;
          const response = new Response(new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }), {
            status: testCase.status,
            ...(testCase.headers === undefined ? {} : { headers: testCase.headers }),
          });
          const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
            signal = init?.signal;
            return Promise.resolve(response);
          });
          await runAttachmentFixture(dataDir, fetchMock as unknown as typeof fetch);
          expect((await firstMessageAttachment(dataDir)).failure).toMatch(testCase.failure);
          expect(signal?.aborted).toBe(true);
          expect(cancelled).toBe(true);
        });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("bounds a stalled Telegram fetch with AbortController", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withWorkspace(async (dataDir) => {
        let signal: AbortSignal | null | undefined;
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
          signal = init?.signal;
          return new Promise<Response>(() => {});
        });
        const fixture = runAttachmentFixture(dataDir, fetchMock as unknown as typeof fetch);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(30_000);
        await fixture;
        expect(signal?.aborted).toBe(true);
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/download timed out/);
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("rejects a chunked response as soon as it exceeds 20 MiB", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const response = chunkedResponse([
          new Uint8Array(20 * 1024 * 1024),
          new Uint8Array([1]),
        ]);
        await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/20 MB/);
        expect(await readFile(path.join(botPaths(dataDir, 999).attachments, "42", "2023-11-14", "7", "report.txt")).catch(() => undefined)).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels an attachment reader after an oversized response", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        let cancelled = false;
        const response = new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(20 * 1024 * 1024));
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }), { status: 200 });
        await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/20 MB/);
        expect(cancelled).toBe(true);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams a bounded response while preserving attachment metadata", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const response = chunkedResponse([
          new TextEncoder().encode("hello "),
          new TextEncoder().encode("telegram"),
        ]);
        await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        const destination = path.join(botPaths(dataDir, 999).attachments, "42", "2023-11-14", "7", "report.txt");
        expect(await readFile(destination, "utf8")).toBe("hello telegram");
        const attachment = await firstMessageAttachment(dataDir);
        expect(attachment.mimeType).toBe("text/plain");
        expect(attachment.originalName).toBe("report.txt");
        expect(attachment.path).toBe("/run/attachments/42/2023-11-14/7/report.txt");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("does not publish an attachment after its pinned directory is replaced", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const directory = path.join(botPaths(dataDir, 999).attachments, "42", "2023-11-14", "7");
        await mkdir(directory, { recursive: true });
        let pulls = 0;
        let replaced = false;
        const response = new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode("hello"));
              return;
            }
            await rename(directory, `${directory}.detached`);
            await mkdir(directory, { mode: 0o700 });
            replaced = true;
            controller.close();
          },
        }, { highWaterMark: 0 }), { status: 200 });
        await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect(replaced).toBe(true);
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/download failed/);
        expect(await readFile(path.join(directory, "report.txt")).catch(() => undefined)).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });


  it("keeps Unicode attachment filenames within Linux filename limits", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const fileName = `${"界".repeat(100)}.txt`;
        await runAttachmentFixture(dataDir, vi.fn(async () => chunkedResponse([new TextEncoder().encode("hello")])) as unknown as typeof fetch, fileName);
        expect((await firstMessageAttachment(dataDir)).failure).toBeUndefined();
        const directory = path.join(botPaths(dataDir, 999).attachments, "42", "2023-11-14", "7");
        const [savedName] = await readdir(directory);
        expect(savedName).toBeDefined();
        expect(Buffer.byteLength(savedName!)).toBeLessThanOrEqual(255);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a pre-existing symlinked attachment root", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const outside = path.join(dataDir, "outside");
        const attachments = botPaths(dataDir, 999).attachments;
        await mkdir(outside, { recursive: true });
        await mkdir(path.dirname(attachments), { recursive: true });
        await symlink(outside, attachments);
        const response = chunkedResponse([new TextEncoder().encode("secret")]);
        await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/download failed/);
        expect(await readFile(path.join(outside, "42", "2023-11-14", "7", "report.txt")).catch(() => undefined)).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("Telegram location and venue updates", () => {
  async function sendLocationUpdate(dataDir: string, message: Record<string, unknown>): Promise<Mock> {
    const prompt = vi.fn(async () => undefined);
    const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Test" },
        ...message,
      },
    } as never);
    return prompt;
  }

  it("records a shared location as a message event and wakes the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = await sendLocationUpdate(dataDir, { location: { latitude: 52.52, longitude: 13.405 } });
      expect(wakeArg(prompt)).toMatchObject({
        v: 1,
        t: expect.any(String),
        type: "message",
        chat_id: 42,
        message: { message_id: 7, location: { latitude: 52.52, longitude: 13.405 } },
        attachments: [],
      });
      expect(await messageEvent(dataDir)).toMatchObject({ type: "message", chat_id: 42, message: { message_id: 7, location: { latitude: 52.52, longitude: 13.405 } }, attachments: [] });
    });
  });

  it("records a venue as a message event and wakes the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = await sendLocationUpdate(dataDir, {
        venue: {
          location: { latitude: 52.5163, longitude: 13.3777 },
          title: "Brandenburg Gate",
          address: "Pariser Platz 1",
        },
      });
      expect(wakeArg(prompt)).toMatchObject({
        v: 1,
        t: expect.any(String),
        type: "message",
        chat_id: 42,
        message: { message_id: 7, venue: { title: "Brandenburg Gate", address: "Pariser Platz 1" } },
        attachments: [],
      });
      expect(await messageEvent(dataDir)).toMatchObject({ type: "message", chat_id: 42, message: { message_id: 7, venue: { title: "Brandenburg Gate", address: "Pariser Platz 1" } }, attachments: [] });
    });
  });
});

describe("Telegram callback queries", () => {
  function callbackUpdate(chatId: number, data: string) {
    return {
      update_id: 2,
      callback_query: {
        id: "cb-1",
        from: { id: chatId, is_bot: false, first_name: "Test" },
        message: {
          message_id: 7,
          date: 1_700_000_000,
          chat: { id: chatId, type: "private" },
          from: { id: 999, is_bot: true, first_name: "Test" },
        },
        chat_instance: "ci",
        data,
      },
    };
  }

  it("records an authorized button press as a callback event and wakes the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(callbackUpdate(42, "do_thing") as never);
      expect(wakeArg(prompt)).toMatchObject({
        v: 1,
        t: expect.any(String),
        type: "callback",
        chat_id: 42,
        callback_query: { data: "do_thing", message: { message_id: 7 } },
      });
      expect(sentRequests.some((request) => request.url.endsWith("/answerCallbackQuery"))).toBe(true);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "callback"));
      expect(events.find((event) => event.type === "callback")).toMatchObject({ type: "callback", chat_id: 42, callback_query: { data: "do_thing", message: { message_id: 7 } } });
    });
  });

  it("rejects a button press from a chat not on the allow list without answering or recording", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(callbackUpdate(999, "do_thing") as never);
      expect(prompt).not.toHaveBeenCalled();
      expect(sentRequests.some((request) => request.url.endsWith("/answerCallbackQuery"))).toBe(false);
      expect((await readLogEvents(dataDir)).some((event) => event.type === "callback")).toBe(false);
    });
  });

  it("embeds the raw callback query in the callback event", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(callbackUpdate(42, "x".repeat(100)) as never);
      expect(wakeArg(prompt)).toMatchObject({
        v: 1,
        t: expect.any(String),
        type: "callback",
        chat_id: 42,
        callback_query: { data: "x".repeat(100) },
      });
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "callback"));
      expect(events.find((event) => event.type === "callback")).toMatchObject({ type: "callback", chat_id: 42, callback_query: { data: "x".repeat(100) } });
    });
  });
});

describe("Telegram chat events", () => {
  function textUpdate(text: string): Record<string, unknown> {
    return {
      update_id: 1,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Test" },
        text,
      },
    };
  }

  it("logs a text message event and wakes the agent with the appended jsonl entry", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate(textUpdate("hello") as never);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "message"));
      expect(events.find((event) => event.type === "message")).toMatchObject({ type: "message", chat_id: 42, message: { message_id: 7, text: "hello" } });
      expect(wakeArg(prompt)).toMatchObject({
        v: 1,
        t: expect.any(String),
        type: "message",
        chat_id: 42,
        message: { message_id: 7, text: "hello" },
        attachments: [],
      });
      const chatLog = await readFile(path.join(dataDir, "timeline.jsonl"), "utf8");
      expect(wakeArg(prompt)).toEqual(JSON.parse(chatLog.trim().split("\n").at(-1)!));
    });
  });

  it("logs an edited message event silently without waking the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 2,
        edited_message: {
          message_id: 7,
          date: 1_700_000_000,
          edit_date: 1_700_000_050,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "Test" },
          text: "hello edited",
        },
      } as never);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "edited_message"));
      expect(events.find((event) => event.type === "edited_message")).toMatchObject({
        type: "edited_message",
        chat_id: 42,
        message: { message_id: 7, text: "hello edited", edit_date: 1_700_000_050 },
        attachments: [],
      });
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  it("logs a message_reaction event silently without waking the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 3,
        message_reaction: {
          chat: { id: 42, type: "private" },
          message_id: 7,
          user: { id: 42, is_bot: false, first_name: "Test" },
          date: 1_700_000_000,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "👍" }],
        },
      } as never);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "message_reaction"));
      expect(events.find((event) => event.type === "message_reaction")).toMatchObject({
        type: "message_reaction",
        chat_id: 42,
        message_reaction: {
          message_id: 7,
          new_reaction: [{ type: "emoji", emoji: "👍" }],
        },
      });
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  it("treats member or administrator additions from left/kicked as bot group adds", () => {
    const member = { status: "member" };
    const administrator = { status: "administrator" };
    const left = { status: "left" };
    const kicked = { status: "kicked" };
    expect(isBotGroupAdd({ old_chat_member: left, new_chat_member: member })).toBe(true);
    expect(isBotGroupAdd({ old_chat_member: kicked, new_chat_member: member })).toBe(true);
    expect(isBotGroupAdd({ old_chat_member: left, new_chat_member: administrator })).toBe(true);
    expect(isBotGroupAdd({ old_chat_member: kicked, new_chat_member: administrator })).toBe(true);
  });

  it("does not treat permission changes or non-adds as bot group adds", () => {
    const member = { status: "member" };
    const administrator = { status: "administrator" };
    const left = { status: "left" };
    expect(isBotGroupAdd({ old_chat_member: member, new_chat_member: administrator })).toBe(false);
    expect(isBotGroupAdd({ old_chat_member: member, new_chat_member: member })).toBe(false);
    expect(isBotGroupAdd({ old_chat_member: administrator, new_chat_member: member })).toBe(false);
    expect(isBotGroupAdd({ old_chat_member: left, new_chat_member: left })).toBe(false);
    expect(isBotGroupAdd(null)).toBe(false);
    expect(isBotGroupAdd({ old_chat_member: member })).toBe(false);
  });

  it("surfaces an administrator add on an unlisted chat instead of denying it", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 6,
        my_chat_member: {
          chat: { id: -100123, type: "channel", title: "Test Channel" },
          from: { id: 42, is_bot: false, first_name: "Admin" },
          date: 1_700_000_000,
          old_chat_member: { status: "left", user: { id: 999, is_bot: true, first_name: "Bot" } },
          new_chat_member: { status: "administrator", user: { id: 999, is_bot: true, first_name: "Bot" } },
        },
      } as never);
      const events = await waitForChatEvents(dataDir, (events) => events.some(
        (event) => event.type === "my_chat_member" && event.chat_id === -100123,
      ));
      expect(events.find((event) => event.type === "my_chat_member")).toMatchObject({
        type: "my_chat_member",
        chat_id: -100123,
        my_chat_member: { new_chat_member: { status: "administrator" } },
      });
      expect(events.some((event) => event.type === "chat_denied")).toBe(false);
    });
  });

  it("logs a my_chat_member event silently without waking the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 4,
        my_chat_member: {
          chat: { id: 42, type: "group", title: "Test Group" },
          from: { id: 42, is_bot: false, first_name: "Admin" },
          date: 1_700_000_000,
          old_chat_member: { status: "member", user: { id: 999, is_bot: true, first_name: "Bot" } },
          new_chat_member: { status: "administrator", user: { id: 999, is_bot: true, first_name: "Bot" } },
        },
      } as never);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "my_chat_member"));
      expect(events.find((event) => event.type === "my_chat_member")).toMatchObject({
        type: "my_chat_member",
        chat_id: 42,
        my_chat_member: {
          new_chat_member: { status: "administrator" },
        },
      });
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  it("logs a chat_join_request event silently without waking the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 5,
        chat_join_request: {
          chat: { id: 42, type: "supergroup", title: "Test Supergroup" },
          from: { id: 123, is_bot: false, first_name: "NewUser" },
          user_chat_id: 123,
          date: 1_700_000_000,
        },
      } as never);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "chat_join_request"));
      expect(events.find((event) => event.type === "chat_join_request")).toMatchObject({
        type: "chat_join_request",
        chat_id: 42,
        chat_join_request: {
          user_chat_id: 123,
          from: { id: 123, first_name: "NewUser" },
        },
      });
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  it("does not hang or follow a FIFO planted at the timeline path", async () => {
    await withWorkspace(async (workspace) => {
      const fifoPath = path.join(workspace, "timeline.jsonl");
      execFileSync("mkfifo", [fifoPath]);
      await expect(appendTimelineEvents(fifoPath, [{ type: "message", chat_id: 42, message: { message_id: 1 }, attachments: [] }])).resolves.toBe(false);
      expect((await lstat(fifoPath)).isFIFO()).toBe(true);
    });
  }, 2_000);
});






describe("Telegram ingress gate", () => {
  function messageUpdate(chatId: number, chat: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      update_id: 1,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: chatId, type: "private", ...chat },
        from: { id: chatId, is_bot: false, first_name: "Test" },
        text: "hello",
      },
    };
  }

  it("drops a message and fails closed when allowed.json is missing", async () => {
    await withWorkspace(async (dataDir) => {
      await rm(path.join(workspaceDir(dataDir), ".allowed.json"), { force: true });
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate(messageUpdate(42, { title: "Bootstrap Group" }) as never);

      expect(prompt).not.toHaveBeenCalled();
      expect(await readLogEvents(dataDir)).toEqual([]);
    });
  });

  it("drops a message from a chat that is not on the allow list", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(messageUpdate(999, { title: "Secret Group" }) as never);

      expect(prompt).not.toHaveBeenCalled();
      expect(sentRequests.some((request) => request.url.endsWith("/sendMessage"))).toBe(false);

      expect(await readLogEvents(dataDir)).toEqual([]);
    });
  });

  it("drops unlisted chats without adding them to the shared timeline", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const interrupt = vi.fn(async () => undefined);
      const followup = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt, followup });

      await bot.handleUpdate(messageUpdate(999, { title: "Stranger" }) as never);
      await bot.handleUpdate(messageUpdate(999, { title: "Stranger" }) as never);
      await bot.handleUpdate({
        update_id: 10,
        message: {
          message_id: 1,
          date: 100,
          chat: { id: -500, type: "group", title: "Random Group" },
          from: { id: 777, is_bot: false, first_name: "Bob" },
          text: "hello",
        },
      } as never);

      expect(interrupt).not.toHaveBeenCalled();
      expect(followup).not.toHaveBeenCalled();
      expect(await readLogEvents(dataDir)).toEqual([]);
    });
  });

  it("admits a listed chat and denies an unlisted one", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });

      await bot.handleUpdate(messageUpdate(42) as never);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(wakeArg(prompt)).toMatchObject({ type: "message", chat_id: 42 });

      await bot.handleUpdate(messageUpdate(999) as never);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect((await readLogEvents(dataDir)).filter((event) => event.type === "message")).toHaveLength(1);
    });
  });

  it("logs ambient group messages silently without interrupting the agent", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [-100]);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: -100, type: "group", title: "Busy Work Group" },
          from: { id: 42, is_bot: false, first_name: "Alice" },
          text: "Just discussing general work stuff",
        },
      } as never);

      expect(prompt).not.toHaveBeenCalled();
      const events = await readLogEvents(dataDir);
      expect(events.some((e) => e.type === "message" && e.chat_id === -100)).toBe(true);
    });
  });

  it("interrupts the agent when mentioned or directly replied to in a group", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [-100]);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });

      // 1. Direct mention
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1_700_000_000,
          chat: { id: -100, type: "group", title: "Busy Work Group" },
          from: { id: 42, is_bot: false, first_name: "Alice" },
          text: "Hey @test_bot can you summarize this?",
          entities: [{ type: "mention", offset: 4, length: 9 }],
        },
      } as never);
      expect(prompt).toHaveBeenCalledTimes(1);

      // 2. Direct reply
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: 1_700_000_000,
          chat: { id: -100, type: "group", title: "Busy Work Group" },
          from: { id: 42, is_bot: false, first_name: "Alice" },
          text: "Yes, exactly that",
          reply_to_message: { message_id: 10, from: { id: 999, is_bot: true, first_name: "Test" } },
        },
      } as never);
      expect(prompt).toHaveBeenCalledTimes(2);
    });
  });

  describe("isMessageDirectedToBot", () => {
    const botInfo = { id: 999, username: "test_bot" };

    it("detects direct replies to the bot", () => {
      const msg = {
        message_id: 1,
        date: 100,
        chat: { id: -100, type: "group" },
        reply_to_message: { message_id: 2, date: 90, chat: { id: -100, type: "group" }, from: { id: 999, is_bot: true, first_name: "Bot" } },
      } as never;
      expect(isMessageDirectedToBot(msg, botInfo)).toBe(true);
    });

    it("detects @username mentions in text and captions", () => {
      const msgWithText = {
        message_id: 1,
        date: 100,
        chat: { id: -100, type: "group" },
        text: "hello @TEST_BOT what is up",
        entities: [{ type: "mention", offset: 6, length: 9 }],
      } as never;
      expect(isMessageDirectedToBot(msgWithText, botInfo)).toBe(true);

      const msgWithCaption = {
        message_id: 2,
        date: 100,
        chat: { id: -100, type: "group" },
        caption: "check this @test_bot",
        caption_entities: [{ type: "mention", offset: 11, length: 9 }],
      } as never;
      expect(isMessageDirectedToBot(msgWithCaption, botInfo)).toBe(true);
    });

    it("detects text_mention user IDs", () => {
      const msg = {
        message_id: 1,
        date: 100,
        chat: { id: -100, type: "group" },
        text: "hello bot",
        entities: [{ type: "text_mention", offset: 6, length: 3, user: { id: 999, is_bot: true, first_name: "Bot" } }],
      } as never;
      expect(isMessageDirectedToBot(msg, botInfo)).toBe(true);
    });

    it("returns false for ambient group messages without mentions or replies", () => {
      const msg = {
        message_id: 1,
        date: 100,
        chat: { id: -100, type: "group" },
        text: "hello everyone @someone_else",
        entities: [{ type: "mention", offset: 15, length: 13 }],
      } as never;
      expect(isMessageDirectedToBot(msg, botInfo)).toBe(false);
    });
  });

  it("fails closed when allowed.json is malformed", async () => {
    await withWorkspace(async (dataDir) => {
      const directory = workspaceDir(dataDir);
      await mkdir(directory, { recursive: true });
      const malformed = path.join(directory, ".allowed.json");
      await writeFile(malformed, "{ not valid json\n", "utf8");
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });

      await bot.handleUpdate(messageUpdate(42) as never);

      expect(prompt).not.toHaveBeenCalled();
      expect(await readLogEvents(dataDir)).toEqual([]);
      expect(await readFile(malformed, "utf8")).toBe("{ not valid json\n");
    });
  });
});


describe("Telegram poll answers", () => {
  it("records a poll answer for the in-memory owning chat without waking", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const prompt = vi.fn(async () => undefined);
      const pollOwners = new Map([["poll-9", 42]]);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, pollOwners });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-9",
          user: { id: 42, is_bot: false, first_name: "Test" },
          option_ids: [1, 2],
        },
      } as never);
      expect(prompt).not.toHaveBeenCalled();
      const events = await waitForChatEvents(dataDir, (records) => records.some((event) => event.type === "poll_answer"));
      expect(events.find((event) => event.type === "poll_answer")).toMatchObject({
        type: "poll_answer",
        chat_id: 42,
        poll_answer: { poll_id: "poll-9", option_ids: [1, 2] },
      });
    });
  });

  it("does not consult timeline history while routing poll answers", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      await writeFile(path.join(dataDir, "timeline.jsonl"), "not json\n", "utf8");
      const prompt = vi.fn(async () => undefined);
      const pollOwners = new Map([["poll-9", 42]]);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, pollOwners });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-9",
          user: { id: 42, is_bot: false, first_name: "Test" },
          option_ids: [0],
        },
      } as never);
      expect((await readLogEvents(dataDir)).some((event) => event.type === "poll_answer")).toBe(true);
    });
  });

  it("drops poll answers from unknown polls", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-missing",
          user: { id: 42, is_bot: false, first_name: "Test" },
          option_ids: [0],
        },
      } as never);
      expect(prompt).not.toHaveBeenCalled();
      expect((await readLogEvents(dataDir)).some((event) => event.type === "poll_answer")).toBe(false);
    });
  });

  it("drops poll answers owned by a chat not on the allow list", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const prompt = vi.fn(async () => undefined);
      const pollOwners = new Map([["poll-999", 999]]);
      const bot = await makeTestBot(dataDir, { interrupt: prompt }, { fetchResult: { message_id: 555 }, pollOwners });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-999",
          user: { id: 999, is_bot: false, first_name: "Test" },
          option_ids: [0],
        },
      } as never);
      expect(prompt).not.toHaveBeenCalled();
      expect((await readLogEvents(dataDir)).some((event) => event.type === "poll_answer")).toBe(false);
    });
  });
});


describe("Telegram commands", () => {
  it("publishes only the remaining commands", async () => {
    const setMyCommands = vi.fn(async () => true);
    await registerBotCommands({ api: { setMyCommands } } as unknown as Bot);
    expect(setMyCommands).toHaveBeenCalledWith([
      { command: "restart", description: "Restart all agents after settings changes" },
      { command: "start", description: "Introduction" },
    ]);
  });

  type FakeAgents = {
    followup: Mock<(text: string) => Promise<void>>;
    interrupt: Mock<(text: string) => Promise<void>>;
    restartAll: Mock<() => Promise<void>>;
  };

  function makeAgents(overrides: Partial<FakeAgents> = {}): FakeAgents {
    return {
      followup: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      restartAll: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function commandLength(text: string): number {
    const end = text.search(/[\s@]/);
    return end === -1 ? text.length : end;
  }

  async function sendCommand(bot: Bot, text: string, chatId = 42): Promise<void> {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: chatId, type: "private" },
        from: { id: chatId, is_bot: false, first_name: "Test" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: commandLength(text) }],
      },
    } as never);
  }

  function replies(_bot: Bot): string[] {
    return sentRequests
      .filter((request) => request.url.endsWith("/sendMessage"))
      .map((request) => (JSON.parse(request.body) as { text: string }).text);
  }

  it("/start sends the personal-agent help text", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const agents = makeAgents();
      const bot = await makeTestBot(dataDir, agents, { recordRequests: true });
      await sendCommand(bot, "/start");
      expect(replies(bot)).toEqual([
        "Personal agent. Send text, attachments, or a location pin to continue your persistent session.",
      ]);
    });
  });

  it("/restart restarts all agents", async () => {
    await withWorkspace(async (dataDir) => {
      await writeAllowedChats(dataDir, [{ chat_id: 42 }]);
      const agents = makeAgents();
      const bot = await makeTestBot(dataDir, agents, { recordRequests: true });
      await sendCommand(bot, "/restart");
      expect(agents.restartAll).toHaveBeenCalledOnce();
      expect(replies(bot)).toEqual(["Restarting all agents. They will resume on the next message."]);
    });
  });

});
