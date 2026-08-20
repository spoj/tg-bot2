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
  /** Comma-separated host tool names exposed to the run (send, spawn, cancel). */
  hostTools?: string;
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
  /** Quiet window with no new input before a queue drains and combines; shared debounce for interrupts and followups. 0 drains immediately. */
  combineDebounceMs?: number;
  /** Hard cap on a burst: the active run is stopped this long after the first interrupt even if interrupts keep arriving. */
  interruptForceDrainMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type AgentStatus = {
  model?: { provider: string; id: string };
  thinkingLevel: string;
  sessionFile?: string;
  messageCount: number;
  autoCompactionEnabled: boolean;
  activeTasks?: number;
  activeSchedules?: number;
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
  interruptDebounceTimer: NodeJS.Timeout | undefined;
  interruptForceTimer: NodeJS.Timeout | undefined;
  followupDebounceTimer: NodeJS.Timeout | undefined;
  stopping: boolean;
};

const COMBINE_DEBOUNCE_MS = 2_000;
const INTERRUPT_FORCE_DRAIN_MS = 15_000;
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

async function readSessionSummary(sessionsDirectory: string): Promise<{
  messageCount: number;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string | undefined;
  sessionFile: string;
} | undefined> {
  const newestName = await newestSessionFile(sessionsDirectory);
  if (!newestName) return undefined;
  try {
    const raw = await readFile(path.join(sessionsDirectory, newestName), "utf8");
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
    return { messageCount, model, thinkingLevel, sessionFile: newestName };
  } catch {
    return undefined;
  }
}

async function newestSessionFile(sessionsDirectory: string): Promise<string | undefined> {
  try {
    const entries = await readdir(sessionsDirectory, { withFileTypes: true });
    let newest: { name: string; mtimeMs: number } | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
      const fileStat = await stat(path.join(sessionsDirectory, entry.name));
      if (!newest || fileStat.mtimeMs > newest.mtimeMs) newest = { name: entry.name, mtimeMs: fileStat.mtimeMs };
    }
    return newest?.name;
  } catch {
    return undefined;
  }
}

async function countActiveTasks(workspace: string): Promise<number | undefined> {
  try {
    const taskEntries = await readdir(path.join(workspace, ".pi", "tasks"), { withFileTypes: true });
    let activeTasks = 0;
    for (const entry of taskEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        await stat(path.join(workspace, ".pi", "tasks", entry.name, "result.json"));
      } catch {
        activeTasks += 1;
      }
    }
    return activeTasks;
  } catch {
    // .pi/tasks directory absent or unreadable
    return undefined;
  }
}

