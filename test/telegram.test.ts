import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it, vi, type Mock } from "vitest";
import { appendFile, mkdtemp, mkdir, open as openFile, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { GrammyError, type Bot } from "grammy";
import {
  closeTelegramIngress,
  createTelegramBot,
  deleteTelegramMessage,
  flushTelegramIngress,
  formatModelList,
  formatStatus,
  formatThinkingLevels,
  recordPollOwner,
  attachmentSource,
  sendTelegramEditMessage,
  sendTelegramLocation,
  sendTelegramPoll,
  sendTelegramReaction,
  sendTelegramRichMessage,
  stopTelegramPoll,
  sendWorkspaceFile,
  splitTelegramText,
  TelegramDeliveryQueue,
  TelegramIngressBuffer,
} from "../src/telegram.js";
import type { ChatEvent } from "../src/events.js";
import type {
  WorkspaceOutboxEditMessageRequest,
  WorkspaceOutboxReaction,
  WorkspaceOutboxSendLocationRequest,
  WorkspaceOutboxSendMessageRequest,
  WorkspaceOutboxSendPollRequest,
} from "../src/outbox-protocol.js";

const execFile = promisify(execFileCallback);
function fakeBot() {
  return {
    api: {
      deleteMessage: vi.fn(async () => true),
      editMessageText: vi.fn(async () => ({ message_id: 123 })),
      sendAudio: vi.fn(async () => ({ message_id: 123 })),
      sendDocument: vi.fn(async () => ({ message_id: 123 })),
      sendLocation: vi.fn(async () => ({ message_id: 123 })),
      sendMessage: vi.fn(async () => ({ message_id: 123 })),
      sendPhoto: vi.fn(async () => ({ message_id: 123 })),
      sendPoll: vi.fn(async () => ({ message_id: 123, poll: { id: "poll-9" } })),
      sendVenue: vi.fn(async () => ({ message_id: 123 })),
      sendVideo: vi.fn(async () => ({ message_id: 123 })),
      sendVoice: vi.fn(async () => ({ message_id: 123 })),
      setMessageReaction: vi.fn(async () => true),
      stopPoll: vi.fn(async () => ({ id: "poll-9", question: "Q", options: [], total_voter_count: 0, is_closed: true })),
    },
  } as unknown as Bot;
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), "tg-bot-telegram-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
async function readChatEvents(dataDir: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path.join(dataDir, "chats", "42", "workspace", ".tg-bot", "events.jsonl"), "utf8").catch(() => "");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForChatEvents(dataDir: string, predicate: (events: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
  let events: Record<string, unknown>[] = [];
  await vi.waitFor(async () => {
    events = await readChatEvents(dataDir);
    if (!predicate(events)) throw new Error("chat events not yet flushed");
  });
  return events;
}

async function messageEvent(dataDir: string): Promise<Record<string, unknown>> {
  const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "message"));
  return events.find((event) => event.type === "message") as Record<string, unknown>;
}

