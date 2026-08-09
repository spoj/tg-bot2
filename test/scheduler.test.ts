import { mkdir, mkdtemp, open as openFile, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceScheduler, type ScheduleRecord } from "../src/scheduler.js";

const NOW = Date.parse("2026-01-10T12:30:00.000Z");

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "tg-bot2-workspace-scheduler-"));
}

function record(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "schedule-1",
    prompt: "follow up",
    dueAt: new Date(NOW - 1_000).toISOString(),
    recurrence: null,
    enabled: true,
    lastRunAt: null,
    runCount: 0,
    ...overrides,
  };
}

async function writeSchedules(dataDir: string, chatId: string | number, schedules: unknown, suffix = "schedules.json"): Promise<string> {
  const metadata = path.join(dataDir, "chats", String(chatId), "workspace", ".tg-bot");
  await mkdir(metadata, { recursive: true });
  const filePath = path.join(metadata, suffix);
  await writeFile(filePath, JSON.stringify({ version: 1, schedules }), "utf8");
  return filePath;
}

async function readSchedules(filePath: string): Promise<{ version: number; schedules: ScheduleRecord[] }> {
  return JSON.parse(await readFile(filePath, "utf8")) as { version: number; schedules: ScheduleRecord[] };
}

async function withDirectory(test: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await temporaryDirectory();
  try {
    await test(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function fakeInterval() {
  const callbacks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const setInterval = ((callback: () => void, _delay?: number) => {
    callbacks.push(callback);
    return callbacks.length;
  }) as typeof globalThis.setInterval;
  const clearInterval = ((timer: unknown) => {
    cleared.push(timer);
  }) as typeof globalThis.clearInterval;
  return { callbacks, cleared, setInterval, clearInterval };
}

describe("WorkspaceScheduler discovery and validation", () => {
  it("discovers each chat workspace and isolates malformed files", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 12, [record({ id: "twelve", prompt: "chat twelve" })]);
    await writeSchedules(dataDir, -2, [record({ id: "negative", prompt: "chat negative" })]);
    const malformed = await writeSchedules(dataDir, 3, []);
    await writeFile(malformed, JSON.stringify({ version: 99, schedules: [] }), "utf8");
    const broken = await writeSchedules(dataDir, 4, []);
    await writeFile(broken, "{not json", "utf8");
    await mkdir(path.join(dataDir, "chats", "missing", "workspace"), { recursive: true });
    await mkdir(path.join(dataDir, "chats", "01", "workspace", ".tg-bot"), { recursive: true });
    await writeSchedules(dataDir, "ignored", [record({ id: "ignored" })]);

    const outside = path.join(dataDir, "outside.json");
    await writeFile(outside, JSON.stringify({ version: 1, schedules: [record({ id: "outside" })] }), "utf8");
    const symlinkPath = await writeSchedules(dataDir, 5, []);
    await rm(symlinkPath);
    await symlink(outside, symlinkPath);

    const runs: [number, string][] = [];
    const errors: unknown[] = [];
    const scheduler = new WorkspaceScheduler({
      dataDir,
      now: () => NOW,
      run: async (chatId, prompt) => {
        runs.push([chatId, prompt]);
        return "";
      },
      send: async () => {},
      logger: (error) => errors.push(error),
    });

    await scheduler.poll(NOW);
    expect(runs).toEqual([[-2, "chat negative"], [12, "chat twelve"]]);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  }));
  it("rejects the maximum safe run count before execution", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 6, [record({ runCount: Number.MAX_SAFE_INTEGER })]);
    const runs: string[] = [];
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async (_chatId, prompt) => { runs.push(prompt); return ""; },
      send: async () => {},
    });

    await scheduler.poll(NOW);
    expect(runs).toEqual([]);
    expect((await readSchedules(filePath)).schedules[0]!.runCount).toBe(Number.MAX_SAFE_INTEGER);
  }));

  it("rejects symlinked workspace metadata directories", async () => withDirectory(async (dataDir) => {
    const target = path.join(dataDir, "target-metadata");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "schedules.json"), JSON.stringify({ version: 1, schedules: [record()] }), "utf8");
    const metadata = path.join(dataDir, "chats", "8", "workspace", ".tg-bot");
    await mkdir(path.dirname(metadata), { recursive: true });
    await symlink(target, metadata);

    const runs: string[] = [];
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async (_chatId, prompt) => { runs.push(prompt); return ""; },
      send: async () => {},
    });
    await scheduler.poll(NOW);
    expect(runs).toEqual([]);
  }));

  it("does not follow metadata replacement during an atomic update", async () => withDirectory(async (dataDir) => {
    const original = await writeSchedules(dataDir, 11, [record()]);
    const metadata = path.dirname(original);
    const replacement = path.join(dataDir, "replacement-metadata");
    await mkdir(replacement, { recursive: true });
    const replacementFile = path.join(replacement, "schedules.json");
    await writeFile(replacementFile, JSON.stringify({ version: 1, schedules: [record({ id: "replacement" })] }), "utf8");

    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async () => {
        await rm(metadata, { recursive: true });
        await symlink(replacement, metadata);
        return "";
      },
      send: async () => {},
    });

    await scheduler.poll(NOW);
    expect((await readSchedules(replacementFile)).schedules[0]!.enabled).toBe(true);
  }));
});

