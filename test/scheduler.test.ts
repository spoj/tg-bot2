import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { advanceDueAt, parseDueAt, Scheduler, type ScheduleRecord } from "../src/scheduler.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tg-bot2-scheduler-test-"));
}

function fakeTimers() {
  const callbacks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const setTimeout = ((callback: () => void) => {
    callbacks.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  const clearTimeout = ((timer: unknown) => { cleared.push(timer); }) as typeof globalThis.clearTimeout;
  return { callbacks, cleared, setTimeout, clearTimeout };
}

describe("scheduler time parsing", () => {
  const now = Date.parse("2026-01-10T12:30:00.000Z");

  it("parses ISO and relative times", () => {
    expect(parseDueAt("2026-01-10T13:00:00.000Z", now)).toBe(now + 30 * 60_000);
    expect(parseDueAt("in 2 hours", now)).toBe(now + 2 * 60 * 60_000);
    expect(parseDueAt("45m", now)).toBe(now + 45 * 60_000);
  });

  it("parses tomorrow and the next local clock occurrence", () => {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(parseDueAt("tomorrow", now)).toBe(tomorrow.getTime());

    const clock = new Date(now);
    clock.setHours(9, 15, 0, 0);
    if (clock.getTime() <= now) clock.setDate(clock.getDate() + 1);
    expect(parseDueAt("at 09:15", now)).toBe(clock.getTime());
  });

  it("skips every missed recurrence period deterministically", () => {
    expect(advanceDueAt(1_000, "hourly", 3_600_001)).toBe(3_601_000);
    expect(advanceDueAt(1_000, "daily", 2 * 86_400_000 + 1_000)).toBe(3 * 86_400_000 + 1_000);
    expect(advanceDueAt(1_000, "weekly", 7 * 86_400_000 + 1_000)).toBe(2 * 7 * 86_400_000 + 1_000);
  });
});

describe("persistent scheduler", () => {
  it("atomically persists and reloads records", async () => {
    const directory = await temporaryDirectory();
    try {
      let now = 1_000_000;
      const timers = fakeTimers();
      const first = new Scheduler({
        dataDir: directory,
        now: () => now,
        idFactory: () => "first",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async () => "",
        send: async () => {},
      });
      await first.start();
      await first.schedule(10, { when: new Date(now + 60_000).toISOString(), prompt: "check in" });
      const persisted = JSON.parse(await readFile(path.join(directory, "schedules.json"), "utf8")) as ScheduleRecord[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ id: "first", chatId: 10, prompt: "check in", recurrence: null });
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await first.stop();

      const second = new Scheduler({
        dataDir: directory,
        now: () => now,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async () => "",
        send: async () => {},
      });
      await second.start();
      expect(second.getRecords(10)).toHaveLength(1);
      await second.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("filters list and cancel operations by chat ownership", async () => {
    const directory = await temporaryDirectory();
    try {
      const timers = fakeTimers();
      const scheduler = new Scheduler({
        dataDir: directory,
        now: () => 1_000_000,
        idFactory: (() => { let next = 0; return () => `id-${++next}`; })(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async () => "",
        send: async () => {},
      });
      await scheduler.start();
      await scheduler.schedule(1, { when: "in 1 hour", prompt: "private one" });
      await scheduler.schedule(2, { when: "in 1 hour", prompt: "private two" });
      const own = await scheduler.list(1);
      expect(own).toContain("private one");
      expect(own).not.toContain("private two");
      const otherId = scheduler.getRecords(2)[0]?.id;
      expect(otherId).toBeDefined();
      await expect(scheduler.cancel(1, otherId!)).resolves.toBe("No scheduled reminder found.");
      expect(scheduler.getRecords(2)).toHaveLength(1);
      await expect(scheduler.cancel(2, otherId!)).resolves.toContain(otherId!);
      await scheduler.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("processes due reminders and advances recurring jobs", async () => {
    const directory = await temporaryDirectory();
    try {
      let now = 1_000_000;
      const timers = fakeTimers();
      const runs: [number, string][] = [];
      const sends: [number, string][] = [];
      const scheduler = new Scheduler({
        dataDir: directory,
        now: () => now,
        idFactory: (() => { let next = 0; return () => `id-${++next}`; })(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async (chatId, prompt) => { runs.push([chatId, prompt]); return `answer: ${prompt}`; },
        send: async (chatId, text) => { sends.push([chatId, text]); },
      });
      await scheduler.start();
      await scheduler.schedule(4, { when: new Date(now + 1_000).toISOString(), prompt: "once" });
      await scheduler.schedule(4, { when: new Date(now + 2_000).toISOString(), prompt: "repeat", recurring: "hourly" });
      now += 3 * 60 * 60_000 + 2_000;
      await scheduler.processDue(now);
      expect(runs).toEqual([[4, "once"], [4, "repeat"]]);
      expect(sends).toEqual([[4, "answer: once"], [4, "answer: repeat"]]);
      expect(scheduler.getRecords(4)).toHaveLength(1);
      expect(scheduler.getRecords(4)[0]?.dueAt).toBe(now + 60 * 60_000);
      await scheduler.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("releases persistence before a due callback schedules another record", async () => {
    const directory = await temporaryDirectory();
    try {
      const now = 1_000_000;
      const timers = fakeTimers();
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let nested: Promise<string> | undefined;
      const scheduler = new Scheduler({
        dataDir: directory,
        now: () => now,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async () => {
          startedResolve();
          nested = scheduler.schedule(8, { when: "in 1 hour", prompt: "nested" });
          await nested;
          await gate;
          return "done";
        },
        send: async () => {},
      });
      await scheduler.start();
      await scheduler.schedule(8, { when: new Date(now - 1).toISOString(), prompt: "due" });
      const processing = scheduler.processDue(now);
      await started;
      await expect(nested).resolves.toContain("Scheduled");
      release();
      await processing;
      expect(scheduler.getRecords(8)).toHaveLength(1);
      await scheduler.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drains a due callback claimed before shutdown", async () => {
    const directory = await temporaryDirectory();
    try {
      const now = 1_000_000;
      const timers = fakeTimers();
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const runs: string[] = [];
      const scheduler = new Scheduler({
        dataDir: directory,
        now: () => now,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async (_chatId, prompt) => {
          startedResolve();
          await gate;
          runs.push(prompt);
          return "done";
        },
        send: async () => {},
      });
      await scheduler.start();
      await scheduler.schedule(9, { when: new Date(now - 1).toISOString(), prompt: "claimed" });
      const processing = scheduler.processDue(now);
      await started;
      const stopping = scheduler.stop();
      release();
      await Promise.all([processing, stopping]);
      expect(runs).toEqual(["claimed"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops and clears the nearest-due timer", async () => {
    const directory = await temporaryDirectory();
    try {
      const timers = fakeTimers();
      const scheduler = new Scheduler({
        dataDir: directory,
        now: () => 1_000_000,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        run: async () => "",
        send: async () => {},
      });
      await scheduler.start();
      await scheduler.schedule(1, { when: "in 1 hour", prompt: "later" });
      expect(timers.callbacks).toHaveLength(1);
      await scheduler.stop();
      expect(timers.cleared).toHaveLength(1);
      await expect(scheduler.schedule(1, { when: "in 1 hour", prompt: "rejected" })).rejects.toThrow("not running");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed startup state", async () => {
    const directory = await temporaryDirectory();
    try {
      await writeFile(path.join(directory, "schedules.json"), "{broken", "utf8");
      const scheduler = new Scheduler({ dataDir: directory, run: async () => "", send: async () => {} });
      await expect(scheduler.start()).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
