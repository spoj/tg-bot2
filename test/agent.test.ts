import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  AgentEventRouter,
  AgentManager,
  loadUserSettings,
  SYSTEM_PROMPT,
  type AgentNotifier,
  type AgentWorker,
  type AgentWorkerOptions,
  type AgentStatus,
} from "../src/agent.js";
import { OUTBOX_PROMPT } from "../src/outbox-protocol.js";
import { EVENTS_PROMPT } from "../src/events.js";
import { SCHEDULES_PROMPT } from "../src/schedule-protocol.js";
import { TASKS_PROMPT } from "../src/task-protocol.js";

type FakeWorker = AgentWorker & {
  options: AgentWorkerOptions;
  prompts: Array<{ message: string; streamingBehavior?: "steer" | "followUp" }>;
  reap: () => void;
  prompt: Mock<(message: string, streamingBehavior?: "steer" | "followUp") => Promise<void>>;
  close: Mock<() => Promise<void>>;
  stop: Mock<() => Promise<void>>;
};

function fakeWorkerFactory(): {
  factory: Mock<(options: AgentWorkerOptions) => Promise<AgentWorker>>;
  workers: FakeWorker[];
} {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(async (options: AgentWorkerOptions): Promise<AgentWorker> => {
    let reapedCallback: (() => void) | undefined;
    let alive = true;
    let busy = false;
    const prompts: Array<{ message: string; streamingBehavior?: "steer" | "followUp" }> = [];
    const prompt = vi.fn(async (message: string, streamingBehavior?: "steer" | "followUp") => {
      prompts.push({ message, ...(streamingBehavior !== undefined ? { streamingBehavior } : {}) });
      busy = true;
    });
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
      isAlive: () => alive,
      isBusy: () => busy,
      prompt,
      close,
      stop,
      onReaped,
    };
    workers.push(worker);
    return worker;
  });
  return { factory, workers };
}

function managerOptions(overrides: Record<string, unknown> = {}): ConstructorParameters<typeof AgentManager>[1] {
  return {
    appRoot: "/tmp/tg-bot2-app",
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

const INTRO = `You are a persistent personal agent reached through Telegram serving multiple chats concurrently.
Direct assistant text output is not delivered to Telegram — you must call the send tool with the target chat_id to communicate.
Your writable workspace is /workspace; runtime/sessions live under /workspace/.pi. Attachments are downloaded to /workspace/attachments/<chat_id>/...
To automate a browser, call start_browser and connect scripts to ws+unix:///workspace/.browser/cdp.sock.
Install project extensions with pi install <pkg> -l --approve; project settings live at /workspace/.pi/settings.json.
`;

const OUTRO = `Keep Telegram-facing answers concise unless the user asks for detail.
Responsiveness & Multi-Chat Orchestration:
- Never leave users hanging on long queries. For multi-step research or deep tasks, send a quick acknowledgment via the send tool, spawn a background task (spawn tool), and finish your turn so the main loop stays responsive to other chats. Deliver findings when task_settled arrives.
- Message formatting: Prefer parse_mode: "HTML" (using <b>, <i>, <code>, <pre>, <blockquote>, <a>, bullet points •) over raw markdown so messages render cleanly on Telegram.
- Forum topics: When conversing in a topic (message_thread_id is present), rename it around message 2-3 to a short descriptive name distinct from the last 10 active topic names in events.jsonl using edit_forum_topic.
- Allowlist & Status: /workspace/.tg-bot/allowed.json controls allowed chat IDs. /status reports current model, thinking level, and session info. Adjust model/thinking in /workspace/.pi/agent/settings.json.
- Session continuity: Active sessions resume across runs within 2 hours of inactivity; an admin can /restart to apply settings changes.
- Context gathering hierarchy:
  1. Thread context: if message_thread_id is present, query events.jsonl filtered by chat_id and message_thread_id (using grep, rq, or jq).
  2. Chat context: if not in a thread or broader context is needed, query events.jsonl filtered by chat_id.
  3. Global context: search unconstrained across events.jsonl for system events, tasks, or schedules.
  Session files persist under /workspace/.pi/sessions/<chat_id>/<message_thread_id>/*.jsonl (with 0 for general/unthreaded chats; background tasks under /workspace/.pi/tasks/<runId>/sessions/). When referencing older history, search active thread sessions first, then the chat (<chat_id>/*), then root sessions.
`;

it("composes the SYSTEM_PROMPT from the intro, protocol sections, and outro", () => {
  expect(SYSTEM_PROMPT).toBe(`${INTRO}${OUTBOX_PROMPT}${EVENTS_PROMPT}${SCHEDULES_PROMPT}${TASKS_PROMPT}${OUTRO}`);
  expect(SYSTEM_PROMPT).toContain("/status reports current model");
  expect(SYSTEM_PROMPT).toContain("/restart to apply settings changes");
  expect(SYSTEM_PROMPT).not.toContain("/model, /thinking, /status, and /restart");
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
    await manager.followup("scheduled work");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ resume: false, appendSystemPrompt: SYSTEM_PROMPT });
    expect(workers[0]?.prompt).toHaveBeenCalledWith("scheduled work", "followUp");
  });
});

