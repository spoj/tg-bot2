import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  AgentEventRouter,
  AgentManager,
  loadUserSettings,
  USER_INTERRUPT_MAX_WAIT_MS,
  SYSTEM_PROMPT,
  type AgentNotifier,
  type AgentWorker,
  type AgentWorkerOptions,
} from "../src/agent.js";
import { conversationAgent } from "../src/agent-ref.js";
import { AgentCredentials } from "../src/host-bridge.js";
import { OUTBOX_PROMPT } from "../src/outbox-protocol.js";
import { TIMELINE_PROMPT } from "../src/events.js";
import { SCHEDULES_PROMPT } from "../src/schedule-protocol.js";
import { TASKS_PROMPT } from "../src/task-protocol.js";

type FakeWorker = AgentWorker & {
  options: AgentWorkerOptions;
  prompts: Array<{ message: string; streamingBehavior?: "steer" | "followUp"; maxWaitMs?: number }>;
  reap: () => void;
  settle: () => void;
  settleHold: (hold: boolean) => void;
  prompt: Mock<(message: string, streamingBehavior?: "steer" | "followUp", maxWaitMs?: number) => Promise<void>>;
  waitForSettled: Mock<() => Promise<unknown>>;
  close: Mock<() => Promise<void>>;
  stop: Mock<() => Promise<void>>;
};

function fakeWorkerFactory(
  onPrompt?: (message: string, streamingBehavior?: "steer" | "followUp", maxWaitMs?: number) => Promise<void>,
): {
  factory: Mock<(options: AgentWorkerOptions) => Promise<AgentWorker>>;
  workers: FakeWorker[];
} {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(async (options: AgentWorkerOptions): Promise<AgentWorker> => {
    let reapedCallback: (() => void) | undefined;
    let alive = true;
    let busy = false;
    const prompts: Array<{ message: string; streamingBehavior?: "steer" | "followUp"; maxWaitMs?: number }> = [];
    const prompt = vi.fn(async (message: string, streamingBehavior?: "steer" | "followUp", maxWaitMs?: number) => {
      prompts.push({
        message,
        ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
        ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
      });
      busy = true;
      await onPrompt?.(message, streamingBehavior, maxWaitMs);
    });
    let settleHold = false;
    let settleWaiters: Array<() => void> = [];
    const waitForSettled = vi.fn(async (): Promise<unknown> => {
      if (!busy || !settleHold) return undefined;
      await new Promise<void>((resolve) => {
        settleWaiters.push(resolve);
      });
    });
    const settle = () => {
      busy = false;
      for (const resolve of settleWaiters) resolve();
      settleWaiters = [];
    };
    const close = vi.fn(async () => {
      alive = false;
      busy = false;
    });
    const stop = vi.fn(async () => {
      alive = false;
      busy = false;
    });
    const onReaped = vi.fn((cb: () => void) => {
      reapedCallback = cb;
    });
    const reap = () => {
      alive = false;
      busy = false;
      reapedCallback?.();
    };
    const worker: FakeWorker = {
      options,
      prompts,
      reap,
      settle,
      settleHold: (hold: boolean) => {
        settleHold = hold;
      },
      isAlive: () => alive,
      isBusy: () => busy,
      prompt,
      waitForSettled,
      close,
      stop,
      onReaped,
    };
    workers.push(worker);
    return worker;
  });
  return { factory, workers };
}

const CHAT = conversationAgent(123);

