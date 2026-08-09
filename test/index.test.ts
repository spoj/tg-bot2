import { describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const state = vi.hoisted(() => {
  const order: string[] = [];
  const flushState = { current: undefined as Deferred<void> | undefined };
  const agents = {
    beginShutdown: vi.fn(() => {
      order.push("agents.beginShutdown");
      return Promise.resolve();
    }),
    disposeAll: vi.fn(async () => { order.push("agents.disposeAll"); }),
    prompt: vi.fn(async () => ""),
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
      prompt = agents.prompt;
    }),
    scheduler: vi.fn(class WorkspaceSchedulerMock {
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("scheduler.stop"); });
    }),
    outbox: vi.fn(class WorkspaceOutboxMock {
      start = vi.fn(async () => {});
      stop = vi.fn(async () => { order.push("outbox.stop"); });
    }),
    createTelegramBot: vi.fn(() => bot),
    closeTelegramIngress: vi.fn(() => { order.push("closeTelegramIngress"); }),
    flushTelegramIngress: vi.fn(async () => {
      order.push("flushTelegramIngress");
      await flushState.current?.promise;
    }),
    delivery: vi.fn(class TelegramDeliveryQueueMock {
      drain = vi.fn(async () => { order.push("delivery.drain"); });
    }),
    terminateActiveSandboxes: vi.fn(),
  };
});

vi.mock("../src/config.js", () => ({
  parseConfig: () => state.config,
  chatPaths: (dataDir: string, chatId: number) => ({ workspace: `${dataDir}/chats/${chatId}/workspace` }),
}));
vi.mock("../src/sandbox.js", () => ({
  checkSandboxEnvironment: state.checkSandboxEnvironment,
  terminateActiveSandboxes: state.terminateActiveSandboxes,
}));
vi.mock("../src/agent.js", () => ({ AgentManager: state.agentManager }));
vi.mock("../src/scheduler.js", () => ({ WorkspaceScheduler: state.scheduler }));
vi.mock("../src/outbox.js", () => ({ WorkspaceOutbox: state.outbox }));
vi.mock("../src/telegram.js", () => ({
  createTelegramBot: state.createTelegramBot,
  closeTelegramIngress: state.closeTelegramIngress,
  flushTelegramIngress: state.flushTelegramIngress,
  sendTelegramText: vi.fn(),
  sendWorkspaceFile: vi.fn(),
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
    await importIndex(() => state.bot.start.mockResolvedValue(undefined));
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
  });

  it("raises the shutdown gate before waiting for ingress and treats signal abort as graceful", async () => {
    const startFailure = new Error("Aborted delay");
    const start = deferred<void>();
    await importIndex(() => state.bot.start.mockReturnValue(start.promise));
    await vi.waitFor(() => expect(state.bot.start).toHaveBeenCalledOnce());

    state.signalHandlers.SIGTERM?.();
    await vi.waitFor(() => expect(state.order).toEqual(["bot.stop", "closeTelegramIngress", "agents.beginShutdown", "flushTelegramIngress"]));
    expect(process.exitCode).toBeUndefined();

    start.reject(startFailure);
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