it("interrupt sends prompt with steer streaming behavior to the active worker", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("scheduled");
    expect(workers).toHaveLength(1);
    await manager.interrupt("stop and do this");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.prompt).toHaveBeenLastCalledWith("stop and do this", "steer");
  });
});

it("interrupt while idle starts a worker immediately", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.interrupt("user instruction");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.prompt).toHaveBeenCalledWith("user instruction", "steer");
  });
});

it("reaped idle worker triggers fresh worker creation on next message", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("first");
    expect(workers).toHaveLength(1);

    // Simulate idle reaping
    workers[0]?.reap();

    await manager.followup("second");
    expect(workers).toHaveLength(2);
    expect(workers[1]?.prompt).toHaveBeenCalledWith("second", "followUp");
  });
});

it("resumes within the window and starts fresh after it closes", async () => {
  await withDataDir(async (dataDir) => {
    const tenHours = 10 * 60 * 60 * 1000;
    const workspace = path.join(dataDir, "workspace");
    const sessions = path.join(workspace, ".pi", "sessions");
    await mkdir(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "one.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "one" })}\n`, "utf8");
    // The only session file predates the resume window, so the first run starts fresh.
    await utimes(sessionFile, new Date(), new Date(tenHours - 3 * 60 * 60 * 1000));

    let now = tenHours;
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => now }));
    await manager.followup("one");
    expect(workers[0]?.options.resume).toBe(false);

    // Run one writes its session file at its start time.
    await utimes(sessionFile, new Date(), new Date(tenHours));
    workers[0]?.reap();

    now = tenHours + 60_000;
    await manager.followup("two");
    expect(workers[1]?.options.resume).toBe(true);

    workers[1]?.reap();
    now = tenHours + 3 * 60 * 60 * 1000;
    await manager.followup("three");
    expect(workers[2]?.options.resume).toBe(false);
  });
});

it("restartAll closes active workers and respawns them on the next message", async () => {
  await withDataDir(async (dataDir) => {
    const tenHours = 10 * 60 * 60 * 1000;
    let now = tenHours;
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => now }));
    await manager.followup("one");
    expect(workers).toHaveLength(1);

    const sessions = path.join(dataDir, "workspace", ".pi", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "recent.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "recent" })}\n`, "utf8");

    await manager.restartAll();
    expect(workers[0]?.close).toHaveBeenCalled();

    now = tenHours + 60_000;

    await manager.followup("two");
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
    await manager.followup(".");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      model: "openrouter/deepseek/deepseek-chat",
      thinkingLevel: "high",
    });
  });
});