function managerOptions(overrides: Record<string, unknown> = {}): ConstructorParameters<typeof AgentManager>[1] {
  return {
    appRoot: "/tmp/tg-bot2-app",
    credentials: new AgentCredentials(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    now: () => 1_000_000,
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

async function settingsFile(dataDir: string, content: Record<string, unknown>): Promise<void> {
  const target = path.join(dataDir, "workspace", ".pi", "agent", "settings.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(content), "utf8");
}


it("composes a concise behavior-oriented SYSTEM_PROMPT", () => {
  expect(SYSTEM_PROMPT).toContain(OUTBOX_PROMPT);
  expect(SYSTEM_PROMPT).toContain(TIMELINE_PROMPT);
  expect(SYSTEM_PROMPT).toContain(SCHEDULES_PROMPT);
  expect(SYSTEM_PROMPT).toContain(TASKS_PROMPT);
  expect(SYSTEM_PROMPT).toContain("include topic_name in a normal sendMessage");
  expect(SYSTEM_PROMPT).toContain("Never spend a separate tool call");
  expect(SYSTEM_PROMPT).not.toContain("around message 2-3");
  expect(SYSTEM_PROMPT).toContain("/restart applies settings changes");
  expect(SYSTEM_PROMPT).toContain("complete raw Telegram event");
  expect(SYSTEM_PROMPT).toContain("stable notification ID");
  expect(SYSTEM_PROMPT).toContain("mktemp -d /tmp/chrome-profile.XXXXXX");
  expect(SYSTEM_PROMPT).toContain("--remote-debugging-port=0");
});

it("loadUserSettings tolerates missing, empty, and malformed files", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    await mkdir(path.join(workspace, ".pi", "agent"), { recursive: true });
    await expect(loadUserSettings(workspace)).resolves.toEqual({});
    await writeFile(path.join(workspace, ".pi", "agent", "settings.json"), "not json", "utf8");
    await expect(loadUserSettings(workspace)).resolves.toEqual({});
    await settingsFile(dataDir, { defaultModel: "claude", custom: true });
    await expect(loadUserSettings(workspace)).resolves.toEqual({ defaultModel: "claude", custom: true });
  });
});

it("followup starts a fresh worker and sends prompt with followUp streaming behavior", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("scheduled work", CHAT);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      appendSystemPrompt: SYSTEM_PROMPT,
      hostTools: "send,annotate,spawn,continue_task,steer_conversation,steer_task,cancel,schedule_add,schedule_replace,schedule_remove,schedule_take",
    });
    expect(workers[0]?.prompt).toHaveBeenCalledWith(expect.stringContaining("\nscheduled work"), "followUp", undefined);
  });
});

it("interrupt sends prompt with steer streaming behavior to the active worker", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("scheduled", CHAT);
    expect(workers).toHaveLength(1);
    await manager.interrupt("stop and do this", CHAT, 120_000);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.prompt).toHaveBeenLastCalledWith(expect.stringContaining("\nstop and do this"), "steer", 120_000);
  });
});

it("interrupt while idle starts a worker immediately", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.interrupt("user instruction", CHAT);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.prompt).toHaveBeenCalledWith(expect.stringContaining("\nuser instruction"), "steer", undefined);
  });
});

it("waits for prompt acceptance before delivering the next notification", async () => {
  await withDataDir(async (dataDir) => {
    let releaseFirst!: () => void;
    const firstAccepted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let promptCount = 0;
    const { factory, workers } = fakeWorkerFactory(async () => {
      promptCount += 1;
      if (promptCount === 1) await firstAccepted;
    });
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));

    const first = manager.interrupt("first", CHAT, undefined, { id: "event-1", sequence: 1 });
    await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledOnce());
    const second = manager.interrupt("second", CHAT, undefined, { id: "event-2", sequence: 2 });
    await Promise.resolve();
    expect(workers[0]?.prompt).toHaveBeenCalledOnce();

    releaseFirst();
    await Promise.all([first, second]);
    expect(workers[0]?.prompt).toHaveBeenNthCalledWith(2, expect.stringContaining("id=event-2 seq=2"), "steer", undefined);
  });
});

it("replays a notification that was persisted but not accepted", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const failed = fakeWorkerFactory(async () => { throw new Error("RPC rejected prompt"); });
    const firstManager = new AgentManager({ workspace }, managerOptions({ workerFactory: failed.factory }));
    await expect(firstManager.interrupt("complete user instruction", CHAT, undefined, { id: "event-replay", sequence: 4 }))
      .rejects.toThrow("RPC rejected prompt");

    const replayed = fakeWorkerFactory();
    const secondManager = new AgentManager({ workspace }, managerOptions({ workerFactory: replayed.factory }));
    await secondManager.start();

    expect(replayed.workers[0]?.prompt).toHaveBeenCalledWith(
      "[notification id=event-replay seq=4]\ncomplete user instruction",
      "steer",
      undefined,
    );
  });
});

