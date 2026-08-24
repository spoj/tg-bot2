import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationAgent, type ConversationAgentRef } from "../src/agent-ref.js";
import type { AppConfig } from "../src/config.js";
import { workspacePaths } from "../src/util.js";

const temporaryDirectories: string[] = [];

const state = vi.hoisted(() => {
  const lifecycle: string[] = [];
  const connectorRunResolvers: Array<() => void> = [];
  const signalHandlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};

  const agentsStart = vi.fn(async () => { lifecycle.push("agents.start"); });
  const agentsBeginShutdown = vi.fn(async () => { lifecycle.push("agents.beginShutdown"); });
  const agentsDisposeAll = vi.fn(async () => { lifecycle.push("agents.disposeAll"); });
  const agentsRestartAll = vi.fn(async () => {});
  const agentsInterrupt = vi.fn(async () => {});
  const agentManager = vi.fn(class AgentManagerMock {
    constructor(_paths: unknown, _options: unknown) {}
    start = agentsStart;
    beginShutdown = agentsBeginShutdown;
    disposeAll = agentsDisposeAll;
    restartAll = agentsRestartAll;
    interrupt = agentsInterrupt;
  });
  const routerOnEvent = vi.fn();
  const agentEventRouter = vi.fn(class AgentEventRouterMock {
    constructor(_agents: unknown, _options: unknown) {}
    onEvent = routerOnEvent;
  });

  const schedulerAdd = vi.fn(async () => ({ id: "schedule-1" }));
  const schedulerReplace = vi.fn(async () => ({ id: "schedule-1" }));
  const schedulerRemove = vi.fn(async () => "schedule-1");
  const schedulerTake = vi.fn(async () => ({ id: "schedule-1" }));
  const scheduler = vi.fn(class WorkspaceSchedulerMock {
    constructor(_options: unknown) {}
    start = vi.fn(async () => { lifecycle.push("scheduler.start"); });
    stop = vi.fn(async () => { lifecycle.push("scheduler.stop"); });
    add = schedulerAdd;
    replace = schedulerReplace;
    remove = schedulerRemove;
    take = schedulerTake;
  });

  const bridge = vi.fn(class HostBridgeMock {
    constructor(_options: unknown) {}
    start = vi.fn(async () => { lifecycle.push("bridge.start"); });
    stop = vi.fn(async () => { lifecycle.push("bridge.stop"); });
  });
  const agentCredentials = vi.fn(class AgentCredentialsMock {});

  const timelineSubscribe = vi.fn();
  const timelineAnnotate = vi.fn(async () => 1);
  const timeline = vi.fn(class WorkspaceTimelineMock {
    constructor(_filePath: string) {}
    subscribe = timelineSubscribe;
    start = vi.fn(async () => { lifecycle.push("timeline.start"); });
    annotateAttachment = timelineAnnotate;
  });

  const resourcesStart = vi.fn(async () => { lifecycle.push("resources.start"); });
  const resources = vi.fn(class WorkspaceResourcesMock {
    constructor(_filePath: string) {}
    start = resourcesStart;
  });

  const registryRegister = vi.fn(() => { lifecycle.push("registry.register"); });
  const registryPrompt = vi.fn((connectorId: string) => `prompt:${connectorId}`);
  const parsedConversation = {
    kind: "conversation" as const,
    connectorId: "telegram:123",
    conversationKey: "99:3",
    address: { chat_id: 99, message_thread_id: 3 },
  };
  const registryParseConversation = vi.fn(() => parsedConversation);
  const registryAuthorizeConversation = vi.fn(async () => {});
  const registry = vi.fn(class ConnectorRegistryMock {
    constructor() {}
    register = registryRegister;
    prompt = registryPrompt;
    parseConversation = registryParseConversation;
    authorizeConversation = registryAuthorizeConversation;
  });

  const connectorSetAgent = vi.fn(() => { lifecycle.push("connector.setAgent"); });
  const connectorRun = vi.fn(async () => {
    lifecycle.push("connector.run");
    await new Promise<void>((resolve) => connectorRunResolvers.push(resolve));
  });
  const connectorStop = vi.fn(async () => {
    lifecycle.push("connector.stop");
    for (const resolve of connectorRunResolvers.splice(0)) resolve();
  });
  const telegramConnector = vi.fn(class TelegramConnectorMock {
    readonly id: string;
    constructor(config: { id: string }, _timeline: unknown, _resources: unknown) {
      this.id = config.id;
    }
    setAgent = connectorSetAgent;
    run = connectorRun;
    stop = connectorStop;
  });

  const outboxSend = vi.fn(async () => ({ ok: true }));
  const outbox = vi.fn(class WorkspaceOutboxMock {
    constructor(_options: unknown) {}
    send = outboxSend;
  });

  const sandbox = { dataDir: "/validated", bwrapPath: "/validated/bwrap" };
  const checkSandboxEnvironment = vi.fn(async () => sandbox);
  const terminateActiveSandboxes = vi.fn(() => { lifecycle.push("sandbox.terminate"); });

  return {
    lifecycle,
    connectorRunResolvers,
    signalHandlers,
    config: undefined as unknown as AppConfig,
    sandbox,
    checkSandboxEnvironment,
    terminateActiveSandboxes,
    agentManager,
    agentEventRouter,
    agentsStart,
    agentsBeginShutdown,
    agentsDisposeAll,
    agentsRestartAll,
    agentsInterrupt,
    routerOnEvent,
    scheduler,
    schedulerAdd,
    schedulerReplace,
    schedulerRemove,
    schedulerTake,
    bridge,
    agentCredentials,
    timeline,
    timelineSubscribe,
    timelineAnnotate,
    resources,
    resourcesStart,
    registry,
    registryRegister,
    registryPrompt,
    registryParseConversation,
    registryAuthorizeConversation,
    parsedConversation,
    telegramConnector,
    connectorSetAgent,
    connectorRun,
    connectorStop,
    outbox,
    outboxSend,
  };
});

