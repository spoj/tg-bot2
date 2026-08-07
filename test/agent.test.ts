import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  AgentManager,
  extractFinalAssistantText,
  SYSTEM_PROMPT,
  type AgentEvent,
  type AgentWorker,
} from "../src/agent.js";
import type { Config } from "../src/config.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FakeWorker = AgentWorker & {
  emit(event: AgentEvent): void;
  lastText: string | undefined;
};

function fakeWorker(initialText = "done"): FakeWorker {
  const listeners = new Set<(event: AgentEvent) => void>();
  const worker = {
    lastText: initialText,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    newSession: vi.fn(async () => {
      worker.lastText = undefined;
    }),
    prompt: vi.fn(async (_text: string) => {}),
    steer: vi.fn(async (_text: string) => {}),
    waitForSettled: vi.fn(async () => {}),
    getLastAssistantText: vi.fn(async () => worker.lastText),
    onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: AgentEvent): void {
      for (const listener of listeners) listener(event);
    },
  } as unknown as FakeWorker;
  return worker;
}

const config: Config = {
  token: "token",
  allowedUserIds: new Set([1]),
  dataDir: "/tmp/tg-bot2-test",
};
const managerOptions = { appRoot: "/tmp/tg-bot2-app" };

it("describes the exact workspace file protocols", () => {
  expect(SYSTEM_PROMPT).toContain("/workspace/.pi");
  expect(SYSTEM_PROMPT).toContain("Runtime, authentication, and session files are writable");
  expect(SYSTEM_PROMPT).toContain("Attachments are ordinary data paths");
  expect(SYSTEM_PROMPT).toContain("native tools and configured Pi extensions");
  expect(SYSTEM_PROMPT).toContain("/workspace/.tg-bot/outbox/");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"send_file\",path,caption?}");
  expect(SYSTEM_PROMPT).toContain("temporary filename that does not\nend in .json");
  expect(SYSTEM_PROMPT).toContain("final unique *.json request name");
  expect(SYSTEM_PROMPT).toContain("/workspace/.tg-bot/schedules.json");
  expect(SYSTEM_PROMPT).toContain("{version:1,schedules:[...]}");
  expect(SYSTEM_PROMPT).toContain("recurrence must be hourly, daily, weekly, or null");
  expect(SYSTEM_PROMPT).toContain("UTC timestamp ending\nin Z");
  expect(SYSTEM_PROMPT).toContain("runCount must be a nonnegative integer");
});

it("extracts only final assistant text and ignores thinking and tool calls", () => {
  expect(extractFinalAssistantText([
    { role: "assistant", content: "old" },
    { role: "toolResult", content: [{ type: "text", text: "tool" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "hello " },
        { type: "toolCall", name: "bash" },
        { type: "text", text: "world" },
      ],
    },
  ])).toBe("hello world");
  expect(extractFinalAssistantText([{ role: "assistant", content: " answer " }])).toBe("answer");
  expect(extractFinalAssistantText([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }])).toBeUndefined();
});

it("creates one worker lazily per numeric chat and returns its final text", async () => {
  const worker = fakeWorker("answer");
  const factory = vi.fn(() => worker);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  expect(factory).not.toHaveBeenCalled();
  await expect(manager.prompt(42, "hello")).resolves.toBe("answer");
  await expect(manager.prompt(42, "again")).resolves.toBe("answer");

  expect(factory).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledWith({
    workspace: path.join(config.dataDir, "chats", "42", "workspace"),
    appRoot: path.resolve(managerOptions.appRoot),
    appendSystemPrompt: SYSTEM_PROMPT,
  });
  expect(worker.start).toHaveBeenCalledOnce();
  expect(worker.prompt).toHaveBeenCalledTimes(2);
});

it("steers an interactive request while the active worker run owns the response", async () => {
  const worker = fakeWorker("combined");
  const firstDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await firstDone.promise;
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  const first = manager.prompt(1, "first");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  await expect(manager.prompt(1, "second")).resolves.toBeUndefined();
  expect(worker.steer).toHaveBeenCalledWith("second");

  firstDone.resolve();
  await expect(first).resolves.toBe("combined");
  expect(worker.prompt).toHaveBeenCalledTimes(1);
});

it("waits for active work before issuing an independent follow-up prompt", async () => {
  const worker = fakeWorker("follow-up response");
  const firstDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await firstDone.promise;
    worker.lastText = "first response";
  });
  vi.mocked(worker.prompt).mockImplementationOnce(async (text: string) => {
    expect(text).toBe("follow-up");
    worker.lastText = "follow-up response";
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  const first = manager.prompt(2, "first");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  const followUp = manager.prompt(2, "follow-up", "follow-up");
  await Promise.resolve();
  expect(worker.prompt).toHaveBeenCalledOnce();

  firstDone.resolve();
  await expect(first).resolves.toBe("first response");
  await expect(followUp).resolves.toBe("follow-up response");
  expect(worker.prompt).toHaveBeenCalledTimes(2);
  expect(worker.prompt).toHaveBeenNthCalledWith(2, "follow-up");
});