it("a restart resumes a recent session file and starts fresh after the window closes", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const sessions = path.join(workspace, ".pi", "sessions");
    await mkdir(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "one.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "one" })}\n`, "utf8");

    const now = 10 * 60 * 60 * 1000;
    await utimes(sessionFile, new Date(), new Date(now - 60_000));

    const first = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: first.factory, now: () => now }));
    await manager.followup(".");
    expect(first.factory.mock.calls[0]?.[0].resume).toBe(true);

    await utimes(sessionFile, new Date(), new Date(now - 3 * 60 * 60 * 1000));
    const second = fakeWorkerFactory();
    const secondManager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: second.factory, now: () => now }));
    await secondManager.followup(".");
    expect(second.factory.mock.calls[0]?.[0].resume).toBe(false);
  });
});

it("status reads the newest session file and settings defaults without spawning", async () => {
  await withDataDir(async (dataDir) => {
    await settingsFile(dataDir, { defaultModel: "fallback", defaultProvider: "openrouter", defaultThinkingLevel: "low" });
    const sessions = path.join(dataDir, "workspace", ".pi", "sessions");
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

    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions());
    const status: AgentStatus = await manager.status();
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
    await settingsFile(dataDir, { defaultModel: "claude", defaultProvider: "anthropic" });
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions());
    await expect(manager.status()).resolves.toEqual({
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "off",
      messageCount: 0,
      autoCompactionEnabled: true,
    });
  });
});

it("status counts active background tasks and schedule rows", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
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

    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions());
    const status = await manager.status();
    expect(status.activeTasks).toBe(1);
    expect(status.activeSchedules).toBe(2);
  });
});

it("beginShutdown stops active workers and rejects later work", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("one");
    expect(workers).toHaveLength(1);
    await manager.beginShutdown();
    expect(workers[0]?.close).toHaveBeenCalledOnce();
    await expect(manager.followup("two")).rejects.toThrow("Agent manager is shutting down");
  });
});

it("manages independent workers and session directories per conversation key", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));

    await manager.followup("Matthew general", { chatId: 829096380 });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.options.sessionDir).toBe("/workspace/.pi/sessions/829096380/0");

    await manager.followup("Daisy general", { chatId: 875253145 });
    expect(workers).toHaveLength(2);
    expect(workers[1]?.options.sessionDir).toBe("/workspace/.pi/sessions/875253145/0");

    await manager.followup("Group topic 42", { chatId: -100123456, threadId: 42 });
    expect(workers).toHaveLength(3);
    expect(workers[2]?.options.sessionDir).toBe("/workspace/.pi/sessions/-100123456/42");

    // Sending another message to Matthew reuses his active worker
    await manager.followup("Matthew follow up", { chatId: 829096380 });
    expect(workers).toHaveLength(3);
    expect(workers[0]?.prompt).toHaveBeenCalledTimes(2);
  });
});

it("restartAll closes every active conversation worker and respawns them", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions({ workerFactory: factory }));

    await manager.followup("Chat 100", { chatId: 100 });
    await manager.followup("Chat 200 topic 1", { chatId: 200, threadId: 1 });
    expect(workers).toHaveLength(2);

    await manager.restartAll();
    expect(workers[0]?.close).toHaveBeenCalled();
    expect(workers[1]?.close).toHaveBeenCalled();

    await manager.followup("Chat 100 next", { chatId: 100 });
    expect(workers).toHaveLength(3);
  });
});

it("routes browser_ready and task_settled strictly to originating chat/topic session", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const notifier: AgentNotifier = { followup, interrupt };
  const router = new AgentEventRouter(notifier);

  // browser_ready with origin routes to that topic worker
  await router.onEvent({
    type: "browser_ready",
    requestId: "req-1",
    origin: "829096380:9534",
    status: "started",
    socketPath: "/workspace/.browser/cdp.sock",
    wsEndpoint: "ws+unix:///workspace/.browser/cdp.sock",
  }, "");
  expect(interrupt).toHaveBeenCalledWith(
    expect.stringContaining("Browser is ready"),
    { chatId: 829096380, threadId: 9534 },
  );

  // task_settled with origin routes to originating topic worker
  followup.mockClear();
  await router.onEvent({
    type: "task_settled",
    runId: "run-123",
    origin: "829096380:9534",
    prompt: "check menu",
    status: "done",
    exitCode: 0,
  }, "");
  expect(followup).toHaveBeenCalledWith(
    expect.stringContaining('Task "check menu" finished'),
    { chatId: 829096380, threadId: 9534 },
  );

  // task_settled without origin (e.g. scheduler task) is silent
  followup.mockClear();
  await router.onEvent({
    type: "task_settled",
    runId: "run-456",
    status: "done",
    exitCode: 0,
  }, "");
  expect(followup).not.toHaveBeenCalled();
});

