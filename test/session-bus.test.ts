import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceSessionBus,
  extractToolCalls,
  splitRecords,
  type CancelHandler,
  type SendHandler,
  type SessionToolCall,
  type SpawnHandler,
} from "../src/session-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-session-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "chats", "42", "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  await mkdir(path.join(workspace, ".pi", "sessions"), { recursive: true });
  return { dataDir, workspace };
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_FILE = `2026-08-20T01-36-59-329Z_${SESSION_ID}.jsonl`;
const RECORD_ID = "a1b2c3d4";

function record(content: unknown): string {
  return `${JSON.stringify({
    type: "message",
    id: RECORD_ID,
    parentId: "p",
    timestamp: "2026-08-20T01:37:03.006Z",
    message: { role: "assistant", content },
  })}\n`;
}

function call(index: number, name: "send" | "spawn" | "cancel", args: Record<string, unknown>): SessionToolCall {
  return { ref: { sessionId: SESSION_ID, recordId: RECORD_ID, index }, name, args };
}

function setupBus(
  dataDir: string,
  handlers: { onSend?: SendHandler; onSpawn?: SpawnHandler; onCancel?: CancelHandler } = {},
): WorkspaceSessionBus {
  return new WorkspaceSessionBus({
    dataDir,
    onSend: handlers.onSend ?? vi.fn<SendHandler>(async () => undefined),
    onSpawn: handlers.onSpawn ?? vi.fn<SpawnHandler>(async () => "claimed"),
    onCancel: handlers.onCancel ?? vi.fn<CancelHandler>(async () => undefined),
  });
}

async function writeSession(workspace: string, lines: string[], name = SESSION_FILE): Promise<void> {
  await writeFile(path.join(workspace, ".pi", "sessions", name), lines.join(""), "utf8");
}

async function systemEvents(workspace: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(workspace, ".tg-bot", "system.jsonl"), "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("extractToolCalls", () => {
  it("extracts send, spawn, and cancel calls from assistant messages only", () => {
    const line = record([
      { type: "thinking", thinking: "plan" },
      { type: "toolCall", id: "call_1", name: "send", arguments: { type: "send_message", text: "hi" } },
      { type: "toolCall", id: "call_2", name: "spawn", arguments: { prompt: "do it" } },
      { type: "toolCall", id: "call_3", name: "cancel", arguments: { runId: "abc" } },
      { type: "toolCall", id: "call_4", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "call_5", name: "send", arguments: "not-an-object" },
    ]);
    expect(extractToolCalls(SESSION_ID, line)).toEqual([
      call(1, "send", { type: "send_message", text: "hi" }),
      call(2, "spawn", { prompt: "do it" }),
      call(3, "cancel", { runId: "abc" }),
      call(5, "send", {}),
    ]);
  });

  it("ignores user messages, malformed lines, and non-message records", () => {
    expect(extractToolCalls(SESSION_ID, "not json")).toEqual([]);
    expect(extractToolCalls(SESSION_ID, record([
      { type: "toolCall", name: "send", arguments: {} },
    ]).replace('"role":"assistant"', '"role":"user"'))).toEqual([]);
    expect(extractToolCalls(SESSION_ID, JSON.stringify({ type: "session", id: SESSION_ID }))).toEqual([]);
    expect(extractToolCalls(SESSION_ID, "x".repeat(8 * 1024 * 1024 + 1))).toEqual([]);
  });
});

describe("splitRecords", () => {
  it("splits complete lines and defers unparseable trailing fragments", () => {
    expect(splitRecords('{"a":1}')).toEqual({ lines: ['{"a":1}'], partial: "" });
    expect(splitRecords("a\n{\"partial")).toEqual({ lines: ["a"], partial: "{\"partial" });
    expect(splitRecords("")).toEqual({ lines: [], partial: "" });
  });
});