it("migrates the notification journal out of the shared workspace", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const legacyPath = path.join(workspace, ".pi", "notifications.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({
      type: "queued",
      notification: {
        id: "legacy-event",
        sequence: 6,
        target: CHAT,
        text: "legacy instruction",
        behavior: "steer",
      },
    })}\n`, "utf8");
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace }, managerOptions({ workerFactory: factory }));

    await manager.start();

    expect(workers[0]?.prompt).toHaveBeenCalledWith(
      "[notification id=legacy-event seq=6]\nlegacy instruction",
      "steer",
      undefined,
    );
    expect(await readFile(path.join(dataDir, "notifications.jsonl"), "utf8")).toContain("legacy-event");
    await expect(readFile(legacyPath, "utf8")).rejects.toThrow();
  });
});

it("does not redeliver an acknowledged notification ID", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));
    const identity = { id: "event-once", sequence: 5 };

    await manager.interrupt("instruction", CHAT, undefined, identity);
    await manager.interrupt("instruction", CHAT, undefined, identity);

    expect(workers[0]?.prompt).toHaveBeenCalledOnce();
  });
});

it("reaped idle worker triggers fresh worker creation on next message", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("first", CHAT);
    expect(workers).toHaveLength(1);

    // Simulate idle reaping
    workers[0]?.reap();

    await manager.followup("second", CHAT);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.prompt).toHaveBeenCalledWith(expect.stringContaining("\nsecond"), "followUp", undefined);
  });
});


it("restartAll closes active workers and respawns them on the next message", async () => {
  await withDataDir(async (dataDir) => {
    const tenHours = 10 * 60 * 60 * 1000;
    let now = tenHours;
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => now }));
    await manager.followup("one", CHAT);
    expect(workers).toHaveLength(1);

    const sessions = path.join(dataDir, "workspace", ".pi", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "recent.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "recent" })}\n`, "utf8");

    await manager.restartAll();
    expect(workers[0]?.close).toHaveBeenCalled();

    now = tenHours + 60_000;

    await manager.followup("two", CHAT);
    expect(workers).toHaveLength(2);
  });
});

it("passes settings defaults as model and thinking CLI args", async () => {
  await withDataDir(async (dataDir) => {
    await settingsFile(dataDir, {
      defaultProvider: "openrouter",
      defaultModel: "deepseek/deepseek-chat",
      defaultThinkingLevel: "high",
    });
    const { factory } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup(".", CHAT);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      model: "openrouter/deepseek/deepseek-chat",
      thinkingLevel: "high",
    });
  });
});



it("beginShutdown stops active workers and rejects later work", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("one", CHAT);
    expect(workers).toHaveLength(1);
    await manager.beginShutdown();
    expect(workers[0]?.close).toHaveBeenCalledOnce();
    await expect(manager.followup("two", CHAT)).rejects.toThrow("Agent manager is shutting down");
  });
});

it("manages independent workers and session directories per conversation key", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));

    await manager.followup("Matthew general", conversationAgent(829096380));
    expect(workers).toHaveLength(1);
    expect(workers[0]?.options.sessionDir).toBe("/workspace/.pi/sessions/829096380/0");

    await manager.followup("Daisy general", conversationAgent(875253145));
    expect(workers).toHaveLength(2);
    expect(workers[1]?.options.sessionDir).toBe("/workspace/.pi/sessions/875253145/0");

    await manager.followup("Group topic 42", conversationAgent(-100123456, 42));
    expect(workers).toHaveLength(3);
    expect(workers[2]?.options.sessionDir).toBe("/workspace/.pi/sessions/-100123456/42");

    // Sending another message to Matthew reuses his active worker
    await manager.followup("Matthew follow up", conversationAgent(829096380));
    expect(workers).toHaveLength(3);
    expect(workers[0]?.prompt).toHaveBeenCalledTimes(2);
  });
});

it("restartAll closes every active conversation worker and respawns them", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));

    await manager.followup("Chat 100", conversationAgent(100));
    await manager.followup("Chat 200 topic 1", conversationAgent(200, 1));
    expect(workers).toHaveLength(2);

    await manager.restartAll();
    expect(workers[0]?.close).toHaveBeenCalled();
    expect(workers[1]?.close).toHaveBeenCalled();

    await manager.followup("Chat 100 next", conversationAgent(100));
    expect(workers).toHaveLength(3);
  });
});

it("restartAll waits for a busy worker's turn to settle before closing it", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));
    await manager.followup("do work", CHAT);
    expect(workers).toHaveLength(1);
    workers[0]?.settleHold(true);

    const restart = manager.restartAll();
    await vi.waitFor(() => expect(workers[0]?.waitForSettled).toHaveBeenCalled());
    expect(workers[0]?.close).not.toHaveBeenCalled();

    workers[0]?.settle();
    await restart;
    expect(workers[0]?.close).toHaveBeenCalledOnce();
  });
});

it("restartAll closes a never-settling busy worker after the settle cap", async () => {
  vi.useFakeTimers();
  try {
    await withDataDir(async (dataDir) => {
      const { factory, workers } = fakeWorkerFactory();
      const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));
      await manager.followup("never settles", CHAT);
      workers[0]?.settleHold(true);

      const restart = manager.restartAll();
      await vi.advanceTimersByTimeAsync(30_000);
      await restart;
      expect(workers[0]?.close).toHaveBeenCalledOnce();
    });
  } finally {
    vi.useRealTimers();
  }
});