async function countActiveSchedules(workspace: string): Promise<number | undefined> {
  try {
    const rawSchedules = await readFile(path.join(workspace, TG_BOT_DIR, "schedules.json"), "utf8");
    const parsedSchedules = JSON.parse(rawSchedules) as { schedules?: unknown[] };
    if (!Array.isArray(parsedSchedules.schedules)) return undefined;
    return parsedSchedules.schedules.length;
  } catch {
    // schedules.json absent or invalid
    return undefined;
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
  private readonly combineDebounceMs: number;
  private readonly interruptForceDrainMs: number;
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
    const debounceMs = options.combineDebounceMs ?? COMBINE_DEBOUNCE_MS;
    const forceMs = options.interruptForceDrainMs ?? INTERRUPT_FORCE_DRAIN_MS;
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > MAX_TIMER_MS) {
      throw new Error("Combine debounce window must be a non-negative timer-safe integer");
    }
    if (!Number.isSafeInteger(forceMs) || forceMs < 0 || forceMs > MAX_TIMER_MS || forceMs < debounceMs) {
      throw new Error("Interrupt force drain window must be a timer-safe integer at least the debounce window");
    }
    this.combineDebounceMs = debounceMs;
    this.interruptForceDrainMs = forceMs;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRunWorker({
      ...workerOptions,
      spawnProcess: this.spawnProcess,
      terminateProcessGroup: this.terminateProcessGroup,
      ...defined({ stopGraceMs: this.stopGraceMs }),
    }));
  }

  /**
   * Queues a followup — a note to deliver after the current work. Followups never
   * abort a run: they wait until the run settles with no interrupts pending, or
   * until the agent is idle, and are then combined into one message. Idle
   * followups wait out the debounce window to batch; there is no force drain.
   */
  followup(chatId: number, text: string): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error("Agent manager is shutting down"));
    const state = this.state(chatId);
    return state.serial.run(async () => {
      await this.loadActivity(state);
      if (state.closing || this.shuttingDown) throw new Error("Agent manager is shutting down");
      state.followups.push(text);
      if (state.running || state.interrupts.length > 0) return;
      this.restartFollowupDebounceTimer(state);
    });
  }
  /**
   * Queues an interrupt. The queue drains — aborting the active run (or just
   * launching when idle) and delivering every queued interrupt as one combined
   * message — when no interrupt has arrived for the debounce window, when the
   * oldest queued interrupt has waited the force-drain window, or when the
   * active run settles. Queued followups are preserved behind interrupts.
   */
  interrupt(chatId: number, text: string): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error("Agent manager is shutting down"));
    const state = this.state(chatId);
    return state.serial.run(async () => {
      await this.loadActivity(state);
      if (state.closing || this.shuttingDown) throw new Error("Agent manager is shutting down");
      state.interrupts.push(text);
      this.clearFollowupDebounceTimer(state);
      if (state.stopping) return;
      if (state.interruptForceTimer === undefined) {
        state.interruptForceTimer = this.setTimeoutFn(() => this.fireInterruptDrain(state), this.interruptForceDrainMs);
        state.interruptForceTimer.unref?.();
      }
      this.restartInterruptDebounceTimer(state);
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
    const session = await readSessionSummary(sessionsDirectory);
    if (session) {
      result = {
        ...defined({ model: session.model }),
        thinkingLevel: session.thinkingLevel ?? result.thinkingLevel,
        sessionFile: session.sessionFile,
        messageCount: session.messageCount,
        autoCompactionEnabled: result.autoCompactionEnabled,
      };
    }
    const settingsProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const settingsModel = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    if (!result.model && settingsProvider && settingsModel) {
      result = { ...result, model: { provider: settingsProvider, id: settingsModel } };
    }
    const activeTasks = await countActiveTasks(workspace);
    if (activeTasks !== undefined) result = { ...result, activeTasks };
    const activeSchedules = await countActiveSchedules(workspace);
    if (activeSchedules !== undefined) result = { ...result, activeSchedules };
    return result;
  }

  /** Synchronous gate: terminates every active run. */
  beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    const stops = [...this.states.values()].flatMap((state) => {
      this.clearInterruptTimers(state);
      this.clearFollowupDebounceTimer(state);
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
      interruptDebounceTimer: undefined,
      interruptForceTimer: undefined,
      followupDebounceTimer: undefined,
      stopping: false,
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
    void this.runToCompletion(state, text);
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
    this.clearInterruptTimers(state);
    this.clearFollowupDebounceTimer(state);
    state.running = false;
    state.worker = undefined;
    state.stopping = false;
    state.lastActivityAt = this.now();
    await this.persistActivity(state);
    const next = this.drainInterrupts(state) ?? this.drainFollowups(state);
    if (next === undefined || state.closing || this.shuttingDown) return;
    this.launch(state, next);
  }

  /** Drain conditions 1–2: abort the active run, or combine and launch when idle. */
  private fireInterruptDrain(state: ChatState): void {
    this.clearInterruptTimers(state);
    if (state.running) {
      const worker = state.worker;
      if (!worker) return;
      state.stopping = true;
      void worker.stop().catch((error) => console.error("Agent interrupt failed", error));
      return;
    }
    const combined = this.drainInterrupts(state);
    if (combined !== undefined) this.launch(state, combined);
  }

  /** Combines the entire interrupt queue into one message and empties it. */
  private drainInterrupts(state: ChatState): string | undefined {
    if (state.interrupts.length === 0) return undefined;
    const combined = state.interrupts.join("\n");
    state.interrupts.length = 0;
    return combined;
  }

  /** Combines the entire followup queue into one message and empties it. */
  private drainFollowups(state: ChatState): string | undefined {
    if (state.followups.length === 0) return undefined;
    const combined = state.followups.join("\n");
    state.followups.length = 0;
    return combined;
  }

  /** Followup debounce: idle only, no force cap; delivers combined followups once the agent is idle with no interrupts pending. */
  private fireFollowupDrain(state: ChatState): void {
    this.clearFollowupDebounceTimer(state);
    if (state.running || state.interrupts.length > 0) return;
    const combined = this.drainFollowups(state);
    if (combined !== undefined) this.launch(state, combined);
  }

  private clearFollowupDebounceTimer(state: ChatState): void {
    if (state.followupDebounceTimer === undefined) return;
    this.clearTimeoutFn(state.followupDebounceTimer);
    state.followupDebounceTimer = undefined;
  }

  private restartFollowupDebounceTimer(state: ChatState): void {
    if (state.followupDebounceTimer !== undefined) this.clearTimeoutFn(state.followupDebounceTimer);
    state.followupDebounceTimer = this.setTimeoutFn(() => this.fireFollowupDrain(state), this.combineDebounceMs);
    state.followupDebounceTimer.unref?.();
  }

  private clearInterruptTimers(state: ChatState): void {
    if (state.interruptDebounceTimer !== undefined) this.clearTimeoutFn(state.interruptDebounceTimer);
    if (state.interruptForceTimer !== undefined) this.clearTimeoutFn(state.interruptForceTimer);
    state.interruptDebounceTimer = undefined;
    state.interruptForceTimer = undefined;
  }

  private restartInterruptDebounceTimer(state: ChatState): void {
    if (state.interruptDebounceTimer !== undefined) this.clearTimeoutFn(state.interruptDebounceTimer);
    state.interruptDebounceTimer = this.setTimeoutFn(() => this.fireInterruptDrain(state), this.combineDebounceMs);
    state.interruptDebounceTimer.unref?.();
  }
  private async spawnWorker(state: ChatState, text: string): Promise<AgentRunWorker> {
    const workspace = chatPaths(this.config.dataDir, state.chatId).workspace;
    const { resume, model, thinkingLevel } = await this.runOptions(state, workspace);
    return await this.workerFactory({
      workspace,
      appRoot: this.appRoot,
      ...defined({ bwrapPath: this.bwrapPath }),
      appendSystemPrompt: SYSTEM_PROMPT,
      hostTools: "send,spawn,cancel",
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