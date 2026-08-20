import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  AgentManager,
  loadUserSettings,
  SYSTEM_PROMPT,
  type AgentRunWorker,
  type AgentWorkerOptions,
  type AgentStatus,
} from "../src/agent.js";
import { OUTBOX_PROMPT } from "../src/outbox-protocol.js";
import { EVENTS_PROMPT } from "../src/events.js";
import { SCHEDULES_PROMPT } from "../src/schedule-protocol.js";
import { TASKS_PROMPT } from "../src/task-protocol.js";
import type { Config } from "../src/config.js";
import { deferred } from "./helpers.js";

type RunResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string };

type FakeRun = {
  worker: AgentRunWorker & { options: AgentWorkerOptions };
  resolveRun: (result: RunResult) => void;
  stop: Mock<() => Promise<void>>;
  run: Mock<() => Promise<RunResult>>;
};

function fakeWorkerFactory(): { factory: Mock<(options: AgentWorkerOptions) => Promise<AgentRunWorker>>; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const factory = vi.fn(async (options: AgentWorkerOptions): Promise<AgentRunWorker> => {
    const gate = deferred<RunResult>();
    const stop = vi.fn(async () => {});
    const run = vi.fn(async () => await gate.promise);
    const worker = { run, stop, options } as unknown as AgentRunWorker & { options: AgentWorkerOptions };
    runs.push({ worker, resolveRun: gate.resolve, stop, run });
    return worker;
  });
  return { factory, runs };
}

type ManualTimer = { fn: () => void; delay: number };
function manualTimers() {
  const pending = new Set<ManualTimer>();
  const cleared: ManualTimer[] = [];
  return {
    cleared,
    byDelay: (delay: number) => [...pending].filter((entry) => entry.delay === delay),
    setTimeout: ((fn: () => void, delay: number) => {
      const timer: ManualTimer = { fn, delay };
      pending.add(timer);
      return timer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeout: ((timer: NodeJS.Timeout) => {
      const entry = timer as unknown as ManualTimer;
      pending.delete(entry);
      cleared.push(entry);
    }) as typeof clearTimeout,
  };
}

const config: Config = {
  token: "token",
  allowedUserIds: new Set([1]),
  dataDir: "/tmp/tg-bot2-test",
};

function managerOptions(overrides: Record<string, unknown> = {}): ConstructorParameters<typeof AgentManager>[1] {
  return {
    appRoot: "/tmp/tg-bot2-app",
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    now: () => 1_000_000,
    combineDebounceMs: 0,
    ...overrides,
  };
}
async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tg-bot-agent-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function settingsFile(dataDir: string, chatId: number, content: Record<string, unknown>): Promise<void> {
  const target = path.join(dataDir, "chats", String(chatId), "workspace", ".pi", "agent", "settings.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(content), "utf8");
}

const INTRO = `You are a persistent personal agent reached through Telegram.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available.
Install optional project-local extensions with pi install npm:<package> -l --approve, pi install https://... -l --approve, pi install git:... -l --approve, or pi install ./... -l --approve. Use pi list --approve to inspect them. Project settings are stored at /workspace/.pi/settings.json. Settings and extension changes take effect on your next run.
`;

const OUTRO = `Keep Telegram-facing answers concise unless the user asks for detail.
/status is a host command that reports your current model, thinking level, and session summary.
Choose your model and thinking level by editing /workspace/.pi/agent/settings.json (defaultProvider, defaultModel, defaultThinkingLevel); new values apply from your next run. Edit the file atomically because a malformed settings file breaks the next run.
Your session resumes across runs for up to two hours of inactivity; after a longer gap the next run starts fresh. To reset your context deliberately, touch /workspace/.tg-bot/new-session (any empty file) and the next run starts fresh.
Older conversations persist under /workspace/.pi/sessions/*.jsonl — read/grep them when the user references history.
`;

it("composes the SYSTEM_PROMPT from the intro, protocol sections, and outro", () => {
  expect(SYSTEM_PROMPT).toBe(`${INTRO}${OUTBOX_PROMPT}${EVENTS_PROMPT}${SCHEDULES_PROMPT}${TASKS_PROMPT}${OUTRO}`);
  expect(SYSTEM_PROMPT).toContain("/status is a host command");
  expect(SYSTEM_PROMPT).toContain("new-session");
  expect(SYSTEM_PROMPT).not.toContain("/model, /thinking, /status, and /restart");
});

it("loadUserSettings tolerates missing, empty, and malformed files", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "chats", "42", "workspace");
    await mkdir(path.join(workspace, ".pi", "agent"), { recursive: true });
    await expect(loadUserSettings(workspace)).resolves.toEqual({});
    await writeFile(path.join(workspace, ".pi", "agent", "settings.json"), "not json", "utf8");
    await expect(loadUserSettings(workspace)).resolves.toEqual({});
    await settingsFile(dataDir, 42, { defaultModel: "claude", custom: true });
    await expect(loadUserSettings(workspace)).resolves.toEqual({ defaultModel: "claude", custom: true });
  });
});

