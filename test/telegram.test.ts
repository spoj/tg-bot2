import { describe, expect, it, vi } from "vitest";
import {
  formatBufferedPrompt,
  splitTelegramText,
  TelegramIngressBuffer,
  type BufferedTelegramMessage,
} from "../src/telegram.js";

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
