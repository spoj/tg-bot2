import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceScheduler } from "../src/scheduler.js";
import { defined } from "../src/util.js";
import type { ScheduleRow } from "../src/schedule-protocol.js";

const NOW = Date.parse("2026-01-10T12:30:00.000Z");

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tg-bot2-workspace-scheduler-"));
}

function row(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return { prompt: "water the plants", start: "2026-01-10T12:00:00.000Z", recurrence: null, ...overrides };
}

async function writeSchedules(dataDir: string, chatId: number, schedules: unknown): Promise<string> {
  const metadata = path.join(dataDir, "chats", String(chatId), "workspace", ".tg-bot");
  await mkdir(metadata, { recursive: true });
  const filePath = path.join(metadata, "schedules.json");
  await writeFile(filePath, JSON.stringify({ version: 1, schedules }), "utf8");
  return filePath;
}

async function systemEvents(dataDir: string, chatId: number): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(dataDir, "chats", String(chatId), "workspace", ".tg-bot", "system.jsonl");
  const contents = await readFile(filePath, "utf8").catch(() => "");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function appendSystemLine(dataDir: string, chatId: number, event: Record<string, unknown>): Promise<void> {
  const filePath = path.join(dataDir, "chats", String(chatId), "workspace", ".tg-bot", "system.jsonl");
  await writeFile(filePath, `${JSON.stringify({ v: 1, t: new Date().toISOString(), ...event })}\n`, { flag: "a" });
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
  options: Partial<ConstructorParameters<typeof WorkspaceScheduler>[0]> = {},
): WorkspaceScheduler {
  return new WorkspaceScheduler({
    ...defined(options),
    dataDir,
    run: options.run ?? (async () => undefined),
    now: options.now ?? (() => NOW),
  });
}

function fakeInterval() {
  const callbacks: (() => void)[] = [];
  const setIntervalMock = vi.fn((callback: () => void, _delay?: number) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const clearIntervalMock = vi.fn(() => {});
  return { callbacks, setIntervalMock, clearIntervalMock };
}

describe("WorkspaceScheduler firing", () => {
  it("fires a due one-shot exactly once and leaves schedules.json untouched", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 42, [row()]);
    const before = await readFile(filePath, "utf8");
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });

    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(42, "water the plants");
    const events = await systemEvents(dataDir, 42);
    expect(events.map((event) => event.type)).toEqual(["schedule_run_scheduled", "schedule_run_fired"]);
    expect(events[0]).toMatchObject({ runId: expect.any(String), prompt: "water the plants", start: "2026-01-10T12:00:00.000Z", recurrence: null, dueAt: "2026-01-10T12:00:00.000Z" });
    expect(events[1]?.runId).toBe(events[0]?.runId);

    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await systemEvents(dataDir, 42)).toHaveLength(2);
    expect(await readFile(filePath, "utf8")).toBe(before);
  }));

  it("does not fire a one-shot with a future start but materializes the open run", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row({ start: "2026-01-10T14:00:00.000Z" })]);
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });

    await scheduler.poll(NOW);
    expect(run).not.toHaveBeenCalled();
    const events = await systemEvents(dataDir, 42);
    expect(events.map((event) => event.type)).toEqual(["schedule_run_scheduled"]);

    await scheduler.poll(Date.parse("2026-01-10T14:00:01.000Z"));
    expect(run).toHaveBeenCalledTimes(1);
  }));

  it("fires recurring rows on the start-anchored grid with fresh run ids", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row({ start: "2026-01-07T09:00:00.000Z", recurrence: "daily" })]);
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });

    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
    const events = await systemEvents(dataDir, 42);
    expect(events.map((event) => event.type)).toEqual([
      "schedule_run_scheduled", "schedule_run_fired", "schedule_run_scheduled",
    ]);
    const nextDue = events[2];
    expect(nextDue).toMatchObject({ dueAt: "2026-01-11T09:00:00.000Z", recurrence: "daily" });
    expect(nextDue?.runId).not.toBe(events[0]?.runId);

    await scheduler.poll(Date.parse("2026-01-11T09:00:01.000Z"));
    expect(run).toHaveBeenCalledTimes(2);
    const after = await systemEvents(dataDir, 42);
    expect(after.at(-1)).toMatchObject({ type: "schedule_run_scheduled", dueAt: "2026-01-12T09:00:00.000Z" });
  }));

  it("cancels the open run when a row is deleted and never fires it", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row({ start: "2026-01-10T14:00:00.000Z" })]);
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);

    await writeSchedules(dataDir, 42, []);
    await scheduler.poll(NOW);
    expect(run).not.toHaveBeenCalled();
    const events = await systemEvents(dataDir, 42);
    expect(events.map((event) => event.type)).toEqual(["schedule_run_scheduled", "schedule_run_cancelled"]);
    expect(events[1]?.runId).toBe(events[0]?.runId);

    await scheduler.poll(Date.parse("2026-01-10T14:00:01.000Z"));
    expect(run).not.toHaveBeenCalled();
  }));

  it("treats a row edit as cancel of the old run and a new run at the new start", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row({ start: "2026-01-10T14:00:00.000Z" })]);
    const scheduler = makeScheduler(dataDir);
    await scheduler.poll(NOW);

    await writeSchedules(dataDir, 42, [row({ start: "2026-01-10T15:00:00.000Z" })]);
    await scheduler.poll(NOW);
    const events = await systemEvents(dataDir, 42);
    expect(events.map((event) => event.type)).toEqual([
      "schedule_run_scheduled", "schedule_run_cancelled", "schedule_run_scheduled",
    ]);
    expect(events[2]).toMatchObject({ start: "2026-01-10T15:00:00.000Z", dueAt: "2026-01-10T15:00:00.000Z" });
    expect(events[2]?.runId).not.toBe(events[0]?.runId);
  }));

  it("fires identical duplicate rows once (content dedup) with one open run", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row(), row()]);
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await systemEvents(dataDir, 42)).toHaveLength(2);
  }));

  it("fires two same-prompt rows at different starts independently", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [
      row({ start: "2026-01-10T12:00:00.000Z" }),
      row({ start: "2026-01-10T12:15:00.000Z" }),
    ]);
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(2);
    const events = await systemEvents(dataDir, 42);
    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.runId)).size).toBe(2);
  }));

  it("retries an open run on the next poll when run() rejects", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row()]);
    const run = vi.fn(async () => undefined)
      .mockRejectedValueOnce(new Error("agent busy"));
    const errors: unknown[] = [];
    const scheduler = makeScheduler(dataDir, { run, logger: (error) => errors.push(error) });

    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await systemEvents(dataDir, 42)).toHaveLength(1); // scheduled only, no fired
    expect(errors).toHaveLength(1);

    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await systemEvents(dataDir, 42)).toHaveLength(2); // fired on retry
  }));

  it("replays a fired recurring run with no successor (crash window) onto the next grid point", async () => withDirectory(async (dataDir) => {
    const firedDueAt = "2026-01-09T09:00:00.000Z";
    await writeSchedules(dataDir, 42, [row({ start: firedDueAt, recurrence: "daily" })]);
    await appendSystemLine(dataDir, 42, {
      type: "schedule_run_scheduled",
      runId: "run-old-1", prompt: "water the plants", start: firedDueAt, recurrence: "daily", dueAt: firedDueAt,
    });
    await appendSystemLine(dataDir, 42, { type: "schedule_run_fired", runId: "run-old-1" });

    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);
    expect(run).not.toHaveBeenCalled(); // next grid point after now is 01-11T09:00
    const events = await systemEvents(dataDir, 42);
    expect(events.at(-1)).toMatchObject({ type: "schedule_run_scheduled", dueAt: "2026-01-11T09:00:00.000Z" });
  }));

  it("never re-fires a one-shot row re-added with identical content after deletion", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row()]);
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);

    await writeSchedules(dataDir, 42, []);
    await scheduler.poll(NOW);
    await writeSchedules(dataDir, 42, [row()]);
    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
    const types = (await systemEvents(dataDir, 42)).map((event) => event.type);
    expect(types.filter((type) => type === "schedule_run_fired")).toHaveLength(1);
  }));

  it("ignores unrelated and malformed log lines while folding", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row()]);
    await appendSystemLine(dataDir, 42, { type: "outbox_claimed", id: "x", name: "x.json", request: {} });
    await appendSystemLine(dataDir, 42, "not json at all" as unknown as Record<string, unknown>);
    await appendSystemLine(dataDir, 42, { type: "schedule_run_scheduled", runId: 7 });

    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);
    expect(run).toHaveBeenCalledTimes(1);
  }));
});