it("followup starts a fresh run when the resume window has never opened", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, ".");
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ message: ".", resume: false, appendSystemPrompt: SYSTEM_PROMPT });
    expect(runs[0]?.run).toHaveBeenCalledOnce();
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("followup queues behind an active run and drains combined in order", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "first");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.followup(42, "second");
    await manager.followup(42, "third");
    expect(runs).toHaveLength(1);
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.message).toBe("second\nthird");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("interrupt kills the active run and runs next, preserving queued followups", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "scheduled");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.followup(42, "queued");
    await manager.interrupt(42, ".");
    await vi.waitFor(() => expect(runs[0]?.stop).toHaveBeenCalledOnce());
    runs[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.message).toBe(".");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    expect(runs[2]?.worker.options.message).toBe("queued");
    runs[2]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("interrupt while idle starts a run immediately", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.interrupt(42, ".");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(factory.mock.calls[0]?.[0].message).toBe(".");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("coalesces an interrupt burst into one stop and one combined message", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, combineDebounceMs: 50, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "scheduled");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.interrupt(42, "first");
    await manager.interrupt(42, "second");
    await manager.interrupt(42, "third");
    await vi.waitFor(() => expect(runs[0]?.stop).toHaveBeenCalledOnce());
    runs[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.message).toBe("first\nsecond\nthird");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("combines interrupts while idle into one message after the debounce window", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, combineDebounceMs: 50, now: () => 10 * 60 * 60 * 1000 }));
    await manager.interrupt(42, "first");
    await manager.interrupt(42, "second");
    await manager.interrupt(42, "third");
    expect(runs).toHaveLength(0);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.worker.options.message).toBe("first\nsecond\nthird");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("force-drains a running burst at the cap and combines interrupts arriving during the abort", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const timers = manualTimers();
    const manager = new AgentManager({ dataDir }, managerOptions({
      workerFactory: factory,
      combineDebounceMs: 100,
      interruptForceDrainMs: 200,
      now: () => 10 * 60 * 60 * 1000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }));
    await manager.followup(42, "scheduled");
    timers.byDelay(100)[0]?.fn();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.interrupt(42, "first");
    await manager.interrupt(42, "second");
    expect(timers.byDelay(200)).toHaveLength(1);
    timers.byDelay(200)[0]?.fn();
    expect(runs[0]?.stop).toHaveBeenCalledOnce();
    await manager.interrupt(42, "third");
    runs[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.message).toBe("first\nsecond\nthird");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("force-drains an idle interrupt at the cap", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const timers = manualTimers();
    const manager = new AgentManager({ dataDir }, managerOptions({
      workerFactory: factory,
      combineDebounceMs: 100,
      interruptForceDrainMs: 200,
      now: () => 10 * 60 * 60 * 1000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }));
    await manager.interrupt(42, "first");
    expect(runs).toHaveLength(0);
    timers.byDelay(200)[0]?.fn();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.worker.options.message).toBe("first");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("queues followups behind interrupts still waiting out the debounce window", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, combineDebounceMs: 50, now: () => 10 * 60 * 60 * 1000 }));
    await manager.interrupt(42, "first");
    await manager.followup(42, "later");
    expect(runs).toHaveLength(0);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.worker.options.message).toBe("first");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.message).toBe("later");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("combines idle followups into one message after the debounce window", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, combineDebounceMs: 50, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "first");
    await manager.followup(42, "second");
    expect(runs).toHaveLength(0);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.worker.options.message).toBe("first\nsecond");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("combines followups queued during a run and delivers them at settle", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, combineDebounceMs: 50, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "scheduled");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.followup(42, "first");
    await manager.followup(42, "second");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[0]?.stop).not.toHaveBeenCalled();
    expect(runs[1]?.worker.options.message).toBe("first\nsecond");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("restarts the debounce window on each new interrupt without restarting the force cap", async () => {
  await withDataDir(async (dataDir) => {
    const { factory } = fakeWorkerFactory();
    const timers = manualTimers();
    const manager = new AgentManager({ dataDir }, managerOptions({
      workerFactory: factory,
      combineDebounceMs: 100,
      interruptForceDrainMs: 1_000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }));
    await manager.interrupt(42, "first");
    const firstDebounce = timers.byDelay(100)[0];
    expect(firstDebounce).toBeDefined();
    await manager.interrupt(42, "second");
    expect(timers.cleared).toContain(firstDebounce);
    expect(timers.byDelay(100)).toHaveLength(1);
    expect(timers.byDelay(1_000)).toHaveLength(1);
  });
});

