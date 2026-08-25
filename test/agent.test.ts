import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { conversationAgent, conversationSessionPath } from "../src/agent-ref.js";
import { ConnectorRegistry, type WorkspaceConnector } from "../src/connector.js";
import { TIMELINE_PROMPT, type TimelineRecord } from "../src/events.js";
import { AgentCredentials } from "../src/host-bridge.js";
import { SCHEDULES_PROMPT } from "../src/schedule-protocol.js";
import { telegramConversation } from "../src/telegram-ref.js";

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

const CONNECTOR_ID = "telegram:999";
const CONNECTOR_PROMPT = "Connector-native test instructions.\n";
const CHAT = telegramConversation(CONNECTOR_ID, 123);

function managerOptions(dataDir: string, overrides: Record<string, unknown> = {}): ConstructorParameters<typeof AgentManager>[1] {
  return {
    appRoot: "/tmp/tg-bot2-app",
    credentials: new AgentCredentials(),
    notificationsPath: path.join(dataDir, "notifications.jsonl"),
    connectorPrompt: () => CONNECTOR_PROMPT,
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
    now: () => 1_000_000,
    ...overrides,
  };
}

function fakeTelegramConnector(): { connector: WorkspaceConnector; connectors: ConnectorRegistry } {
  const connector: WorkspaceConnector = {
    id: CONNECTOR_ID,
    prompt: CONNECTOR_PROMPT,
    send: vi.fn(async () => ({ request: {} })),
    parseConversation: vi.fn(() => CHAT),
    authorizeConversation: vi.fn(async () => undefined),
    notificationText: vi.fn((_record: TimelineRecord, rawLine: string) => rawLine),
    attention: vi.fn((record: TimelineRecord): "interrupt" | undefined => {
      if (record.type !== "telegram.message") return undefined;
      const meta = record.meta as { user_content?: unknown } | undefined;
      return meta?.user_content === true ? "interrupt" : undefined;
    }),
  };
  const connectors = new ConnectorRegistry();
  connectors.register(connector);
  return { connector, connectors };
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

it("composes a concise behavior-oriented SYSTEM_PROMPT without task protocol instructions", () => {
  expect(SYSTEM_PROMPT).toContain(TIMELINE_PROMPT);
  expect(SYSTEM_PROMPT).toContain(SCHEDULES_PROMPT);
  expect(SYSTEM_PROMPT).toContain("connector-native payload");
  expect(SYSTEM_PROMPT).toContain("/restart applies model and notification setting changes");
  expect(SYSTEM_PROMPT).toContain("stable notification ID");
  expect(SYSTEM_PROMPT).toContain("mktemp -d /tmp/chrome-profile.XXXXXX");
  expect(SYSTEM_PROMPT).toContain("--remote-debugging-port=0");
  expect(SYSTEM_PROMPT).not.toContain("continue_task");
  expect(SYSTEM_PROMPT).not.toContain("steer_task");
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

it("falls back when user settings are a symlink to a special file", async () => {
  await withDataDir(async (dataDir) => {
    const settingsPath = path.join(dataDir, "workspace", ".pi", "agent", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await rm(settingsPath, { force: true });
    await symlink("/dev/zero", settingsPath);

    await expect(loadUserSettings(path.join(dataDir, "workspace"))).resolves.toEqual({});
  });
});
it("falls back when an intermediate user settings directory is a symlink", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const outside = path.join(dataDir, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(outside, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(outside, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "escaped" }), "utf8");
    await symlink(path.join(outside, ".pi"), path.join(workspace, ".pi"));

    await expect(loadUserSettings(workspace)).resolves.toEqual({});
  });
});


it("followup starts a fresh worker and sends prompt with followUp streaming behavior", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("scheduled work", CHAT);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      appendSystemPrompt: expect.stringContaining(CONNECTOR_PROMPT),
      hostTools: "send,annotate,steer_conversation,schedule_add,schedule_replace,schedule_remove,schedule_take",
    });
    expect(workers[0]?.prompt).toHaveBeenCalledWith(expect.stringContaining("\nscheduled work"), "followUp", undefined);
  });
});

