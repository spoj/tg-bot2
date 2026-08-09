import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, mkdir, open as openFile, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { Bot } from "grammy";
import {
  closeTelegramIngress,
  createTelegramBot,
  flushTelegramIngress,
  formatBufferedPrompt,
  sendTelegramText,
  sendWorkspaceFile,
  splitTelegramText,
  TelegramDeliveryQueue,
  TelegramIngressBuffer,
  type TelegramBatchResult,
  type BufferedTelegramMessage,
} from "../src/telegram.js";

const execFile = promisify(execFileCallback);
function fakeBot() {
  return {
    api: {
      sendDocument: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
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

async function runAttachmentFixture(
  dataDir: string,
  fetchImplementation: typeof fetch,
  fileName = "report.txt",
  getFileImplementation: () => Promise<{ file_id: string; file_path?: string }> = async () => ({ file_id: "file-id", file_path: "documents/remote.bin" }),
  beforeUpdate?: (bot: Bot) => void,
): Promise<ReturnType<typeof vi.fn>> {
  const prompt = vi.fn(async () => undefined);
  const bot = createTelegramBot({
    token: "test-token",
    allowedUserIds: new Set([42]),
    dataDir,
  }, {
    prompt,
    setAssistantProgress: vi.fn(),
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

it("formats ordered text, attachment metadata, and failures", () => {
  expect(formatBufferedPrompt([
    { messageId: 10, text: "first", attachments: [] },
    {
      messageId: 11,
      text: "caption",
      attachments: [{
        type: "document",
        path: "/workspace/attachments/2026-01-02/11/report.pdf",
        mimeType: "application/pdf",
        originalName: "report.pdf",
      }],
    },
    {
      messageId: 12,
      attachments: [{ type: "voice", mimeType: "audio/ogg", failure: "download failed" }],
    },
  ])).toBe(`Telegram message 10:
first

Telegram message 11:
caption
Attachment: /workspace/attachments/2026-01-02/11/report.pdf (type=document, MIME=application/pdf, original name="report.pdf")

Telegram message 12:
Attachment download failed (type=voice, MIME=audio/ogg): download failed`);
});

describe("TelegramIngressBuffer", () => {
  const message = (messageId: number): BufferedTelegramMessage => ({
    messageId,
    text: `m${messageId}`,
    attachments: [],
  });

  const entry = (messageId: number, respond: (text: string) => void | Promise<void> = async () => {}) => ({
    value: Promise.resolve(message(messageId)),
    respond,
    typing: async () => {},
  });

  it("batches a quiet window and gives the latest entry ownership", async () => {
    vi.useFakeTimers();
    try {
      const batches: BufferedTelegramMessage[][] = [];
      const replies: string[] = [];
      const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
        batches.push(messages);
        return { kind: "reply", text: "combined response" };
      }, 2_000);

      expect(buffer.add(7, entry(1, (text) => { replies.push(`one:${text}`); })).kind).toBe("accepted");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(buffer.add(7, entry(2, (text) => { replies.push(`two:${text}`); })).kind).toBe("accepted");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(batches).toEqual([[message(1), message(2)]]);
      expect(replies).toEqual(["two:combined response"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pre-barrier messages before admitting post-barrier work", async () => {
    const batches: number[][] = [];
    const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
      batches.push(messages.map(({ messageId }) => messageId));
      return { kind: "no-reply", reason: "steered" };
    }, 60_000);

    buffer.add(7, entry(1));
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry(2));
    await buffer.flush(7);
    expect(batches).toEqual([[1]]);

    barrier.release();
    await buffer.flush(7);
    expect(batches).toEqual([[1], [2]]);
  });

  it("defers post-barrier admission while an earlier batch is active", async () => {
    const batches: number[][] = [];
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
      batches.push(messages.map(({ messageId }) => messageId));
      if (batches.length === 1) {
        resolveFirstStarted();
        await firstFinished;
      }
      return { kind: "no-reply", reason: "steered" };
    }, 60_000);

    buffer.add(7, entry(1));
    const first = buffer.flush(7);
    await firstStarted;
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry(2));
    const beforeRelease = buffer.flush(7);
    expect(batches).toEqual([[1]]);

    releaseFirst();
    await Promise.all([first, beforeRelease]);
    expect(batches).toEqual([[1]]);
    barrier.release();
    await buffer.flush(7);
    expect(batches).toEqual([[1], [2]]);
  });

  it("releases the barrier when starting a new session fails", async () => {
    const batches: number[][] = [];
    const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
      batches.push(messages.map(({ messageId }) => messageId));
      return { kind: "no-reply", reason: "steered" };
    }, 60_000);
    const newSession = vi.fn(async () => {
      throw new Error("session failed");
    });

    buffer.add(7, entry(1));
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry(2));
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
    expect(batches).toEqual([[1], [2]]);
  });

  it("drains accepted barrier work after close and release", async () => {
    const batches: number[][] = [];
    const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
      batches.push(messages.map(({ messageId }) => messageId));
      return { kind: "no-reply", reason: "steered" };
    }, 60_000);
    const barrier = buffer.acquireBarrier(7);
    buffer.add(7, entry(1));

    buffer.close();
    barrier.release();
    await buffer.flushAll();
    expect(batches).toEqual([[1]]);
  });
  it("serializes overlapping batches in FIFO order even when later work completes first", async () => {
    const completions: Array<() => void> = [];
    const callbacks: number[] = [];
    const replies: string[] = [];
    let resolveFirstStarted!: () => void;
    let resolveSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve; });
    const buffer = new TelegramIngressBuffer((_chatId, messages) => new Promise<TelegramBatchResult>((resolve) => {
      const messageId = messages[0]!.messageId;
      callbacks.push(messageId);
      if (messageId === 1) resolveFirstStarted();
      else resolveSecondStarted();
      completions.push(() => resolve({ kind: "reply", text: `reply-${messageId}` }));
    }), 60_000);

    buffer.add(7, entry(1, (text) => { replies.push(text); }));
    const first = buffer.flush(7);
    await firstStarted;
    buffer.add(7, entry(2, (text) => { replies.push(text); }));
    const second = buffer.flush(7);
    expect(callbacks).toEqual([1]);
    completions[0]!();
    await secondStarted;
    expect(callbacks).toEqual([1, 2]);
    expect(replies).toEqual(["reply-1"]);
    completions[1]!();
    await Promise.all([first, second]);
    expect(replies).toEqual(["reply-1", "reply-2"]);
  });

  it("keeps accepted pending work deliverable after close", async () => {
    const replies: string[] = [];
    const buffer = new TelegramIngressBuffer(async () => ({ kind: "reply", text: "pending" }), 60_000);
    buffer.add(7, entry(1, (text) => { replies.push(text); }));
    buffer.close();
    await buffer.flushAll();
    expect(replies).toEqual(["pending"]);
  });

  it("does not suppress an in-flight delivery when closing", async () => {
    let responseStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { responseStarted = resolve; });
    let releaseResponse!: () => void;
    const responseFinished = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let attempts = 0;
    const buffer = new TelegramIngressBuffer(async () => ({ kind: "reply", text: "in flight" }), 60_000);
    buffer.add(7, entry(1, () => {
      attempts += 1;
      responseStarted();
      return responseFinished;
    }));
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
    const buffer = new TelegramIngressBuffer(async () => ({ kind: "no-reply", reason: "steered" }));
    buffer.close();
    expect(buffer.add(7, entry(1))).toEqual({ kind: "quiesced", reason: "closed" });
  });
  it("does not block batch processing on deferred initial typing", async () => {
    let releaseTyping!: () => void;
    const deferredTyping = new Promise<void>((resolve) => { releaseTyping = resolve; });
    let typingStarted = false;
    const replies: string[] = [];
    const buffer = new TelegramIngressBuffer(async () => ({ kind: "reply", text: "reply" }), 60_000);
    buffer.add(7, {
      value: Promise.resolve(message(1)),
      respond: (text) => { replies.push(text); },
      typing: () => {
        typingStarted = true;
        return deferredTyping;
      },
    });

    await buffer.flushAll();
    expect(typingStarted).toBe(true);
    expect(replies).toEqual(["reply"]);
    releaseTyping();
  });

  it("does not deliver a reply for a steered batch", async () => {
    let attempts = 0;
    const buffer = new TelegramIngressBuffer(async () => ({ kind: "no-reply", reason: "steered" }));
    buffer.add(7, entry(1, () => { attempts += 1; }));
    await buffer.flushAll();
    expect(attempts).toBe(0);
  });

  it("flushAll drains work admitted while an earlier batch is running", async () => {
    const replies: string[] = [];
    let calls = 0;
    const buffer = new TelegramIngressBuffer(async () => {
      calls += 1;
      if (calls === 1) {
        buffer.add(7, entry(2, (text) => { replies.push(text); }));
        return { kind: "reply", text: "first" };
      }
      return { kind: "reply", text: "second" };
    }, 60_000);
    buffer.add(7, entry(1, (text) => { replies.push(text); }));
    await buffer.flushAll();
    expect(replies).toEqual(["first", "second"]);
  });

  it("uses one fallback for model failures and never retries response delivery", async () => {
    const fallbackReplies: string[] = [];
    const failingModel = new TelegramIngressBuffer(async () => {
      throw new Error("model failed");
    });
    failingModel.add(7, entry(1, (text) => { fallbackReplies.push(text); }));
    await failingModel.flushAll();
    expect(fallbackReplies).toEqual(["I could not complete that request. Please try again."]);

    const sendAttempts: string[] = [];
    const failingSend = new TelegramIngressBuffer(async () => ({ kind: "reply", text: "reply" }));
    failingSend.add(7, entry(1, () => {
      sendAttempts.push("attempt");
      throw new Error("send failed");
    }));
    await failingSend.flushAll();
    expect(sendAttempts).toEqual(["attempt"]);
  });

  it("catches synchronous callback throws without leaking a rejection", async () => {
    const replies: string[] = [];
    const buffer = new TelegramIngressBuffer(() => {
      throw new Error("synchronous handler failure");
    });
    buffer.add(7, entry(1, (text) => { replies.push(text); }));
    await expect(buffer.flushAll()).resolves.toBeUndefined();
    expect(replies).toHaveLength(1);
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
    })).resolves.toBe("Sent report.txt.");

    const sendDocument = bot.api.sendDocument as unknown as ReturnType<typeof vi.fn>;
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(sendDocument.mock.calls[0]?.[0]).toBe(42);
    expect(sendDocument.mock.calls[0]?.[2]).toEqual({ caption: Array.from(caption).slice(0, 1_024).join("") });
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