it("a natural settle cancels the pending interrupt stop", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, combineDebounceMs: 50, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "scheduled");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.interrupt(42, ".");
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[0]?.stop).not.toHaveBeenCalled();
    expect(runs[1]?.worker.options.message).toBe(".");
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("rejects a non-timer-safe combine debounce window", () => {
  expect(() => new AgentManager(config, managerOptions({ combineDebounceMs: -1 }))).toThrow("non-negative timer-safe integer");
});

it("rejects a force drain window shorter than the debounce window", () => {
  expect(() => new AgentManager(config, managerOptions({ combineDebounceMs: 100, interruptForceDrainMs: 50 }))).toThrow("at least the debounce window");
});

it("beginShutdown cancels pending interrupt stops", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const timers = manualTimers();
    const manager = new AgentManager({ dataDir }, managerOptions({
      workerFactory: factory,
      combineDebounceMs: 100,
      interruptForceDrainMs: 1_000,
      now: () => 10 * 60 * 60 * 1000,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }));
    await manager.followup(42, "scheduled");
    timers.byDelay(100)[0]?.fn();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.interrupt(42, ".");
    expect(timers.byDelay(100)).toHaveLength(1);
    expect(timers.byDelay(1_000)).toHaveLength(1);
    await manager.beginShutdown();
    expect(runs[0]?.stop).toHaveBeenCalledOnce();
    runs[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
    expect(runs).toHaveLength(1);
  });
});

it("resumes within the window and starts fresh after it closes", async () => {
  await withDataDir(async (dataDir) => {
    const tenHours = 10 * 60 * 60 * 1000;
    let now = tenHours;
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => now }));
    await manager.followup(42, "one");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.worker.options.resume).toBe(false);
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });

    now = tenHours + 60_000;
    await manager.followup(42, "two");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.resume).toBe(true);
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });

    // Wait for run two to fully settle before advancing the clock, so "three"
    // starts after a real gap rather than draining from run two's queue.
    await vi.waitFor(async () => {
      const activity = JSON.parse(await readFile(path.join(dataDir, "chats", "42", "activity.json"), "utf8")) as { at: number };
      expect(activity.at).toBe(tenHours + 60_000);
    });

    now = tenHours + 3 * 60 * 60 * 1000;
    await manager.followup(42, "three");
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    expect(runs[2]?.worker.options.resume).toBe(false);
    runs[2]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("a new-session marker forces a fresh run and is consumed", async () => {
  await withDataDir(async (dataDir) => {
    const tenHours = 10 * 60 * 60 * 1000;
    let now = tenHours;
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => now }));
    await manager.followup(42, "one");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(async () => {
      const activity = JSON.parse(await readFile(path.join(dataDir, "chats", "42", "activity.json"), "utf8")) as { at: number };
      expect(activity.at).toBe(tenHours);
    });

    const marker = path.join(dataDir, "chats", "42", "workspace", ".tg-bot", "new-session");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "", "utf8");
    now = tenHours + 60_000;
    await manager.followup(42, "two");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]?.worker.options.resume).toBe(false);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("passes settings defaults as model and thinking CLI args", async () => {
  await withDataDir(async (dataDir) => {
    await settingsFile(dataDir, 42, {
      defaultProvider: "openrouter",
      defaultModel: "deepseek/deepseek-chat",
      defaultThinkingLevel: "high",
    });
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, ".");
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      model: "openrouter/deepseek/deepseek-chat",
      thinkingLevel: "high",
    });
    runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("persists last activity host-side and reloads it for a new manager", async () => {
  await withDataDir(async (dataDir) => {
    const tenHours = 10 * 60 * 60 * 1000;
    const now = tenHours;
    const first = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: first.factory, now: () => now }));
    await manager.followup(42, "one");
    await vi.waitFor(() => expect(first.runs).toHaveLength(1));
    first.runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    await vi.waitFor(async () => {
      const activity = JSON.parse(await readFile(path.join(dataDir, "chats", "42", "activity.json"), "utf8")) as { at: number };
      expect(activity.at).toBe(tenHours);
    });

    const second = fakeWorkerFactory();
    const secondManager = new AgentManager({ dataDir }, managerOptions({ workerFactory: second.factory, now: () => tenHours + 5_000 }));
    await secondManager.followup(42, "two");
    await vi.waitFor(() => expect(second.runs).toHaveLength(1));
    expect(second.factory.mock.calls[0]?.[0].resume).toBe(true);
    second.runs[0]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
  });
});