async function firstMessageAttachment(dataDir: string): Promise<Record<string, unknown>> {
  const message = await messageEvent(dataDir);
  return (message.attachments as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
}

let sentRequests: Array<{ url: string; body: string }> = [];

async function makeTestBot(
  dataDir: string,
  agents: { prompt: ReturnType<typeof vi.fn> },
  { fetchResult, recordRequests = false }: { fetchResult?: Record<string, unknown>; recordRequests?: boolean } = {},
): Promise<Bot> {
  if (recordRequests) sentRequests = [];
  const bot = createTelegramBot(
    { token: "test-token", allowedUserIds: new Set([42]), dataDir },
    agents as never,
  );
  Object.assign(bot, { botInfo: { id: 999, is_bot: true, first_name: "Test", username: "test_bot" } });
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
  const bot = createTelegramBot({
    token: "test-token",
    allowedUserIds: new Set([42]),
    dataDir,
  }, {
    prompt,
  } as never);
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
  await flushTelegramIngress(bot);
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
async function createFifo(fifoPath: string): Promise<boolean> {
  try {
    await execFile("mkfifo", [fifoPath]);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP") return false;
    throw error;
  }
}

it("splits Telegram responses below the limit without losing content", () => {
  const text = `${"a".repeat(30)}\n\n${"b".repeat(30)} ${"c".repeat(30)}`;
  const chunks = splitTelegramText(text, 40);
  expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
  expect(chunks.join("")).toBe(text);
});

describe("splitTelegramText", () => {
  it("handles exact limits and empty input", () => {
    expect(splitTelegramText("abcd", 4)).toEqual(["abcd"]);
    expect(splitTelegramText("")).toEqual([]);
  });
  it("caps a delimiter that starts at the message limit", () => {
    const text = `${"a".repeat(4_000)}\n\nb`;
    const chunks = splitTelegramText(text);
    expect(chunks).toEqual(["a".repeat(4_000), "\n\nb"]);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
  });
});

describe("TelegramIngressBuffer", () => {
  const entry = (typing?: () => void | Promise<void>) => ({
    value: Promise.resolve<ChatEvent>({ type: "message", message: { message_id: 1, text: "m1" }, attachments: [] }),
    ...(typing === undefined ? {} : { typing }),
  });

  it("batches a quiet window and wakes once", async () => {
    vi.useFakeTimers();
    try {
      const wakes: number[] = [];
      const buffer = new TelegramIngressBuffer(async (chatId) => {
        wakes.push(chatId);
      }, 2_000);

      expect(buffer.add(7, entry())).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(buffer.add(7, entry())).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(wakes).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pre-barrier work before admitting post-barrier work", async () => {
    const wakes: number[] = [];
    const buffer = new TelegramIngressBuffer(async (chatId) => {
      wakes.push(chatId);
    }, 60_000);

    buffer.add(7, entry());
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry());
    await buffer.flush(7);
    expect(wakes).toEqual([7]);

    barrier.release();
    await buffer.flush(7);
    expect(wakes).toEqual([7, 7]);
  });

  it("defers post-barrier admission while an earlier batch is active", async () => {
    const wakes: number[] = [];
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    let batch = 0;
    const buffer = new TelegramIngressBuffer(async () => {
      batch += 1;
      wakes.push(batch);
      if (batch === 1) {
        resolveFirstStarted();
        await firstFinished;
      }
    }, 60_000);

    buffer.add(7, entry());
    const first = buffer.flush(7);
    await firstStarted;
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry());
    const beforeRelease = buffer.flush(7);
    expect(wakes).toEqual([1]);

    releaseFirst();
    await Promise.all([first, beforeRelease]);
    expect(wakes).toEqual([1]);
    barrier.release();
    await buffer.flush(7);
    expect(wakes).toEqual([1, 2]);
  });

  it("releases the barrier when starting a new session fails", async () => {
    const wakes: number[] = [];
    const buffer = new TelegramIngressBuffer(async (chatId) => {
      wakes.push(chatId);
    }, 60_000);
    const newSession = vi.fn(async () => {
      throw new Error("session failed");
    });

    buffer.add(7, entry());
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry());
    try {
      await buffer.flush(7);
      await newSession();
    } catch {
      // The command reports the failure after its barrier is resumed.
    } finally {
      barrier.release();
    }

    await buffer.flush(7);
    expect(newSession).toHaveBeenCalledOnce();
    expect(wakes).toEqual([7, 7]);
  });

  it("drains accepted barrier work after close and release", async () => {
    const wakes: number[] = [];
    const buffer = new TelegramIngressBuffer(async (chatId) => {
      wakes.push(chatId);
    }, 60_000);
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry());

    buffer.close();
    barrier.release();
    await buffer.flushAll();
    expect(wakes).toEqual([7]);
  });

  it("serializes overlapping batches in FIFO order even when later work completes first", async () => {
    const completions: Array<() => void> = [];
    const callbacks: number[] = [];
    let resolveFirstStarted!: () => void;
    let resolveSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve; });
    let batch = 0;
    const buffer = new TelegramIngressBuffer(() => new Promise<void>((resolve) => {
      batch += 1;
      const current = batch;
      callbacks.push(current);
      if (current === 1) resolveFirstStarted();
      else resolveSecondStarted();
      completions.push(resolve);
    }), 60_000);

    buffer.add(7, entry());
    const first = buffer.flush(7);
    await firstStarted;
    buffer.add(7, entry());
    const second = buffer.flush(7);
    expect(callbacks).toEqual([1]);
    completions[0]!();
    await secondStarted;
    expect(callbacks).toEqual([1, 2]);
    completions[1]!();
    await Promise.all([first, second]);
  });

  it("keeps accepted pending work deliverable after close", async () => {
    const wakes: number[] = [];
    const buffer = new TelegramIngressBuffer(async (chatId) => {
      wakes.push(chatId);
    }, 60_000);
    buffer.add(7, entry());
    buffer.close();
    await buffer.flushAll();
    expect(wakes).toEqual([7]);
  });

  it("does not suppress an in-flight flush when closing", async () => {
    let responseStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { responseStarted = resolve; });
    let releaseResponse!: () => void;
    const responseFinished = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let attempts = 0;
    const buffer = new TelegramIngressBuffer(async () => {
      attempts += 1;
      responseStarted();
      return responseFinished;
    }, 60_000);
    buffer.add(7, entry());
    const draining = buffer.flush(7);
    await callbackStarted;
    expect(attempts).toBe(1);
    buffer.close();
    releaseResponse();
    await draining;
    await buffer.flushAll();
    expect(attempts).toBe(1);
  });

  it("reports quiesced admission after close", () => {
    const buffer = new TelegramIngressBuffer(async () => undefined);
    buffer.close();
    expect(buffer.add(7, entry())).toBe(false);
  });

  it("does not block batch processing on deferred initial typing", async () => {
    let releaseTyping!: () => void;
    const deferredTyping = new Promise<void>((resolve) => { releaseTyping = resolve; });
    let typingStarted = false;
    const wakes: number[] = [];
    const buffer = new TelegramIngressBuffer(async (chatId) => {
      wakes.push(chatId);
    }, 60_000);
    buffer.add(7, entry(() => {
      typingStarted = true;
      return deferredTyping;
    }));

    await buffer.flushAll();
    expect(typingStarted).toBe(true);
    expect(wakes).toEqual([7]);
    releaseTyping();
  });

  it("swallows a rejecting flush without retrying", async () => {
    let attempts = 0;
    const buffer = new TelegramIngressBuffer(async () => {
      attempts += 1;
      throw new Error("model failed");
    });
    buffer.add(7, entry());
    await buffer.flushAll();
    expect(attempts).toBe(1);
  });

  it("flushAll drains work admitted while an earlier batch is running", async () => {
    let calls = 0;
    const buffer = new TelegramIngressBuffer(async () => {
      calls += 1;
      if (calls === 1) {
        buffer.add(7, entry());
      }
    }, 60_000);
    buffer.add(7, entry());
    await buffer.flushAll();
    expect(calls).toBe(2);
  });

  it("catches synchronous callback throws without leaking a rejection", async () => {
    const buffer = new TelegramIngressBuffer(() => {
      throw new Error("synchronous handler failure");
    });
    buffer.add(7, entry());
    await expect(buffer.flushAll()).resolves.toBeUndefined();
  });
});
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