vi.mock("../src/config.js", () => ({ loadConfig: async () => state.config }));
vi.mock("../src/sandbox.js", () => ({
  checkSandboxEnvironment: state.checkSandboxEnvironment,
  spawnProcess: vi.fn(),
  terminateProcessGroup: vi.fn(),
  terminateActiveSandboxes: state.terminateActiveSandboxes,
}));
vi.mock("../src/agent.js", () => ({ AgentManager: state.agentManager, AgentEventRouter: state.agentEventRouter }));
vi.mock("../src/scheduler.js", () => ({ WorkspaceScheduler: state.scheduler }));
vi.mock("../src/outbox.js", () => ({ WorkspaceOutbox: state.outbox }));
vi.mock("../src/host-bridge.js", () => ({ HostBridge: state.bridge, AgentCredentials: state.agentCredentials }));
vi.mock("../src/events.js", () => ({ WorkspaceTimeline: state.timeline }));
vi.mock("../src/resource-state.js", () => ({ WorkspaceResources: state.resources }));
vi.mock("../src/connector.js", () => ({ ConnectorRegistry: state.registry }));
vi.mock("../src/telegram-connector.js", () => ({ TelegramConnector: state.telegramConnector }));

async function importIndex(): Promise<{ module: typeof import("../src/index.js"); paths: ReturnType<typeof workspacePaths> }> {
  vi.resetModules();
  vi.clearAllMocks();
  state.lifecycle.length = 0;
  state.connectorRunResolvers.length = 0;
  delete state.signalHandlers.SIGINT;
  delete state.signalHandlers.SIGTERM;

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tg-bot2-index-"));
  temporaryDirectories.push(dataDir);
  const paths = workspacePaths(dataDir, "primary");
  state.sandbox.dataDir = dataDir;
  state.sandbox.bwrapPath = "/validated/bwrap";
  state.config = {
    dataDir: "/requested",
    workspaces: [{
      id: "primary",
      paths,
      connectors: [{
        type: "telegram",
        id: "telegram:123",
        token: "123:token",
        botId: 123,
        workspaceId: "primary",
        dataDir,
        attachmentPrefix: "/attachments",
        workspace: paths.workspace,
        attachments: paths.attachments,
      }],
    }],
  };

  vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
    if (event === "SIGINT" || event === "SIGTERM") state.signalHandlers[event] = listener;
    return process;
  }) as typeof process.once);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { module: await import("../src/index.js"), paths };
}

