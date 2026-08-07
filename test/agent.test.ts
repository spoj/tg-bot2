import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AgentManager,
  extractFinalAssistantText,
  isSessionIdleExpired,
  newestSessionModifiedAt,
} from "../src/agent.js";
import type { Config } from "../src/config.js";

it("extracts only final assistant text blocks and ignores thinking", () => {
  const messages = [
    { role: "assistant", content: "older" },
    { role: "toolResult", content: [{ type: "text", text: "tool" }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "hello " },
      { type: "toolCall", name: "x" },
      { type: "text", text: "world" },
    ] },
  ];
  expect(extractFinalAssistantText(messages)).toBe("hello world");
});

it("supports string content and empty responses", () => {
  expect(extractFinalAssistantText([{ role: "assistant", content: " answer " }])).toBe("answer");
  expect(extractFinalAssistantText([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }])).toBeUndefined();
});

const config: Config = {
  token: "token",
  allowedUserIds: new Set([1]),
  dataDir: "/tmp/tg-bot2-test",
  thinking: "medium",
  toolTimeoutMs: 1_000,
  maxToolOutputBytes: 1_000,
  sessionIdleTimeoutMs: 1_000,
};

function fakeSession(response = "done"): AgentSession {
  const messages: unknown[] = [];
  return {
    messages,
    prompt: vi.fn(async () => { messages.push({ role: "assistant", content: response }); }),
    dispose: vi.fn(),
    abort: vi.fn(),
  } as unknown as AgentSession;
}

it("uses the configured idle boundary", () => {
  expect(isSessionIdleExpired(undefined, 10_000, 1_000)).toBe(false);
  expect(isSessionIdleExpired(9_001, 10_000, 1_000)).toBe(false);
  expect(isSessionIdleExpired(9_000, 10_000, 1_000)).toBe(true);
});

it("finds the newest JSONL modification time and ignores other files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-agent-test-"));
  try {
    const oldSession = path.join(directory, "old.jsonl");
    const newSession = path.join(directory, "new.jsonl");
    const unrelated = path.join(directory, "newer.txt");
    await Promise.all([writeFile(oldSession, ""), writeFile(newSession, ""), writeFile(unrelated, "")]);
    await utimes(oldSession, 1, 1);
    await utimes(newSession, 2, 2);
    await utimes(unrelated, 3, 3);
    expect(await newestSessionModifiedAt(directory)).toBe(2_000);
    expect(await newestSessionModifiedAt(path.join(directory, "missing"))).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("steers a logical request arriving during an active Pi run", async () => {
  let finishFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { finishFirst = resolve; });
  const messages: unknown[] = [];
  const prompt = vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
    if (!options) {
      await firstDone;
      messages.push({ role: "assistant", content: "combined" });
    }
  });
  const session = {
    messages,
    prompt,
    dispose: vi.fn(),
    abort: vi.fn(),
  } as unknown as AgentSession;
  let now = 0;
  const factory = vi.fn(async () => session);
  const manager = new AgentManager(config, factory, {
    now: () => now,
    newestSessionModifiedAt: async () => undefined,
  });

  const first = manager.prompt(1, "first batch");
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  now = 5_000; // Longer than the idle timeout, but the run is still active.
  const steered = manager.prompt(1, "second batch");
  await expect(steered).resolves.toBeUndefined();
  expect(prompt).toHaveBeenNthCalledWith(2, "second batch", { streamingBehavior: "steer" });
  finishFirst();
  await expect(first).resolves.toBe("combined");
  expect(factory).toHaveBeenCalledTimes(1);

  now = 5_999;
  await expect(manager.prompt(1, "still recent after settlement")).resolves.toBe("combined");
  expect(factory).toHaveBeenCalledTimes(1);
});

it("waits for an active run before starting a distinct follow-up prompt", async () => {
  let finishFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { finishFirst = resolve; });
  const messages: unknown[] = [];
  const prompt = vi.fn(async (text: string) => {
    if (text === "first") {
      messages.push({ role: "assistant", content: [{ type: "text", text: "first response" }] });
    } else {
      messages.push({ role: "assistant", content: [{ type: "text", text: "follow-up response" }] });
    }
  });
  const session = { messages, prompt, dispose: vi.fn(), abort: vi.fn() } as unknown as AgentSession;
  const manager = new AgentManager(config, vi.fn(async () => session), { newestSessionModifiedAt: async () => undefined });

  const first = manager.prompt(1, "first");
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  const followUp = manager.prompt(1, "follow-up", "follow-up");
  await Promise.resolve();
  expect(prompt).toHaveBeenCalledTimes(1);
  finishFirst();
  await expect(first).resolves.toBe("first response");
  await expect(followUp).resolves.toBe("follow-up response");
  expect(prompt).toHaveBeenNthCalledWith(2, "follow-up");
});

