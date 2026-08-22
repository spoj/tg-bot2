import { describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers.js";

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
    config: {
      dataDir: "/requested",
      bots: [
        {
          token: "123:token",
          botId: 123,
          dataDir: "/requested",
          botDir: "/requested/bots/123",
          workspace: "/requested/bots/123/workspace",
        },
      ],
    },
    sandbox: { dataDir: "/canonical-data", bwrapPath: "/validated/bwrap" },
    signalHandlers: {} as Record<string, () => void>,
    checkSandboxEnvironment: vi.fn(),
    agentManager: vi.fn(class AgentManagerMock {
      beginShutdown = agents.beginShutdown;
      disposeAll = agents.disposeAll;
      handleNewSessionRequest = vi.fn(async () => {});
    }),
    agentEventRouter: vi.fn(class AgentEventRouterMock {
      onEvent = vi.fn();
    }),
    scheduler: vi.fn(class WorkspaceSchedulerMock {
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("scheduler.stop"); });
    }),
    outbox: vi.fn(class WorkspaceOutboxMock {
      dispatch: unknown;
      constructor(options: { dispatch: unknown }) {
        this.dispatch = options.dispatch;
      }
    }),
    requestBus: vi.fn(class WorkspaceRequestBusMock {
      constructor(_options: unknown) {}
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("requestBus.stop"); });
      flush = vi.fn(async () => {});
    }),
    tasks: vi.fn(class WorkspaceTasksMock {
      constructor(_options: unknown) {}
      flush: unknown;
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
  loadConfig: async () => state.config,
}));
vi.mock("../src/sandbox.js", () => ({
  checkSandboxEnvironment: state.checkSandboxEnvironment,
  spawnProcess: state.spawnProcess,
  terminateActiveSandboxes: state.terminateActiveSandboxes,
  terminateProcessGroup: state.terminateProcessGroup,
}));
vi.mock("../src/agent.js", () => ({ AgentManager: state.agentManager, AgentEventRouter: state.agentEventRouter }));
vi.mock("../src/scheduler.js", () => ({ WorkspaceScheduler: state.scheduler }));
vi.mock("../src/outbox.js", () => ({ WorkspaceOutbox: state.outbox }));
vi.mock("../src/request-bus.js", () => ({ WorkspaceRequestBus: state.requestBus }));
vi.mock("../src/task.js", () => ({ WorkspaceTasks: state.tasks }));
vi.mock("../src/telegram.js", () => ({
  createTelegramBot: state.createTelegramBot,
  dispatchOutboxRequest: state.dispatchOutboxRequest,
  TelegramDeliveryQueue: state.delivery,
}));

async function importIndex(configure?: () => void): Promise<typeof import("../src/index.js")> {
  state.order.length = 0;
  state.checkSandboxEnvironment.mockReset().mockResolvedValue(state.sandbox);
  state.agentManager.mockClear();
  state.scheduler.mockClear();
  state.outbox.mockClear();
  state.requestBus.mockClear();
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
      { workspace: "/canonical-data/bots/123/workspace" },
      expect.objectContaining({ appRoot: expect.any(String), bwrapPath: "/validated/bwrap" }),
    );
    const schedulerOptions = state.scheduler.mock.calls[0]?.[0] as { workspace: string; events: unknown };
    expect(schedulerOptions.workspace).toBe("/canonical-data/bots/123/workspace");
    expect(schedulerOptions.events).toBeDefined();
    expect(state.outbox).toHaveBeenCalledWith(expect.objectContaining({ dispatch: expect.any(Function), events: expect.any(Object) }));
    expect(state.requestBus).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/canonical-data/bots/123/workspace" }));
    expect(state.tasks).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/canonical-data/bots/123/workspace", bwrapPath: "/validated/bwrap", events: expect.any(Object) }));
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
    expect(state.dispatchOutboxRequest).toHaveBeenCalledWith(state.bot, { botDir: "/canonical-data/bots/123", workspace: "/canonical-data/bots/123/workspace" }, 42, request);
    expect(result).toEqual({ messageId: 7 });
  });

  it("raises the shutdown gate, disposes every service, and treats signal abort as graceful", async () => {
    const start = deferred<void>();
    const index = await importIndex(() => state.bot.start.mockReturnValue(start.promise));
    void index.main();
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledOnce());

    state.signalHandlers.SIGTERM?.();
    await vi.waitFor(() => expect(state.order).toEqual([
      "bot.stop", "agents.beginShutdown", "scheduler.stop", "requestBus.stop", "tasks.stop", "agents.disposeAll", "delivery.drain",
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

  it("starts and stops all configured bots when multiple bots exist", async () => {
    const start1 = deferred<void>();
    const start2 = deferred<void>();
    state.config = {
      dataDir: "/requested",
      bots: [
        { token: "100:token100", botId: 100, dataDir: "/requested", botDir: "/requested/bots/100", workspace: "/requested/bots/100/workspace" },
        { token: "200:token200", botId: 200, dataDir: "/requested", botDir: "/requested/bots/200", workspace: "/requested/bots/200/workspace" },
      ],
    };
    let callCount = 0;
    const index = await importIndex(() => {
      state.bot.start.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? start1.promise : start2.promise;
      });
    });
    void index.main();
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledTimes(2));
    expect(state.agentManager).toHaveBeenCalledTimes(2);
    expect(state.scheduler).toHaveBeenCalledTimes(2);
    expect(state.requestBus).toHaveBeenCalledTimes(2);
    expect(state.tasks).toHaveBeenCalledTimes(2);

    state.signalHandlers.SIGINT?.();
    await vi.waitFor(() => expect(state.bot.stop).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.agents.beginShutdown).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.agents.disposeAll).toHaveBeenCalledTimes(2));
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
        requestBus: { stop: step("requestBus.stop") },
        tasks: { stop: step("tasks.stop") },
        delivery: { drain: step("delivery.drain") },
      },
    };
  }

  it("runs every disposal step in order and forces agent disposal", async () => {
    const { finishDisposal } = await importIndex();
    const { calls, services } = makeServices();

    await finishDisposal(services);

    expect(calls).toEqual(["scheduler.stop", "requestBus.stop", "tasks.stop", "disposeAll", "delivery.drain"]);
    expect(services.agents.disposeAll).toHaveBeenCalledWith();
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });

  it("runs every step even when earlier steps throw and swallows the errors", async () => {
    const { finishDisposal } = await importIndex();
    const { calls, services } = makeServices(true);

    await expect(finishDisposal(services)).resolves.toBeUndefined();

    expect(calls).toEqual(["scheduler.stop", "requestBus.stop", "tasks.stop", "disposeAll", "delivery.drain"]);
    expect(services.agents.disposeAll).toHaveBeenCalledWith();
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });
});
