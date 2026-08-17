import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiRpcWorker, type AvailableModel, type WorkerSessionState } from "./pi-worker.js";
import type { Config } from "./config.js";
import { chatPaths } from "./config.js";
import { SerialQueue } from "./queue.js";

export const SYSTEM_PROMPT = `You are a persistent personal agent reached through Telegram.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available.
Install optional project-local extensions with pi install npm:<package> -l --approve, pi install https://... -l --approve, pi install git:... -l --approve, or pi install ./... -l --approve. Use pi list --approve to inspect them. Project settings are stored at /workspace/.pi/settings.json. Extension changes are debounced and automatically reloaded after the current turn.
To send a file through Telegram, write a send_file request under the root
/workspace/.tg-bot/outbox/. The request object is
{version:1,id,type:"send_file",path,caption?}; id must be unique and path must
identify the file to send. Write the request to a temporary filename that does not
end in .json, then atomically rename it to the final unique *.json request name.
Schedules are stored in /workspace/.tg-bot/schedules.json. Its root object is
{version:1,schedules:[...]}. Each schedule record requires id, prompt, dueAt,
recurrence, enabled, lastRunAt, and runCount. dueAt must be a UTC timestamp ending
in Z; recurrence must be hourly, daily, weekly, or null; enabled is a boolean;
lastRunAt is nullable and, when present, must be a UTC timestamp ending in Z; and
runCount must be a nonnegative integer.
Keep Telegram-facing answers concise unless the user asks for detail.
Host commands /model, /thinking, /status, and /restart manage configuration; do not edit .pi config files yourself.
Every worker start begins a fresh session; previous conversations persist in /workspace/.pi/sessions/*.jsonl and the agent should read/grep them when the user references history.
`;

export function extractFinalAssistantText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!candidate || candidate.role !== "assistant") continue;
    if (typeof candidate.content === "string") return candidate.content.trim() || undefined;
    if (Array.isArray(candidate.content)) {
      const text = candidate.content
        .filter((block): block is { type: "text"; text: string } =>
          !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
      return text || undefined;
    }
    return undefined;
  }
  return undefined;
}

export type PromptMode = "interactive" | "follow-up";

export type AssistantProgressCallback = (chatId: number, text: string) => void | Promise<void>;

export type AgentEvent = Record<string, unknown>;

export type AgentWorker = {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  waitForSettled(): Promise<void>;
  getLastAssistantText(): Promise<string | undefined>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getAvailableModels(): Promise<AvailableModel[]>;
  getAvailableThinkingLevels(): Promise<string[]>;
  getSessionState(): Promise<WorkerSessionState>;
  restart(): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
};

export type AgentWorkerOptions = {
  workspace: string;
  appRoot: string;
  bwrapPath?: string;
  appendSystemPrompt?: string;
};

export type AgentWorkerFactory = (options: AgentWorkerOptions) => AgentWorker | Promise<AgentWorker>;

export type AgentManagerOptions = {
  appRoot: string;
  bwrapPath?: string;
  workerFactory?: AgentWorkerFactory;
  /** Bounds worker abort and active-run draining during shutdown. */
  shutdownTimeoutMs?: number;
};


type ChatState = {
  worker: AgentWorker | undefined;
  workerPromise: Promise<AgentWorker> | undefined;
  activeRun: Promise<string> | undefined;
  workerTurnActive: boolean;
  queue: SerialQueue;
  unsubscribe: (() => void) | undefined;
  progressTail: Promise<void>;
  invalidation: { worker: AgentWorker; completion: Promise<void> } | undefined;
  stoppedWorker: AgentWorker | undefined;
  closing: boolean;
  abortPromise: Promise<void> | undefined;
  shutdownSignal: Promise<void>;
  resolveShutdown: () => void;
  shutdownError: Error | undefined;
  lastActivityAt: number;
  idleStopTimer: NodeJS.Timeout | undefined;
};

type PromptAction =
  | { kind: "steer"; completion: Promise<void> }
  | { kind: "prompt"; completion: Promise<string> };