it("my_chat_member group add notifies the agent; permission changes and private chats are silent", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const notifier: AgentNotifier = { followup, interrupt };
  const router = new AgentEventRouter(notifier);

  // Bot added to a brand-new group (old status left -> new status member)
  await router.onEvent({
    type: "my_chat_member",
    chat_id: -100123456,
    my_chat_member: { new_chat_member: { status: "member" }, old_chat_member: { status: "left" } },
  }, "");
  expect(followup).toHaveBeenCalledWith(
    expect.stringContaining("Bot was added to group -100123456"),
    { chatId: -100123456 },
  );

  // Permission change (member -> administrator) is not an add
  followup.mockClear();
  await router.onEvent({
    type: "my_chat_member",
    chat_id: -100123456,
    my_chat_member: { new_chat_member: { status: "administrator" }, old_chat_member: { status: "member" } },
  }, "");
  expect(followup).not.toHaveBeenCalled();

  // Private chat add is silent (not a group-add; no self-provisioning signal)
  followup.mockClear();
  await router.onEvent({
    type: "my_chat_member",
    chat_id: 829096380,
    my_chat_member: { new_chat_member: { status: "member" }, old_chat_member: { status: "left" } },
  }, "");
  expect(followup).not.toHaveBeenCalled();
});

it("outbox_sent is silent for same-session send and notifies target on cross-session send", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const notifier: AgentNotifier = { followup, interrupt };
  const router = new AgentEventRouter(notifier);

  // Same-session send: Topic 9534 sends to Topic 9534 -> silent
  await router.onEvent({
    type: "outbox_sent",
    requestId: "req-same",
    origin: "829096380:9534",
    chat_id: 829096380,
    message_thread_id: 9534,
    request_type: "send_message",
    summary: "drinks menu",
  }, "");
  expect(followup).not.toHaveBeenCalled();

  // Cross-session send: Task or Topic 9479 sends to Topic 9534 -> target Topic 9534 gets transcript notice
  await router.onEvent({
    type: "outbox_sent",
    requestId: "req-cross",
    origin: "task:run-999",
    chat_id: 829096380,
    message_thread_id: 9534,
    request_type: "send_message",
    summary: "morning briefing",
  }, "");
  expect(followup).toHaveBeenCalledWith(
    '[Outbound send_message sent to this chat: "morning briefing"]',
    { chatId: 829096380, threadId: 9534 },
  );

  // Topic creation notifies origin with the newly created thread ID
  followup.mockClear();
  await router.onEvent({
    type: "outbox_sent",
    requestId: "req-topic",
    origin: "829096380:0",
    chat_id: 829096380,
    message_thread_id: 9600,
    request_type: "create_forum_topic",
    summary: "New Discussion",
  }, "");
  expect(followup).toHaveBeenCalledWith(
    '[Topic "New Discussion" created with thread ID 9600]',
    { chatId: 829096380 },
  );
});

it("outbox_rejected interrupts the originating worker with the error", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const notifier: AgentNotifier = { followup, interrupt };
  const router = new AgentEventRouter(notifier);

  await router.onEvent({
    type: "outbox_rejected",
    requestId: "req-bad",
    origin: "829096380:9534",
    chat_id: 829096380,
    message_thread_id: 9534,
    detail: "Bad HTML entity",
  }, "");

  expect(interrupt).toHaveBeenCalledWith(
    "Send req-bad rejected: Bad HTML entity",
    { chatId: 829096380, threadId: 9534 },
  );
});
