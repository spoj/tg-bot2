import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceRequestBus,
  parseCommand,
  splitRecords,
  type CancelRequestHandler,
  type SendRequestHandler,
  type SpawnRequestHandler,
} from "../src/request-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-request-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  return { dataDir, workspace };
}

function setupBus(
  dataDir: string,
  handlers: { onSend?: SendRequestHandler; onSpawn?: SpawnRequestHandler; onCancel?: CancelRequestHandler } = {},
): WorkspaceRequestBus {
  return new WorkspaceRequestBus({
    dataDir,
    onSend: handlers.onSend ?? vi.fn<SendRequestHandler>(async () => undefined),
    onSpawn: handlers.onSpawn ?? vi.fn<SpawnRequestHandler>(async () => "claimed"),
    onCancel: handlers.onCancel ?? vi.fn<CancelRequestHandler>(async () => undefined),
  });
}

function sendRequest(requestId = "req-1", request: unknown = { type: "send_message", text: "hi" }): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "send_request", requestId, request })}\n`;
}
function spawnRequest(runId = "run-1", prompt = "do it"): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "spawn_request", runId, prompt })}\n`;
}
function cancelRequest(runId = "run-1"): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "cancel_request", runId })}\n`;
}
const outcome = (record: Record<string, unknown>): string => `${JSON.stringify({ v: 1, t: "t", ...record })}\n`;

async function writeLog(workspace: string, lines: string[]): Promise<void> {
  await writeFile(path.join(workspace, ".tg-bot", "system.jsonl"), lines.join(""), "utf8");
}

describe("parseCommand", () => {
  it("parses well-formed commands and rejects outcomes and junk", () => {
    expect(parseCommand(sendRequest())).toEqual({ requestId: "req-1", request: { type: "send_message", text: "hi" } });
    expect(parseCommand(spawnRequest())).toEqual({ runId: "run-1", prompt: "do it" });
    expect(parseCommand(cancelRequest())).toEqual({ runId: "run-1" });
    expect(parseCommand("not json")).toBeUndefined();
    expect(parseCommand(outcome({ type: "task_settled", runId: "run-1", status: "done", exitCode: 0 }))).toBeUndefined();
    expect(parseCommand(outcome({ type: "outbox_claimed", requestId: "req-1" }))).toBeUndefined();
    expect(parseCommand(`${JSON.stringify({ v: 1, t: "t", type: "spawn_request", runId: "run-1", prompt: 7 })}\n`)).toBeUndefined();
    expect(parseCommand("x".repeat(8 * 1024 * 1024 + 1))).toBeUndefined();
  });
});

describe("splitRecords", () => {
  it("splits complete lines and defers unparseable trailing fragments", () => {
    expect(splitRecords("a\nb\nc\n")).toEqual({ lines: ["a", "b", "c"], partial: "" });
    expect(splitRecords("a\n{\"partial")).toEqual({ lines: ["a"], partial: "{\"partial" });
    expect(splitRecords('{"a":1}')).toEqual({ lines: ['{"a":1}'], partial: "" });
    expect(splitRecords("")).toEqual({ lines: [], partial: "" });
  });
});

describe("WorkspaceRequestBus", () => {
  it("routes fresh commands once and skips them on later polls", async () => {
    const { dataDir, workspace } = await fixture();
    await writeLog(workspace, [sendRequest()]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledWith({ requestId: "req-1", request: { type: "send_message", text: "hi" } }, workspace, false);
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("boot replay skips terminal sends, resumes open claims, and skips claimed tasks and cancels", async () => {
    const { dataDir, workspace } = await fixture();
    await writeLog(workspace, [
      sendRequest("req-done"),
      outcome({ type: "outbox_claimed", requestId: "req-done" }),
      outcome({ type: "outbox_sent", requestId: "req-done" }),
      sendRequest("req-open"),
      outcome({ type: "outbox_claimed", requestId: "req-open" }),
      spawnRequest("run-done"),
      outcome({ type: "task_claimed", runId: "run-done" }),
      cancelRequest("run-cancelled"),
      outcome({ type: "task_cancelled", runId: "run-cancelled" }),
      sendRequest("req-fresh"),
      spawnRequest("run-fresh"),
      cancelRequest("run-unknown"),
    ]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const onSpawn = vi.fn<SpawnRequestHandler>(async () => "claimed");
    const onCancel = vi.fn<CancelRequestHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend, onSpawn, onCancel });

    await bus.poll();

    expect(onSend.mock.calls.map(([record]) => record.requestId)).toEqual(["req-open", "req-fresh"]);
    expect(onSend).toHaveBeenNthCalledWith(1, expect.objectContaining({ requestId: "req-open" }), workspace, true);
    expect(onSend).toHaveBeenNthCalledWith(2, expect.objectContaining({ requestId: "req-fresh" }), workspace, false);
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn).toHaveBeenCalledWith({ runId: "run-fresh", prompt: "do it" }, workspace);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ runId: "run-unknown" }, workspace);
  });

  it("retries pending spawns until a slot frees", async () => {
    const { dataDir, workspace } = await fixture();
    await writeLog(workspace, [spawnRequest("run-1", "queued")]);
    const onSpawn = vi.fn<SpawnRequestHandler>(async () => "pending");
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
    const full = sendRequest("req-partial").trimEnd();
    await writeLog(workspace, [full.slice(0, full.length - 10)]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).not.toHaveBeenCalled();

    await appendFile(path.join(workspace, ".tg-bot", "system.jsonl"), `${full.slice(-10)}\n`, "utf8");
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("re-reads a truncated log and routes only new commands", async () => {
    const { dataDir, workspace } = await fixture();
    const padding = `${JSON.stringify({ v: 1, t: "t", type: "custom", customType: "pad", data: "x".repeat(2_000) })}\n`;
    await writeLog(workspace, [sendRequest("req-1"), padding]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);

    // The agent truncated the shared log; the consumed command stays deduped while
    // the new one is routed.
    await writeLog(workspace, [sendRequest("req-2")]);
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[0]?.requestId).toBe("req-2");
  });

  it("flush consumes newly written commands", async () => {
    const { dataDir, workspace } = await fixture();
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await writeLog(workspace, [sendRequest("req-1")]);
    await bus.flush(workspace);
    expect(onSend).toHaveBeenCalledTimes(1);
    await bus.flush(workspace);
    expect(onSend).toHaveBeenCalledTimes(1);

    await appendFile(path.join(workspace, ".tg-bot", "system.jsonl"), sendRequest("req-2"), "utf8");
    await bus.flush(workspace);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("survives handler errors without re-emitting", async () => {
    const { dataDir, workspace } = await fixture();
    await writeLog(workspace, [sendRequest()]);
    const onSend = vi.fn<SendRequestHandler>(async () => { throw new Error("handler boom"); });
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("skips a planted symlinked system.jsonl", async () => {
    const { dataDir, workspace } = await fixture();
    const target = path.join(workspace, "outside.jsonl");
    await writeFile(target, sendRequest(), "utf8");
    await symlink(target, path.join(workspace, ".tg-bot", "system.jsonl"));
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(dataDir, { onSend });

    await bus.poll();
    expect(onSend).not.toHaveBeenCalled();
  });
});