describe("WorkspaceSessionBus", () => {
  it("routes fresh calls once and skips them on later polls", async () => {
    const { dataDir, workspace } = await fixture();
    await writeSession(workspace, [
      record([{ type: "toolCall", name: "send", arguments: { type: "send_message", text: "hi" } }]),
    ]);
    const onSend = vi.fn<SendHandler>(async () => undefined);
    const onSpawn = vi.fn<SpawnHandler>(async () => "claimed");
    const onCancel = vi.fn<CancelHandler>(async () => undefined);
    const bus = new WorkspaceSessionBus({ dataDir, onSend, onSpawn, onCancel });

    await bus.poll();
    expect(onSend).toHaveBeenCalledWith(
      call(0, "send", { type: "send_message", text: "hi" }),
      42,
      workspace,
      undefined,
    );
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("boot replay skips terminal calls, resumes open sends, and re-routes unclaimed calls", async () => {
    const { dataDir, workspace } = await fixture();
    const doneRef = { sessionId: SESSION_ID, recordId: "aaaa1111", index: 0 };
    const openRef = { sessionId: SESSION_ID, recordId: "bbbb2222", index: 0 };
    const claimedTaskRef = { sessionId: SESSION_ID, recordId: "cccc3333", index: 0 };
    const cancelledRef = { sessionId: SESSION_ID, recordId: "dddd4444", index: 0 };
    await writeFile(path.join(workspace, ".tg-bot", "system.jsonl"), [
      { v: 1, t: "t", type: "outbox_claimed", requestId: "req-done", callRef: doneRef, request: {} },
      { v: 1, t: "t", type: "outbox_sent", requestId: "req-done", callRef: doneRef, request: {} },
      { v: 1, t: "t", type: "outbox_claimed", requestId: "req-open", callRef: openRef, request: {} },
      { v: 1, t: "t", type: "task_claimed", runId: "run-c", callRef: claimedTaskRef, prompt: "p" },
      { v: 1, t: "t", type: "task_cancelled", runId: "run-d", callRef: cancelledRef },
    ].map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
    await writeSession(workspace, [
      record([{ type: "toolCall", name: "send", arguments: { type: "send_message", text: "done" } }]).replace(RECORD_ID, "aaaa1111"),
      record([{ type: "toolCall", name: "send", arguments: { type: "send_message", text: "open" } }]).replace(RECORD_ID, "bbbb2222"),
      record([{ type: "toolCall", name: "spawn", arguments: { prompt: "claimed" } }]).replace(RECORD_ID, "cccc3333"),
      record([{ type: "toolCall", name: "cancel", arguments: { runId: "run-d" } }]).replace(RECORD_ID, "dddd4444"),
      record([{ type: "toolCall", name: "send", arguments: { type: "send_message", text: "fresh" } }]),
    ]);
    const onSend = vi.fn<SendHandler>(async () => undefined);
    const onSpawn = vi.fn<SpawnHandler>(async () => "claimed");
    const onCancel = vi.fn<CancelHandler>(async () => undefined);
    const bus = new WorkspaceSessionBus({ dataDir, onSend, onSpawn, onCancel });

    await bus.poll();

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls.map(([callArgs]) => (callArgs as SessionToolCall).args)).toEqual([
      { type: "send_message", text: "open" },
      { type: "send_message", text: "fresh" },
    ]);
    expect(onSend).toHaveBeenNthCalledWith(1, expect.objectContaining({ ref: openRef }), 42, workspace, { requestId: "req-open" });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("consumes task-run session files and flushes a run's remaining calls on demand", async () => {
    const { dataDir, workspace } = await fixture();
    const taskSessions = path.join(workspace, ".pi", "tasks", "run-1", "sessions");
    await mkdir(taskSessions, { recursive: true });
    const taskFile = "2026-08-20T02-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl";
    const taskRecord = (id: string, text: string): string => JSON.stringify({
      type: "message",
      id,
      parentId: "p",
      timestamp: "t",
      message: { role: "assistant", content: [{ type: "toolCall", name: "send", arguments: { type: "send_message", text } }] },
    });
    await writeFile(path.join(taskSessions, taskFile), `${taskRecord("ef567890", "first")}\n`, "utf8");
    const onSend = vi.fn<SendHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await bus.flushTaskRun(42, workspace, "run-1");
    expect(onSend).toHaveBeenCalledTimes(1);

    await appendFile(path.join(taskSessions, taskFile), `${taskRecord("ef567891", "second")}\n`, "utf8");
    await bus.flushTaskRun(42, workspace, "run-1");
    expect(onSend).toHaveBeenCalledTimes(2);
    await bus.flushTaskRun(42, workspace, "run-1");
    expect(onSend).toHaveBeenCalledTimes(2);

    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("retries pending spawns until a slot frees", async () => {
    const { dataDir, workspace } = await fixture();
    await writeSession(workspace, [
      record([{ type: "toolCall", name: "spawn", arguments: { prompt: "queued" } }]),
    ]);
    const onSpawn = vi.fn<SpawnHandler>(async () => "pending");
    const bus = setupBus(dataDir, { onSpawn });
    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(1);

    onSpawn.mockResolvedValue("claimed");
    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(2);
    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(2);
  });

  it("reads partial records once the writer completes them", async () => {
    const { dataDir, workspace } = await fixture();
    const name = "2026-08-20T03-00-00-000Z_33333333-3333-4333-8333-333333333333.jsonl";
    const full = record([{ type: "toolCall", name: "spawn", arguments: { prompt: "later" } }]).trimEnd();
    await writeSession(workspace, [full.slice(0, full.length - 10)], name);
    const onSpawn = vi.fn<SpawnHandler>(async () => "claimed");
    const bus = setupBus(dataDir, { onSpawn });

    await bus.poll();
    expect(onSpawn).not.toHaveBeenCalled();

    await appendFile(path.join(workspace, ".pi", "sessions", name), `${full.slice(-10)}\n`, "utf8");
    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  it("routes a send and a spawn from one multi-tool-call message", async () => {
    const { dataDir, workspace } = await fixture();
    await writeSession(workspace, [
      record([
        { type: "toolCall", name: "spawn", arguments: { prompt: "first" } },
        { type: "toolCall", name: "send", arguments: { type: "send_message", text: "second" } },
      ]),
    ]);
    const onSend = vi.fn<SendHandler>(async () => undefined);
    const onSpawn = vi.fn<SpawnHandler>(async () => "claimed");
    const bus = setupBus(dataDir, { onSend, onSpawn });

    await bus.poll();
    expect(onSpawn).toHaveBeenCalledWith(call(0, "spawn", { prompt: "first" }), 42, workspace);
    expect(onSend).toHaveBeenCalledWith(call(1, "send", { type: "send_message", text: "second" }), 42, workspace, undefined);
  });

  it("ignores non-numeric chat directories and survives handler errors without re-emitting", async () => {
    const { dataDir, workspace } = await fixture();
    await mkdir(path.join(dataDir, "chats", "not-a-chat", "workspace", ".pi", "sessions"), { recursive: true });
    await writeSession(workspace, [
      record([{ type: "toolCall", name: "send", arguments: { type: "send_message", text: "hi" } }]),
    ]);
    const onSend = vi.fn<SendHandler>(async () => { throw new Error("handler boom"); });
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("skips planted symlinked session files", async () => {
    const { dataDir, workspace } = await fixture();
    const target = path.join(workspace, "outside.jsonl");
    await writeFile(target, record([{ type: "toolCall", name: "send", arguments: { type: "send_message", text: "hi" } }]), "utf8");
    await symlink(target, path.join(workspace, ".pi", "sessions", "2026-08-20T05-00-00-000Z_55555555-5555-4555-8555-555555555555.jsonl"));
    const onSend = vi.fn<SendHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).not.toHaveBeenCalled();
    expect(await systemEvents(workspace)).toEqual([]);
  });
});