async function stopMain(running: Promise<void>): Promise<void> {
  state.signalHandlers.SIGTERM?.();
  await vi.waitFor(() => expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce());
  await running;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const resolve of state.connectorRunResolvers.splice(0)) resolve();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const mockInstance = <T>(mock: { mock: { instances: T[] } }, index = 0): T => mock.mock.instances[index]!;

describe("application startup and shutdown wiring", () => {
  it("constructs one workspace-native runtime and starts resources before services", async () => {
    const { module: index, paths } = await importIndex();
    const running = index.main();
    await vi.waitFor(() => expect(state.connectorRun).toHaveBeenCalledOnce());

    expect(state.checkSandboxEnvironment).toHaveBeenCalledWith("/requested");
    expect(state.resources).toHaveBeenCalledWith(paths.resources);
    expect(state.resourcesStart).toHaveBeenCalledWith();

    const timeline = mockInstance(state.timeline);
    const resources = mockInstance(state.resources);
    const connector = mockInstance(state.telegramConnector);
    const registry = mockInstance(state.registry);
    const agents = mockInstance(state.agentManager);
    expect(state.telegramConnector).toHaveBeenCalledWith(state.config.workspaces[0]!.connectors[0], timeline, resources);
    expect(state.registryRegister).toHaveBeenCalledWith(connector);
    expect(state.connectorSetAgent).toHaveBeenCalledWith(agents);
    expect(state.timelineSubscribe).toHaveBeenCalledWith(expect.any(Function));

    expect(state.agentManager).toHaveBeenCalledWith(
      { workspace: paths.workspace },
      expect.objectContaining({
        appRoot: process.cwd(),
        bwrapPath: "/validated/bwrap",
        hostSocketDir: paths.runDir,
        hostTimeline: paths.timeline,
        hostAttachments: paths.attachments,
        notificationsPath: paths.notifications,
        connectorPrompt: expect.any(Function),
      }),
    );
    const agentOptions = state.agentManager.mock.calls[0]![1] as { connectorPrompt: (connectorId: string) => string };
    expect(agentOptions.connectorPrompt("telegram:123")).toBe("prompt:telegram:123");
    expect(state.registryPrompt).toHaveBeenCalledWith("telegram:123");
    expect(state.outbox).toHaveBeenCalledWith({ connectors: registry, timeline });
    expect(state.scheduler).toHaveBeenCalledWith({
      schedulePath: paths.schedules,
      timeline,
    });

    expect(state.bridge).toHaveBeenCalledOnce();
    const bridgeOptions = state.bridge.mock.calls[0]![0] as { socketPath: string; handlers: Record<string, unknown> };
    expect(bridgeOptions.socketPath).toBe(path.join(paths.runDir, "host.sock"));
    expect(Object.keys(bridgeOptions.handlers).sort()).toEqual([
      "annotate",
      "scheduleAdd",
      "scheduleRemove",
      "scheduleReplace",
      "scheduleTake",
      "send",
      "steerConversation",
    ]);
    expect(state.lifecycle).toEqual([
      "timeline.start",
      "resources.start",
      "registry.register",
      "connector.setAgent",
      "bridge.start",
      "scheduler.start",
      "agents.start",
      "connector.run",
    ]);
    expect(await readFile(paths.timeline, "utf8")).toBe("");
    expect((await stat(paths.runDir)).isDirectory()).toBe(true);
    expect((await stat(paths.attachments)).isDirectory()).toBe(true);

    await stopMain(running);
  });

  it("routes connector-native bridge operations through the registry and conversation owner", async () => {
    const { module: index } = await importIndex();
    const running = index.main();
    await vi.waitFor(() => expect(state.connectorRun).toHaveBeenCalledOnce());
    const actor = conversationAgent("telegram:123", "42:7", { chat_id: 42, message_thread_id: 7 });
    const handlers = (state.bridge.mock.calls[0]![0] as {
      handlers: {
        send: (params: Record<string, unknown>, actor: ConversationAgentRef) => Promise<unknown>;
        annotate: (params: Record<string, unknown>) => Promise<unknown>;
        steerConversation: (params: Record<string, unknown>, actor: ConversationAgentRef) => Promise<unknown>;
        scheduleAdd: (params: Record<string, unknown>, actor: ConversationAgentRef) => Promise<unknown>;
      };
    }).handlers;

    const request = { method: "sendMessage", text: "hello" };
    await expect(handlers.send({ request }, actor)).resolves.toEqual({ ok: true });
    expect(state.outboxSend).toHaveBeenCalledWith(request, actor);
    await expect(handlers.annotate({ attachment: "/attachments/a", description: "receipt" })).resolves.toEqual({ occurrences: 1 });
    expect(state.timelineAnnotate).toHaveBeenCalledWith("/attachments/a", "receipt");
    await expect(handlers.steerConversation({ conversation: { connectorId: "telegram:123" }, message: "delegate" }, actor)).resolves.toEqual({ status: "delivered" });
    expect(state.registryAuthorizeConversation).toHaveBeenCalledWith(state.parsedConversation);
    expect(state.agentsInterrupt).toHaveBeenCalledWith(expect.stringContaining("delegate"), state.parsedConversation);
    await handlers.scheduleAdd({ prompt: "later" }, actor);
    expect(state.schedulerAdd).toHaveBeenCalledWith({ prompt: "later" }, actor);

    await stopMain(running);
  });

  it("stops agents before disposing the workspace and its connectors", async () => {
    const { module: index } = await importIndex();
    const running = index.main();
    await vi.waitFor(() => expect(state.connectorRun).toHaveBeenCalledOnce());

    state.signalHandlers.SIGINT?.();
    await vi.waitFor(() => expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce());
    await running;
    expect(state.lifecycle).toEqual([
      "timeline.start",
      "resources.start",
      "registry.register",
      "connector.setAgent",
      "bridge.start",
      "scheduler.start",
      "agents.start",
      "connector.run",
      "agents.beginShutdown",
      "scheduler.stop",
      "bridge.stop",
      "agents.disposeAll",
      "connector.stop",
      "sandbox.terminate",
    ]);
  });
});

