import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiRunWorker, type PiRunResult } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import type { Config } from "./config.js";
import { SerialQueue } from "./queue.js";
import { TG_BOT_DIR, chatPaths, defined } from "./util.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import { EVENTS_PROMPT } from "./events.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";
import { TASKS_PROMPT } from "./task-protocol.js";

export const SYSTEM_PROMPT = [
`You are a persistent personal agent reached through Telegram.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available.
Install optional project-local extensions with pi install npm:<package> -l --approve, pi install https://... -l --approve, pi install git:... -l --approve, or pi install ./... -l --approve. Use pi list --approve to inspect them. Project settings are stored at /workspace/.pi/settings.json. Settings and extension changes take effect on your next run.
`,
  OUTBOX_PROMPT,
  EVENTS_PROMPT,
  SCHEDULES_PROMPT,
  TASKS_PROMPT,
  `Keep Telegram-facing answers concise unless the user asks for detail.
/status is a host command that reports your current model, thinking level, and session summary.
Choose your model and thinking level by editing /workspace/.pi/agent/settings.json (defaultProvider, defaultModel, defaultThinkingLevel); new values apply from your next run. Edit the file atomically because a malformed settings file breaks the next run.
Your session resumes across runs for up to two hours of inactivity; after a longer gap the next run starts fresh. To reset your context deliberately, touch /workspace/.tg-bot/new-session (any empty file) and the next run starts fresh.
Older conversations persist under /workspace/.pi/sessions/*.jsonl — read/grep them when the user references history.
`,
].join("");

export type AgentRunWorker = {
  run(): Promise<PiRunResult>;
  stop(): Promise<void>;
};

export type AgentWorkerOptions = {
  workspace: string;
  appRoot: string;
  bwrapPath?: string;
  appendSystemPrompt?: string;
  message: string;
  resume: boolean;
  model?: string;
  thinkingLevel?: string;
};

export type AgentWorkerFactory = (options: AgentWorkerOptions) => AgentRunWorker | Promise<AgentRunWorker>;