it("exports chunked text delivery through the Bot API", async () => {
  const bot = fakeBot();
  const text = "a".repeat(4_001);
  await sendTelegramText(bot, 9, text);
  const sendMessage = bot.api.sendMessage as unknown as ReturnType<typeof vi.fn>;
  expect(sendMessage.mock.calls.map(([chatId, chunk]) => [chatId, chunk])).toEqual(
    splitTelegramText(text).map((chunk) => [9, chunk]),
  );
});

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
        const prompt = await fixture;
        expect(getFile).toHaveBeenCalledOnce();
        expect(prompt.mock.calls[0]?.[1]).toMatch(/download timed out/);
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("aborts and cancels bodies rejected by response headers", async () => {
    try {
      await withWorkspace(async (dataDir) => {
        for (const testCase of [
          { status: 503, headers: undefined, failure: /HTTP 503/ },
          { status: 200, headers: { "content-length": String(20 * 1024 * 1024 + 1) }, failure: /20 MB/ },
        ]) {
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
          const prompt = await runAttachmentFixture(dataDir, fetchMock as unknown as typeof fetch);
          expect(prompt.mock.calls[0]?.[1]).toMatch(testCase.failure);
          expect(signal?.aborted).toBe(true);
          expect(cancelled).toBe(true);
        }
      });
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
        const prompt = await fixture;
        expect(signal?.aborted).toBe(true);
        expect(prompt.mock.calls[0]?.[1]).toMatch(/download timed out/);
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
        const prompt = await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect(prompt.mock.calls[0]?.[1]).toMatch(/20 MB/);
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
        const prompt = await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect(prompt.mock.calls[0]?.[1]).toMatch(/20 MB/);
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
        const prompt = await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        const destination = path.join(dataDir, "chats", "42", "workspace", "attachments", "2023-11-14", "7", "report.txt");
        expect(await readFile(destination, "utf8")).toBe("hello telegram");
        expect(prompt.mock.calls[0]?.[1]).toMatch(/text\/plain/);
        expect(prompt.mock.calls[0]?.[1]).toMatch(/report\.txt/);
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
        const prompt = await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect(replaced).toBe(true);
        expect(prompt.mock.calls[0]?.[1]).toMatch(/download failed/);
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
        const prompt = await runAttachmentFixture(dataDir, vi.fn(async () => chunkedResponse([new TextEncoder().encode("hello")])) as unknown as typeof fetch, fileName);
        expect(prompt.mock.calls[0]?.[1]).not.toMatch(/download failed/);
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
        const prompt = await runAttachmentFixture(dataDir, vi.fn(async () => response) as unknown as typeof fetch);
        expect(prompt.mock.calls[0]?.[1]).toMatch(/download failed/);
        expect(await readFile(path.join(outside, "attachments", "2023-11-14", "7", "report.txt")).catch(() => undefined)).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});