describe("finishDisposal", () => {
  function makeServices(throws = false) {
    const calls: string[] = [];
    const step = (name: string) => vi.fn(async () => {
      calls.push(name);
      if (throws) throw new Error(name);
    });
    return {
      calls,
      services: {
        scheduler: { stop: step("scheduler.stop") },
        bridge: { stop: step("bridge.stop") },
        agents: { disposeAll: step("agents.disposeAll") },
        connectors: [{ stop: step("connector.1.stop") }, { stop: step("connector.2.stop") }],
      },
    };
  }

  it("disposes host services before every connector", async () => {
    const { module: index } = await importIndex();
    const { calls, services } = makeServices();

    await index.finishDisposal(services);

    expect(calls).toEqual(["scheduler.stop", "bridge.stop", "agents.disposeAll", "connector.1.stop", "connector.2.stop"]);
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });

  it("continues connector disposal after earlier failures", async () => {
    const { module: index } = await importIndex();
    const { calls, services } = makeServices(true);

    await expect(index.finishDisposal(services)).resolves.toBeUndefined();

    expect(calls).toEqual(["scheduler.stop", "bridge.stop", "agents.disposeAll", "connector.1.stop", "connector.2.stop"]);
    expect(state.terminateActiveSandboxes).toHaveBeenCalledOnce();
  });
});