export type AgentManagerOptions = {
  appRoot: string;
  bwrapPath?: string;
  workerFactory?: AgentWorkerFactory;
  /** Process-control seams injected by the composition root; the default worker factory passes them to the Pi run worker. */
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  now?: () => number;
  /** Quiet window absorbing interrupt bursts into one worker stop; 0 disables it. */
  interruptCoalesceMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type AgentStatus = {
  model?: { provider: string; id: string };
  thinkingLevel: string;
  sessionFile?: string;
  messageCount: number;
  autoCompactionEnabled: boolean;
};

type ChatState = {
  chatId: number;
  serial: SerialQueue;
  worker: AgentRunWorker | undefined;
  running: boolean;
  followups: string[];
  interrupts: string[];
  lastActivityAt: number;
  activityLoaded: boolean;
  closing: boolean;
  interruptTimer: NodeJS.Timeout | undefined;
};

const INTERRUPT_COALESCE_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;
const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
const NEW_SESSION_MARKER = path.join(TG_BOT_DIR, "new-session");
const ACTIVITY_FILE = "activity.json";

const USER_SETTINGS_RELATIVE_PATH = path.join(".pi", "agent", "settings.json");

export async function loadUserSettings(workspace: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(workspace, USER_SETTINGS_RELATIVE_PATH), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class AgentManager {
  private readonly states = new Map<number, ChatState>();
  private readonly workerFactory: AgentWorkerFactory;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly spawnProcess: PiWorkerSpawn;
  private readonly terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  private readonly stopGraceMs: number | undefined;
  private readonly now: () => number;
  private readonly interruptCoalesceMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private shuttingDown = false;

  constructor(private readonly config: Pick<Config, "dataDir">, options: AgentManagerOptions) {
    this.appRoot = path.resolve(options.appRoot);
    this.bwrapPath = options.bwrapPath;
    this.spawnProcess = options.spawnProcess;
    this.terminateProcessGroup = options.terminateProcessGroup;
    this.stopGraceMs = options.stopGraceMs;
    this.now = options.now ?? Date.now;
    const coalesceMs = options.interruptCoalesceMs ?? INTERRUPT_COALESCE_MS;
    if (!Number.isSafeInteger(coalesceMs) || coalesceMs < 0 || coalesceMs > MAX_TIMER_MS) {
      throw new Error("Interrupt coalesce window must be a non-negative timer-safe integer");
    }
    this.interruptCoalesceMs = coalesceMs;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRunWorker({
      ...workerOptions,
      spawnProcess: this.spawnProcess,
      terminateProcessGroup: this.terminateProcessGroup,
      ...defined({ stopGraceMs: this.stopGraceMs }),
    }));
  }

  /** Queues a message behind the active run, or starts one when idle. */
  followup(chatId: number, text: string): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error("Agent manager is shutting down"));
    const state = this.state(chatId);
    return state.serial.run(async () => {
      await this.loadActivity(state);
      if (state.closing || this.shuttingDown) throw new Error("Agent manager is shutting down");
      if (state.running) {
        state.followups.push(text);
        return;
      }
      this.launch(state, text);
    });
  }

  /** Terminates the active run and starts one immediately with text; queued followups are preserved. Interrupts arriving within the coalesce window join one stop. */
  interrupt(chatId: number, text: string): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error("Agent manager is shutting down"));
    const state = this.state(chatId);
    return state.serial.run(async () => {
      await this.loadActivity(state);
      if (state.closing || this.shuttingDown) throw new Error("Agent manager is shutting down");
      state.interrupts.push(text);
      if (!state.running) {
        this.launch(state, state.interrupts.shift()!);
        return;
      }
      if (state.interruptTimer !== undefined) return;
      const worker = state.worker;
      if (!worker) return;
      state.interruptTimer = this.setTimeoutFn(() => {
        state.interruptTimer = undefined;
        void worker.stop().catch((error) => console.error("Agent interrupt failed", error));
      }, this.interruptCoalesceMs);
      state.interruptTimer.unref?.();
    });
  }

  /** File-based session summary; never spawns a worker. */
  async status(chatId: number): Promise<AgentStatus> {
    const workspace = chatPaths(this.config.dataDir, chatId).workspace;
    const settings = await loadUserSettings(workspace);
    const sessionsDirectory = path.join(workspace, ".pi", "sessions");
    let result: AgentStatus = {
      thinkingLevel: typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "off",
      messageCount: 0,
      autoCompactionEnabled: (settings.autoCompaction as { enabled?: unknown } | undefined)?.enabled !== false,
    };
    try {
      const entries = await readdir(sessionsDirectory, { withFileTypes: true });
      let newest: { name: string; mtimeMs: number } | undefined;
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
        const fileStat = await stat(path.join(sessionsDirectory, entry.name));
        if (!newest || fileStat.mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs: fileStat.mtimeMs };
      }
      if (newest) {
        const raw = await readFile(path.join(sessionsDirectory, newest.name), "utf8");
        let messageCount = 0;
        let model: { provider: string; id: string } | undefined;
        let thinkingLevel: string | undefined;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
          const record = entry as Record<string, unknown>;
          if (record.type === "message") messageCount += 1;
          else if (record.type === "model_change" && typeof record.provider === "string" && typeof record.modelId === "string") {
            model = { provider: record.provider, id: record.modelId };
          } else if (record.type === "thinking_level_change" && typeof record.thinkingLevel === "string") {
            thinkingLevel = record.thinkingLevel;
          }
        }
        result = {
          ...defined({ model: model ?? result.model }),
          thinkingLevel: thinkingLevel ?? result.thinkingLevel,
          sessionFile: newest.name,
          messageCount,
          autoCompactionEnabled: result.autoCompactionEnabled,
        };
      }
    } catch {
      // A missing or unreadable sessions directory just reports defaults.
    }
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    if (!result.model && settingsProvider && settingsModel) {
      result = { ...result, model: { provider: settingsProvider, id: settingsModel } };
    }
    return result;
  }

  /** Synchronous gate: terminates every active run. */
  beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    const stops = [...this.states.values()].flatMap((state) => {
      this.clearInterruptTimer(state);
      const worker = state.worker;
      if (!worker) return [];
      return [worker.stop().catch((error) => console.error("Agent shutdown stop failed", error))];
    });
    return Promise.allSettled(stops).then(() => {});
  }

  async disposeAll(): Promise<void> {
    await this.beginShutdown();
  }


  private state(chatId: number): ChatState {
    const existing = this.states.get(chatId);
    if (existing) return existing;
    const state: ChatState = {
      chatId,
      serial: new SerialQueue(),
      worker: undefined,
      running: false,
      followups: [],
      interrupts: [],
      lastActivityAt: 0,
      activityLoaded: false,
      closing: false,
      interruptTimer: undefined,
    };
    this.states.set(chatId, state);
    return state;
  }

  private async loadActivity(state: ChatState): Promise<void> {
    if (state.activityLoaded) return;
    state.activityLoaded = true;
    try {
      const raw = await readFile(this.activityPath(state.chatId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const at = (parsed as Record<string, unknown>).at;
        if (typeof at === "number" && Number.isSafeInteger(at)) state.lastActivityAt = at;
      }
    } catch {
      // Missing or malformed activity records start with a fresh session.
    }
  }

  private activityPath(chatId: number): string {
    return path.join(this.config.dataDir, "chats", String(chatId), ACTIVITY_FILE);
  }

  private async persistActivity(state: ChatState): Promise<void> {
    const file = this.activityPath(state.chatId);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify({ at: state.lastActivityAt }), { encoding: "utf8", mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      console.error("Agent activity persistence failed", error);
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  /** Starts a run for text; must be called with the state's serial queue held. */
  private launch(state: ChatState, text: string): void {
    state.running = true;
    const run = this.runToCompletion(state, text);
    void run;
  }

  private async runToCompletion(state: ChatState, text: string): Promise<void> {
    try {
      const worker = await this.spawnWorker(state, text);
      state.worker = worker;
      const result = await worker.run();
      if (result.signal === null && result.code !== 0) {
        console.error(`Agent run failed (exit ${result.code ?? "unknown"}): ${result.stderr}`);
      }
    } catch (error) {
      console.error("Agent run failed", error);
    } finally {
      await state.serial.run(async () => { this.onRunSettled(state); });
    }
  }

  private async onRunSettled(state: ChatState): Promise<void> {
    this.clearInterruptTimer(state);
    state.running = false;
    state.worker = undefined;
    state.lastActivityAt = this.now();
    await this.persistActivity(state);
    const next = state.interrupts.shift() ?? state.followups.shift();
    if (next === undefined || state.closing || this.shuttingDown) return;
    this.launch(state, next);
  }

  private clearInterruptTimer(state: ChatState): void {
    if (state.interruptTimer === undefined) return;
    this.clearTimeoutFn(state.interruptTimer);
    state.interruptTimer = undefined;
  }

  private async spawnWorker(state: ChatState, text: string): Promise<AgentRunWorker> {
    const workspace = chatPaths(this.config.dataDir, state.chatId).workspace;
    const { resume, model, thinkingLevel } = await this.runOptions(state, workspace);
    return await this.workerFactory({
      workspace,
      appRoot: this.appRoot,
      ...defined({ bwrapPath: this.bwrapPath }),
      appendSystemPrompt: SYSTEM_PROMPT,
      message: text,
      resume,
      ...defined({ model, thinkingLevel }),
    });
  }

  /** Resume unless a fresh-start marker exists or the resume window has closed. */
  private async runOptions(state: ChatState, workspace: string): Promise<{
    resume: boolean;
    model?: string;
    thinkingLevel?: string;
  }> {
    const marker = path.join(workspace, NEW_SESSION_MARKER);
    let freshStart = false;
    try {
      await stat(marker);
      freshStart = true;
      await rm(marker, { force: true });
    } catch {
      // No marker: resume normally within the window.
    }
    const resume = !freshStart && this.now() - state.lastActivityAt <= RESUME_WINDOW_MS;
    const settings = await loadUserSettings(workspace);
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const modelId = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    const model = provider && modelId ? `${provider}/${modelId}` : undefined;
    const thinkingLevel = typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined;
    return { resume, ...defined({ model, thinkingLevel }) };
  }
}