it("interrupt sends prompt with steer streaming behavior to the active worker", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
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
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
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
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));

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
    const firstManager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: failed.factory }));
    await expect(firstManager.interrupt("complete user instruction", CHAT, undefined, { id: "event-replay", sequence: 4 }))
      .rejects.toThrow("RPC rejected prompt");

    const replayed = fakeWorkerFactory();
    const secondManager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: replayed.factory }));
    await secondManager.start();

    await vi.waitFor(() => expect(replayed.workers[0]?.prompt).toHaveBeenCalledWith(
      "[notification id=event-replay seq=4]\ncomplete user instruction",
      "steer",
      undefined,
    ));
  });
});

it("compacts notification history while retaining a bounded delivered set", async () => {
  await withDataDir(async (dataDir) => {
    const { factory } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
    for (let index = 0; index < 80; index++) {
      await manager.followup(`instruction ${index}`, CHAT, { id: `notification-${index}` });
    }

    const lines = (await readFile(path.join(dataDir, "notifications.jsonl"), "utf8")).trim().split("\n");
    expect(lines.length).toBeLessThan(128);
  });
});

it("recovers a persisted timeline event that never reached the notification journal", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const target = telegramConversation(CONNECTOR_ID, 321);
    const record: TimelineRecord = {
      v: 2,
      id: "unhanded-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: target,
      payload: { message_id: 7, text: "recover me" },
      meta: { user_content: true, private: true },
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: factory, hostTimeline: timelinePath }));
    const { connectors } = fakeTelegramConnector();
    new AgentEventRouter(manager, { workspace, connectors });

    await manager.start();

    await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledWith(expect.stringContaining("recover me"), "steer", USER_INTERRUPT_MAX_WAIT_MS));
  });
});
it("baselines a legacy notification journal without replaying historical timeline events", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const notificationsPath = path.join(dataDir, "notifications.jsonl");
    const target = telegramConversation(CONNECTOR_ID, 321);
    const historical: TimelineRecord = {
      v: 2,
      id: "historical-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: target,
      payload: { message_id: 6, text: "do not replay" },
      meta: { user_content: true, private: true },
    };
    const tail: TimelineRecord = {
      v: 2,
      id: "timeline-tail",
      seq: 2,
      t: "2026-08-24T00:00:01.000Z",
      type: "system.event",
    };
    await writeFile(timelinePath, `${JSON.stringify(historical)}\n${JSON.stringify(tail)}\n`, "utf8");
    const queued = {
      type: "queued",
      notification: {
        id: "queued-legacy",
        sequence: 1,
        target,
        text: "deliver queued legacy notification",
        behavior: "steer",
      },
    };
    const delivered = Array.from({ length: 1_025 }, (_, index) => ({
      type: "delivered",
      id: index === 0 ? historical.id : `historical-${index}`,
      sequence: index + 1,
    }));
    await writeFile(notificationsPath, `${[queued, ...delivered].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: factory, hostTimeline: timelinePath }));
    const { connectors } = fakeTelegramConnector();
    new AgentEventRouter(manager, { workspace, connectors });

    await manager.start();

    await vi.waitFor(() => expect(workers).toHaveLength(1));
    await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledOnce());
    expect(workers[0]?.prompt).toHaveBeenCalledWith(
      "[notification id=queued-legacy seq=1]\ndeliver queued legacy notification",
      "steer",
      undefined,
    );
  });
});

it("uses delivered legacy sequences as the timeline baseline", async () => {
  await withDataDir(async (dataDir) => {
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const notificationsPath = path.join(dataDir, "notifications.jsonl");
    const record: TimelineRecord = {
      v: 2,
      id: "delivered-legacy-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "system.event",
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    const delivered = Array.from({ length: 1_025 }, (_, index) => ({
      type: "delivered",
      id: index === 0 ? record.id : `delivered-${index}`,
      sequence: index + 1,
    }));
    await writeFile(notificationsPath, `${delivered.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { hostTimeline: timelinePath }));
    const recovered: number[] = [];
    manager.registerTimelineRecovery(async (nextRecord) => {
      recovered.push(nextRecord.seq);
      await manager.markTimelineProcessed(nextRecord.seq);
    });

    await manager.start();

    expect(recovered).toEqual([]);
  });
});