it("restartAll keeps the entry when close rejects so exit detection can clean up", async () => {
  await withDataDir(async (dataDir) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { factory, workers } = fakeWorkerFactory();
      const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));
      await manager.followup("one", CHAT);
      expect(workers).toHaveLength(1);
      workers[0]?.close.mockRejectedValue(new Error("close boom"));

      await expect(manager.restartAll()).resolves.toBeUndefined();
      expect(workers[0]?.close).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith("Agent restart close failed", expect.any(Error));

      // The entry still owns the worker: the next message reuses it instead of respawning
      await manager.followup("two", CHAT);
      expect(workers).toHaveLength(1);
      expect(workers[0]?.prompt).toHaveBeenLastCalledWith(expect.stringContaining("\ntwo"), "followUp", undefined);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

it("bounds user message steering waits", async () => {
  const interrupt = vi.fn(async () => undefined);
  const router = new AgentEventRouter({ interrupt, followup: vi.fn(async () => undefined) });
  const rawLine = JSON.stringify({ type: "message" });

  await router.onEvent({
    id: "event-1",
    seq: 7,
    type: "message",
    chat_id: 829096380,
    message: { message_id: 1, date: 1_700_000_000, text: "hello", chat: { id: 829096380, type: "private" } },
    attachments: [],
  }, rawLine);

  expect(interrupt).toHaveBeenCalledWith(
    rawLine,
    conversationAgent(829096380),
    USER_INTERRUPT_MAX_WAIT_MS,
    { id: "event-1", sequence: 7 },
  );
});

it("ignores a topic service event and delivers the complete first post", async () => {
  const interrupt = vi.fn(async () => undefined);
  const router = new AgentEventRouter({ interrupt, followup: vi.fn(async () => undefined) });
  const target = conversationAgent(829096380, 9751);
  await router.onEvent({
    id: "topic-created",
    seq: 10,
    type: "message",
    chat_id: 829096380,
    message: { message_id: 9652, message_thread_id: 9751, forum_topic_created: { name: "My conception of..." } },
    attachments: [],
  }, "service-event");

  const text = "My conception of harness is ".repeat(50);
  const rawLine = JSON.stringify({ id: "first-post", seq: 11, type: "message", message: { text } });
  await router.onEvent({
    id: "first-post",
    seq: 11,
    type: "message",
    chat_id: 829096380,
    message: { message_id: 9653, message_thread_id: 9751, text },
    attachments: [],
  }, rawLine);

  expect(interrupt).toHaveBeenCalledOnce();
  expect(interrupt).toHaveBeenCalledWith(rawLine, target, USER_INTERRUPT_MAX_WAIT_MS, { id: "first-post", sequence: 11 });
  expect(rawLine).toContain(text);
});

it("routes task finishes and schedules directly to their owners", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const router = new AgentEventRouter({ followup, interrupt });
  const target = conversationAgent(829096380, 9534);

  await router.onEvent({
    id: "task-event",
    seq: 8,
    type: "task_finished",
    runId: "run-123",
    owner: target,
    prompt: "check menu",
    status: "done",
    exitCode: 0,
  }, "");
  expect(followup).toHaveBeenCalledWith(
    "Task run-123 finished. Output: /workspace/.pi/tasks/run-123/output.md. Continue it with continue_task.",
    target,
    { id: "task-event", sequence: 8 },
  );

  followup.mockClear();
  await router.onEvent({
    scheduleId: "schedule-1",
    id: "schedule-event",
    seq: 9,
    type: "schedule_fired",
    occurrenceId: "occurrence-1",
    owner: target,
    prompt: "create today's topic",
    dueAt: "2026-08-24T00:00:00.000Z",
  }, "");
  expect(followup).toHaveBeenCalledWith(
    "Scheduled instruction due 2026-08-24T00:00:00.000Z:\ncreate today's topic",
    target,
    { id: "schedule-event", sequence: 9 },
  );
});


it("edited_message is logged silently without waking the agent", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const notifier: AgentNotifier = { followup, interrupt };
  const router = new AgentEventRouter(notifier);

  const rawLine = JSON.stringify({
    v: 1,
    t: "2026-08-22T00:00:00.000Z",
    type: "edited_message",
    chat_id: 829096380,
    message: { message_id: 10, text: "edited text", message_thread_id: 50 },
    attachments: [],
  });

  await router.onEvent({
    type: "edited_message",
    chat_id: 829096380,
    message: { message_id: 10, text: "edited text", message_thread_id: 50 },
    attachments: [],
  }, rawLine);

  expect(interrupt).not.toHaveBeenCalled();
  expect(followup).not.toHaveBeenCalled();
});
