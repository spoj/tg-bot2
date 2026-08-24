import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentEventRouter, AgentManager } from "./agent.js";
import { type AgentRef, type ConversationAgentRef } from "./agent-ref.js";
import { loadConfig, type WorkspaceConfig } from "./config.js";
import { ConnectorRegistry } from "./connector.js";
import { WorkspaceTimeline } from "./events.js";
import { AgentCredentials, HostBridge } from "./host-bridge.js";
import { WorkspaceOutbox } from "./outbox.js";
import { WorkspaceResources } from "./resource-state.js";
import { checkSandboxEnvironment, spawnProcess, terminateActiveSandboxes, terminateProcessGroup } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { TelegramConnector } from "./telegram-connector.js";
import { appendJsonl } from "./util.js";

export function isIntentionalSignalAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") return true;
  return candidate.message === "Aborted delay" || candidate.message === "This operation was aborted";
}

export interface DisposableServices {
  agents: Pick<AgentManager, "disposeAll">;
  scheduler: Pick<WorkspaceScheduler, "stop">;
  bridge: Pick<HostBridge, "stop">;
  connectors: Array<Pick<TelegramConnector, "stop">>;
}

export interface WorkspaceInstance {
  config: WorkspaceConfig;
  agents: AgentManager;
  scheduler: WorkspaceScheduler;
  bridge: HostBridge;
  connectors: TelegramConnector[];
}

function stringField(record: Record<string, unknown> | undefined, field: string): string {
  const value = record?.[field];
  return typeof value === "string" ? value : "";
}

function conversationActor(actor: AgentRef): ConversationAgentRef {
  if (actor.kind !== "conversation") throw new Error("Only conversation agents can manage schedules");
  return actor;
}

export async function ensureTimeline(timelinePath: string): Promise<void> {
  await mkdir(path.dirname(timelinePath), { recursive: true, mode: 0o700 });
  await appendJsonl(timelinePath, []);
}

export async function finishDisposal(services: DisposableServices): Promise<void> {
  try {
    await services.scheduler.stop();
  } catch (error) {
    console.error("Scheduler shutdown failed", error);
  }
  try {
    await services.bridge.stop();
  } catch (error) {
    console.error("Host bridge shutdown failed", error);
  }
  try {
    await services.agents.disposeAll();
  } catch (error) {
    console.error("Agent shutdown failed", error);
  }
  for (const connector of services.connectors) {
    try {
      await connector.stop();
    } catch (error) {
      console.error("Connector shutdown failed", error);
    }
  }
  try {
    terminateActiveSandboxes();
  } catch (error) {
    console.error("Sandbox shutdown failed", error);
  }
}

async function createInstance(config: WorkspaceConfig, bwrapPath: string | undefined): Promise<WorkspaceInstance> {
  const paths = config.paths;
  await ensureTimeline(paths.timeline);
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.attachments, { recursive: true, mode: 0o700 });

  const telegramConfigs = config.connectors.filter((connector) => connector.type === "telegram");

  const timeline = new WorkspaceTimeline(path.resolve(paths.timeline));
  const resources = new WorkspaceResources(path.resolve(paths.resources));
  await timeline.start();
  await resources.start();

  const registry = new ConnectorRegistry();
  const connectors = telegramConfigs.map((connectorConfig) => new TelegramConnector(connectorConfig, timeline, resources));
  for (const connector of connectors) registry.register(connector);

  const credentials = new AgentCredentials();
  const hostSocketDir = path.resolve(paths.runDir);
  const agentManager = new AgentManager({ workspace: paths.workspace }, {
    appRoot: process.cwd(),
    credentials,
    notificationsPath: paths.notifications,
    connectorPrompt: (connectorId) => registry.prompt(connectorId),
    hostSocketDir,
    spawnProcess,
    terminateProcessGroup,
    ...(bwrapPath === undefined ? {} : { bwrapPath }),
    hostTimeline: path.resolve(paths.timeline),
    hostAttachments: path.resolve(paths.attachments),
  });
  for (const connector of connectors) connector.setAgent(agentManager);
  const router = new AgentEventRouter(agentManager, { workspace: paths.workspace, connectors: registry });
  timeline.subscribe((record, rawLine) => router.onEvent(record, rawLine));

  const outbox = new WorkspaceOutbox({ connectors: registry, timeline });
  const scheduler = new WorkspaceScheduler({
    schedulePath: paths.schedules,
    timeline,
  });
  const handlers = {
    send: (params: Record<string, unknown>, actor: AgentRef) => outbox.send(params.request, conversationActor(actor)),
    annotate: async (params: Record<string, unknown>) => ({
      occurrences: await timeline.annotateAttachment(stringField(params, "attachment"), stringField(params, "description")),
    }),
    steerConversation: async (params: Record<string, unknown>, actor: AgentRef) => {
      const source = conversationActor(actor);
      const target = registry.parseConversation(params.conversation);
      const message = stringField(params, "message").trim();
      await registry.authorizeConversation(target);
      if (message.length === 0) throw new Error("message must be a non-empty string");
      await agentManager.interrupt(`Conversation ${source.connectorId}/${source.conversationKey} delegated work to you:\n${message}`, target);
      return { status: "delivered" };
    },
    scheduleAdd: async (params: Record<string, unknown>, actor: AgentRef) => ({ schedule: await scheduler.add(params, conversationActor(actor)) }),
    scheduleReplace: async (params: Record<string, unknown>, actor: AgentRef) => ({ schedule: await scheduler.replace(params, conversationActor(actor)) }),
    scheduleRemove: async (params: Record<string, unknown>, actor: AgentRef) => ({ id: await scheduler.remove(params, conversationActor(actor)) }),
    scheduleTake: async (params: Record<string, unknown>, actor: AgentRef) => ({ schedule: await scheduler.take(params, conversationActor(actor)) }),
  };
  const bridge = new HostBridge({ socketPath: path.join(hostSocketDir, "host.sock"), credentials, handlers });
  return { config, agents: agentManager, scheduler, bridge, connectors };
}

export async function main(): Promise<void> {
  const config = await loadConfig();
  const sandbox = await checkSandboxEnvironment(config.dataDir);
  const instances = await Promise.all(config.workspaces.map((workspace) => createInstance(workspace, sandbox.bwrapPath)));

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`Received ${signal}; shutting down`);
      for (const instance of instances) await instance.agents.beginShutdown().catch((error) => console.error("Agent abort failed", error));
      for (const instance of instances) await finishDisposal(instance);
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    for (const instance of instances) {
      await instance.bridge.start();
      if (shuttingDown) return void await shutdown("startup interrupted");
      await instance.scheduler.start();
      if (shuttingDown) return void await shutdown("startup interrupted");
      await instance.agents.start();
      if (shuttingDown) return void await shutdown("startup interrupted");
    }
    const connectors = instances.flatMap((instance) => instance.connectors);
    console.log(`Starting ${connectors.length} connector(s) across ${instances.length} workspace(s)`);
    await Promise.all(connectors.map((connector) => connector.run()));
  } catch (error) {
    if (!(shuttingDown && isIntentionalSignalAbort(error))) throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
