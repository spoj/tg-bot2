import { describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "./helpers.js";

const state = vi.hoisted(() => {
  const order: string[] = [];
  const agents = {
    beginShutdown: vi.fn(() => {
      order.push("agents.beginShutdown");
      return Promise.resolve();
    }),
    disposeAll: vi.fn(async () => { order.push("agents.disposeAll"); }),
  };
  const bot = {
    start: vi.fn(),
    stop: vi.fn(async () => { order.push("bot.stop"); }),
  };
  return {
    order,
    agents,
    bot,
    config: { token: "token", allowedUserIds: new Set([42]), dataDir: "/requested" },
    sandbox: { dataDir: "/canonical-data", bwrapPath: "/validated/bwrap" },
    signalHandlers: {} as Record<string, () => void>,
    checkSandboxEnvironment: vi.fn(),
    agentManager: vi.fn(class AgentManagerMock {
      beginShutdown = agents.beginShutdown;
      disposeAll = agents.disposeAll;
    }),
    scheduler: vi.fn(class WorkspaceSchedulerMock {
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("scheduler.stop"); });
    }),
    outbox: vi.fn(class WorkspaceOutboxMock {
      dispatch: unknown;
      constructor(options: { dispatch: unknown }) {
        this.dispatch = options.dispatch;
      }
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("outbox.stop"); });
    }),
    tasks: vi.fn(class WorkspaceTasksMock {
      constructor(_options: unknown) {}
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("tasks.stop"); });
    }),
    createTelegramBot: vi.fn(() => bot),
    dispatchOutboxRequest: vi.fn(),
    delivery: vi.fn(class TelegramDeliveryQueueMock {
      enqueue = vi.fn(async (_chatId: number, run: () => unknown) => run());
      drain = vi.fn(async () => { order.push("delivery.drain"); });
    }),
    terminateActiveSandboxes: vi.fn(),
    spawnProcess: vi.fn(),
    terminateProcessGroup: vi.fn(),
  };
});


vi.mock("../src/config.js", () => ({
  parseConfig: () => state.config,
}));
vi.mock("../src/sandbox.js", () => ({
  checkSandboxEnvironment: state.checkSandboxEnvironment,
  spawnProcess: state.spawnProcess,
  terminateActiveSandboxes: state.terminateActiveSandboxes,
  terminateProcessGroup: state.terminateProcessGroup,
}));
vi.mock("../src/agent.js", () => ({ AgentManager: state.agentManager }));
vi.mock("../src/scheduler.js", () => ({ WorkspaceScheduler: state.scheduler }));
vi.mock("../src/outbox.js", () => ({ WorkspaceOutbox: state.outbox }));
vi.mock("../src/task.js", () => ({ WorkspaceTasks: state.tasks }));
vi.mock("../src/telegram.js", () => ({
  createTelegramBot: state.createTelegramBot,
  dispatchOutboxRequest: state.dispatchOutboxRequest,
  TelegramDeliveryQueue: state.delivery,
  WAKE_PROMPT: ".",
}));

