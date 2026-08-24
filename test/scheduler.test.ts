import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramConversation } from "../src/telegram-ref.js";
import { WorkspaceTimeline } from "../src/events.js";
import { WorkspaceScheduler, type WorkspaceSchedulerOptions } from "../src/scheduler.js";

const temporaryDirectories: string[] = [];
const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const CONNECTOR_ID = "telegram:123";
const OWNER = telegramConversation(CONNECTOR_ID, 42, 7);

const input = {
  prompt: "water the plants",
  start: "2026-01-10T11:00:00.000Z",
  recurrence: null,
} as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "scheduler-test-"));
  temporaryDirectories.push(dataDir);
  await mkdir(path.join(dataDir, "workspace"), { recursive: true });
  await mkdir(path.join(dataDir, "run"), { recursive: true });
  await writeFile(path.join(dataDir, "timeline.jsonl"), "", "utf8");
  return dataDir;
}

async function timeline(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(dataDir, "timeline.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function schedules(dataDir: string): Promise<{ schedules: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(path.join(dataDir, "run", "schedules.json"), "utf8")) as { schedules: Array<Record<string, unknown>> };
}

function makeScheduler(dataDir: string, overrides: Partial<WorkspaceSchedulerOptions> = {}): { scheduler: WorkspaceScheduler; errors: unknown[] } {
  const errors: unknown[] = [];
  const scheduler = new WorkspaceScheduler({
    schedulePath: path.join(dataDir, "run", "schedules.json"),
    timeline: new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl")),
    now: () => NOW,
    logger: (error) => errors.push(error),
    ...overrides,
  });
  return { scheduler, errors };
}

describe("WorkspaceScheduler", () => {
  it("creates host-owned schedules and publishes a due one-shot once across restarts", async () => {
    const dataDir = await fixture();
    const first = makeScheduler(dataDir).scheduler;
    const created = await first.add(input, OWNER);

    expect(created).toMatchObject({
      id: expect.any(String),
      ...input,
      owner: OWNER,
      next_due_at: input.start,
    });
    expect((await schedules(dataDir)).schedules).toEqual([created]);

    await first.poll(NOW);
    expect(await timeline(dataDir)).toMatchObject([{
      type: "schedule_fired",
      scheduleId: created.id,
      occurrenceId: expect.any(String),
      prompt: input.prompt,
      dueAt: input.start,
      conversation: OWNER,
    }]);
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, next_due_at: null });

    await first.poll(NOW);
    await makeScheduler(dataDir).scheduler.poll(NOW);
    expect(await timeline(dataDir)).toHaveLength(1);
  });

  it("restores a due one-shot when timeline publication fails", async () => {
    const dataDir = await fixture();
    const workspaceTimeline = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
    const publish = vi.spyOn(workspaceTimeline, "publish");
    publish.mockRejectedValueOnce(new Error("timeline unavailable"));
    const { scheduler, errors } = makeScheduler(dataDir, { timeline: workspaceTimeline });
    const created = await scheduler.add(input, OWNER);

    await scheduler.poll(NOW);

    expect(errors).toHaveLength(1);
    expect(await timeline(dataDir)).toEqual([]);
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, next_due_at: input.start });

    await scheduler.poll(NOW);
    expect(await timeline(dataDir)).toMatchObject([{ type: "schedule_fired", scheduleId: created.id, dueAt: input.start }]);
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, next_due_at: null });
  });

  it("restores a due recurring schedule when timeline publication fails", async () => {
    const dataDir = await fixture();
    const workspaceTimeline = new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl"));
    const publish = vi.spyOn(workspaceTimeline, "publish");
    publish.mockRejectedValueOnce(new Error("timeline unavailable"));
    const { scheduler, errors } = makeScheduler(dataDir, { timeline: workspaceTimeline });
    const created = await scheduler.add({ ...input, start: "2026-01-08T12:00:00.000Z", recurrence: "daily" }, OWNER);

    await scheduler.poll(NOW);

    expect(errors).toHaveLength(1);
    expect(await timeline(dataDir)).toEqual([]);
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, next_due_at: created.start });

    await scheduler.poll(NOW);
    expect(await timeline(dataDir)).toMatchObject([{ type: "schedule_fired", scheduleId: created.id, dueAt: created.start }]);
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, next_due_at: "2026-01-11T12:00:00.000Z" });
  });

  it("reactivates a completed one-shot when replaced with recurrence at the same start", async () => {
    const dataDir = await fixture();
    const scheduler = makeScheduler(dataDir).scheduler;
    const created = await scheduler.add(input, OWNER);

    await scheduler.poll(NOW);
    const recurring = await scheduler.replace({ ...created, recurrence: "daily" }, OWNER);

    expect(recurring.next_due_at).toBe("2026-01-11T11:00:00.000Z");
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, recurrence: "daily", next_due_at: "2026-01-11T11:00:00.000Z" });

    await scheduler.poll(Date.parse("2026-01-11T11:00:00.000Z"));
    expect(await timeline(dataDir)).toHaveLength(2);
  });


  it("advances recurring schedules to the next future occurrence", async () => {
    const dataDir = await fixture();
    const scheduler = makeScheduler(dataDir).scheduler;
    const created = await scheduler.add({ ...input, recurrence: "daily", start: "2026-01-08T12:00:00.000Z" }, OWNER);

    await scheduler.poll(NOW);
    expect((await schedules(dataDir)).schedules[0]).toMatchObject({ id: created.id, next_due_at: "2026-01-11T12:00:00.000Z" });
    await scheduler.poll(Date.parse("2026-01-11T12:00:00.000Z"));
    expect(await timeline(dataDir)).toHaveLength(2);
  });

  it("replaces owned definitions while only a changed start resets next due", async () => {
    const dataDir = await fixture();
    const scheduler = makeScheduler(dataDir).scheduler;
    const created = await scheduler.add({ ...input, start: "2026-01-11T12:00:00.000Z", recurrence: "daily" }, OWNER);

    const cadenceChanged = await scheduler.replace({
      id: created.id,
      prompt: "water the garden",
      start: created.start,
      recurrence: "hourly",
    }, OWNER);
    expect(cadenceChanged).toMatchObject({ prompt: "water the garden", recurrence: "hourly", next_due_at: "2026-01-11T12:00:00.000Z" });

    const rescheduled = await scheduler.replace({ ...cadenceChanged, start: "2026-01-10T13:00:00.000Z" }, OWNER);
    expect(rescheduled.next_due_at).toBe("2026-01-10T13:00:00.000Z");
    await expect(scheduler.replace({ ...rescheduled, prompt: "stolen" }, telegramConversation(CONNECTOR_ID, 99))).rejects.toThrow("not owned by this conversation");
    await expect(scheduler.remove({ id: created.id }, telegramConversation(CONNECTOR_ID, 99))).rejects.toThrow("not owned by this conversation");

    await scheduler.remove({ id: created.id }, OWNER);
    expect((await schedules(dataDir)).schedules).toEqual([]);
  });

  it("lets any conversation take responsibility without changing timing", async () => {
    const dataDir = await fixture();
    const scheduler = makeScheduler(dataDir).scheduler;
    const created = await scheduler.add({ ...input, start: "2026-01-11T12:00:00.000Z" }, OWNER);
    const taker = telegramConversation(CONNECTOR_ID, 99, 3);

    const taken = await scheduler.take({ id: created.id }, taker);
    expect(taken).toEqual({ ...created, owner: taker });
    expect(await timeline(dataDir)).toMatchObject([{
      type: "schedule_taken",
      scheduleId: created.id,
      previousOwner: OWNER,
      conversation: taker,
    }]);
    await expect(scheduler.remove({ id: created.id }, OWNER)).rejects.toThrow("not owned by this conversation");
    await expect(scheduler.remove({ id: created.id }, taker)).resolves.toBe(created.id);
  });

  it("serializes taking with firing so the committed owner receives the occurrence", async () => {
    const dataDir = await fixture();
    const scheduler = makeScheduler(dataDir).scheduler;
    const created = await scheduler.add(input, OWNER);
    const taker = telegramConversation(CONNECTOR_ID, 99);

    await scheduler.take({ id: created.id }, taker);
    await scheduler.poll(NOW);
    expect((await timeline(dataDir)).filter((event) => event.type === "schedule_fired")).toMatchObject([{ conversation: taker }]);
  });


  it("reports malformed host state without replacing it", async () => {
    const dataDir = await fixture();
    const schedulePath = path.join(dataDir, "run", "schedules.json");
    await writeFile(schedulePath, "not json", "utf8");
    const { scheduler, errors } = makeScheduler(dataDir);

    await scheduler.poll(NOW);
    expect(errors).toHaveLength(1);
    expect(await readFile(schedulePath, "utf8")).toBe("not json");
  });

  it("coalesces concurrent polls", async () => {
    const dataDir = await fixture();
    const scheduler = makeScheduler(dataDir).scheduler;
    await scheduler.add(input, OWNER);
    await Promise.all([scheduler.poll(NOW), scheduler.poll(NOW), scheduler.poll(NOW)]);
    expect((await timeline(dataDir)).filter((event) => event.type === "schedule_fired")).toHaveLength(1);
  });

  it("rejects invalid poll intervals", async () => {
    const dataDir = await fixture();
    const base = {
      schedulePath: path.join(dataDir, "run", "schedules.json"),
      timeline: new WorkspaceTimeline(path.join(dataDir, "timeline.jsonl")),
    };
    expect(() => new WorkspaceScheduler({ ...base, pollIntervalMs: 0 })).toThrow("positive timer-safe integer");
    expect(() => new WorkspaceScheduler({ ...base, pollIntervalMs: 2_147_483_648 })).toThrow("positive timer-safe integer");
  });

  it("starts once, creates the read-only projection source, and stops its polling timer", async () => {
    const dataDir = await fixture();
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn(() => timer);
    const clearIntervalFn = vi.fn();
    const { scheduler } = makeScheduler(dataDir, { setInterval: setIntervalFn as unknown as typeof setInterval, clearInterval: clearIntervalFn as unknown as typeof clearInterval });

    await scheduler.start();
    await scheduler.start();
    expect((await schedules(dataDir)).schedules).toEqual([]);
    expect(setIntervalFn).toHaveBeenCalledOnce();
    await scheduler.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });
});