describe("WorkspaceScheduler processing", () => {
  it("runs due records in deterministic order and advances recurrence", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 42, [
      record({ id: "z", prompt: "later id", dueAt: new Date(NOW).toISOString() }),
      record({ id: "a", prompt: "first id", dueAt: new Date(NOW).toISOString() }),
      record({ id: "hourly", prompt: "hourly", recurrence: "hourly", dueAt: new Date(NOW - 3 * 60 * 60_000).toISOString() }),
      record({ id: "future", dueAt: new Date(NOW + 60_000).toISOString() }),
    ]);
    const runs: string[] = [];
    const sent: string[] = [];
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async (_chatId, prompt) => { runs.push(prompt); return prompt === "first id" ? "answer" : ""; },
      send: async (_chatId, text) => { sent.push(text); },
    });

    await scheduler.poll(NOW);
    expect(runs).toEqual(["hourly", "first id", "later id"]);
    expect(sent).toEqual(["answer"]);
    const persisted = await readSchedules(filePath);
    expect(persisted.schedules.find((item) => item.id === "a")).toMatchObject({ enabled: false, runCount: 1, lastRunAt: new Date(NOW).toISOString() });
    expect(persisted.schedules.find((item) => item.id === "z")).toMatchObject({ enabled: false, runCount: 1 });
    expect(persisted.schedules.find((item) => item.id === "hourly")).toMatchObject({ enabled: true, runCount: 1 });
    expect(Date.parse(persisted.schedules.find((item) => item.id === "hourly")!.dueAt)).toBeGreaterThan(NOW);
    expect(persisted.schedules.find((item) => item.id === "future")!.runCount).toBe(0);
  }));
  it("rechecks each due record after earlier callbacks edit schedules", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 43, [
      record({ id: "first", prompt: "first", dueAt: new Date(NOW - 2_000).toISOString() }),
      record({ id: "later", prompt: "later", dueAt: new Date(NOW - 1_000).toISOString() }),
    ]);
    const runs: string[] = [];
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async (_chatId, prompt) => {
        runs.push(prompt);
        if (prompt === "first") {
          const current = await readSchedules(filePath);
          current.schedules = current.schedules.map((item) => item.id === "later" ? { ...item, enabled: false } : item);
          await writeFile(filePath, JSON.stringify(current), "utf8");
        }
        return "";
      },
      send: async () => {},
    });

    await scheduler.poll(NOW);
    expect(runs).toEqual(["first"]);
    expect((await readSchedules(filePath)).schedules).toMatchObject([{ id: "first" }, { id: "later", enabled: false, runCount: 0 }]);
  }));


  it("leaves a failed run due for at-least-once retry", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 7, [record()]);
    let attempts = 0;
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
        return "done";
      },
      send: async () => {},
    });

    await scheduler.poll(NOW);
    expect((await readSchedules(filePath)).schedules[0]).toMatchObject({ enabled: true, runCount: 0 });
    await scheduler.poll(NOW);
    expect((await readSchedules(filePath)).schedules[0]).toMatchObject({ enabled: false, runCount: 1 });
  }));

  it("re-reads before updating and preserves agent edits", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 9, [record({ recurrence: "daily" })]);
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async () => {
        const current = await readSchedules(filePath);
        current.schedules[0] = {
          ...current.schedules[0]!,
          prompt: "agent changed prompt",
          dueAt: new Date(NOW + 10 * 60_000).toISOString(),
        };
        await writeFile(filePath, JSON.stringify(current), "utf8");
        return "done";
      },
      send: async () => {},
    });

    await scheduler.poll(NOW);
    const persisted = await readSchedules(filePath);
    expect(persisted.schedules[0]).toMatchObject({
      prompt: "agent changed prompt",
      dueAt: new Date(NOW + 10 * 60_000).toISOString(),
      enabled: true,
      runCount: 1,
      lastRunAt: new Date(NOW).toISOString(),
    });
  }));
  it("preserves an atomic agent edit detected before replacement", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 14, [record({ prompt: "original" })]);
    const probe = await openFile(filePath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      sync: (this: unknown, ...args: any[]) => Promise<any>;
    };
    const originalSync = prototype.sync;
    let syncs = 0;
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: unknown, ...args: any[]) {
      syncs += 1;
      if (syncs === 1) {
        const replacement = `${filePath}.agent`;
        await writeFile(replacement, JSON.stringify({
          version: 1,
          schedules: [record({ prompt: "agent edit", runCount: 0 })],
        }) + "\n", "utf8");
        await rename(replacement, filePath);
      }
      return originalSync.apply(this, args);
    });
    const errors: unknown[] = [];
    try {
      const scheduler = new WorkspaceScheduler({
        dataDir,
        run: async () => "done",
        send: async () => {},
        logger: (error) => errors.push(error),
      });
      await scheduler.poll(NOW);
    } finally {
      syncSpy.mockRestore();
      await probe.close();
    }


    const persisted = await readSchedules(filePath);
    expect(persisted.schedules[0]).toMatchObject({ prompt: "agent edit", enabled: true, runCount: 0 });
    expect(Date.parse(persisted.schedules[0]!.dueAt)).toBeLessThanOrEqual(NOW);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).cause)).toContain("leaving schedule due for a later poll");
  }));


  it("uses an atomic replacement without leaving temporary files", async () => withDirectory(async (dataDir) => {
    const filePath = await writeSchedules(dataDir, 10, [record()]);
    const scheduler = new WorkspaceScheduler({ dataDir, run: async () => "ok", send: async () => {} });
    await scheduler.poll(NOW);
    expect((await readdir(path.dirname(filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await readSchedules(filePath)).schedules[0]!.enabled).toBe(false);
  }));
});