async function importIndex(configure?: () => void): Promise<typeof import("../src/index.js")> {
  state.order.length = 0;
  state.checkSandboxEnvironment.mockReset().mockResolvedValue(state.sandbox);
  state.agentManager.mockClear();
  state.scheduler.mockClear();
  state.outbox.mockClear();
  state.tasks.mockClear();
  state.createTelegramBot.mockClear();
  state.dispatchOutboxRequest.mockClear();
  state.terminateActiveSandboxes.mockClear();
  state.agents.beginShutdown.mockClear();
  state.agents.disposeAll.mockClear();
  state.bot.stop.mockClear();
  state.bot.start.mockReset();
  configure?.();
  state.signalHandlers = {};
  vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
    state.signalHandlers[event] = listener;
    return process;
  }) as typeof process.once);
  process.exitCode = undefined;
  vi.resetModules();
  return import("../src/index.js");
}
describe("application startup and shutdown wiring", () => {
  it("passes canonical sandbox paths through every runtime component", async () => {
    const index = await importIndex(() => state.bot.start.mockResolvedValue(undefined));
    void index.main();
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(state.agentManager).toHaveBeenCalledOnce());
    expect(state.checkSandboxEnvironment).toHaveBeenCalledOnce();
    expect(state.checkSandboxEnvironment).toHaveBeenCalledWith("/requested");
    expect(state.agentManager).toHaveBeenCalledWith(
      { ...state.config, dataDir: "/canonical-data" },
      expect.objectContaining({ appRoot: expect.any(String), bwrapPath: "/validated/bwrap" }),
    );
    expect(state.scheduler).toHaveBeenCalledWith(expect.objectContaining({ dataDir: "/canonical-data" }));
    expect(state.outbox).toHaveBeenCalledWith(expect.objectContaining({ dataDir: "/canonical-data" }));
    expect(state.tasks).toHaveBeenCalledWith(expect.objectContaining({ dataDir: "/canonical-data", bwrapPath: "/validated/bwrap", agent: state.agentManager.mock.instances[0] }));
    expect(state.bot.start).toHaveBeenCalledWith(expect.objectContaining({
      allowed_updates: ["message", "callback_query", "poll_answer"],
    }));
  });

  it("delegates outbox dispatch to dispatchOutboxRequest via the delivery queue", async () => {
    const index = await importIndex(() => state.bot.start.mockResolvedValue(undefined));
    void index.main();
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledOnce());

    state.dispatchOutboxRequest.mockResolvedValue({ messageId: 7 });
    const outbox = state.outbox.mock.instances[0] as { dispatch: (chatId: number, req: unknown) => Promise<unknown> };
    const request = { type: "send_message", version: 1, id: "x", text: "hi" };
    const result = await outbox.dispatch(42, request);

    expect(state.dispatchOutboxRequest).toHaveBeenCalledWith(state.bot, "/canonical-data", 42, request);
    expect(result).toEqual({ messageId: 7 });
  });

  it("raises the shutdown gate, disposes every service, and treats signal abort as graceful", async () => {
    const start = deferred<void>();
    const index = await importIndex(() => state.bot.start.mockReturnValue(start.promise));
    void index.main();
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledOnce());

    state.signalHandlers.SIGTERM?.();
    await vi.waitFor(() => expect(state.order).toEqual([
      "bot.stop", "agents.beginShutdown", "scheduler.stop", "outbox.stop", "tasks.stop", "agents.disposeAll", "delivery.drain",
    ]));
    expect(process.exitCode).toBeUndefined();

    start.reject(Object.assign(new Error("telegram polling aborted"), { name: "AbortError" }));
    await vi.waitFor(() => expect(process.exitCode).toBeUndefined());
  });

  it("does not classify an unrelated startup failure as a signal abort", async () => {
    const { isIntentionalSignalAbort } = await importIndex();
    expect(isIntentionalSignalAbort(new Error("Telegram polling failed"))).toBe(false);
    expect(isIntentionalSignalAbort(new Error("Aborted delay"))).toBe(true);
    expect(isIntentionalSignalAbort(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toBe(true);
  });
});

describe("finishDisposal", () => {
  function makeServices(throws = false) {
    const calls: string[] = [];
    const step = (name: string) => vi.fn(async () => {
      calls.push(name);
      if (throws) throw new Error(`${name} failed`);
    });
    return {
      calls,
      services: {
        agents: { disposeAll: step("disposeAll") },
        scheduler: { stop: step("scheduler.stop") },
        outbox: { stop: step("outbox.stop") },
        tasks: { stop: step("tasks.stop") },
        delivery: { drain: step("delivery.drain") },
      },
    };
  }

  it("runs every disposal step in order and forces agent disposal", async () => {
    const { finishDisposal } = await importIndex();
    const { calls, services } = makeServices();

    await finishDisposal(services);

    expect(calls).toEqual(["scheduler.stop", "outbox.stop", "tasks.stop", "disposeAll", "delivery.drain"]);
    expect(services.agents.disposeAll).toHaveBeenCalledWith();
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });

  it("runs every step even when earlier steps throw and swallows the errors", async () => {
    const { finishDisposal } = await importIndex();
    const { calls, services } = makeServices(true);

    await expect(finishDisposal(services)).resolves.toBeUndefined();

    expect(calls).toEqual(["scheduler.stop", "outbox.stop", "tasks.stop", "disposeAll", "delivery.drain"]);
    expect(services.agents.disposeAll).toHaveBeenCalledWith();
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });
});