it("status reads the newest session file and settings defaults without spawning", async () => {
  await withDataDir(async (dataDir) => {
    await settingsFile(dataDir, 42, { defaultModel: "fallback", defaultProvider: "openrouter", defaultThinkingLevel: "low" });
    const sessions = path.join(dataDir, "chats", "42", "workspace", ".pi", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "old.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "old", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [] } }),
    ].join("\n"), "utf8");
    await writeFile(path.join(sessions, "new.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "new", timestamp: "2026-02-01T00:00:00.000Z", cwd: "/workspace" }),
      JSON.stringify({ type: "model_change", id: "c1", parentId: null, timestamp: "2026-02-01T00:00:01.000Z", provider: "anthropic", modelId: "claude" }),
      JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "c1", timestamp: "2026-02-01T00:00:02.000Z", thinkingLevel: "medium" }),
      JSON.stringify({ type: "message", id: "m1", parentId: "t1", timestamp: "2026-02-01T00:00:03.000Z", message: { role: "user", content: [] } }),
      JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-02-01T00:00:04.000Z", message: { role: "assistant", content: [] } }),
    ].join("\n"), "utf8");

    const manager = new AgentManager({ dataDir }, managerOptions());
    const status: AgentStatus = await manager.status(42);
    expect(status).toEqual({
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "medium",
      sessionFile: "new.jsonl",
      messageCount: 2,
      autoCompactionEnabled: true,
    });
  });
});

it("status reports settings defaults when no session file exists", async () => {
  await withDataDir(async (dataDir) => {
    await settingsFile(dataDir, 42, { defaultModel: "claude", defaultProvider: "anthropic" });
    const manager = new AgentManager({ dataDir }, managerOptions());
    await expect(manager.status(42)).resolves.toEqual({
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "off",
      messageCount: 0,
      autoCompactionEnabled: true,
    });
  });
});
it("status counts active background tasks and schedule rows", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "chats", "42", "workspace");
    const tasks = path.join(workspace, ".pi", "tasks");
    await mkdir(path.join(tasks, "running-task"), { recursive: true });
    await mkdir(path.join(tasks, "done-task"), { recursive: true });
    await writeFile(path.join(tasks, "done-task", "result.json"), '{"status":"done"}\n', "utf8");

    const tgBotDir = path.join(workspace, ".tg-bot");
    await mkdir(tgBotDir, { recursive: true });
    await writeFile(path.join(tgBotDir, "schedules.json"), JSON.stringify({
      version: 1,
      schedules: [
        { prompt: "p1", start: "2026-08-20T00:00:00.000Z", recurrence: null },
        { prompt: "p2", start: "2026-08-20T01:00:00.000Z", recurrence: "daily" },
      ],
    }), "utf8");

    const manager = new AgentManager({ dataDir }, managerOptions());
    const status = await manager.status(42);
    expect(status.activeTasks).toBe(1);
    expect(status.activeSchedules).toBe(2);
  });
});


it("beginShutdown stops active runs and rejects later work", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, runs } = fakeWorkerFactory();
    const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(42, "one");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await manager.beginShutdown();
    expect(runs[0]?.stop).toHaveBeenCalledOnce();
    await expect(manager.followup(42, "two")).rejects.toThrow("Agent manager is shutting down");
    runs[0]?.resolveRun({ code: null, signal: "SIGTERM", stderr: "", stdout: "" });
  });
});

it("a failed run logs and continues draining queued followups", async () => {
  await withDataDir(async (dataDir) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { factory, runs } = fakeWorkerFactory();
      const manager = new AgentManager({ dataDir }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
      await manager.followup(42, "one");
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      await manager.followup(42, "two");
      runs[0]?.resolveRun({ code: 1, signal: null, stderr: "boom", stdout: "" });
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[1]?.worker.options.message).toBe("two");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));
      runs[1]?.resolveRun({ code: 0, signal: null, stderr: "", stdout: "" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