it("forwards only assistant tool-call progress and unsubscribes replaced sessions", async () => {
  let listener!: (event: unknown) => void;
  const unsubscribe = vi.fn();
  const session = {
    messages: [],
    prompt: vi.fn(async () => { (session.messages as unknown[]).push({ role: "assistant", content: "done" }); }),
    subscribe: vi.fn((callback: (event: unknown) => void) => { listener = callback; return unsubscribe; }),
    dispose: vi.fn(),
    abort: vi.fn(),
  } as unknown as AgentSession;
  const progress = vi.fn();
  const manager = new AgentManager(config, vi.fn(async () => session), {
    assistantProgress: progress,
    newestSessionModifiedAt: async () => undefined,
  });
  await manager.prompt(1, "request");
  listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
  listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working " }, { type: "toolCall", name: "bash" }] } });
  listener({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }, { type: "toolCall" }] } });
  await Promise.resolve();
  expect(progress).toHaveBeenCalledOnce();
  expect(progress).toHaveBeenCalledWith(1, "working");
  await manager.newSession(1);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("extracts the latest assistant result after compaction", async () => {
  const session = fakeSession("new result");
  (session.messages as unknown[]).push({ role: "assistant", content: "old result" });
  vi.mocked(session.prompt).mockImplementationOnce(async () => {
    (session.messages as unknown[]).splice(0, session.messages.length, { role: "assistant", content: "new result" });
  });
  const manager = new AgentManager(config, vi.fn(async () => session), { newestSessionModifiedAt: async () => undefined });
  await expect(manager.prompt(1, "compact")).resolves.toBe("new result");
});

it("continues a recent session but starts fresh for a stale session after restart", async () => {
  const recentFactory = vi.fn(async () => fakeSession());
  const recent = new AgentManager(config, recentFactory, {
    now: () => 10_000,
    newestSessionModifiedAt: async () => 9_001,
  });
  await recent.prompt(1, "recent");
  expect(recentFactory).toHaveBeenCalledWith(expect.objectContaining({ fresh: false }));

  const staleFactory = vi.fn(async () => fakeSession());
  const stale = new AgentManager(config, staleFactory, {
    now: () => 10_000,
    newestSessionModifiedAt: async () => 9_000,
  });
  await stale.prompt(1, "stale");
  expect(staleFactory).toHaveBeenCalledWith(expect.objectContaining({ fresh: true }));
});

it("lazily replaces a session after one idle timeout from settlement", async () => {
  let now = 100;
  const firstSession = fakeSession("first");
  const secondSession = fakeSession("second");
  const factory = vi.fn()
    .mockResolvedValueOnce(firstSession)
    .mockResolvedValueOnce(secondSession);
  const manager = new AgentManager(config, factory, {
    now: () => now,
    newestSessionModifiedAt: async () => undefined,
  });

  await expect(manager.prompt(1, "one")).resolves.toBe("first");
  now = 1_099;
  await expect(manager.prompt(1, "two")).resolves.toBe("first");
  expect(factory).toHaveBeenCalledTimes(1);

  now = 2_099;
  await expect(manager.prompt(1, "three")).resolves.toBe("second");
  expect(firstSession.dispose).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: true }));
});

it("/new waits for active work, creates fresh, and resets idle settlement", async () => {
  let now = 0;
  let finish!: () => void;
  const running = fakeSession("old");
  vi.mocked(running.prompt).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    (running.messages as unknown[]).push({ role: "assistant", content: "old" });
  });
  const fresh = fakeSession("new");
  const factory = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(fresh);
  const manager = new AgentManager(config, factory, {
    now: () => now,
    newestSessionModifiedAt: async () => undefined,
  });

  const prompt = manager.prompt(1, "running");
  await vi.waitFor(() => expect(running.prompt).toHaveBeenCalledOnce());
  const reset = manager.newSession(1);
  await Promise.resolve();
  expect(factory).toHaveBeenCalledTimes(1);
  finish();
  await prompt;
  await reset;
  expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: true }));

  now = 10_000;
  await expect(manager.prompt(1, "after explicit reset")).resolves.toBe("new");
  expect(factory).toHaveBeenCalledTimes(2);
});