const NO_TEXT_RESPONSE = "I completed the turn but produced no text response.";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
export const WORKER_IDLE_STOP_MS = 2 * 60 * 60 * 1000;


function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const USER_SETTINGS_RELATIVE_PATH = path.join(".pi", "agent", "settings.json");

export async function loadUserSettings(workspace: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(workspace, USER_SETTINGS_RELATIVE_PATH), "utf8");
    return record(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

export async function writeUserSettings(workspace: string, patch: Record<string, unknown>): Promise<void> {
  const target = path.join(workspace, USER_SETTINGS_RELATIVE_PATH);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const merged = { ...(await loadUserSettings(workspace)), ...patch };
  const temporary = path.join(directory, `settings.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(merged, null, 2), "utf8");
  await rename(temporary, target);
}

export class AgentManager {
  private readonly states = new Map<number, ChatState>();
  private readonly workerFactory: AgentWorkerFactory;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private readonly shutdownTimeoutMs: number;
  private assistantProgress: AssistantProgressCallback | undefined;
  private shutdownAbort: Promise<void> | undefined;
  private shuttingDown = false;
  constructor(private readonly config: Pick<Config, "dataDir">, options: AgentManagerOptions) {
    this.appRoot = path.resolve(options.appRoot);
    this.bwrapPath = options.bwrapPath;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRpcWorker(workerOptions));
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 0) {
      throw new Error("shutdownTimeoutMs must be a non-negative integer");
    }
  }

  setAssistantProgress(callback: AssistantProgressCallback | undefined): void {
    this.assistantProgress = callback;
  }

  /** Synchronous gate closes ingress before abort RPCs complete. */
  beginShutdown(): Promise<void> {
    if (this.shuttingDown) return this.shutdownAbort ?? Promise.resolve();
    this.shuttingDown = true;
    const aborts = [...this.states.values()].map((state) => {
      state.closing = true;
      return this.requestAbort(state);
    });
    this.shutdownAbort = Promise.allSettled(aborts).then(() => {});
    return this.shutdownAbort;
  }

  private cancelState(state: ChatState, message: string): void {
    this.disarmIdleStop(state);
    if (state.shutdownError) return;
    state.shutdownError = new Error(message);
    state.resolveShutdown();
    if (state.worker) void this.invalidateWorker(state, state.worker).catch(() => {});
  }

  private raceShutdown<T>(state: ChatState, promise: Promise<T>): Promise<T> {
    if (state.shutdownError) return Promise.reject(state.shutdownError);
    return Promise.race([
      promise,
      state.shutdownSignal.then(() => {
        throw state.shutdownError ?? new Error("Agent manager is shutting down");
      }),
    ]);
  }

  private requestAbort(state: ChatState): Promise<void> {
    if (state.abortPromise) return state.abortPromise;
    const worker = state.worker;
    if (worker) {
      state.abortPromise = this.abortWorker(state, worker);
      return state.abortPromise;
    }
    const workerPromise = state.workerPromise;
    if (workerPromise) {
      let handled = false;
      const handle = async (startedWorker: AgentWorker): Promise<void> => {
        if (handled) return;
        handled = true;
        await this.abortWorker(state, startedWorker);
      };
      void workerPromise.then((startedWorker) => handle(startedWorker), () => {});
      state.abortPromise = bounded(workerPromise, this.shutdownTimeoutMs, "Agent worker startup timed out")
        .then((startedWorker) => handle(startedWorker), () => {});
      return state.abortPromise;
    }
    state.abortPromise = Promise.resolve();
    return state.abortPromise;
  }

  private async abortWorker(state: ChatState, worker: AgentWorker): Promise<void> {
    try {
      await bounded(worker.abort(), this.shutdownTimeoutMs, "Agent worker abort timed out");
    } catch {
      await bounded(
        this.invalidateWorker(state, worker),
        this.shutdownTimeoutMs,
        "Agent worker stop timed out",
      ).catch(() => {});
    }
  }

  private armIdleStop(state: ChatState): void {
    state.lastActivityAt = Date.now();
    clearTimeout(state.idleStopTimer);
    state.idleStopTimer = setTimeout(() => {
      void state.queue.run(async () => {
        if (state.closing || this.shuttingDown) return;
        if (Date.now() - state.lastActivityAt < WORKER_IDLE_STOP_MS) {
          this.armIdleStop(state);
          return;
        }
        if (state.activeRun || state.workerPromise || state.queue.size > 1) {
          this.armIdleStop(state);
          return;
        }
        if (state.worker) {
          await this.invalidateWorker(state, state.worker).catch(() => {});
        }
      });
    }, WORKER_IDLE_STOP_MS);
    state.idleStopTimer.unref?.();
  }

  private disarmIdleStop(state: ChatState): void {
    if (state.idleStopTimer) {
      clearTimeout(state.idleStopTimer);
      state.idleStopTimer = undefined;
    }
  }


  private state(chatId: number): ChatState {
    const existing = this.states.get(chatId);
    if (existing) return existing;

    let resolveShutdown!: () => void;
    const shutdownSignal = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const state: ChatState = {
      worker: undefined,
      workerPromise: undefined,
      activeRun: undefined,
      workerTurnActive: false,
      queue: new SerialQueue(),
      unsubscribe: undefined,
      progressTail: Promise.resolve(),
      invalidation: undefined,
      stoppedWorker: undefined,
      closing: false,
      abortPromise: undefined,
      shutdownSignal,
      resolveShutdown,
      shutdownError: undefined,
      lastActivityAt: Date.now(),
      idleStopTimer: undefined,
    };
    this.states.set(chatId, state);
    return state;
  }

  private ensureOpen(): void {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
  }

  private subscribeAssistantProgress(chatId: number, state: ChatState, worker: AgentWorker): void {
    state.unsubscribe?.();
    state.unsubscribe = worker.onEvent((event) => {
      if (event.type === "worker_error") {
        void this.invalidateWorker(state, worker).catch(() => {});
        return;
      }
      if (event.type !== "message_end") return;
      const message = record(event.message);
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
      const hasToolCall = message.content.some((block) => record(block)?.type === "toolCall");
      if (!hasToolCall) return;
      const text = extractFinalAssistantText([message]);
      const callback = this.assistantProgress;
      if (!text || !callback) return;
      state.progressTail = state.progressTail
        .then(() => callback(chatId, text))
        .catch(() => {});
    });
  }

  private invalidateWorker(state: ChatState, worker: AgentWorker): Promise<void> {
    const existing = state.invalidation;
    if (existing?.worker === worker) return existing.completion;
    if (state.stoppedWorker === worker) return Promise.resolve();

    let completion!: Promise<void>;
    completion = (async () => {
      if (state.worker === worker) {
        state.worker = undefined;
        state.unsubscribe?.();
        state.unsubscribe = undefined;
      }
      let stopped = false;
      try {
        await worker.stop();
        stopped = true;
      } finally {
        if (state.invalidation?.completion === completion) {
          state.invalidation = undefined;
          if (stopped) state.stoppedWorker = worker;
          else if (state.stoppedWorker === worker) state.stoppedWorker = undefined;
        }
      }
    })();
    state.invalidation = { worker, completion };
    return completion;
  }

  private async ensureWorker(chatId: number, state: ChatState): Promise<AgentWorker> {
    if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
    const priorInvalidation = state.invalidation;
    if (priorInvalidation) await priorInvalidation.completion.catch(() => {});
    if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
    if (state.worker) return state.worker;
    if (!state.workerPromise) {
      const paths = chatPaths(this.config.dataDir, chatId);
      const pending = (async () => {
        let worker: AgentWorker | undefined;
        let invalidated = false;
        try {
          worker = await this.workerFactory({
            workspace: paths.workspace,
            appRoot: this.appRoot,
            ...(this.bwrapPath === undefined ? {} : { bwrapPath: this.bwrapPath }),
            appendSystemPrompt: SYSTEM_PROMPT,
          });
          state.stoppedWorker = undefined;
          await worker.start();
          if (this.shuttingDown || state.closing) {
            invalidated = true;
            await this.invalidateWorker(state, worker).catch(() => {});
            throw new Error("Agent manager is shutting down");
          }
          state.worker = worker;
          this.subscribeAssistantProgress(chatId, state, worker);
          return worker;
        } catch (error) {
          if (worker && !invalidated && state.worker !== worker && state.invalidation?.worker !== worker) {
            await this.invalidateWorker(state, worker).catch(() => {});
          }
          throw error;
        }
      })();
      state.workerPromise = pending;
    }
    const pending = state.workerPromise;
    if (!pending) throw new Error("Pi worker startup was not scheduled");
    try {
      return await this.raceShutdown(state, pending);
    } finally {
      if (state.workerPromise === pending) state.workerPromise = undefined;
    }
  }

  private async drainProgress(state: ChatState): Promise<void> {
    while (true) {
      const tail = state.progressTail;
      await tail;
      if (tail === state.progressTail) return;
    }
  }
  private finishProgressDrain(state: ChatState): Promise<void> {
    const progress = this.drainProgress(state);
    return state.shutdownError
      ? bounded(progress, this.shutdownTimeoutMs, "Agent progress drain timed out").catch(() => {})
      : progress;
  }


  private beginRun(state: ChatState, worker: AgentWorker, command: () => Promise<void>): Promise<string> {
    let run!: Promise<string>;
    state.workerTurnActive = true;
    const operation = (async () => {
      try {
        await command();
        await worker.waitForSettled();
        // activeRun remains set while progress callbacks drain, but the worker turn
        // is no longer steerable once waitForSettled has completed.
        state.workerTurnActive = false;
        const result = (await worker.getLastAssistantText()) ?? NO_TEXT_RESPONSE;
        await this.drainProgress(state);
        return result;
      } finally {
        state.workerTurnActive = false;
      }
    })();
    run = (async () => {
      try {
        return await this.raceShutdown(state, operation);
      } catch (error) {
        await this.invalidateWorker(state, worker).catch(() => {});
        throw error;
      } finally {
        await this.finishProgressDrain(state);
        if (state.activeRun === run) state.activeRun = undefined;
      }
    })();
    state.activeRun = run;
    return run;
  }

  private steer(state: ChatState, worker: AgentWorker, text: string): Promise<void> {
    return this.raceShutdown(state, worker.steer(text)).catch(async (error) => {
      await this.invalidateWorker(state, worker).catch(() => {});
      throw error;
    });
  }

  async prompt(chatId: number, text: string, mode: PromptMode = "interactive"): Promise<string | undefined> {
    this.ensureOpen();
    const state = this.state(chatId);
    const action = await state.queue.run(async (): Promise<PromptAction> => {
      this.armIdleStop(state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      if (state.activeRun) {
        if (mode === "interactive" && state.workerTurnActive && state.worker) {
          return { kind: "steer", completion: this.steer(state, state.worker, text) };
        }
        await this.raceShutdown(state, state.activeRun).catch(() => {});
      }

      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const completion = this.beginRun(state, worker, () => worker.prompt(text));
      return { kind: "prompt", completion };
    });

    if (action.kind === "steer") {
      try {
        await action.completion;
      } finally {
        await this.finishProgressDrain(state);
      }
      return undefined;
    }
    return await action.completion;
  }

  newSession(chatId: number): Promise<void> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      this.armIdleStop(state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const activeRun = state.activeRun;
      if (activeRun) await this.raceShutdown(state, activeRun).catch(() => {});
      await this.raceShutdown(state, this.drainProgress(state)).catch(() => {});
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      try {
        await this.raceShutdown(state, worker.newSession());
      } catch (error) {
        await this.invalidateWorker(state, worker).catch(() => {});
        throw error;
      }
    });
  }

  setModel(chatId: number, provider: string, modelId: string): Promise<void> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      this.armIdleStop(state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      await this.raceShutdown(state, worker.setModel(provider, modelId));
      await writeUserSettings(chatPaths(this.config.dataDir, chatId).workspace, {
        defaultProvider: provider,
        defaultModel: modelId,
      });
    });
  }

  setThinkingLevel(chatId: number, level: string): Promise<void> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      this.armIdleStop(state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      await this.raceShutdown(state, worker.setThinkingLevel(level));
      await writeUserSettings(chatPaths(this.config.dataDir, chatId).workspace, {
        defaultThinkingLevel: level,
      });
    });
  }

  status(chatId: number): Promise<WorkerSessionState> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      return await this.raceShutdown(state, worker.getSessionState());
    });
  }

  getAvailableModels(chatId: number): Promise<AvailableModel[]> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      return await this.raceShutdown(state, worker.getAvailableModels());
    });
  }

  getAvailableThinkingLevels(chatId: number): Promise<string[]> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      return await this.raceShutdown(state, worker.getAvailableThinkingLevels());
    });
  }

  restart(chatId: number): Promise<void> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      this.armIdleStop(state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      const activeRun = state.activeRun;
      if (activeRun) await this.raceShutdown(state, activeRun).catch(() => {});
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      await this.raceShutdown(state, worker.restart());
    });
  }

  async disposeAll(abort = false): Promise<void> {
    const permanentlyClosed = this.shuttingDown;
    for (const state of this.states.values()) state.closing = true;

    while (true) {
      const states = [...this.states.values()];
      if (states.length === 0) break;
      for (const state of states) this.disarmIdleStop(state);

      if (abort) {
        await Promise.allSettled(states.map((state) => this.requestAbort(state)));
        await Promise.all(states.map(async (state) => {
          try {
            await bounded(state.queue.idle(), this.shutdownTimeoutMs, "Agent queue drain timed out");
          } catch {
            this.cancelState(state, "Agent manager shutdown timed out");
          }
        }));
        const activeRuns = states.flatMap((state) =>
          state.activeRun ? [{ state, run: state.activeRun }] : [],
        );
        await Promise.all(activeRuns.map(async ({ state, run }) => {
          const completed = run.then(() => false, () => false);
          try {
            await bounded(completed, this.shutdownTimeoutMs, "Agent worker run drain timed out");
          } catch {
            this.cancelState(state, "Agent worker run drain timed out");
          }
        }));
        break;
      }

      await Promise.allSettled(states.map((state) => state.queue.idle()));
      const activeRuns = states.map((state) => state.activeRun).filter(
        (run): run is Promise<string> => run !== undefined,
      );
      await Promise.allSettled(activeRuns);
      const current = [...this.states.values()];
      if (
        current.length === states.length &&
        current.every((state) => state.queue.size === 0 && !state.activeRun && !state.workerPromise)
      ) break;
    }
    while (true) {
      const states = [...this.states.values()];
      if (states.length === 0) break;
      for (const state of states) state.closing = true;
      for (const state of states) this.disarmIdleStop(state);
      await Promise.allSettled(states.map(async (state) => {
        if (abort) {
          await bounded(state.queue.idle(), this.shutdownTimeoutMs, "Agent queue drain timed out").catch(() => {});
        } else {
          await state.queue.idle().catch(() => {});
        }
        state.unsubscribe?.();
        state.unsubscribe = undefined;
        const invalidation = state.invalidation;
        if (invalidation) {
          if (abort) {
            await bounded(invalidation.completion, this.shutdownTimeoutMs, "Agent worker stop timed out").catch(() => {});
          } else {
            await invalidation.completion.catch(() => {});
          }
          return;
        }
        const worker = state.worker;
        if (!worker) return;
        if (abort) {
          await bounded(this.invalidateWorker(state, worker), this.shutdownTimeoutMs, "Agent worker stop timed out").catch(() => {});
        } else {
          await this.invalidateWorker(state, worker).catch(() => {});
        }
      }));
      const disposing = new Set(states);
      for (const [chatId, state] of this.states) {
        if (disposing.has(state)) this.states.delete(chatId);
      }
    }
    if (!permanentlyClosed) this.shuttingDown = false;
  }
}
