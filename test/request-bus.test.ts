import { appendFile, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCommand,
  splitRecords,
  WorkspaceRequestBus,
  type CancelRequestHandler,
  type SendRequestHandler,
  type SpawnRequestHandler,
  type SteerTaskRequestHandler,
  type WorkspaceRequestBusOptions,
} from "../src/request-bus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-bus-test-"));
  temporaryDirectories.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  await mkdir(path.join(workspace, ".tg-bot"), { recursive: true });
  return { dataDir, workspace };
}

function setupBus(
  workspace: string,
  options: Partial<WorkspaceRequestBusOptions> = {},
): WorkspaceRequestBus {
  return new WorkspaceRequestBus({
    workspace,
    onSend: options.onSend ?? (async () => undefined),
    onSpawn: options.onSpawn ?? (async () => "claimed"),
    onCancel: options.onCancel ?? (async () => undefined),
    ...options,
  });
}

function sendRequest(requestId = "req-1"): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "send_request", requestId, request: { type: "send_message", text: "hi" } })}\n`;
}

function spawnRequest(runId = "run-1", prompt = "do it"): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "spawn_request", runId, prompt })}\n`;
}

function cancelRequest(runId = "run-1"): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "cancel_request", runId })}\n`;
}

function steerTaskRequest(steerId = "steer-1", runId = "run-1", message = "adjust"): string {
  return `${JSON.stringify({ v: 1, t: "t", type: "steer_task_request", steerId, runId, message })}\n`;
}

const outcome = (record: Record<string, unknown>): string => `${JSON.stringify({ v: 1, t: "t", ...record })}\n`;

async function writeLog(workspace: string, lines: string[]): Promise<void> {
  await writeFile(path.join(workspace, ".tg-bot", "events.jsonl"), lines.join(""), "utf8");
}

describe("parseCommand", () => {
  it("parses well-formed commands and rejects outcomes and junk", () => {
    expect(parseCommand(sendRequest())).toEqual({ type: "send_request", requestId: "req-1", request: { type: "send_message", text: "hi" } });
    expect(parseCommand(spawnRequest())).toEqual({ type: "spawn_request", runId: "run-1", prompt: "do it" });
    expect(parseCommand(cancelRequest())).toEqual({ type: "cancel_request", runId: "run-1" });
    expect(parseCommand(steerTaskRequest())).toEqual({ type: "steer_task_request", steerId: "steer-1", runId: "run-1", message: "adjust" });
    expect(parseCommand(`${JSON.stringify({ v: 1, t: "t", type: "new_session_request", requestId: "ns-1", origin: "42:0", chat_id: 42 })}\n`)).toEqual({ type: "new_session_request", requestId: "ns-1", origin: "42:0", chat_id: 42 });
    expect(parseCommand(`${JSON.stringify({ v: 1, t: "t", type: "send_request", requestId: "req-1", origin: "42:100", request: { type: "send_message", text: "hi" } })}\n`)).toEqual({ type: "send_request", requestId: "req-1", origin: "42:100", request: { type: "send_message", text: "hi" } });
    expect(parseCommand(`${JSON.stringify({ v: 1, t: "t", type: "schedule_run_fired", runId: "sched-1", prompt: "morning briefing" })}\n`)).toEqual({ type: "spawn_request", runId: "sched-1", prompt: "morning briefing" });
    expect(parseCommand("not json")).toBeUndefined();
    expect(parseCommand(outcome({ type: "task_settled", runId: "run-1", status: "done", exitCode: 0 }))).toBeUndefined();
    expect(parseCommand(outcome({ type: "outbox_sent", requestId: "req-1" }))).toBeUndefined();
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
    const { workspace } = await fixture();
    await writeLog(workspace, [sendRequest()]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledWith({ type: "send_request", requestId: "req-1", request: { type: "send_message", text: "hi" } }, workspace);
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it("routes schedule_run_fired to onSpawn reusing the schedule runId", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [
      `${JSON.stringify({ v: 1, t: "t", type: "schedule_run_fired", runId: "sched-run-42", prompt: "daily report" })}\n`,
    ]);
    const onSpawn = vi.fn<SpawnRequestHandler>(async () => "claimed");
    const bus = setupBus(workspace, { onSpawn });

    await bus.poll();
    expect(onSpawn).toHaveBeenCalledWith({ type: "spawn_request", runId: "sched-run-42", prompt: "daily report" }, workspace);
  });


  it("boot replay skips terminal sends and tasks, and routes fresh ones", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [
      sendRequest("req-done"),
      outcome({ type: "outbox_sent", requestId: "req-done", chat_id: 42 }),
      sendRequest("req-rejected"),
      outcome({ type: "outbox_rejected", requestId: "req-rejected", detail: "failed" }),
      spawnRequest("run-done"),
      outcome({ type: "task_settled", runId: "run-done", status: "done", exitCode: 0 }),
      sendRequest("req-fresh"),
      spawnRequest("run-fresh"),
      cancelRequest("run-cancel-fresh"),
    ]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const onSpawn = vi.fn<SpawnRequestHandler>(async () => "claimed");
    const onCancel = vi.fn<CancelRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSend, onSpawn, onCancel });

    await bus.poll();

    expect(onSend.mock.calls.map(([record]) => record.requestId)).toEqual(["req-fresh"]);
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-fresh" }), workspace);
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn).toHaveBeenCalledWith({ type: "spawn_request", runId: "run-fresh", prompt: "do it" }, workspace);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ type: "cancel_request", runId: "run-cancel-fresh" }, workspace);
  });
  it("routes steer_task commands to onSteerTask", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [steerTaskRequest("s-1", "run-1", "use python 3.12")]);
    const onSteerTask = vi.fn<SteerTaskRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSteerTask });

    await bus.poll();
    expect(onSteerTask).toHaveBeenCalledWith({ type: "steer_task_request", steerId: "s-1", runId: "run-1", message: "use python 3.12" }, workspace);
  });

  it("routes new_session commands and skips completed ones during boot replay", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [
      `${JSON.stringify({ v: 1, t: "t", type: "new_session_request", requestId: "ns-done" })}\n`,
      outcome({ type: "new_session_scheduled", requestId: "ns-done" }),
      `${JSON.stringify({ v: 1, t: "t", type: "new_session_request", requestId: "ns-fresh", chat_id: 123 })}\n`,
    ]);
    const onNewSession = vi.fn(async () => undefined);
    const bus = setupBus(workspace, { onNewSession });

    await bus.poll();
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewSession).toHaveBeenCalledWith(
      { type: "new_session_request", requestId: "ns-fresh", chat_id: 123 },
      workspace,
    );
  });

  it("retries pending spawns until a slot frees", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [spawnRequest("run-1", "queued")]);
    const onSpawn = vi.fn<SpawnRequestHandler>(async () => "pending");
    const bus = setupBus(workspace, { onSpawn });
    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(1);

    onSpawn.mockResolvedValue("claimed");
    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(2);

    await bus.poll();
    expect(onSpawn).toHaveBeenCalledTimes(2);
  });

  it("resumes reading across polls when a record arrives in fragments", async () => {
    const { workspace } = await fixture();
    const full = sendRequest("req-split");
    await writeLog(workspace, [full.slice(0, -10)]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSend });

    await bus.poll();
    expect(onSend).not.toHaveBeenCalled();

    await appendFile(path.join(workspace, ".tg-bot", "events.jsonl"), `${full.slice(-10)}\n`, "utf8");
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("resets offset and reads from the start when events.jsonl is truncated", async () => {
    const { workspace } = await fixture();
    const target = path.join(workspace, ".tg-bot", "events.jsonl");
    await writeFile(target, `${sendRequest("req-1")}${sendRequest("req-2")}`, "utf8");
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(2);

    await truncate(target, 0);
    await appendFile(target, sendRequest("req-3"), "utf8");
    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(3);
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: "req-3" }), workspace);
  });

  it("flushes unconsumed commands synchronously through the flush interface", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [sendRequest("req-1")]);
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSend });

    await bus.poll();
    expect(onSend).toHaveBeenCalledTimes(1);

    await appendFile(path.join(workspace, ".tg-bot", "events.jsonl"), sendRequest("req-2"), "utf8");
    await bus.flush(workspace);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("continues polling when a handler throws an error", async () => {
    const { workspace } = await fixture();
    await writeLog(workspace, [sendRequest("req-1")]);
    const errors: unknown[] = [];
    const bus = setupBus(workspace, {
      onSend: vi.fn<SendRequestHandler>(async () => { throw new Error("handler threw"); }),
      logger: (error) => errors.push(error),
    });

    await bus.poll();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("handler threw");
  });

  it("skips a planted symlinked events.jsonl", async () => {
    const { workspace } = await fixture();
    const target = path.join(workspace, "outside.jsonl");
    await writeFile(target, sendRequest(), "utf8");
    await symlink(target, path.join(workspace, ".tg-bot", "events.jsonl"));
    const onSend = vi.fn<SendRequestHandler>(async () => undefined);
    const bus = setupBus(workspace, { onSend });

    await bus.poll();
    expect(onSend).not.toHaveBeenCalled();
  });
});