it("sends a valid workspace file with a bounded caption", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "report.txt"), "report");
    const bot = fakeBot();
    const caption = "caption".repeat(300);

    await expect(sendWorkspaceFile(bot, {
      chatId: 42,
      workspace,
      sandboxPath: "/workspace/report.txt",
      caption,
    })).resolves.toBe(123);

    const sendDocument = bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>;
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(sendDocument.mock.calls[0]?.[0]).toBe(42);
    expect(sendDocument.mock.calls[0]?.[2]).toEqual({ caption: Array.from(caption).slice(0, 1_024).join("") });
  });
});
it("passes reply target and notification settings to the send method", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "report.txt"), "report");
    const bot = fakeBot();

    await expect(sendWorkspaceFile(bot, {
      chatId: 42,
      workspace,
      sandboxPath: "/workspace/report.txt",
      replyToMessageId: 9,
      disableNotification: true,
    })).resolves.toBe(123);

    const sendDocument = bot.api.sendDocument as unknown as Mock;
    expect(sendDocument.mock.calls[0]?.[0]).toBe(42);
    expect(sendDocument.mock.calls[0]?.[2]).toEqual({ reply_to_message_id: 9, disable_notification: true });
  });
});
it("sends detected media kinds with the matching API methods", async () => {
  await withWorkspace(async (workspace) => {
    const cases = [
      ["shot.png", "sendPhoto"],
      ["clip.mp4", "sendVideo"],
      ["song.mp3", "sendAudio"],
    ] as const;
    for (const [name, method] of cases) {
      await writeFile(path.join(workspace, name), "payload");
      const bot = fakeBot();
      await expect(sendWorkspaceFile(bot, { chatId: 42, workspace, sandboxPath: name })).resolves.toBe(123);
      const api = bot.api[method] as unknown as ReturnType<typeof vi.fn>;
      expect(api).toHaveBeenCalledTimes(1);
      expect(api.mock.calls[0]?.[0]).toBe(42);
      const others = (["sendPhoto", "sendVideo", "sendAudio", "sendVoice", "sendDocument"] as const).filter((entry) => entry !== method);
      for (const other of others) expect(bot.api[other] as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    }
  });
});

it("honors explicit kinds and voice overrides", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "note.ogg"), "payload");
    const bot = fakeBot();
    await sendWorkspaceFile(bot, { chatId: 42, workspace, sandboxPath: "note.ogg", kind: "voice" });
    expect(bot.api.sendVoice as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(bot.api.sendAudio as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    const forcedDocument = fakeBot();
    await sendWorkspaceFile(forcedDocument, { chatId: 42, workspace, sandboxPath: "note.ogg", kind: "document" });
    expect(forcedDocument.api.sendDocument as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(forcedDocument.api.sendAudio as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

it("sends oversized images as documents instead of photos", async () => {
  await withWorkspace(async (workspace) => {
    const big = path.join(workspace, "big.png");
    await writeFile(big, "");
    await truncate(big, 10 * 1024 * 1024 + 1);
    const bot = fakeBot();
    await expect(sendWorkspaceFile(bot, { chatId: 42, workspace, sandboxPath: "big.png" })).resolves.toBe(123);
    expect(bot.api.sendPhoto as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});
it("applies the photo cap to explicit photo overrides as well", async () => {
  await withWorkspace(async (workspace) => {
    const big = path.join(workspace, "big.bin");
    await writeFile(big, "");
    await truncate(big, 10 * 1024 * 1024 + 1);
    const bot = fakeBot();
    await expect(sendWorkspaceFile(bot, { chatId: 42, workspace, sandboxPath: "big.bin", kind: "photo" })).resolves.toBe(123);
    expect(bot.api.sendPhoto as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});



it("rejects FIFOs without blocking when FIFO creation is supported", async () => {
  await withWorkspace(async (workspace) => {
    const fifo = path.join(workspace, "workspace-outbox-fifo");
    if (!(await createFifo(fifo))) return;
    const bot = fakeBot();
    const outcomePromise = sendWorkspaceFile(bot, {
      chatId: 42,
      workspace,
      sandboxPath: "workspace-outbox-fifo",
    }).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      outcomePromise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 250);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      const writer = await openFile(fifo, fsConstants.O_WRONLY);
      await writer.close();
      await outcomePromise;
      throw new Error("sendWorkspaceFile blocked while opening a FIFO.");
    }
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.error).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/regular file/) }),
    );
    expect((bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
}, 2_000);

it("rejects traversal and symlinks that resolve outside the workspace", async () => {

  const parent = await mkdtemp(path.join(tmpdir(), "tg-bot-telegram-parent-"));
  const workspace = path.join(parent, "workspace");
  const outside = path.join(parent, "outside.txt");
  try {
    await mkdir(workspace);
    await writeFile(outside, "secret");
    await symlink(outside, path.join(workspace, "link.txt"));
    const bot = fakeBot();

    await expect(sendWorkspaceFile(bot, { chatId: 1, workspace, sandboxPath: "../outside.txt" }))
      .rejects.toThrow(/escapes/);
    await expect(sendWorkspaceFile(bot, { chatId: 1, workspace, sandboxPath: "/workspace/link.txt" }))
      .rejects.toThrow(/outside/);
    expect((bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("rejects missing files, directories, and files over the upload cap", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "directory"));
    const oversized = path.join(workspace, "oversized.bin");
    await writeFile(oversized, "x");
    await truncate(oversized, 20 * 1024 * 1024 + 1);
    const bot = fakeBot();

    await expect(sendWorkspaceFile(bot, { chatId: 1, workspace, sandboxPath: "missing.txt" }))
      .rejects.toThrow(/does not exist/);
    await expect(sendWorkspaceFile(bot, { chatId: 1, workspace, sandboxPath: "directory" }))
      .rejects.toThrow(/regular file/);
    await expect(sendWorkspaceFile(bot, { chatId: 1, workspace, sandboxPath: "oversized.bin" }))
      .rejects.toThrow(/20 MiB/);
  });
});
it("rejects a regular file that grows beyond the upload cap after stat", async () => {
  await withWorkspace(async (workspace) => {
    const file = path.join(workspace, "growing.bin");
    await writeFile(file, "");
    await truncate(file, 20 * 1024 * 1024);
    const probe = await openFile(file, fsConstants.O_RDONLY);
    const prototype = Object.getPrototypeOf(probe) as {
      read: (this: unknown, ...args: any[]) => Promise<any>;
    };
    const originalRead = prototype.read;
    let grew = false;
    const readSpy = vi.spyOn(prototype, "read").mockImplementation(async function (this: unknown, ...args: any[]) {
      if (!grew) {
        grew = true;
        await appendFile(file, Buffer.from("x"));
      }
      return originalRead.apply(this, args);
    });
    try {
      const bot = fakeBot();
      await expect(sendWorkspaceFile(bot, {
        chatId: 42,
        workspace,
        sandboxPath: "growing.bin",
      })).rejects.toThrow(/20 MiB/);
      expect((bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      await probe.close();
    }
  });
});


describe("Telegram attachment downloads", () => {
  it("bounds a stalled Telegram getFile call with the attachment deadline", async () => {
    vi.useFakeTimers();
    try {
      await withWorkspace(async (dataDir) => {
        const getFile = vi.fn(() => new Promise<{ file_id: string; file_path?: string }>(() => {}));
        const fixture = runAttachmentFixture(
          dataDir,
          vi.fn(async () => chunkedResponse([new TextEncoder().encode("unused")])) as unknown as typeof fetch,
          "report.txt",
          getFile,
        );
        await Promise.resolve();
        await Promise.resolve();
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
    vi.useFakeTimers();
    try {
      await withWorkspace(async (dataDir) => {
        let signal: AbortSignal | null | undefined;
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
          signal = init?.signal;
          return new Promise<Response>(() => {});
        });
        const fixture = runAttachmentFixture(dataDir, fetchMock as unknown as typeof fetch);
        await Promise.resolve();
        await Promise.resolve();
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
        expect(await readFile(path.join(dataDir, "chats", "42", "workspace", "attachments", "2023-11-14", "7", "report.txt")).catch(() => undefined)).toBeUndefined();
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
        const destination = path.join(dataDir, "chats", "42", "workspace", "attachments", "2023-11-14", "7", "report.txt");
        expect(await readFile(destination, "utf8")).toBe("hello telegram");
        const attachment = await firstMessageAttachment(dataDir);
        expect(attachment.mimeType).toBe("text/plain");
        expect(attachment.originalName).toBe("report.txt");
        expect(attachment.path).toBe("/workspace/attachments/2023-11-14/7/report.txt");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("does not publish an attachment after its pinned directory is replaced", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const directory = path.join(dataDir, "chats", "42", "workspace", "attachments", "2023-11-14", "7");
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
  it("does not prepare attachments after quiesced ingress admission", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const getFile = vi.fn(async () => ({ file_id: "file-id", file_path: "documents/remote.bin" }));
        const fetchMock = vi.fn(async () => {
          throw new Error("fetch should not start after quiescing");
        });
        const prompt = await runAttachmentFixture(
          dataDir,
          fetchMock as unknown as typeof fetch,
          "report.txt",
          getFile,
          closeTelegramIngress,
        );
        expect(getFile).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
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
        const directory = path.join(dataDir, "chats", "42", "workspace", "attachments", "2023-11-14", "7");
        const [savedName] = await readdir(directory);
        expect(savedName).toBeDefined();
        expect(Buffer.byteLength(savedName!)).toBeLessThanOrEqual(255);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a pre-existing symlinked chat workspace", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        const chatRoot = path.join(dataDir, "chats", "42");
        const outside = path.join(dataDir, "outside");
        const workspace = path.join(chatRoot, "workspace");
        await mkdir(chatRoot, { recursive: true });
        await mkdir(outside);
        await symlink(outside, workspace);
        const response = chunkedResponse([new TextEncoder().encode("secret")]);
        await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect((await firstMessageAttachment(dataDir)).failure).toMatch(/download failed/);
        expect(await readFile(path.join(outside, "attachments", "2023-11-14", "7", "report.txt")).catch(() => undefined)).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("Telegram location and venue updates", () => {
  async function sendLocationUpdate(dataDir: string, message: Record<string, unknown>): Promise<Mock> {
    const prompt = vi.fn(async () => undefined);
    const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 } });
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
    await flushTelegramIngress(bot);
    return prompt;
  }

  it("records a shared location as a message event and wakes the agent", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = await sendLocationUpdate(dataDir, { location: { latitude: 52.52, longitude: 13.405 } });
      expect(prompt).toHaveBeenCalledWith(42, ".");
      expect(await messageEvent(dataDir)).toMatchObject({ type: "message", message: { message_id: 7, location: { latitude: 52.52, longitude: 13.405 } }, attachments: [] });
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
      expect(prompt).toHaveBeenCalledWith(42, ".");
      expect(await messageEvent(dataDir)).toMatchObject({ type: "message", message: { message_id: 7, venue: { title: "Brandenburg Gate", address: "Pariser Platz 1" } }, attachments: [] });
    });
  });
});
describe("Telegram rich messages", () => {
  it("sends a rich message with markup, keyboard, and reply target", async () => {
    const bot = fakeBot();
    await expect(sendTelegramRichMessage(bot, 42, {
      version: 1,
      id: "rich-1",
      type: "send_message",
      text: "<b>hi</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 7,
    })).resolves.toBe(123);
    const sendMessage = bot.api.sendMessage as unknown as ReturnType<typeof vi.fn>;
    expect(sendMessage).toHaveBeenCalledWith(42, "<b>hi</b>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      reply_to_message_id: 7,
    });
  });

  it("resends malformed markup as plain text and keeps the message fields", async () => {
    const bot = fakeBot();
    const sendMessage = bot.api.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockRejectedValueOnce(new GrammyError(
      "Bad Request: can't parse entities",
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      "sendMessage",
      { chat_id: 42, text: "<b>hi</b>", parse_mode: "HTML" },
    ));
    await expect(sendTelegramRichMessage(bot, 42, {
      version: 1,
      id: "rich-2",
      type: "send_message",
      text: "<b>hi</b>",
      parse_mode: "HTML",
      reply_to_message_id: 7,
    })).resolves.toBe(123);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]).toEqual([42, "<b>hi</b>", { reply_to_message_id: 7 }]);
  });

  it("propagates non-parse failures without a plain retry", async () => {
    const bot = fakeBot();
    const sendMessage = bot.api.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockRejectedValueOnce(new GrammyError(
      "Bad Request: chat not found",
      { ok: false, error_code: 400, description: "Bad Request: chat not found" },
      "sendMessage",
      { chat_id: 42, text: "<b>hi</b>", parse_mode: "HTML" },
    ));
    await expect(sendTelegramRichMessage(bot, 42, { version: 1, id: "rich-3", type: "send_message", text: "<b>hi</b>", parse_mode: "HTML" })).rejects.toThrow("chat not found");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("passes entities, link preview options, and notifications to sendMessage", async () => {
    const bot = fakeBot();
    await expect(sendTelegramRichMessage(bot, 42, {
      version: 1,
      id: "rich-4",
      type: "send_message",
      text: "hi",
      entities: [{ type: "bold", offset: 0, length: 2 }],
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    })).resolves.toBe(123);
    const sendMessage = bot.api.sendMessage as unknown as Mock;
    expect(sendMessage).toHaveBeenCalledWith(42, "hi", {
      entities: [{ type: "bold", offset: 0, length: 2 }],
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    });
  });
});

describe("Telegram message editing and deletion", () => {
  it("edits a message and returns the edited message id", async () => {
    const bot = fakeBot();
    await expect(sendTelegramEditMessage(bot, 42, {
      version: 1,
      id: "edit-1",
      type: "edit_message",
      message_id: 7,
      text: "<b>updated</b>",
      parse_mode: "HTML",
      entities: [{ type: "bold", offset: 0, length: 3 }],
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    })).resolves.toBe(123);
    const editMessageText = bot.api.editMessageText as unknown as Mock;
    expect(editMessageText).toHaveBeenCalledWith(42, 7, "<b>updated</b>", {
      parse_mode: "HTML",
      entities: [{ type: "bold", offset: 0, length: 3 }],
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    });
  });

  it("resends a malformed edit as plain text", async () => {
    const bot = fakeBot();
    const editMessageText = bot.api.editMessageText as unknown as Mock;
    editMessageText.mockRejectedValueOnce(new GrammyError(
      "Bad Request: can't parse entities",
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      "editMessageText",
      { chat_id: 42, message_id: 7, text: "<b>updated</b>", parse_mode: "HTML" },
    ));
    await expect(sendTelegramEditMessage(bot, 42, {
      version: 1,
      id: "edit-2",
      type: "edit_message",
      message_id: 7,
      text: "<b>updated</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    })).resolves.toBe(123);
    expect(editMessageText).toHaveBeenCalledTimes(2);
    expect(editMessageText.mock.calls[1]).toEqual([42, 7, "<b>updated</b>", {
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    }]);
  });

  it("deletes a message through the Bot API", async () => {
    const bot = fakeBot();
    await expect(deleteTelegramMessage(bot, 42, 7)).resolves.toBeUndefined();
    const deleteMessage = bot.api.deleteMessage as unknown as Mock;
    expect(deleteMessage).toHaveBeenCalledWith(42, 7);
  });
});

describe("Telegram callback queries", () => {
  function callbackUpdate(fromId: number, data: string) {
    return {
      update_id: 2,
      callback_query: {
        id: "cb-1",
        from: { id: fromId, is_bot: false, first_name: "Test" },
        message: {
          message_id: 7,
          date: 1_700_000_000,
          chat: { id: 42, type: "private" },
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
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(callbackUpdate(42, "do_thing") as never);
      await flushTelegramIngress(bot);
      expect(prompt).toHaveBeenCalledWith(42, ".");
      expect(sentRequests.some((request) => request.url.endsWith("/answerCallbackQuery"))).toBe(true);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "callback"));
      expect(events.find((event) => event.type === "callback")).toMatchObject({ type: "callback", callback_query: { data: "do_thing", message: { message_id: 7 } } });
    });
  });

  it("rejects unauthorized button presses without a callback event", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(callbackUpdate(999, "do_thing") as never);
      await flushTelegramIngress(bot);
      expect(prompt).not.toHaveBeenCalled();
      expect(sentRequests.some((request) => request.url.endsWith("/answerCallbackQuery"))).toBe(false);
      expect((await readChatEvents(dataDir)).some((event) => event.type === "callback")).toBe(false);
    });
  });

  it("embeds the raw callback query in the callback event", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 }, recordRequests: true });
      await bot.handleUpdate(callbackUpdate(42, "x".repeat(100)) as never);
      await flushTelegramIngress(bot);
      expect(prompt).toHaveBeenCalledWith(42, ".");
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "callback"));
      expect(events.find((event) => event.type === "callback")).toMatchObject({ type: "callback", callback_query: { data: "x".repeat(100) } });
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

  it("logs a text message event and wakes the agent with the wake prompt", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate(textUpdate("hello") as never);
      await flushTelegramIngress(bot);
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "message"));
      expect(events.find((event) => event.type === "message")).toMatchObject({ type: "message", message: { message_id: 7, text: "hello" } });
      expect(prompt).toHaveBeenCalledWith(42, ".");
    });
  });
});





describe("Telegram locations, polls, and reactions", () => {
  it("sends a location pin with optional fields", async () => {
    const bot = fakeBot();
    await expect(sendTelegramLocation(bot, 42, {
      version: 1,
      id: "loc-1",
      type: "send_location",
      latitude: 52.52,
      longitude: 13.405,
      heading: 180,
      live_period: 120,
    })).resolves.toBe(123);
    const sendLocation = bot.api.sendLocation as unknown as ReturnType<typeof vi.fn>;
    expect(sendLocation).toHaveBeenCalledWith(42, 52.52, 13.405, { heading: 180, live_period: 120 });
  });

  it("sends a venue when venue fields are present", async () => {
    const bot = fakeBot();
    await expect(sendTelegramLocation(bot, 42, {
      version: 1,
      id: "loc-2",
      type: "send_location",
      latitude: 52.5163,
      longitude: 13.3777,
      venue: { title: "Brandenburg Gate", address: "Pariser Platz 1" },
    })).resolves.toBe(123);
    expect(bot.api.sendVenue as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(42, 52.5163, 13.3777, "Brandenburg Gate", "Pariser Platz 1");
    expect(bot.api.sendLocation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("sends a venue with reply and notification options", async () => {
    const bot = fakeBot();
    await expect(sendTelegramLocation(bot, 42, {
      version: 1,
      id: "loc-3",
      type: "send_location",
      latitude: 52.5163,
      longitude: 13.3777,
      venue: { title: "Brandenburg Gate", address: "Pariser Platz 1" },
      reply_to_message_id: 9,
      disable_notification: true,
    })).resolves.toBe(123);
    expect(bot.api.sendVenue as unknown as Mock).toHaveBeenCalledWith(42, 52.5163, 13.3777, "Brandenburg Gate", "Pariser Platz 1", { reply_to_message_id: 9, disable_notification: true });
    expect(bot.api.sendLocation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("sends a poll and returns its message and poll ids", async () => {
    const bot = fakeBot();
    await expect(sendTelegramPoll(bot, 42, {
      version: 1,
      id: "poll-1",
      type: "send_poll",
      question: "Pick one",
      options: ["a", "b"],
      is_anonymous: false,
      poll_type: "quiz",
      correct_option_id: 1,
    })).resolves.toEqual({ messageId: 123, pollId: "poll-9" });
    expect(bot.api.sendPoll as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(42, "Pick one", ["a", "b"], {
      is_anonymous: false,
      type: "quiz",
      correct_option_id: 1,
    });
  });

  it("stops a poll and returns the final poll", async () => {
    const bot = fakeBot();
    const poll = await stopTelegramPoll(bot, 42, 123);
    expect(poll.id).toBe("poll-9");
    expect(bot.api.stopPoll as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(42, 123, undefined);
  });

  it("sets and clears reactions", async () => {
    const bot = fakeBot();
    await sendTelegramReaction(bot, 42, 123, [
      { type: "emoji", emoji: "👍" },
      { type: "custom_emoji", custom_emoji_id: "custom-1" },
    ]);
    const setReaction = bot.api.setMessageReaction as unknown as Mock;
    expect(setReaction).toHaveBeenCalledWith(42, 123, [
      { type: "emoji", emoji: "👍" },
      { type: "custom_emoji", custom_emoji_id: "custom-1" },
    ]);
    await sendTelegramReaction(bot, 42, 123, []);
    expect(setReaction.mock.calls[1]).toEqual([42, 123, []]);
  });
});

describe("Telegram poll answers", () => {
  it("records a poll answer event for the owning chat without waking", async () => {
    await withWorkspace(async (dataDir) => {
      await recordPollOwner(dataDir, 42, "poll-9", 77);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-9",
          user: { id: 42, is_bot: false, first_name: "Test" },
          option_ids: [1, 2],
        },
      } as never);
      await flushTelegramIngress(bot);
      expect(prompt).not.toHaveBeenCalled();
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "poll_answer"));
      expect(events.find((event) => event.type === "poll_answer")).toMatchObject({
        type: "poll_answer",
        poll_answer: {
          poll_id: "poll-9",
          option_ids: [1, 2],
        },
      });
    });
  });

  it("skips corrupt or non-object registry lines while resolving owners", async () => {
    await withWorkspace(async (dataDir) => {
      const storePath = path.join(dataDir, "poll-owners.jsonl");
      await writeFile(storePath, "null\nnot json\n{\"pollId\":\"poll-9\",\"chatId\":\"42\"}\n", "utf8");
      await recordPollOwner(dataDir, 42, "poll-9", 77);
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-9",
          user: { id: 42, is_bot: false, first_name: "Test" },
          option_ids: [0],
        },
      } as never);
      await flushTelegramIngress(bot);
      expect(prompt).not.toHaveBeenCalled();
      const events = await waitForChatEvents(dataDir, (events) => events.some((event) => event.type === "poll_answer"));
      expect(events.find((event) => event.type === "poll_answer")).toMatchObject({
        type: "poll_answer",
        poll_answer: {
          poll_id: "poll-9",
          option_ids: [0],
        },
      });
      });
    });

  it("drops poll answers from unknown polls", async () => {
    await withWorkspace(async (dataDir) => {
      const prompt = vi.fn(async () => undefined);
      const bot = await makeTestBot(dataDir, { prompt }, { fetchResult: { message_id: 555 } });
      await bot.handleUpdate({
        update_id: 3,
        poll_answer: {
          poll_id: "poll-missing",
          user: { id: 42, is_bot: false, first_name: "Test" },
          option_ids: [0],
        },
      } as never);
      await flushTelegramIngress(bot);
      expect(prompt).not.toHaveBeenCalled();
      expect((await readChatEvents(dataDir)).some((event) => event.type === "poll_answer")).toBe(false);
    });
  });
});

describe("Telegram command formatting", () => {
  it("numbers models, marks the current one, and handles empty lists", () => {
    expect(formatModelList([], undefined)).toBe("No models available.");
    expect(formatModelList([
      { provider: "openrouter", id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
      { provider: "anthropic", id: "claude-3-5-sonnet" },
    ], { provider: "anthropic", id: "claude-3-5-sonnet" })).toBe(
      "1. openrouter/deepseek/deepseek-chat — DeepSeek Chat\n2. anthropic/claude-3-5-sonnet (current)",
    );
  });

  it("numbers thinking levels, marks the current one, and handles empty lists", () => {
    expect(formatThinkingLevels([], undefined)).toBe("No thinking levels available.");
    expect(formatThinkingLevels(["low", "medium", "high"], "medium")).toBe(
      "1. low\n2. medium (current)\n3. high",
    );
  });

  it("formats session state on one line", () => {
    expect(formatStatus({
      model: { provider: "openrouter", id: "deepseek/deepseek-chat" },
      thinkingLevel: "medium",
      sessionId: "42",
      sessionFile: "42.jsonl",
      messageCount: 7,
      autoCompactionEnabled: true,
    })).toBe("Model: openrouter/deepseek/deepseek-chat | Thinking: medium | Session: 42.jsonl | Messages: 7");
    expect(formatStatus({
      thinkingLevel: "low",
      sessionId: "42",
      messageCount: 0,
      autoCompactionEnabled: false,
    })).toBe("Model: unset | Thinking: low | Session: 42 | Messages: 0");
  });
});

describe("Telegram commands", () => {
  const defaultStatus = {
    model: undefined,
    thinkingLevel: "medium",
    sessionId: "42",
    sessionFile: undefined,
    messageCount: 0,
    autoCompactionEnabled: true,
  };

  type FakeAgents = {
    prompt: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
    getAvailableModels: ReturnType<typeof vi.fn>;
    getAvailableThinkingLevels: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    setThinkingLevel: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
  };

  function makeAgents(overrides: Partial<FakeAgents> = {}): FakeAgents {
    return {
      prompt: vi.fn(async () => undefined),
      newSession: vi.fn(async () => {}),
      getAvailableModels: vi.fn(async () => []),
      getAvailableThinkingLevels: vi.fn(async () => []),
      status: vi.fn(async () => defaultStatus),
      setModel: vi.fn(async () => {}),
      setThinkingLevel: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ...overrides,
    };
  }

  function commandLength(text: string): number {
    const end = text.search(/[\s@]/);
    return end === -1 ? text.length : end;
  }

  async function sendCommand(bot: Bot, text: string, fromId = 42): Promise<void> {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: fromId, type: "private" },
        from: { id: fromId, is_bot: false, first_name: "Test" },
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

  it("rejects unauthorized users before running command handlers", async () => {
    const agents = makeAgents();
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/status", 999);
    expect(replies(bot)).toEqual(["Unauthorized."]);
    expect(agents.status).not.toHaveBeenCalled();
  });

  it("/start sends the personal-agent help text", async () => {
    const agents = makeAgents();
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/start");
    expect(replies(bot)).toEqual([
      "Personal agent. Send text, attachments, or a location pin to continue your persistent session, or /new to start a fresh one.",
    ]);
  });

  it("rejects unauthorized /start and /new before running handlers", async () => {
    const agents = makeAgents();
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/start", 999);
    await sendCommand(bot, "/new", 999);
    expect(replies(bot)).toEqual(["Unauthorized.", "Unauthorized."]);
    expect(agents.newSession).not.toHaveBeenCalled();
  });

  it("/new starts a new session and confirms", async () => {
    const newSession = vi.fn(async () => {});
    const agents = makeAgents({ newSession });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/new");
    expect(newSession).toHaveBeenCalledWith(42);
    expect(replies(bot)).toEqual([
      "Started a new session. Earlier session files remain searchable.",
    ]);
  });

  it("/new reports a friendly failure when newSession rejects", async () => {
    const newSession = vi.fn(async () => { throw new Error("boom"); });
    const agents = makeAgents({ newSession });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/new");
    expect(replies(bot)).toEqual([
      "I could not start a new session. Please try again.",
    ]);
  });

  it("delivers /new and /status replies in command order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agents = makeAgents({ newSession: vi.fn(() => gate) });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });

    const newDone = sendCommand(bot, "/new");
    const statusDone = sendCommand(bot, "/status");
    release();
    await Promise.all([newDone, statusDone]);

    expect(replies(bot)).toEqual([
      "Started a new session. Earlier session files remain searchable.",
      "Model: unset | Thinking: medium | Session: 42 | Messages: 0",
    ]);
  });

  it("/model lists available models with the current one marked", async () => {
    const agents = makeAgents({
      getAvailableModels: vi.fn(async () => [
        { provider: "openrouter", id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
        { provider: "anthropic", id: "claude-3-5-sonnet" },
      ]),
      status: vi.fn(async () => ({ ...defaultStatus, model: { provider: "anthropic", id: "claude-3-5-sonnet" } })),
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/model");
    expect(replies(bot)).toEqual([
      "1. openrouter/deepseek/deepseek-chat — DeepSeek Chat\n2. anthropic/claude-3-5-sonnet (current)",
    ]);
  });

  it("/model sets a uniquely matched model", async () => {
    const setModel = vi.fn(async () => {});
    const agents = makeAgents({
      getAvailableModels: vi.fn(async () => [
        { provider: "openrouter", id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
        { provider: "anthropic", id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
      ]),
      setModel,
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/model claude");
    expect(setModel).toHaveBeenCalledWith(42, "anthropic", "claude-3-5-sonnet");
    expect(replies(bot)).toEqual(["Model set to anthropic/claude-3-5-sonnet."]);
  });

  it("/model lists matches when the query is ambiguous", async () => {
    const agents = makeAgents({
      getAvailableModels: vi.fn(async () => [
        { provider: "openrouter", id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
        { provider: "openrouter", id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner" },
      ]),
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/model deepseek");
    expect(agents.setModel).not.toHaveBeenCalled();
    expect(replies(bot)[0]).toContain('Multiple models match "deepseek":');
  });

  it("/model reports when nothing matches", async () => {
    const agents = makeAgents({
      getAvailableModels: vi.fn(async () => [
        { provider: "openrouter", id: "deepseek/deepseek-chat" },
      ]),
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/model nonexistent");
    expect(replies(bot)).toEqual(['No model matches "nonexistent".']);
  });

  it("/thinking lists levels with the current one marked", async () => {
    const agents = makeAgents({
      getAvailableThinkingLevels: vi.fn(async () => ["low", "medium", "high"]),
      status: vi.fn(async () => ({ ...defaultStatus, thinkingLevel: "medium" })),
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/thinking");
    expect(replies(bot)).toEqual(["1. low\n2. medium (current)\n3. high"]);
  });

  it("/thinking sets a valid level", async () => {
    const setThinkingLevel = vi.fn(async () => {});
    const agents = makeAgents({
      getAvailableThinkingLevels: vi.fn(async () => ["low", "high"]),
      setThinkingLevel,
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/thinking high");
    expect(setThinkingLevel).toHaveBeenCalledWith(42, "high");
    expect(replies(bot)).toEqual(["Thinking level set to high."]);
  });

  it("/thinking rejects an invalid level and lists valid ones", async () => {
    const agents = makeAgents({
      getAvailableThinkingLevels: vi.fn(async () => ["low", "high"]),
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/thinking extreme");
    expect(agents.setThinkingLevel).not.toHaveBeenCalled();
    expect(replies(bot)).toEqual(['Unknown thinking level "extreme". Valid levels: low, high.']);
  });

  it("/status reports the session state", async () => {
    const agents = makeAgents({
      status: vi.fn(async () => ({
        model: { provider: "openrouter", id: "deepseek/deepseek-chat" },
        thinkingLevel: "medium",
        sessionId: "42",
        sessionFile: "42.jsonl",
        messageCount: 7,
        autoCompactionEnabled: true,
      })),
    });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/status");
    expect(replies(bot)).toEqual([
      "Model: openrouter/deepseek/deepseek-chat | Thinking: medium | Session: 42.jsonl | Messages: 7",
    ]);
  });

  it("/restart restarts the agent and confirms", async () => {
    const restart = vi.fn(async () => {});
    const agents = makeAgents({ restart });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/restart");
    expect(restart).toHaveBeenCalledWith(42);
    expect(replies(bot)).toEqual(["Restarting agent…", "Agent restarted."]);
  });

  it("/restart reports a friendly failure", async () => {
    const restart = vi.fn(async () => { throw new Error("Pi worker is busy"); });
    const agents = makeAgents({ restart });
    const bot = await makeTestBot("/tmp/ignored", agents, { recordRequests: true });
    await sendCommand(bot, "/restart");
    expect(replies(bot)).toEqual(["Restarting agent…", "I could not restart the agent. Please try again."]);
  });
});