describe("WorkspaceScheduler validation", () => {
  it("reports a malformed schedules file and appends nothing", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [{ prompt: "x", start: "not-a-date", recurrence: null }]);
    const errors: unknown[] = [];
    const scheduler = makeScheduler(dataDir, { logger: (error) => errors.push(error) });
    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
    expect(await systemEvents(dataDir, 42)).toHaveLength(0);
  }));

  it("reports a wrong-version schedules file and appends nothing", async () => withDirectory(async (dataDir) => {
    const metadata = path.join(dataDir, "chats", "42", "workspace", ".tg-bot");
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(metadata, "schedules.json"), JSON.stringify({ version: 2, schedules: [] }), "utf8");
    const errors: unknown[] = [];
    const scheduler = makeScheduler(dataDir, { logger: (error) => errors.push(error) });
    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
  }));

  it("rejects an invalid recurrence", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [{ prompt: "x", start: "2026-01-10T12:00:00.000Z", recurrence: "yearly" }]);
    const errors: unknown[] = [];
    const scheduler = makeScheduler(dataDir, { logger: (error) => errors.push(error) });
    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
  }));

  it("ignores a missing schedules file", async () => withDirectory(async (dataDir) => {
    const run = vi.fn(async () => undefined);
    const scheduler = makeScheduler(dataDir, { run });
    await scheduler.poll(NOW);
    expect(run).not.toHaveBeenCalled();
    expect(await systemEvents(dataDir, 42)).toHaveLength(0);
  }));
});

describe("WorkspaceScheduler lifecycle", () => {
  it("start() polls immediately and registers an interval; stop() clears it", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row()]);
    const interval = fakeInterval();
    const run = vi.fn(async () => undefined);
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run,
      now: () => NOW,
      setInterval: interval.setIntervalMock as unknown as typeof setInterval,
      clearInterval: interval.clearIntervalMock as unknown as typeof clearInterval,
    });

    await scheduler.start();
    expect(run).toHaveBeenCalledTimes(1);
    expect(interval.setIntervalMock).toHaveBeenCalledTimes(1);
    expect(interval.clearIntervalMock).not.toHaveBeenCalled();

    await scheduler.stop();
    expect(interval.clearIntervalMock).toHaveBeenCalledTimes(1);
  }));

  it("concurrent polls share one operation", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 42, [row()]);
    let concurrent = 0;
    let maximum = 0;
    const run = vi.fn(async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
    });
    const scheduler = makeScheduler(dataDir, { run });
    await Promise.all([scheduler.poll(NOW), scheduler.poll(NOW)]);
    expect(maximum).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  }));
});
