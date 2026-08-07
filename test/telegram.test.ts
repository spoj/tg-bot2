import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, mkdir, open as openFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { Bot } from "grammy";
import {
  formatBufferedPrompt,
  sendTelegramText,
  sendWorkspaceFile,
  splitTelegramText,
  TelegramIngressBuffer,
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

it("buffers all updates until two seconds of quiet and replies only once", async () => {
  vi.useFakeTimers();
  try {
    const batches: BufferedTelegramMessage[][] = [];
    const replies: string[] = [];
    const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
      batches.push(messages);

      return "combined response";
    }, 2_000);
    const makeEntry = (messageId: number) => ({
      value: Promise.resolve({ messageId, text: `m${messageId}`, attachments: [] }),
      respond: async (text: string) => { replies.push(text); },
      typing: async () => {},
    });

    buffer.add(7, makeEntry(1));
    await vi.advanceTimersByTimeAsync(1_500);
    buffer.add(7, makeEntry(2));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(batches).toEqual([[
      { messageId: 1, text: "m1", attachments: [] },
      { messageId: 2, text: "m2", attachments: [] },
    ]]);
    expect(replies).toEqual(["combined response"]);
  } finally {
    vi.useRealTimers();
  }
});
it("drops pending ingress after shutdown close", async () => {
  const batches: BufferedTelegramMessage[][] = [];
  const buffer = new TelegramIngressBuffer(async (_chatId, messages) => {
    batches.push(messages);
    return "should not run";
  }, 2_000);
  buffer.add(7, {
    value: Promise.resolve({ messageId: 1, text: "pending", attachments: [] }),
    respond: async () => {},
    typing: async () => {},
  });
  buffer.close();
  await buffer.flushAll();
  expect(batches).toEqual([]);
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
