import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiRpcWorker, type AvailableModel, type WorkerSessionState } from "./pi-worker.js";
import type { PiWorkerChildProcess, PiWorkerSpawn } from "./sandbox.js";
import type { Config } from "./config.js";
import { SerialQueue } from "./queue.js";
import { chatPaths, defined, withTimeout } from "./util.js";
import { OUTBOX_PROMPT } from "./outbox-protocol.js";
import { EVENTS_PROMPT } from "./events.js";
import { SCHEDULES_PROMPT } from "./schedule-protocol.js";

export const SYSTEM_PROMPT = [
`You are a persistent personal agent reached through Telegram.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available.
Install optional project-local extensions with pi install npm:<package> -l --approve, pi install https://... -l --approve, pi install git:... -l --approve, or pi install ./... -l --approve. Use pi list --approve to inspect them. Project settings are stored at /workspace/.pi/settings.json. Extension changes are debounced and automatically reloaded after the current turn.
`,
  OUTBOX_PROMPT,
  EVENTS_PROMPT,
  SCHEDULES_PROMPT,
  `Keep Telegram-facing answers concise unless the user asks for detail.
Host commands /model, /thinking, /status, and /restart manage configuration; do not edit .pi config files yourself.
Every worker start begins a fresh session; previous conversations persist in /workspace/.pi/sessions/*.jsonl and the agent should read/grep them when the user references history.
`,
].join("");

export type PromptMode = "interactive" | "follow-up";

export type AgentEvent = Record<string, unknown>;

export type AgentWorker = {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  prompt(message: string): Promise<void>;
  waitForSettled(): Promise<void>;
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
  /** Process-control seams injected by the composition root; the default worker factory passes them to the Pi worker. */
  spawnProcess: PiWorkerSpawn;
  terminateProcessGroup: (child: PiWorkerChildProcess, signal: NodeJS.Signals) => void;
  /** Bounds worker abort and active-run draining during shutdown. */
  shutdownTimeoutMs?: number;
};


