import { expect, it } from "vitest";
import { extractFinalAssistantText } from "../src/agent.js";

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