it("forwards ordered tool-call progress and drains it before the final response", async () => {
  const worker = fakeWorker("finished");
  const firstProgressDone = deferred<void>();
  const started: string[] = [];
  const finished: string[] = [];
  const progress = vi.fn(async (_chatId: number, text: string) => {
    started.push(text);
    if (text === "working") await firstProgressDone.promise;
    finished.push(text);
  });
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    worker.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } });
    worker.emit({ type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }, { type: "toolCall", name: "bash" }],
    } });
    worker.emit({ type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "next" }, { type: "toolCall", name: "bash" }],
    } });
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });
  manager.setAssistantProgress(progress);

  const completion = manager.prompt(3, "request");
  await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
  expect(started).toEqual(["working"]);
  expect(finished).toEqual([]);
  firstProgressDone.resolve();

  await expect(completion).resolves.toBe("finished");
  expect(started).toEqual(["working", "next"]);
  expect(finished).toEqual(["working", "next"]);
});
it("uses the no-text fallback for a completed worker turn", async () => {
  const worker = fakeWorker();
  vi.mocked(worker.getLastAssistantText).mockResolvedValueOnce(undefined);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });
  await expect(manager.prompt(4, "silent")).resolves.toBe("I completed the turn but produced no text response.");
});

it("waits behind active work for /new and keeps the existing workspace", async () => {
  const worker = fakeWorker("old");
  const firstDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await firstDone.promise;
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  const first = manager.prompt(5, "running");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  const reset = manager.newSession(5);
  await Promise.resolve();
  expect(worker.newSession).not.toHaveBeenCalled();

  firstDone.resolve();
  await expect(first).resolves.toBe("old");
  await expect(reset).resolves.toBeUndefined();
  expect(worker.newSession).toHaveBeenCalledOnce();
  expect(worker.stop).not.toHaveBeenCalled();
});

it("stops a worker whose startup fails before assignment", async () => {
  const failed = fakeWorker();
  const replacement = fakeWorker("fresh");
  vi.mocked(failed.start).mockRejectedValueOnce(new Error("startup failed"));
  const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(replacement);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  await expect(manager.prompt(6, "not replayed")).rejects.toThrow("startup failed");
  expect(failed.stop).toHaveBeenCalledOnce();
  await expect(manager.prompt(6, "new request")).resolves.toBe("fresh");
  expect(failed.prompt).not.toHaveBeenCalled();
  expect(replacement.prompt).toHaveBeenCalledWith("new request");
});

it("stops a failed worker before dispatching queued work without replaying it", async () => {
  const failed = fakeWorker();
  const replacement = fakeWorker("fresh");
  const runFailure = deferred<void>();
  const stopFinished = deferred<void>();
  vi.mocked(failed.prompt).mockImplementationOnce(async () => {
    await runFailure.promise;
    throw new Error("worker failed");
  });
  vi.mocked(failed.stop).mockImplementationOnce(async () => {
    await stopFinished.promise;
  });
  const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(replacement);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  const first = manager.prompt(6, "accepted once");
  await vi.waitFor(() => expect(failed.prompt).toHaveBeenCalledOnce());
  const later = manager.prompt(6, "later request", "follow-up");
  runFailure.resolve();
  await vi.waitFor(() => expect(failed.stop).toHaveBeenCalledOnce());
  expect(replacement.start).not.toHaveBeenCalled();

  stopFinished.resolve();
  await expect(first).rejects.toThrow("worker failed");
  await expect(later).resolves.toBe("fresh");
  expect(failed.prompt).toHaveBeenCalledTimes(1);
  expect(replacement.prompt).toHaveBeenCalledWith("later request");
  expect(factory).toHaveBeenCalledTimes(2);
});

it("aborts active work and drains queued disposal work without replacement", async () => {
  const worker = fakeWorker("done");
  const activeDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await activeDone.promise;
  });
  vi.mocked(worker.abort).mockImplementationOnce(async () => {
    activeDone.resolve();
  });
  const factory = vi.fn().mockReturnValue(worker);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  const active = manager.prompt(8, "active");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  const queued = manager.prompt(8, "queued", "follow-up");
  const queuedResult = expect(queued).rejects.toThrow("shutting down");

  await manager.disposeAll(true);
  await expect(active).resolves.toBe("done");
  await queuedResult;
  expect(worker.prompt).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledOnce();
  expect(worker.abort).toHaveBeenCalledOnce();
  expect(worker.stop).toHaveBeenCalledOnce();
});

it("aborts, drains, stops all workers, and clears manager state", async () => {
  const worker = fakeWorker("done");
  const replacement = fakeWorker("new worker");
  const activeDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await activeDone.promise;
  });
  vi.mocked(worker.abort).mockImplementationOnce(async () => {
    activeDone.resolve();
  });
  const factory = vi.fn().mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });
  const active = manager.prompt(7, "active");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());

  await manager.disposeAll(true);
  await expect(active).resolves.toBe("done");
  expect(worker.abort).toHaveBeenCalledOnce();
  expect(worker.stop).toHaveBeenCalledOnce();

  await expect(manager.prompt(7, "after dispose")).resolves.toBe("new worker");
  expect(factory).toHaveBeenCalledTimes(2);
  await manager.disposeAll();
  expect(replacement.stop).toHaveBeenCalledOnce();
});

it("gates new work and aborts each known worker only once", async () => {
  const worker = fakeWorker("done");
  const activeDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await activeDone.promise;
  });
  vi.mocked(worker.abort).mockImplementationOnce(async () => {
    activeDone.resolve();
  });
  const factory = vi.fn().mockReturnValue(worker);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  const active = manager.prompt(9, "scheduled work", "follow-up");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());

  manager.beginShutdown();
  manager.beginShutdown();
  await expect(active).resolves.toBe("done");
  expect(worker.abort).toHaveBeenCalledOnce();
  await expect(manager.prompt(9, "replacement", "follow-up")).rejects.toThrow("shutting down");
  expect(factory).toHaveBeenCalledOnce();

  await manager.disposeAll(true);
  expect(worker.stop).toHaveBeenCalledOnce();
});