describe("WorkspaceScheduler lifecycle", () => {
  it("serializes overlapping polls", async () => withDirectory(async (dataDir) => {
    await writeSchedules(dataDir, 1, [record()]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const scheduler = new WorkspaceScheduler({
      dataDir,
      run: async () => {
        started += 1;
        await blocked;
        return "";
      },
      send: async () => {},
    });
    const first = scheduler.poll(NOW);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = scheduler.poll(NOW);
    release();
    await Promise.all([first, second]);
    expect(started).toBe(1);
  }));

  it("performs an initial poll and owns a five-minute interval", async () => withDirectory(async (dataDir) => {
    const timers = fakeInterval();
    let polls = 0;
    const scheduler = new WorkspaceScheduler({
      dataDir,
      setInterval: ((callback: Parameters<typeof globalThis.setInterval>[0], delay: Parameters<typeof globalThis.setInterval>[1]) => {
        expect(delay).toBe(5 * 60_000);
        return timers.setInterval(callback, delay);
      }) as typeof setInterval,
      clearInterval: timers.clearInterval,
      run: async () => { polls += 1; return ""; },
      send: async () => {},
    });
    await scheduler.start();
    expect(timers.callbacks).toHaveLength(1);
    expect(polls).toBe(0);
    timers.callbacks[0]!();
    await scheduler.poll();
    expect(polls).toBe(0);
    await scheduler.stop();
    expect(timers.cleared).toEqual([1]);
  }));
});
