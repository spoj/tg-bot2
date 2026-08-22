import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceScheduler, type WorkspaceSchedulerOptions } from "../src/scheduler.js";
import { WorkspaceEventLog } from "../src/events.js";
import { defined } from "../src/util.js";
import type { ScheduleRow } from "../src/schedule-protocol.js";

const NOW = Date.parse("2026-01-10T12:30:00.000Z");

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tg-bot2-workspace-scheduler-"));
}

function row(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return { prompt: "water the plants", start: "2026-01-10T12:00:00.000Z", recurrence: null, ...overrides };
}

async function writeSchedules(dataDir: string, schedules: unknown): Promise<string> {
  const metadata = path.join(dataDir, "workspace", ".tg-bot");
  await mkdir(metadata, { recursive: true });
  const filePath = path.join(metadata, "schedules.json");
  await writeFile(filePath, JSON.stringify({ version: 1, schedules }), "utf8");
  return filePath;
}

async function logEvents(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(dataDir, "events.jsonl");
  const contents = await readFile(filePath, "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function withDirectory(test: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await temporaryDirectory();
  try {
    await test(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function makeScheduler(
  dataDir: string,
  options: Partial<WorkspaceSchedulerOptions> = {},
): { scheduler: WorkspaceScheduler; events: WorkspaceEventLog } {
  const defaultWorkspace = path.join(dataDir, "workspace");
  const defaultEvents = new WorkspaceEventLog(path.join(dataDir, "events.jsonl"));
  const {
    workspace = defaultWorkspace,
    events = defaultEvents,
    now = () => NOW,
    ...rest
  } = options;
  const scheduler = new WorkspaceScheduler({
    workspace,
    events,
    now,
    ...defined(rest),
  });
  return { scheduler, events };
}

function fakeInterval() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    setIntervalMock: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
    clearIntervalMock: vi.fn(),
  };
}

describe("WorkspaceScheduler firing", () => {
  it("fires a due schedule and appends schedule_run_fired to events.jsonl", () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, [row()]);
    const { scheduler } = makeScheduler(dataDir);

    await scheduler.poll(NOW);

    const events = await logEvents(dataDir);
    expect(events).toMatchObject([
      { type: "schedule_run_scheduled", prompt: "water the plants" },
      { type: "schedule_run_fired", prompt: "water the plants" },
    ]);
  }));

  it("advances a recurring schedule after firing", () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, [row({ recurrence: "daily", start: "2026-01-10T12:00:00.000Z" })]);
    const { scheduler } = makeScheduler(dataDir);

    await scheduler.poll(NOW);

    const events = await logEvents(dataDir);
    const scheduled = events.filter((e) => e.type === "schedule_run_scheduled");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]).toMatchObject({ dueAt: "2026-01-11T12:00:00.000Z" });
    const fired = events.filter((e) => e.type === "schedule_run_fired");
    expect(fired).toHaveLength(1);
  }));

  it("cancels runs whose row vanished from schedules.json", () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, [row({ prompt: "row-1", start: "2026-01-10T14:00:00.000Z" })]);
    const { scheduler } = makeScheduler(dataDir);

    await scheduler.poll(NOW);
    expect((await logEvents(dataDir)).filter((e) => e.type === "schedule_run_scheduled")).toHaveLength(1);

    await writeSchedules(dataDir, []);
    await scheduler.poll(NOW);

    const events = await logEvents(dataDir);
    expect(events.filter((e) => e.type === "schedule_run_cancelled")).toHaveLength(1);
  }));

  it("replaces a run when its prompt or start changes", () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, [row({ prompt: "original", start: "2026-01-10T14:00:00.000Z" })]);
    const { scheduler } = makeScheduler(dataDir);

    await scheduler.poll(NOW);
    await writeSchedules(dataDir, [row({ prompt: "updated", start: "2026-01-10T14:00:00.000Z" })]);
    await scheduler.poll(NOW);

    const events = await logEvents(dataDir);
    expect(events.filter((e) => e.type === "schedule_run_cancelled")).toHaveLength(1);
    expect(events.filter((e) => e.type === "schedule_run_scheduled")).toHaveLength(2);
  }));

  it("ignores missing schedules.json quietly", () => withDirectory(async (dataDir) => {
    const { scheduler } = makeScheduler(dataDir);
    await expect(scheduler.poll(NOW)).resolves.toBeUndefined();
    expect(await logEvents(dataDir)).toHaveLength(0);
  }));

  it("recovers state from events.jsonl at boot without duplicate runs", () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, [row()]);
    const { scheduler: scheduler1 } = makeScheduler(dataDir);
    await scheduler1.poll(NOW);
    const events1 = await logEvents(dataDir);
    expect(events1.filter((e) => e.type === "schedule_run_fired")).toHaveLength(1);

    const { scheduler: scheduler2 } = makeScheduler(dataDir);
    await scheduler2.poll(NOW);
    const events2 = await logEvents(dataDir);
    expect(events2.filter((e) => e.type === "schedule_run_fired")).toHaveLength(1);
  }));
});

describe("WorkspaceScheduler validation", () => {
  it("rejects non-positive or non-timer-safe intervals", () => withDirectory(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const events = new WorkspaceEventLog(path.join(dataDir, "events.jsonl"));
    expect(() => new WorkspaceScheduler({ workspace, events, pollIntervalMs: 0 })).toThrow("positive timer-safe integer");
    expect(() => new WorkspaceScheduler({ workspace, events, pollIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  }));

  it("reports malformed schedules.json to logger", () => withDirectory(async (dataDir) => {
    const metadata = path.join(dataDir, "workspace", ".tg-bot");
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(metadata, "schedules.json"), "{ invalid json", "utf8");
    const errors: unknown[] = [];
    const { scheduler } = makeScheduler(dataDir, { logger: (e: unknown) => errors.push(e) });

    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("Malformed schedules");
  }));
});

describe("WorkspaceScheduler lifecycle", () => {
  it("starts periodic timer and stops cleanly", () => withDirectory(async (dataDir) => {
    const interval = fakeInterval();
    const { scheduler } = makeScheduler(dataDir, {
      setInterval: interval.setIntervalMock as unknown as typeof setInterval,
      clearInterval: interval.clearIntervalMock as unknown as typeof clearInterval,
    });

    await scheduler.start();
    expect(interval.setIntervalMock).toHaveBeenCalledOnce();

    await scheduler.stop();
    expect(interval.clearIntervalMock).toHaveBeenCalledOnce();
  }));
});
