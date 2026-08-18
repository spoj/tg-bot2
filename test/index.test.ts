import { describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "./helpers.js";

const state = vi.hoisted(() => {
  const order: string[] = [];
  const flushState = { current: undefined as Deferred<void> | undefined };
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
    flush: undefined as Deferred<void> | undefined,
    setFlush: (value: Deferred<void>) => { flushState.current = value; },
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
    createTelegramBot: vi.fn(() => bot),
    dispatchOutboxRequest: vi.fn(),
    closeTelegramIngress: vi.fn(() => { order.push("closeTelegramIngress"); }),
    flushTelegramIngress: vi.fn(async () => {
      order.push("flushTelegramIngress");
      await flushState.current?.promise;
    }),
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
vi.mock("../src/telegram.js", () => ({
  createTelegramBot: state.createTelegramBot,
  closeTelegramIngress: state.closeTelegramIngress,
  flushTelegramIngress: state.flushTelegramIngress,
  dispatchOutboxRequest: state.dispatchOutboxRequest,
  TelegramDeliveryQueue: state.delivery,
}));

async function importIndex(configure?: () => void): Promise<typeof import("../src/index.js")> {
  const flush = deferred<void>();
  state.flush = flush;
  state.setFlush(flush);
  state.order.length = 0;
  state.checkSandboxEnvironment.mockReset().mockResolvedValue(state.sandbox);
  state.agentManager.mockClear();
  state.scheduler.mockClear();
  state.outbox.mockClear();
  state.createTelegramBot.mockClear();
  state.dispatchOutboxRequest.mockClear();
  state.closeTelegramIngress.mockClear();
  state.flushTelegramIngress.mockClear();
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

  it("raises the shutdown gate before waiting for ingress and treats signal abort as graceful", async () => {
    const start = deferred<void>();
    const index = await importIndex(() => state.bot.start.mockReturnValue(start.promise));
    void index.main();
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledOnce());

    state.signalHandlers.SIGTERM?.();
    await vi.waitFor(() => expect(state.order).toEqual(["bot.stop", "closeTelegramIngress", "agents.beginShutdown", "flushTelegramIngress"]));
    expect(process.exitCode).toBeUndefined();

    start.reject(Object.assign(new Error("telegram polling aborted"), { name: "AbortError" }));
    state.flush?.resolve();
    await vi.waitFor(() => expect(state.agents.disposeAll).toHaveBeenCalledOnce());
    expect(process.exitCode).toBeUndefined();
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
        delivery: { drain: step("delivery.drain") },
      },
    };
  }

  it("runs every disposal step in order and forces agent disposal", async () => {
    const { finishDisposal } = await importIndex();
    const { calls, services } = makeServices();

    await finishDisposal(services);

    expect(calls).toEqual(["scheduler.stop", "outbox.stop", "disposeAll", "delivery.drain"]);
    expect(services.agents.disposeAll).toHaveBeenCalledWith();
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });

  it("runs every step even when earlier steps throw and swallows the errors", async () => {
    const { finishDisposal } = await importIndex();
    const { calls, services } = makeServices(true);

    await expect(finishDisposal(services)).resolves.toBeUndefined();

    expect(calls).toEqual(["scheduler.stop", "outbox.stop", "disposeAll", "delivery.drain"]);
    expect(services.agents.disposeAll).toHaveBeenCalledWith();
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });
});