it("recovers a missed timeline event when a checkpoint establishes the cursor", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const notificationsPath = path.join(dataDir, "notifications.jsonl");
    const target = telegramConversation(CONNECTOR_ID, 654);
    const record: TimelineRecord = {
      v: 2,
      id: "checkpoint-missed-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: target,
      payload: { message_id: 8, text: "recover after checkpoint" },
      meta: { user_content: true, private: true },
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(notificationsPath, `${JSON.stringify({ type: "checkpoint", sequence: 0 })}\n`, "utf8");

    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: factory, hostTimeline: timelinePath }));
    const { connectors } = fakeTelegramConnector();
    new AgentEventRouter(manager, { workspace, connectors });

    await manager.start();

    await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledWith(expect.stringContaining("recover after checkpoint"), "steer", USER_INTERRUPT_MAX_WAIT_MS));
  });
});
it("retries a transient timeline recovery failure on the next start", async () => {
  await withDataDir(async (dataDir) => {
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const record: TimelineRecord = {
      v: 2,
      id: "retry-recovery",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "system.event",
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { hostTimeline: timelinePath }));
    let attempts = 0;
    let fail = true;
    manager.registerTimelineRecovery(async (nextRecord) => {
      attempts += 1;
      if (fail) throw new Error("temporary recovery failure");
      await manager.markTimelineProcessed(nextRecord.seq);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(manager.start()).rejects.toThrow("temporary recovery failure");
      fail = false;
      await manager.start();
      expect(attempts).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
it("initializes a safe baseline for a compacted timeline starting above one", async () => {
  await withDataDir(async (dataDir) => {
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const record: TimelineRecord = {
      v: 2,
      id: "compacted-first-event",
      seq: 7,
      t: "2026-08-24T00:00:00.000Z",
      type: "system.event",
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { hostTimeline: timelinePath }));
    const recovered: number[] = [];
    manager.registerTimelineRecovery(async (nextRecord) => {
      recovered.push(nextRecord.seq);
      await manager.markTimelineProcessed(nextRecord.seq);
    });

    await manager.start();

    expect(recovered).toEqual([7]);
  });
});

it("recovers a torn legacy queue append without baselining to the timeline tail", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const notificationsPath = path.join(dataDir, "notifications.jsonl");
    const record: TimelineRecord = {
      v: 2,
      id: "torn-queue-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: CHAT,
      payload: { text: "recover torn append" },
      meta: { private: true, user_content: true },
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(notificationsPath, '{"type":"queued","notification":', "utf8");
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: factory, hostTimeline: timelinePath }));
    const { connectors } = fakeTelegramConnector();
    new AgentEventRouter(manager, { workspace, connectors });

    await manager.start();

    await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledWith(expect.stringContaining("recover torn append"), "steer", USER_INTERRUPT_MAX_WAIT_MS));
  });
});

it("recovers a live cursor gap before advancing a later event", async () => {
  await withDataDir(async (dataDir) => {
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const first: TimelineRecord = { v: 2, id: "live-gap-1", seq: 1, t: "2026-08-24T00:00:00.000Z", type: "system.event" };
    const second: TimelineRecord = { v: 2, id: "live-gap-2", seq: 2, t: "2026-08-24T00:00:01.000Z", type: "system.event" };
    await writeFile(timelinePath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { hostTimeline: timelinePath }));
    let firstAttempt = true;
    const handoff = async (record: TimelineRecord): Promise<void> => {
      if (record.seq === 1 && firstAttempt) {
        firstAttempt = false;
        throw new Error("temporary handoff failure");
      }
      await manager.markTimelineProcessed(record.seq);
    };

    await expect(manager.processTimelineEvent(first, JSON.stringify(first), handoff)).rejects.toThrow("temporary handoff failure");
    await expect(manager.processTimelineEvent(second, JSON.stringify(second), handoff)).resolves.toBeUndefined();
  });
});

it("retries a failed live timeline handoff without another event", async () => {
  vi.useFakeTimers();
  try {
    await withDataDir(async (dataDir) => {
      const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir));
      const record: TimelineRecord = {
        v: 2,
        id: "live-handoff-retry",
        seq: 1,
        t: "2026-08-24T00:00:00.000Z",
        type: "system.event",
      };
      let attempts = 0;
      const handoff = async (nextRecord: TimelineRecord): Promise<void> => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary live handoff failure");
        await manager.markTimelineProcessed(nextRecord.seq);
      };

      await expect(manager.processTimelineEvent(record, JSON.stringify(record), handoff)).rejects.toThrow("temporary live handoff failure");
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
    });
  } finally {
    vi.useRealTimers();
  }
});

