import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnector } from "../src/connector.js";
import { ConnectorRegistry } from "../src/connector.js";
import { WorkspaceTimeline } from "../src/events.js";
import { WorkspaceOutbox } from "../src/outbox.js";
import { telegramConversation } from "../src/telegram-ref.js";

const temporaryDirectories: string[] = [];

const actor = telegramConversation("telegram:999", 42, 7);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(send: WorkspaceConnector["send"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-outbox-"));
  temporaryDirectories.push(directory);
  const timelinePath = path.join(directory, "timeline.jsonl");
  await writeFile(timelinePath, "", "utf8");
  const timeline = new WorkspaceTimeline(timelinePath);
  await timeline.start();
  const connector: WorkspaceConnector = {
    id: "telegram:999",
    prompt: "telegram",
    send,
    parseConversation: vi.fn(),
    authorizeConversation: vi.fn(async () => undefined),
    notificationText: vi.fn((_record, rawLine) => rawLine),
  };
  const connectors = new ConnectorRegistry();
  connectors.register(connector);
  return { outbox: new WorkspaceOutbox({ connectors, timeline }), timelinePath };
}

async function events(timelinePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(timelinePath, "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("WorkspaceOutbox", () => {
  it("dispatches through the actor's connector and records the connector result", async () => {
    const attachment = "/run/attachments/dGVsZWdyYW06OTk5/42/2026-08-24/request/report.txt";
    const send = vi.fn<WorkspaceConnector["send"]>(async () => ({
      request: { method: "sendDocument", chat_id: 42, message_thread_id: 7, document: attachment },
      response: { message_id: 9001 },
      attachments: [{ path: attachment }],
      summary: { method: "sendDocument", messageId: 9001, attachments: [attachment] },
    }));
    const { outbox, timelinePath } = await fixture(send);
    const request = { method: "sendDocument", document: "/workspace/report.txt" };

    const result = await outbox.send(request, actor);

    expect(result).toMatchObject({
      requestId: expect.any(String),
      method: "sendDocument",
      messageId: 9001,
      attachments: [attachment],
    });
    expect(send).toHaveBeenCalledWith(request, actor);
    expect(await events(timelinePath)).toMatchObject([{
      v: 2,
      id: expect.any(String),
      seq: 1,
      t: expect.any(String),
      type: "connector.sent",
      connectorId: "telegram:999",
      actor,
      conversation: actor,
      request: { chat_id: 42, message_thread_id: 7, document: attachment },
      response: { message_id: 9001 },
      attachments: [{ path: attachment }],
    }]);
  });

  it("leaves connector-native validation and target resolution to the connector", async () => {
    const send = vi.fn<WorkspaceConnector["send"]>(async (request) => ({ request: request as Record<string, unknown> }));
    const { outbox } = await fixture(send);
    const request = { connector_specific_option: true };

    await outbox.send(request, actor);

    expect(send).toHaveBeenCalledWith(request, actor);
  });

  it("rejects non-object and oversized envelopes before dispatch", async () => {
    const send = vi.fn<WorkspaceConnector["send"]>();
    const { outbox, timelinePath } = await fixture(send);

    await expect(outbox.send("not an object", actor)).rejects.toThrow("Connector request must be a JSON object");
    await expect(outbox.send({ text: "🙂".repeat(262_145) }, actor)).rejects.toThrow("exceeds 1048576 bytes");
    expect(send).not.toHaveBeenCalled();
    expect(await events(timelinePath)).toEqual([]);
  });

  it("does not record connector failures", async () => {
    const send = vi.fn<WorkspaceConnector["send"]>(async () => {
      throw new Error("delivery failed");
    });
    const { outbox, timelinePath } = await fixture(send);

    await expect(outbox.send({ method: "sendMessage", text: "hello" }, actor)).rejects.toThrow("delivery failed");
    expect(await events(timelinePath)).toEqual([]);
  });

  it("fails when the actor's connector is not registered", async () => {
    const send = vi.fn<WorkspaceConnector["send"]>();
    const { outbox, timelinePath } = await fixture(send);
    const unknownActor = telegramConversation("telegram:123", 42);

    await expect(outbox.send({ method: "sendMessage", text: "hello" }, unknownActor)).rejects.toThrow("Unknown connector telegram:123");
    expect(send).not.toHaveBeenCalled();
    expect(await events(timelinePath)).toEqual([]);
  });
});
