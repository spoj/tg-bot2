import { expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager, extractFinalAssistantText } from "../src/agent.js";
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
  const config: Config = {
    token: "token",
    allowedUserIds: new Set([1]),
    dataDir: "/tmp/tg-bot2-test",
    thinking: "medium",
    toolTimeoutMs: 1_000,
    maxToolOutputBytes: 1_000,
  };
  const manager = new AgentManager(config, async () => session);

  const first = manager.prompt(1, "first batch");
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  const steered = manager.prompt(1, "second batch");
  await expect(steered).resolves.toBeUndefined();
  expect(prompt).toHaveBeenNthCalledWith(2, "second batch", { streamingBehavior: "steer" });
  finishFirst();
  await expect(first).resolves.toBe("combined");
});
