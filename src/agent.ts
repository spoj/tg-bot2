import path from "node:path";
import { PiRpcWorker } from "./pi-worker.js";
import type { Config } from "./config.js";
import { chatPaths } from "./config.js";
import { SerialQueue } from "./queue.js";

export const SYSTEM_PROMPT = `You are a persistent personal agent reached through Telegram.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available.
Use the pi command with install <source> -l for optional project-local extensions and list to inspect them; extension changes are debounced and automatically reloaded after the current turn settles.
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
};

type ChatState = {
  worker: AgentWorker | undefined;
  workerPromise: Promise<AgentWorker> | undefined;
  activeRun: Promise<string> | undefined;
  queue: SerialQueue;
  unsubscribe: (() => void) | undefined;
  progressTail: Promise<void>;
  invalidation: { worker: AgentWorker; completion: Promise<void> } | undefined;
  closing: boolean;
  abortPromise: Promise<void> | undefined;
};

type PromptAction =
  | { kind: "steer"; completion: Promise<void> }
  | { kind: "prompt"; completion: Promise<string> };

const NO_TEXT_RESPONSE = "I completed the turn but produced no text response.";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class AgentManager {
  private readonly states = new Map<number, ChatState>();
  private readonly workerFactory: AgentWorkerFactory;
  private readonly appRoot: string;
  private readonly bwrapPath: string | undefined;
  private assistantProgress: AssistantProgressCallback | undefined;
  private shutdownAbort: Promise<void> | undefined;
  private shuttingDown = false;
  constructor(private readonly config: Pick<Config, "dataDir">, options: AgentManagerOptions) {
    this.appRoot = path.resolve(options.appRoot);
    this.bwrapPath = options.bwrapPath;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new PiRpcWorker(workerOptions));
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

  private requestAbort(state: ChatState): Promise<void> {
    if (state.abortPromise) return state.abortPromise;
    const worker = state.worker;
    if (worker) {
      state.abortPromise = this.abortWorker(worker);
      return state.abortPromise;
    }
    const workerPromise = state.workerPromise;
    if (workerPromise) {
      state.abortPromise = workerPromise.then(
        (startedWorker) => this.abortWorker(startedWorker),
        () => {},
      );
      return state.abortPromise;
    }
    state.abortPromise = Promise.resolve();
    return state.abortPromise;
  }

  private async abortWorker(worker: AgentWorker): Promise<void> {
    try {
      await worker.abort();
    } catch {
      // Shutdown continues if abort rejects.
    }
  }

  private state(chatId: number): ChatState {
    let state = this.states.get(chatId);
    if (!state) {
      state = {
        worker: undefined,
        workerPromise: undefined,
        activeRun: undefined,
        queue: new SerialQueue(),
        unsubscribe: undefined,
        progressTail: Promise.resolve(),
        invalidation: undefined,
        closing: false,
        abortPromise: undefined,
      };
      this.states.set(chatId, state);
    }
    return state;
  }

  private ensureOpen(): void {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
  }

  private subscribeAssistantProgress(chatId: number, state: ChatState, worker: AgentWorker): void {
    state.unsubscribe?.();
    state.unsubscribe = worker.onEvent((event) => {
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

    let completion!: Promise<void>;
    completion = (async () => {
      if (state.worker === worker) {
        state.worker = undefined;
        state.unsubscribe?.();
        state.unsubscribe = undefined;
      }
      try {
        await worker.stop();
      } finally {
        if (state.invalidation?.completion === completion) state.invalidation = undefined;
      }
    })();
    state.invalidation = { worker, completion };
    return completion;
  }

  private async ensureWorker(chatId: number, state: ChatState): Promise<AgentWorker> {
    if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
    if (state.worker) return state.worker;
    if (!state.workerPromise) {
      const paths = chatPaths(this.config.dataDir, chatId);
      const pending = (async () => {
        let worker: AgentWorker | undefined;
        try {
          worker = await this.workerFactory({
            workspace: paths.workspace,
            appRoot: this.appRoot,
            ...(this.bwrapPath === undefined ? {} : { bwrapPath: this.bwrapPath }),
            appendSystemPrompt: SYSTEM_PROMPT,
          });
          await worker.start();
          state.worker = worker;
          this.subscribeAssistantProgress(chatId, state, worker);
          return worker;
        } catch (error) {
          if (worker) await this.invalidateWorker(state, worker);
          throw error;
        }
      })();
      state.workerPromise = pending;
    }
    const pending = state.workerPromise;
    if (!pending) throw new Error("Pi worker startup was not scheduled");
    try {
      return await pending;
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

  private beginRun(state: ChatState, worker: AgentWorker, command: () => Promise<void>): Promise<string> {
    let run!: Promise<string>;
    run = (async () => {
      try {
        await command();
        await worker.waitForSettled();
        const result = (await worker.getLastAssistantText()) ?? NO_TEXT_RESPONSE;
        await this.drainProgress(state);
        return result;
      } catch (error) {
        await this.invalidateWorker(state, worker);
        throw error;
      } finally {
        await this.drainProgress(state);
        if (state.activeRun === run) state.activeRun = undefined;
      }
    })();
    state.activeRun = run;
    return run;
  }

  private steer(state: ChatState, worker: AgentWorker, text: string): Promise<void> {
    return worker.steer(text).catch(async (error) => {
      await this.invalidateWorker(state, worker);
      throw error;
    });
  }

  async prompt(chatId: number, text: string, mode: PromptMode = "interactive"): Promise<string | undefined> {
    this.ensureOpen();
    const state = this.state(chatId);
    const action = await state.queue.run(async (): Promise<PromptAction> => {
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      if (mode === "interactive" && state.activeRun) {
        const activeWorker = state.worker;
        if (activeWorker) {
          return { kind: "steer", completion: this.steer(state, activeWorker, text) };
        }
        await state.activeRun.catch(() => {});
      }
      if (mode === "follow-up" && state.activeRun) await state.activeRun.catch(() => {});

      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      if (mode === "interactive" && state.activeRun) {
        return { kind: "steer", completion: this.steer(state, worker, text) };
      }
      const completion = this.beginRun(state, worker, () => worker.prompt(text));
      return { kind: "prompt", completion };
    });

    if (action.kind === "steer") {
      try {
        await action.completion;
      } finally {
        await this.drainProgress(state);
      }
      return undefined;
    }
    return await action.completion;
  }

  newSession(chatId: number): Promise<void> {
    this.ensureOpen();
    const state = this.state(chatId);
    return state.queue.run(async () => {
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      await state.activeRun?.catch(() => {});
      await this.drainProgress(state);
      const worker = await this.ensureWorker(chatId, state);
      if (this.shuttingDown || state.closing) throw new Error("Agent manager is shutting down");
      try {
        await worker.newSession();
      } catch (error) {
        await this.invalidateWorker(state, worker);
        throw error;
      }
    });
  }

  async disposeAll(abort = false): Promise<void> {
    const permanentlyClosed = this.shuttingDown;
    for (const state of this.states.values()) state.closing = true;

    while (true) {
      const states = [...this.states.values()];
      if (states.length === 0) return;

      if (abort) {
        await Promise.allSettled(states.map((state) => this.requestAbort(state)));
      }
      await Promise.allSettled(states.map((state) => state.queue.idle()));
      const activeRuns = states.map((state) => state.activeRun).filter(
        (run): run is Promise<string> => run !== undefined,
      );
      await Promise.allSettled(activeRuns);

      const remaining = [...this.states.values()];
      if (!remaining.some((state) => state.activeRun || state.workerPromise || state.queue.size > 0)) break;
    }

    const states = [...this.states.values()];
    await Promise.allSettled(states.map(async (state) => {
      await state.queue.idle();
      const worker = state.worker ?? await state.workerPromise?.catch(() => undefined);
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      await worker?.stop();
    }));
    this.states.clear();
    if (!permanentlyClosed) this.shuttingDown = false;
  }
}