type ChatState = {
  worker: AgentWorker | undefined;
  workerPromise: Promise<AgentWorker> | undefined;
  activeRun: Promise<void> | undefined;
  workerTurnActive: boolean;
  queue: SerialQueue;
  unsubscribe: (() => void) | undefined;
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

export const WORKER_IDLE_STOP_MS = 2 * 60 * 60 * 1000;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

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
  private shutdownAbort: Promise<void> | undefined;
  private shuttingDown = false;
  constructor(private readonly config: Pick<Config, "dataDir">, options: AgentManagerOptions) {
    this.appRoot = path.resolve(options.appRoot);
    this.bwrapPath = options.bwrapPath;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRpcWorker({
      ...workerOptions,
      spawn: options.spawnProcess,
      terminateProcessGroup: options.terminateProcessGroup,
    }));
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 0) {
      throw new Error("shutdownTimeoutMs must be a non-negative integer");
    }
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
        throw state.shutdownError;
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
      state.abortPromise = withTimeout(workerPromise, this.shutdownTimeoutMs, () => new Error("Agent worker startup timed out"))
        .then((startedWorker) => handle(startedWorker), () => {});
      return state.abortPromise;
    }
    state.abortPromise = Promise.resolve();
    return state.abortPromise;
  }

  private async abortWorker(state: ChatState, worker: AgentWorker): Promise<void> {
    try {
      await withTimeout(worker.abort(), this.shutdownTimeoutMs, () => new Error("Agent worker abort timed out"));
    } catch {
      await withTimeout(
        this.invalidateWorker(state, worker),
        this.shutdownTimeoutMs,
        () => new Error("Agent worker stop timed out"),
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

  private subscribeWorkerErrors(state: ChatState, worker: AgentWorker): void {
    state.unsubscribe?.();
    state.unsubscribe = worker.onEvent((event) => {
      if (event.type === "worker_error") {
        void this.invalidateWorker(state, worker).catch(() => {});
      }
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
            ...defined({ bwrapPath: this.bwrapPath }),
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
          this.subscribeWorkerErrors(state, worker);
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
    try {
      return await this.raceShutdown(state, pending);
    } finally {
      if (state.workerPromise === pending) state.workerPromise = undefined;
    }
  }

  private beginRun(state: ChatState, worker: AgentWorker, command: () => Promise<void>): Promise<void> {
    let run!: Promise<void>;
    state.workerTurnActive = true;
    const operation = (async () => {
      try {
        await command();
        await worker.waitForSettled();
        // activeRun remains set until the run resolves; the worker turn is no
        // longer interruptible once waitForSettled has completed.
        state.workerTurnActive = false;
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
        if (state.activeRun === run) state.activeRun = undefined;
      }
    })();
    state.activeRun = run;
    return run;
  }


  private withWorker<T>(
    chatId: number,
    opts: {
      armIdle?: boolean;
      waitActiveRun?: boolean;
      beforeWorker?: (state: ChatState) => Promise<void> | void;
    },
    op: (worker: AgentWorker, state: ChatState) => Promise<T>,
  ): Promise<T> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      if (opts.armIdle) this.armIdleStop(state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      if (opts.waitActiveRun) {
        const activeRun = state.activeRun;
        if (activeRun) await this.raceShutdown(state, activeRun).catch(() => {});
      }
      if (opts.beforeWorker) {
        // Await only when the hook actually has work: an unconditional await
        // would suspend an in-flight prompt past disposeAll's closing mark, so
        // its worker startup would never be initiated and a late-resolving
        // factory promise could never be stopped.
        const result = opts.beforeWorker(state);
        if (result) await result;
      }
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      return op(worker, state);
    });
  }

  private call<A>(
    chatId: number,
    opts: { armIdle?: boolean; waitActiveRun?: boolean },
    op: (worker: AgentWorker) => Promise<A>,
  ): Promise<A> {
    return this.withWorker(chatId, opts, (worker, state) => this.raceShutdown(state, op(worker)));
  }

  async prompt(chatId: number, text: string, mode: PromptMode = "interactive"): Promise<void> {
    // The run promise is handed out inside an object so the queue entry itself
    // settles immediately; awaiting the run here would serialize queued prompts
    // behind the active run and starve the abort hook in beforeWorker.
    const action = await this.withWorker(
      chatId,
      {
        armIdle: true,
        beforeWorker: (state) => {
          const run = state.activeRun;
          if (!run) return;
          if (mode === "interactive" && state.workerTurnActive && state.worker) {
            const activeWorker = state.worker;
            // Esc semantics: abort whatever is in flight (generation or tools, as pi's
            // own Esc does) and reprompt fresh; the aborted run's reply is ignored.
            return (async () => {
              await this.raceShutdown(state, activeWorker.abort()).catch(() => {});
              await this.raceShutdown(state, run).catch(() => {});
            })();
          }
          // Settled or non-interactive: wait; the new message starts its own fresh run.
          return (async () => {
            await this.raceShutdown(state, run).catch(() => {});
          })();
        },
      },
      async (worker, state) => {
        return { completion: this.beginRun(state, worker, () => worker.prompt(text)) };
      },
    );
    return await action.completion;
  }

  newSession(chatId: number): Promise<void> {
    return this.withWorker(chatId, { armIdle: true, waitActiveRun: true }, async (worker, state) => {
      try {
        await this.raceShutdown(state, worker.newSession());
      } catch (error) {
        await this.invalidateWorker(state, worker).catch(() => {});
        throw error;
      }
    });
  }

  setModel(chatId: number, provider: string, modelId: string): Promise<void> {
    return this.withWorker(chatId, { armIdle: true }, async (worker, state) => {
      await this.raceShutdown(state, worker.setModel(provider, modelId));
      await writeUserSettings(chatPaths(this.config.dataDir, chatId).workspace, {
        defaultProvider: provider,
        defaultModel: modelId,
      });
    });
  }

  setThinkingLevel(chatId: number, level: string): Promise<void> {
    return this.withWorker(chatId, { armIdle: true }, async (worker, state) => {
      await this.raceShutdown(state, worker.setThinkingLevel(level));
      await writeUserSettings(chatPaths(this.config.dataDir, chatId).workspace, {
        defaultThinkingLevel: level,
      });
    });
  }

  status(chatId: number): Promise<WorkerSessionState> {
    return this.call(chatId, {}, (worker) => worker.getSessionState());
  }

  getAvailableModels(chatId: number): Promise<AvailableModel[]> {
    return this.call(chatId, {}, (worker) => worker.getAvailableModels());
  }

  getAvailableThinkingLevels(chatId: number): Promise<string[]> {
    return this.call(chatId, {}, (worker) => worker.getAvailableThinkingLevels());
  }

  restart(chatId: number): Promise<void> {
    return this.call(chatId, { armIdle: true, waitActiveRun: true }, (worker) => worker.restart());
  }

  async disposeAll(): Promise<void> {
    const permanentlyClosed = this.shuttingDown;
    for (const state of this.states.values()) state.closing = true;

    const states = [...this.states.values()];
    for (const state of states) this.disarmIdleStop(state);

    await Promise.allSettled(states.map((state) => this.requestAbort(state)));
    await Promise.all(states.map(async (state) => {
      try {
        await withTimeout(state.queue.idle(), this.shutdownTimeoutMs, () => new Error("Agent queue drain timed out"));
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
        await withTimeout(completed, this.shutdownTimeoutMs, () => new Error("Agent worker run drain timed out"));
      } catch {
        this.cancelState(state, "Agent worker run drain timed out");
      }
    }));

    // Phase 2: drain each state's queue (a prompt for a chat state created
    // mid-disposal enqueues here), then stop its worker. The follow-up pass
    // covers states created while another worker was stopping.
    const remaining = [...this.states.values()];
    await this.disposeStates(remaining);
    const disposing = new Set(remaining);
    for (const [chatId, state] of this.states) {
      if (disposing.has(state)) this.states.delete(chatId);
    }
    const late = [...this.states.values()];
    await this.disposeStates(late);
    const lateDisposing = new Set(late);
    for (const [chatId, state] of this.states) {
      if (lateDisposing.has(state)) this.states.delete(chatId);
    }

    if (!permanentlyClosed) this.shuttingDown = false;
  }

  private async disposeStates(states: ChatState[]): Promise<void> {
    await Promise.allSettled(states.map(async (state) => {
      try {
        await withTimeout(state.queue.idle(), this.shutdownTimeoutMs, () => new Error("Agent queue drain timed out"));
      } catch {
        this.cancelState(state, "Agent manager shutdown timed out");
      }
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      const invalidation = state.invalidation;
      if (invalidation) {
        await withTimeout(invalidation.completion, this.shutdownTimeoutMs, () => new Error("Agent worker stop timed out")).catch(() => {});
        return;
      }
      const worker = state.worker;
      if (!worker) return;
      await withTimeout(this.invalidateWorker(state, worker), this.shutdownTimeoutMs, () => new Error("Agent worker stop timed out")).catch(() => {});
    }));
  }
}