it("retries a failed live notification delivery without another event", async () => {
  vi.useFakeTimers();
  try {
    await withDataDir(async (dataDir) => {
      const { factory, workers } = fakeWorkerFactory();
      factory.mockImplementationOnce(async () => { throw new Error("temporary worker startup failure"); });
      const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
      const { connectors } = fakeTelegramConnector();
      const router = new AgentEventRouter(manager, { workspace: path.join(dataDir, "workspace"), connectors });
      const record: TimelineRecord = {
        v: 2,
        id: "live-delivery-retry",
        seq: 1,
        t: "2026-08-24T00:00:00.000Z",
        type: "telegram.message",
        connectorId: CONNECTOR_ID,
        conversation: CHAT,
        payload: { text: "retry delivery" },
        meta: { private: true, user_content: true },
      };

      await router.onEvent(record, JSON.stringify(record));
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledWith(
        expect.stringContaining("[notification id=live-delivery-retry seq=1]"),
        "steer",
        USER_INTERRUPT_MAX_WAIT_MS,
      ));
    });
  } finally {
    vi.useRealTimers();
  }
});

it("marks events from removed connectors as intentionally unroutable history", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const record: TimelineRecord = {
      v: 2,
      id: "removed-connector-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.message",
      connectorId: "telegram:removed",
      conversation: telegramConversation("telegram:removed", 123),
      payload: { text: "old" },
      meta: { private: true, user_content: true },
    };
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { hostTimeline: timelinePath }));
    const { connectors } = fakeTelegramConnector();
    new AgentEventRouter(manager, { workspace, connectors });

    await manager.start();

    expect(await readFile(path.join(dataDir, "notifications.jsonl"), "utf8")).toContain('"sequence":1');
  });
});

it("keeps timeline recovery independent of a wedged worker", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const timelinePath = path.join(dataDir, "timeline.jsonl");
    const first: TimelineRecord = {
      v: 2,
      id: "wedged-worker-event",
      seq: 1,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: CHAT,
      payload: { text: "wedged" },
      meta: { private: true, user_content: true },
    };
    const secondTarget = telegramConversation(CONNECTOR_ID, 456);
    const second: TimelineRecord = {
      v: 2,
      id: "independent-worker-event",
      seq: 2,
      t: "2026-08-24T00:00:01.000Z",
      type: "telegram.message",
      connectorId: CONNECTOR_ID,
      conversation: secondTarget,
      payload: { text: "independent" },
      meta: { private: true, user_content: true },
    };
    await writeFile(timelinePath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");
    let promptCount = 0;
    const { factory, workers } = fakeWorkerFactory(async () => {
      promptCount += 1;
      if (promptCount === 1) await new Promise<void>(() => {});
    });
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: factory, hostTimeline: timelinePath }));
    const { connectors } = fakeTelegramConnector();
    new AgentEventRouter(manager, { workspace, connectors });

    await manager.start();

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await vi.waitFor(() => expect(workers[1]?.prompt).toHaveBeenCalledWith(expect.stringContaining("independent"), "steer", USER_INTERRUPT_MAX_WAIT_MS));
  });
});

