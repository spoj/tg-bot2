import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTimeline } from "../src/events.js";
import { WorkspaceScheduler, type WorkspaceSchedulerOptions } from "../src/scheduler.js";
import type { ScheduleRow } from "../src/schedule-protocol.js";
import { conversationAgent } from "../src/agent-ref.js";

const temporaryDirectories: string[] = [];
const NOW = Date.parse("2026-01-10T12:00:00.000Z");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-test-"));
  temporaryDirectories.push(dataDir);
  await mkdir(path.join(dataDir, "workspace"), { recursive: true });
  await writeFile(path.join(dataDir, "timeline.jsonl"), "", "utf8");
  return dataDir;
}

async function writeSchedules(dataDir: string, schedules: ScheduleRow[]): Promise<void> {
  await writeFile(path.join(dataDir, "workspace", ".schedules.json"), JSON.stringify({ version: 1, schedules }), "utf8");
}

async function timeline(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(dataDir, "timeline.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function row(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    prompt: "water the plants",
    start: "2026-01-10T11:00:00.000Z",
    recurrence: null,
    owner: { chat_id: 42, message_thread_id: 7 },
    ...overrides,
  };
}

function makeScheduler(dataDir: string, overrides: Partial<WorkspaceSchedulerOptions> = {}): { scheduler: WorkspaceScheduler; errors: unknown[] } {
  const errors: unknown[] = [];
  const scheduler = new WorkspaceScheduler({
    workspace: path.join(dataDir, "workspace"),
    statePath: path.join(dataDir, "scheduler-state.json"),
    timeline: new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl")),
    now: () => NOW,
    logger: (error) => errors.push(error),
    ...overrides,
  });
  return { scheduler, errors };
}

describe("WorkspaceScheduler", () => {
  it("publishes a due one-shot to its owner once", async () => {
    const dataDir = await fixture();
    await writeSchedules(dataDir, [row()]);
    const first = makeScheduler(dataDir);

    await first.scheduler.poll(NOW);
    expect(await timeline(dataDir)).toMatchObject([{
      type: "schedule_fired",
      occurrenceId: expect.any(String),
      prompt: "water the plants",
      dueAt: "2026-01-10T11:00:00.000Z",
      owner: conversationAgent(42, 7),
    }]);

    await first.scheduler.poll(NOW);
    const restarted = makeScheduler(dataDir);
    await restarted.scheduler.poll(NOW);
    expect(await timeline(dataDir)).toHaveLength(1);
  });

  it("advances a recurring row to the next future occurrence", async () => {
    const dataDir = await fixture();
    await writeSchedules(dataDir, [row({ recurrence: "daily", start: "2026-01-08T12:00:00.000Z" })]);
    const { scheduler } = makeScheduler(dataDir);

    await scheduler.poll(NOW);
    expect(await timeline(dataDir)).toHaveLength(1);
    const state = JSON.parse(await readFile(path.join(dataDir, "scheduler-state.json"), "utf8")) as { rows: Array<{ nextDueAt: string }> };
    expect(state.rows[0]?.nextDueAt).toBe("2026-01-11T12:00:00.000Z");

    await scheduler.poll(Date.parse("2026-01-11T12:00:00.000Z"));
    expect(await timeline(dataDir)).toHaveLength(2);
  });

  it("drops state for removed rows and treats edited rows as new intent", async () => {
    const dataDir = await fixture();
    await writeSchedules(dataDir, [row({ start: "2026-01-11T12:00:00.000Z" })]);
    const { scheduler } = makeScheduler(dataDir);
    await scheduler.poll(NOW);

    await writeSchedules(dataDir, [row({ prompt: "water the garden", start: "2026-01-12T12:00:00.000Z" })]);
    await scheduler.poll(NOW);
    const state = JSON.parse(await readFile(path.join(dataDir, "scheduler-state.json"), "utf8")) as { rows: Array<{ key: string; nextDueAt: string }> };
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.key).toContain("water the garden");
    expect(state.rows[0]?.nextDueAt).toBe("2026-01-12T12:00:00.000Z");
  });

  it("ignores missing schedules and reports malformed schedules", async () => {
    const dataDir = await fixture();
    const { scheduler, errors } = makeScheduler(dataDir);
    await scheduler.poll(NOW);
    expect(errors).toEqual([]);

    await writeFile(path.join(dataDir, "workspace", ".schedules.json"), "not json", "utf8");

    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
  });
  it("rejects schedules without a conversation owner", async () => {
    const dataDir = await fixture();
    await writeFile(path.join(dataDir, "workspace", ".schedules.json"), JSON.stringify({
      version: 1,
      schedules: [{ prompt: "water", start: "2026-01-10T11:00:00.000Z", recurrence: null }],
    }), "utf8");
    const { scheduler, errors } = makeScheduler(dataDir);
    await scheduler.poll(NOW);
    expect(await timeline(dataDir)).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("does not fire when its current-state snapshot cannot be saved", async () => {
    const dataDir = await fixture();
    await writeSchedules(dataDir, [row()]);
    const blocked = path.join(dataDir, "blocked");
    await writeFile(blocked, "not a directory", "utf8");
    const { scheduler, errors } = makeScheduler(dataDir, { statePath: path.join(blocked, "scheduler-state.json") });

    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
    expect(await timeline(dataDir)).toEqual([]);
  });

  it("coalesces concurrent polls", async () => {
    const dataDir = await fixture();
    await writeSchedules(dataDir, [row()]);
    const { scheduler } = makeScheduler(dataDir);
    await Promise.all([scheduler.poll(NOW), scheduler.poll(NOW), scheduler.poll(NOW)]);
    expect(await timeline(dataDir)).toHaveLength(1);
  });

  it("rejects invalid poll intervals", async () => {
    const dataDir = await fixture();
    const base = {
      workspace: path.join(dataDir, "workspace"),
      statePath: path.join(dataDir, "scheduler-state.json"),
      timeline: new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl")),
    };
    expect(() => new WorkspaceScheduler({ ...base, pollIntervalMs: 0 })).toThrow("positive timer-safe integer");
    expect(() => new WorkspaceScheduler({ ...base, pollIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("starts once and stops its polling timer", async () => {
    const dataDir = await fixture();
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn(() => timer);
    const clearIntervalFn = vi.fn();
    const { scheduler } = makeScheduler(dataDir, { setInterval: setIntervalFn as unknown as typeof setInterval, clearInterval: clearIntervalFn as unknown as typeof clearInterval });

    await scheduler.start();
    await scheduler.start();
    expect(setIntervalFn).toHaveBeenCalledOnce();
    await scheduler.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });
});
