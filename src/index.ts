import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentEventRouter, AgentManager } from "./agent.js";
import { type AgentRef, type ConversationAgentRef } from "./agent-ref.js";
import { loadConfig, type AppConfig, type WorkspaceConfig } from "./config.js";
import { ConnectorRegistry } from "./connector.js";
import { WorkspaceTimeline } from "./events.js";
import { AgentCredentials, HostBridge } from "./host-bridge.js";
import { WorkspaceOutbox } from "./outbox.js";
import { WorkspaceResources } from "./resource-state.js";
import { checkSandboxEnvironment, spawnProcess, terminateActiveSandboxes, terminateProcessGroup } from "./sandbox.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { TelegramConnector } from "./telegram-connector.js";
import { appendJsonl, connectorPathSegment, workspacePaths } from "./util.js";

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
async function disposePartial(services: {
  agents: Pick<AgentManager, "disposeAll"> | undefined;
  scheduler: Pick<WorkspaceScheduler, "stop"> | undefined;
  bridge: Pick<HostBridge, "stop"> | undefined;
  connectors: Array<Pick<TelegramConnector, "stop">>;
}): Promise<void> {
  if (services.scheduler) {
    try { await services.scheduler.stop(); }
    catch (error) { console.error("Scheduler startup cleanup failed", error); }
  }
  if (services.bridge) {
    try { await services.bridge.stop(); }
    catch (error) { console.error("Host bridge startup cleanup failed", error); }
  }
  if (services.agents) {
    try { await services.agents.disposeAll(); }
    catch (error) { console.error("Agent startup cleanup failed", error); }
  }
  for (const connector of services.connectors) {
    try { await connector.stop(); }
    catch (error) { console.error("Connector startup cleanup failed", error); }
  }
}

function canonicalConfig(config: AppConfig, dataDir: string): AppConfig {
  return {
    dataDir,
    workspaces: config.workspaces.map((workspace) => {
      const paths = workspacePaths(dataDir, workspace.id);
      const connectors = workspace.connectors.map((connector) => {
        const attachmentPrefix = connectorPathSegment(connector.id);
        return {
          ...connector,
          dataDir,
          workspace: paths.workspace,
          attachments: path.join(paths.attachments, attachmentPrefix),
          attachmentPrefix,
        };
      });
      return { ...workspace, paths, connectors };
    }),
  };
}

async function disposeInstances(instances: readonly WorkspaceInstance[]): Promise<void> {
  for (const instance of instances) {
    await instance.agents.beginShutdown().catch((error) => console.error("Agent abort failed", error));
  }
  for (const instance of instances) await finishDisposal(instance);
}

async function createInstance(config: WorkspaceConfig, bwrapPath: string | undefined): Promise<WorkspaceInstance> {
  const paths = config.paths;
  const connectors: TelegramConnector[] = [];
  let agentManager: AgentManager | undefined;
  let scheduler: WorkspaceScheduler | undefined;
  let bridge: HostBridge | undefined;
  try {
    await ensureTimeline(paths.timeline);
    await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.attachments, { recursive: true, mode: 0o700 });

    const telegramConfigs = config.connectors.filter((connector) => connector.type === "telegram");

    const timeline = new WorkspaceTimeline(path.resolve(paths.timeline));
    const resources = new WorkspaceResources(path.resolve(paths.resources));
    await timeline.start();
    await resources.start();

    const registry = new ConnectorRegistry();
    for (const connectorConfig of telegramConfigs) {
      const connector = new TelegramConnector(connectorConfig, timeline, resources);
      connectors.push(connector);
      registry.register(connector);
    }

    const credentials = new AgentCredentials();
    const hostSocketDir = path.resolve(paths.runDir);
    const agents = new AgentManager({ workspace: paths.workspace }, {
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
    agentManager = agents;
    for (const connector of connectors) connector.setAgent(agents);
    const router = new AgentEventRouter(agents, { workspace: paths.workspace, connectors: registry });
    timeline.subscribe((record, rawLine) => router.onEvent(record, rawLine));

    const outbox = new WorkspaceOutbox({ connectors: registry, timeline });
    const runtimeScheduler = new WorkspaceScheduler({
      schedulePath: paths.schedules,
      timeline,
    });
    scheduler = runtimeScheduler;
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
        await agents.interrupt(`Conversation ${source.connectorId}/${source.conversationKey} delegated work to you:\n${message}`, target);
        return { status: "delivered" };
      },
      scheduleAdd: async (params: Record<string, unknown>, actor: AgentRef) => ({ schedule: await runtimeScheduler.add(params, conversationActor(actor)) }),
      scheduleReplace: async (params: Record<string, unknown>, actor: AgentRef) => ({ schedule: await runtimeScheduler.replace(params, conversationActor(actor)) }),
      scheduleRemove: async (params: Record<string, unknown>, actor: AgentRef) => ({ id: await runtimeScheduler.remove(params, conversationActor(actor)) }),
      scheduleTake: async (params: Record<string, unknown>, actor: AgentRef) => ({ schedule: await runtimeScheduler.take(params, conversationActor(actor)) }),
    };
    const runtimeBridge = new HostBridge({ socketPath: path.join(hostSocketDir, "host.sock"), credentials, handlers });
    bridge = runtimeBridge;
    return { config, agents, scheduler: runtimeScheduler, bridge: runtimeBridge, connectors };
  } catch (error) {
    await disposePartial({ agents: agentManager, scheduler, bridge, connectors });
    throw error;
  }

}
export async function main(): Promise<void> {
  const loadedConfig = await loadConfig();
  const sandbox = await checkSandboxEnvironment(loadedConfig.dataDir);
  const config = canonicalConfig(loadedConfig, sandbox.dataDir);
  const instances: WorkspaceInstance[] = [];

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`Received ${signal}; shutting down`);
      await disposeInstances(instances);
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    for (const workspace of config.workspaces) {
      const instance = await createInstance(workspace, sandbox.bwrapPath);
      if (shuttingDown) {
        await instance.agents.beginShutdown().catch((error) => console.error("Agent abort failed", error));
        await finishDisposal(instance);
        await shutdownPromise;
        return;
      }
      instances.push(instance);
    }
    for (const instance of instances) {
      await instance.bridge.start();
      if (shuttingDown) return void await shutdown("startup interrupted");
      await instance.agents.start();
      if (shuttingDown) return void await shutdown("startup interrupted");
      await instance.scheduler.start();
      if (shuttingDown) return void await shutdown("startup interrupted");
    }
    const connectors = instances.flatMap((instance) => instance.connectors);
    console.log(`Starting ${connectors.length} connector(s) across ${instances.length} workspace(s)`);
    await Promise.all(connectors.map((connector) => connector.run()));
    if (shuttingDown) await shutdown("startup interrupted");
  } catch (error) {
    if (shuttingDown) {
      await shutdownPromise;
      if (isIntentionalSignalAbort(error)) return;
      throw error;
    }
    shuttingDown = true;
    shutdownPromise = disposeInstances(instances);
    await shutdownPromise;
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