it("rejects new notifications when the pending backlog is full", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const notificationsPath = path.join(dataDir, "notifications.jsonl");
    const queued = Array.from({ length: 1_024 }, (_, index) => ({
      type: "queued",
      notification: {
        id: `pending-${index}`,
        sequence: index + 1,
        target: CHAT,
        text: `pending ${index}`,
        behavior: "steer",
      },
    }));
    await writeFile(notificationsPath, `${queued.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const { factory } = fakeWorkerFactory(async () => new Promise<void>(() => {}));
    const manager = new AgentManager({ workspace }, managerOptions(dataDir, { workerFactory: factory }));

    await manager.start();

    await expect(manager.interrupt("overflow", CHAT, undefined, { id: "pending-overflow", sequence: 1_025 })).rejects.toThrow("Pending notification backlog is full");
  });
});


it("still rejects a malformed newline-terminated notification record", async () => {
  await withDataDir(async (dataDir) => {
    const notificationsPath = path.join(dataDir, "notifications.jsonl");
    await writeFile(notificationsPath, "{\"type\":\"queued\"\n", "utf8");
    const { factory } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));

    await expect(manager.start()).rejects.toThrow(SyntaxError);
  });
});


it("does not redeliver an acknowledged notification ID", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
    const identity = { id: "event-once", sequence: 5 };

    await manager.interrupt("instruction", CHAT, undefined, identity);
    await manager.interrupt("instruction", CHAT, undefined, identity);

    expect(workers[0]?.prompt).toHaveBeenCalledOnce();
  });
});

it("reaped idle worker triggers fresh worker creation on next message", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
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
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => now }));
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
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
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
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory, now: () => 10 * 60 * 60 * 1000 }));
    await manager.followup("one", CHAT);
    expect(workers).toHaveLength(1);
    await manager.beginShutdown();
    expect(workers[0]?.close).toHaveBeenCalledOnce();
    await expect(manager.followup("two", CHAT)).rejects.toThrow("Agent manager is shutting down");
  });
});

it("beginShutdown waits for conversation delivery queues before closing workers", async () => {
  await withDataDir(async (dataDir) => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstPromptStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstPromptRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let promptCount = 0;
    const { factory, workers } = fakeWorkerFactory(async () => {
      promptCount += 1;
      if (promptCount === 1) {
        firstStarted();
        await firstPromptRelease;
      }
    });
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
    const first = manager.followup("first", CHAT, { id: "shutdown-first" });
    await firstPromptStarted;
    const second = manager.followup("second", CHAT, { id: "shutdown-second" });
    await vi.waitFor(async () => expect(await readFile(path.join(dataDir, "notifications.jsonl"), "utf8")).toContain("shutdown-second"));

    const shutdown = manager.beginShutdown();
    await Promise.resolve();
    expect(workers[0]?.close).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).rejects.toThrow("Agent manager is shutting down");
    await expect(second).rejects.toThrow("Agent manager is shutting down");
    await shutdown;

    expect(workers[0]?.prompt).toHaveBeenCalledOnce();
    expect(workers[0]?.close).toHaveBeenCalledOnce();
    expect(await readFile(path.join(dataDir, "notifications.jsonl"), "utf8")).toContain('{"type":"delivered","id":"shutdown-first"}');
  });
});

it("manages independent workers and session directories for generic conversation identities", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
    const matthew = conversationAgent("matrix:primary", "room:matthew", { room_id: "!matthew:example" });
    const daisy = conversationAgent("matrix:primary", "room:daisy", { room_id: "!daisy:example" });
    const mirroredKey = conversationAgent("slack:primary", "room:matthew", { channel_id: "C123" });

    await manager.followup("Matthew general", matthew);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.options.sessionDir).toBe(`/workspace/.pi/sessions/${conversationSessionPath(matthew)}`);

    await manager.followup("Daisy general", daisy);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.options.sessionDir).toBe(`/workspace/.pi/sessions/${conversationSessionPath(daisy)}`);

    await manager.followup("Same key, other connector", mirroredKey);
    expect(workers).toHaveLength(3);
    expect(workers[2]?.options.sessionDir).toBe(`/workspace/.pi/sessions/${conversationSessionPath(mirroredKey)}`);

    await manager.followup("Matthew follow up", matthew);
    expect(workers).toHaveLength(3);
    expect(workers[0]?.prompt).toHaveBeenCalledTimes(2);
  });
});

it("restartAll closes every active conversation worker and respawns them", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));

    const chat100 = telegramConversation(CONNECTOR_ID, 100);
    const topic200 = telegramConversation(CONNECTOR_ID, 200, 1);
    await manager.followup("Chat 100", chat100);
    await manager.followup("Chat 200 topic 1", topic200);
    expect(workers).toHaveLength(2);

    await manager.restartAll();
    expect(workers[0]?.close).toHaveBeenCalled();
    expect(workers[1]?.close).toHaveBeenCalled();

    await manager.followup("Chat 100 next", chat100);
    expect(workers).toHaveLength(3);
  });
});

it("restartAll waits for a busy worker's turn to settle before closing it", async () => {
  await withDataDir(async (dataDir) => {
    const { factory, workers } = fakeWorkerFactory();
    const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
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
      const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
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
      const manager = new AgentManager({ workspace: path.join(dataDir, "workspace") }, managerOptions(dataDir, { workerFactory: factory }));
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

it("bounds connector message steering waits", async () => {
  const interrupt = vi.fn(async () => undefined);
  const notifier: AgentNotifier = { interrupt, followup: vi.fn(async () => undefined) };
  const { connector, connectors } = fakeTelegramConnector();
  const router = new AgentEventRouter(notifier, { workspace: "/nonexistent/tg-bot2-router", connectors });
  const target = telegramConversation(CONNECTOR_ID, 829096380);
  const record: TimelineRecord = {
    v: 2,
    id: "event-1",
    seq: 7,
    t: "2026-08-24T00:00:00.000Z",
    type: "telegram.message",
    connectorId: CONNECTOR_ID,
    conversation: target,
    payload: { message_id: 1, date: 1_700_000_000, text: "hello", chat: { id: 829096380, type: "private" } },
    attachments: [],
    meta: { user_content: true },
  };
  const rawLine = JSON.stringify(record);

  await router.onEvent(record, rawLine);

  expect(connector.notificationText).toHaveBeenCalledWith(record, rawLine);
  expect(interrupt).toHaveBeenCalledWith(
    rawLine,
    target,
    USER_INTERRUPT_MAX_WAIT_MS,
    { id: "event-1", sequence: 7 },
  );
});

it("ignores a topic service event and delivers the complete connector-native first post", async () => {
  const interrupt = vi.fn(async () => undefined);
  const { connectors } = fakeTelegramConnector();
  const router = new AgentEventRouter({ interrupt, followup: vi.fn(async () => undefined) }, {
    workspace: "/nonexistent/tg-bot2-router",
    connectors,
  });
  const target = telegramConversation(CONNECTOR_ID, 829096380, 9751);
  const serviceRecord: TimelineRecord = {
    v: 2,
    id: "topic-created",
    seq: 10,
    t: "2026-08-24T00:00:00.000Z",
    type: "telegram.message",
    connectorId: CONNECTOR_ID,
    conversation: target,
    payload: { message_id: 9652, message_thread_id: 9751, forum_topic_created: { name: "My conception of..." } },
    attachments: [],
    meta: { user_content: false },
  };
  await router.onEvent(serviceRecord, JSON.stringify(serviceRecord));

  const text = "My conception of harness is ".repeat(50);
  const firstPost: TimelineRecord = {
    v: 2,
    id: "first-post",
    seq: 11,
    t: "2026-08-24T00:00:01.000Z",
    type: "telegram.message",
    connectorId: CONNECTOR_ID,
    conversation: target,
    payload: { message_id: 9653, message_thread_id: 9751, text },
    attachments: [],
    meta: { user_content: true },
  };
  const rawLine = JSON.stringify(firstPost);
  await router.onEvent(firstPost, rawLine);

  expect(interrupt).toHaveBeenCalledOnce();
  expect(interrupt).toHaveBeenCalledWith(rawLine, target, USER_INTERRUPT_MAX_WAIT_MS, { id: "first-post", sequence: 11 });
  expect(rawLine).toContain(text);
});

it("routes schedules directly to generic conversation owners", async () => {
  const followup = vi.fn(async () => undefined);
  const { connectors } = fakeTelegramConnector();
  const router = new AgentEventRouter({ followup, interrupt: vi.fn(async () => undefined) }, {
    workspace: "/nonexistent/tg-bot2-router",
    connectors,
  });
  const target = conversationAgent("matrix:primary", "room:planning", { room_id: "!planning:example" });
  const record: TimelineRecord = {
    v: 2,
    id: "schedule-event",
    seq: 9,
    t: "2026-08-24T00:00:00.000Z",
    type: "schedule_fired",
    scheduleId: "schedule-1",
    occurrenceId: "occurrence-1",
    conversation: target,
    prompt: "create today's topic",
    dueAt: "2026-08-24T00:00:00.000Z",
  };

  await router.onEvent(record, JSON.stringify(record));

  expect(followup).toHaveBeenCalledWith(
    "Scheduled instruction due 2026-08-24T00:00:00.000Z:\ncreate today's topic",
    target,
    { id: "schedule-event", sequence: 9 },
  );
});

it("connector edited events remain silent without waking the agent", async () => {
  const followup = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const { connector, connectors } = fakeTelegramConnector();
  const router = new AgentEventRouter({ followup, interrupt }, { workspace: "/nonexistent/tg-bot2-router", connectors });
  const record: TimelineRecord = {
    v: 2,
    id: "edited-event",
    seq: 12,
    t: "2026-08-22T00:00:00.000Z",
    type: "telegram.edited_message",
    connectorId: CONNECTOR_ID,
    conversation: telegramConversation(CONNECTOR_ID, 829096380, 50),
    payload: { message_id: 10, text: "edited text", message_thread_id: 50 },
    attachments: [],
  };

  await router.onEvent(record, JSON.stringify(record));

  expect(connector.attention).toHaveBeenCalledWith(record, {});
  expect(connector.notificationText).not.toHaveBeenCalled();
  expect(interrupt).not.toHaveBeenCalled();
  expect(followup).not.toHaveBeenCalled();
});

it("loads attention overrides from the owning conversation session", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const target = telegramConversation(CONNECTOR_ID, 42, 7);
    const settingsPath = path.join(workspace, ".pi", "sessions", conversationSessionPath(target), "notifications.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ wake: ["telegram.edited_message"] }), "utf8");
    const interrupt = vi.fn(async () => undefined);
    const { connector, connectors } = fakeTelegramConnector();
    vi.mocked(connector.attention!).mockImplementation((_record, settings) =>
      Array.isArray(settings.wake) && settings.wake.includes("telegram.edited_message") ? "interrupt" : undefined);
    const router = new AgentEventRouter({ interrupt, followup: vi.fn(async () => undefined) }, { workspace, connectors });
    const record: TimelineRecord = {
      v: 2,
      id: "edited-wake",
      seq: 13,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.edited_message",
      connectorId: CONNECTOR_ID,
      conversation: target,
      payload: { message_id: 10, text: "changed" },
    };

    await router.onEvent(record, JSON.stringify(record));

    expect(connector.attention).toHaveBeenCalledWith(record, { wake: ["telegram.edited_message"] });
    expect(interrupt).toHaveBeenCalledWith(expect.any(String), target, USER_INTERRUPT_MAX_WAIT_MS, { id: "edited-wake", sequence: 13 });
  });
});

it("falls back when notification settings are a symlink to a special file", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const target = telegramConversation(CONNECTOR_ID, 42, 7);
    const settingsPath = path.join(workspace, ".pi", "sessions", conversationSessionPath(target), "notifications.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await symlink("/dev/zero", settingsPath);
    const { connector, connectors } = fakeTelegramConnector();
    const router = new AgentEventRouter({ interrupt: vi.fn(async () => undefined), followup: vi.fn(async () => undefined) }, { workspace, connectors });
    const record: TimelineRecord = {
      v: 2,
      id: "unsafe-settings",
      seq: 14,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.edited_message",
      connectorId: CONNECTOR_ID,
      conversation: target,
      payload: { message_id: 10, text: "changed" },
    };

    await router.onEvent(record, JSON.stringify(record));

    expect(connector.attention).toHaveBeenCalledWith(record, {});
  });
});
it("falls back when an intermediate notification settings directory is a symlink", async () => {
  await withDataDir(async (dataDir) => {
    const workspace = path.join(dataDir, "workspace");
    const target = telegramConversation(CONNECTOR_ID, 42, 7);
    const outside = path.join(dataDir, "outside", "sessions", conversationSessionPath(target));
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "notifications.json"), JSON.stringify({ wake: ["telegram.edited_message"] }), "utf8");
    await mkdir(path.join(workspace, ".pi"), { recursive: true });
    await symlink(path.join(dataDir, "outside", "sessions"), path.join(workspace, ".pi", "sessions"));

    const { connector, connectors } = fakeTelegramConnector();
    const router = new AgentEventRouter({ interrupt: vi.fn(async () => undefined), followup: vi.fn(async () => undefined) }, { workspace, connectors });
    const record: TimelineRecord = {
      v: 2,
      id: "unsafe-intermediate-settings",
      seq: 15,
      t: "2026-08-24T00:00:00.000Z",
      type: "telegram.edited_message",
      connectorId: CONNECTOR_ID,
      conversation: target,
      payload: { message_id: 10, text: "changed" },
    };

    await router.onEvent(record, JSON.stringify(record));

    expect(connector.attention).toHaveBeenCalledWith(record, {});
  });
});
