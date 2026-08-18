import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  AgentManager,
  loadUserSettings,
  SYSTEM_PROMPT,
  WORKER_IDLE_STOP_MS,
  writeUserSettings,
  type AgentEvent,
  type AgentWorker,
} from "../src/agent.js";
import type { Config } from "../src/config.js";
import { deferred } from "./helpers.js";

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
    waitForSettled: vi.fn(async () => {}),
    getLastAssistantText: vi.fn(async () => worker.lastText),
    setModel: vi.fn(async (_provider: string, _modelId: string) => {}),
    setThinkingLevel: vi.fn(async (_level: string) => {}),
    getAvailableModels: vi.fn(async () => []),
    getAvailableThinkingLevels: vi.fn(async () => []),
    getSessionState: vi.fn(async () => ({
      thinkingLevel: "low",
      sessionId: "session-id",
      messageCount: 0,
      autoCompactionEnabled: false,
    })),
    restart: vi.fn(async () => {}),
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
  expect(SYSTEM_PROMPT).toContain("Native tools and Pi-managed extensions");
  expect(SYSTEM_PROMPT).toContain("pi install npm:<package> -l --approve");
  expect(SYSTEM_PROMPT).toContain("pi install https://... -l --approve");
  expect(SYSTEM_PROMPT).toContain("pi install git:... -l --approve");
  expect(SYSTEM_PROMPT).toContain("pi install ./... -l --approve");
  expect(SYSTEM_PROMPT).toContain("pi list --approve");
  expect(SYSTEM_PROMPT).toContain("Project settings are stored at /workspace/.pi/settings.json");
  expect(SYSTEM_PROMPT).toContain("reloaded after the current turn");
  expect(SYSTEM_PROMPT).not.toContain("install <source> -l");
  expect(SYSTEM_PROMPT).toContain("/workspace/.tg-bot/outbox/");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"send_file\",path,caption?,kind?,reply_to_message_id?,disable_notification?}");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"send_message\",text,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}");
  expect(SYSTEM_PROMPT).toContain("/workspace/.tg-bot/events.jsonl");
  expect(SYSTEM_PROMPT).toContain("{v:1,t,type:'message',message,attachments}");
  expect(SYSTEM_PROMPT).toContain("{v:1,t,type:'callback',callback_query}");
  expect(SYSTEM_PROMPT).toContain("{v:1,t,type:'poll_answer',poll_answer}");
  expect(SYSTEM_PROMPT).toContain("{v:1,t,type:'send',kind,id,messageId?,pollId?,ok,error?}");
  expect(SYSTEM_PROMPT).toContain("wakes you with a single \".\" prompt");
  expect(SYSTEM_PROMPT).toContain("ALL Telegram output through");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"send_location\",latitude,longitude,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"send_poll\",question,options,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"stop_poll\",message_id,reply_markup?}");
  expect(SYSTEM_PROMPT).toContain("{version:1,id,type:\"send_reaction\",message_id,reaction}");
  expect(SYSTEM_PROMPT).toContain("sets a Telegram reaction on any message in the chat");
  expect(SYSTEM_PROMPT).toContain("{type:\"custom_emoji\",custom_emoji_id}");
  expect(SYSTEM_PROMPT).toContain("/workspace/.tg-bot/poll-results.jsonl");
  expect(SYSTEM_PROMPT).toContain("temporary filename that does not\nend in .json");
  expect(SYSTEM_PROMPT).toContain("final unique *.json request name");
  expect(SYSTEM_PROMPT).toContain("{version:1,schedules:[...]}");
  expect(SYSTEM_PROMPT).toContain("recurrence must be hourly, daily, weekly, or null");
  expect(SYSTEM_PROMPT).toContain("UTC timestamp ending\nin Z");
  expect(SYSTEM_PROMPT).toContain("runCount must be a nonnegative integer");
});

it("renders the SYSTEM_PROMPT protocol sections from the schemas", () => {
  expect(SYSTEM_PROMPT).toBe(`You are a persistent personal agent reached through Telegram.
Your writable persistent workspace is /workspace.
Runtime, authentication, and session files are writable under /workspace/.pi.
Attachments are ordinary data paths under /workspace/...; read them from those paths.
Native tools and Pi-managed extensions for documents, media, web research, and delegation may be available.
Install optional project-local extensions with pi install npm:<package> -l --approve, pi install https://... -l --approve, pi install git:... -l --approve, or pi install ./... -l --approve. Use pi list --approve to inspect them. Project settings are stored at /workspace/.pi/settings.json. Extension changes are debounced and automatically reloaded after the current turn.
To send files or messages through Telegram, write one request per send under
/workspace/.tg-bot/outbox/. Request types:
{version:1,id,type:"send_file",path,caption?,kind?,reply_to_message_id?,disable_notification?}
sends the file at path (relative to /workspace or an absolute /workspace/... path)
with an optional caption; kind is "auto" (default: images are sent as photos,
audio as audio, video as video, other files as documents, and images over 10 MB
as documents) or an explicit "photo", "audio", "video", "voice", or "document".
{version:1,id,type:"send_message",text,parse_mode?,entities?,link_preview_options?,reply_markup?,reply_to_message_id?,disable_notification?}
sends a text message, where parse_mode is "HTML" or "MarkdownV2" (omit for
plain text; malformed markup is resent as plain text; parse_mode and entities
are mutually exclusive), entities is a list of {type,offset,length} message
entities, link_preview_options is a Telegram LinkPreviewOptions object,
reply_markup is Telegram reply-markup JSON such as an inline_keyboard button
list, reply_to_message_id targets an earlier message, and
disable_notification sends silently.
{version:1,id,type:"send_location",latitude,longitude,horizontal_accuracy?,heading?,live_period?,venue?,reply_to_message_id?,disable_notification?}
sends a location pin (venue {title,address} sends a named venue instead).
{version:1,id,type:"send_poll",question,options,is_anonymous?,allows_multiple_answers?,poll_type?,correct_option_id?,reply_to_message_id?,disable_notification?}
sends a poll: options has 2-10 choices, poll_type is "regular" or "quiz" (quiz
requires correct_option_id). Set is_anonymous:false to receive each vote as a
poll_answer event in events.jsonl; the matching send line in events.jsonl
records pollId.
{version:1,id,type:"stop_poll",message_id,reply_markup?} closes a poll early and
appends {id,result} with the final Poll to /workspace/.tg-bot/poll-results.jsonl
(latest 256 lines kept); poll_id matches the poll_answer events' pollId.
{version:1,id,type:"send_reaction",message_id,reaction} sets a Telegram reaction on any message in the chat (long-press style, e.g. a thumbs up on the user's message): reaction is an array of 1-3 {type:"emoji",emoji} or {type:"custom_emoji",custom_emoji_id} entries; [] removes your reaction. message_id is the numeric messageId of the target message from events.jsonl.
{version:1,id,type:"edit_message",message_id,text?,parse_mode?,entities?,link_preview_options?,reply_markup?} edits one of your earlier messages (at least one of text/reply_markup/link_preview_options required; message_id is the numeric messageId of that message).
{version:1,id,type:"delete_message",message_id} deletes one of your earlier messages (message_id is the numeric messageId of that message).
id must be unique. Write each request to a temporary filename that does not
end in .json, then atomically rename it to the final unique *.json request name.
Every chat event is appended by the host to /workspace/.tg-bot/events.jsonl (one JSON
object per line, newest last; every line starts with {v:1,t,...} where t is an ISO-8601
timestamp). Event types:
- message: {v:1,t,type:'message',message,attachments} where message is the raw Telegram
  Message object (message_id, date, from, chat, text, caption, location, venue, photo,
  document, reply_to_message, and any other Bot API Message field) and attachments lists
  files the host downloaded into /workspace/attachments/... for you
  ({type,path,mimeType,originalName} or {type,failure}).
- callback: {v:1,t,type:'callback',callback_query} where callback_query is the raw
  Telegram CallbackQuery object (id, from, message, data, chat_instance).
- poll_answer: {v:1,t,type:'poll_answer',poll_answer} where poll_answer is the raw
  Telegram PollAnswer object (poll_id, user, option_ids).
- send: a confirmation of one of your outbox requests:
  {v:1,t,type:'send',kind,id,messageId?,pollId?,ok,error?}.
Grep events.jsonl whenever you need recent chat history or sent message ids.
When a user message or button press arrives the host wakes you with a single "." prompt
that carries no content. Read the newest events.jsonl lines and decide whether the user
needs a response. Send ALL Telegram output through .tg-bot/outbox requests; never rely
on the wake prompt for content.
Schedules are stored in /workspace/.tg-bot/schedules.json. Its root object is
{version:1,schedules:[...]}. Each schedule record requires id, prompt, dueAt,
recurrence, enabled, lastRunAt, and runCount. dueAt must be a UTC timestamp ending
in Z; recurrence must be hourly, daily, weekly, or null; enabled is a boolean;
lastRunAt is nullable and, when present, must be a UTC timestamp ending in Z; and
runCount must be a nonnegative integer.
Keep Telegram-facing answers concise unless the user asks for detail.
Host commands /model, /thinking, /status, and /restart manage configuration; do not edit .pi config files yourself.
Every worker start begins a fresh session; previous conversations persist in /workspace/.pi/sessions/*.jsonl and the agent should read/grep them when the user references history.
`);
  for (const discriminator of [
    "send_file",
    "send_message",
    "send_location",
    "send_poll",
    "stop_poll",
    "send_reaction",
    "edit_message",
    "delete_message",
  ]) {
    expect(SYSTEM_PROMPT).toContain(discriminator);
  }
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

it("aborts an active run for an interactive request and reprompts fresh", async () => {
  const worker = fakeWorker("combined");
  const firstDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await firstDone.promise;
  });
  vi.mocked(worker.abort).mockImplementationOnce(async () => {
    firstDone.resolve();
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  const first = manager.prompt(1, "first");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  const second = manager.prompt(1, "second");
  await expect(first).resolves.toBe("combined");
  expect(worker.abort).toHaveBeenCalledOnce();
  await expect(second).resolves.toBe("combined");
  expect(worker.prompt).toHaveBeenLastCalledWith("second");
});

it("waits for active work when the current worker is invalidated", async () => {
  const worker = fakeWorker("first response");
  const replacement = fakeWorker("replacement response");
  const firstDone = deferred<void>();
  const stopDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await firstDone.promise;
  });
  vi.mocked(worker.stop).mockImplementationOnce(async () => {
    await stopDone.promise;
  });
  const factory = vi.fn().mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  const first = manager.prompt(13, "first");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  worker.emit({ type: "worker_error", error: "reload failed" });
  await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledOnce());
  const second = manager.prompt(13, "second");
  await Promise.resolve();
  expect(worker.abort).not.toHaveBeenCalled();
  expect(replacement.prompt).not.toHaveBeenCalled();

  firstDone.resolve();
  stopDone.resolve();
  await expect(first).resolves.toBe("first response");
  await expect(second).resolves.toBe("replacement response");
  expect(replacement.prompt).toHaveBeenCalledWith("second");
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
it("preserves startup failure when cleanup also fails", async () => {
  const worker = fakeWorker();
  vi.mocked(worker.start).mockRejectedValueOnce(new Error("startup failed"));
  vi.mocked(worker.stop).mockRejectedValueOnce(new Error("stop failed"));
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  await expect(manager.prompt(10, "request")).rejects.toThrow("startup failed");
  expect(worker.stop).toHaveBeenCalledOnce();
});

it("preserves prompt failure when cleanup also fails", async () => {
  const worker = fakeWorker();
  vi.mocked(worker.prompt).mockRejectedValueOnce(new Error("prompt failed"));
  vi.mocked(worker.stop).mockRejectedValueOnce(new Error("stop failed"));
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  await expect(manager.prompt(11, "request")).rejects.toThrow("prompt failed");
  expect(worker.stop).toHaveBeenCalledOnce();
});
it("retries stopping a worker after a rejected cleanup", async () => {
  const worker = fakeWorker();
  vi.mocked(worker.stop).mockRejectedValueOnce(new Error("stop failed"));
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });
  const state = (manager as unknown as { state(chatId: number): unknown }).state(14);
  const invalidate = (manager as unknown as {
    invalidateWorker(state: unknown, worker: AgentWorker): Promise<void>;
  }).invalidateWorker.bind(manager);

  await expect(invalidate(state, worker)).rejects.toThrow("stop failed");
  await expect(invalidate(state, worker)).resolves.toBeUndefined();
  expect(worker.stop).toHaveBeenCalledTimes(2);
});

it("replaces an idle worker after a worker_error event", async () => {
  const worker = fakeWorker("old");
  const replacement = fakeWorker("fresh");
  const stopDone = deferred<void>();
  vi.mocked(worker.stop).mockImplementationOnce(async () => {
    await stopDone.promise;
  });
  const factory = vi.fn().mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  await expect(manager.prompt(15, "first")).resolves.toBe("old");
  worker.emit({ type: "worker_error", error: "extension reload failed" });
  const next = manager.prompt(15, "next request");
  await Promise.resolve();
  expect(factory).toHaveBeenCalledOnce();

  stopDone.resolve();
  await expect(next).resolves.toBe("fresh");
  expect(worker.stop).toHaveBeenCalledOnce();
  expect(replacement.start).toHaveBeenCalledOnce();
  expect(replacement.prompt).toHaveBeenCalledWith("next request");
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

  await manager.disposeAll();
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

  await manager.disposeAll();
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

  const firstShutdown = manager.beginShutdown();
  const secondShutdown = manager.beginShutdown();
  await expect(firstShutdown).resolves.toBeUndefined();
  await expect(secondShutdown).resolves.toBeUndefined();
  await expect(active).resolves.toBe("done");
  expect(worker.abort).toHaveBeenCalledOnce();
  await expect(manager.prompt(9, "replacement", "follow-up")).rejects.toThrow("shutting down");
  expect(factory).toHaveBeenCalledOnce();

  await manager.disposeAll();
  expect(worker.stop).toHaveBeenCalledOnce();
});
it("disposes an idle worker normally and clears its state", async () => {
  const worker = fakeWorker("done");
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  await expect(manager.prompt(10, "first")).resolves.toBe("done");
  await expect(manager.disposeAll()).resolves.toBeUndefined();
  expect(worker.stop).toHaveBeenCalledOnce();

  await expect(manager.prompt(10, "after dispose")).resolves.toBe("done");
  await manager.disposeAll();
  expect(worker.stop).toHaveBeenCalledTimes(2);
});
it("also disposes workers created while another worker is stopping", async () => {
  const first = fakeWorker("first");
  const second = fakeWorker("second");
  const stopDone = deferred<void>();
  vi.mocked(first.stop).mockImplementationOnce(async () => {
    await stopDone.promise;
  });
  const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: factory });

  await expect(manager.prompt(12, "first request")).resolves.toBe("first");
  const disposal = manager.disposeAll();
  await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());

  await expect(manager.prompt(13, "during disposal")).resolves.toBe("second");
  stopDone.resolve();
  await expect(disposal).resolves.toBeUndefined();
  expect(second.stop).toHaveBeenCalledOnce();
});


it("bounds abort disposal and rejects active and queued work", async () => {
  const worker = fakeWorker("done");
  const activeDone = deferred<void>();
  const abortDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await activeDone.promise;
  });
  vi.mocked(worker.abort).mockImplementationOnce(async () => {
    await abortDone.promise;
  });
  const manager = new AgentManager(config, {
    ...managerOptions,
    shutdownTimeoutMs: 10,
    workerFactory: () => worker,
  });

  const active = manager.prompt(11, "active");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  const queued = manager.newSession(11);
  await Promise.resolve();
  const disposal = manager.disposeAll();

  await expect(disposal).resolves.toBeUndefined();
  await expect(active).rejects.toThrow("timed out");
  await expect(queued).rejects.toThrow("shutting down");
  expect(worker.stop).toHaveBeenCalledOnce();
  activeDone.resolve();
  abortDone.resolve();
  await manager.disposeAll();
  expect(worker.stop).toHaveBeenCalledOnce();
});

it("cleans up a worker that appears after an aborted hanging startup", async () => {
  const startup = deferred<FakeWorker>();
  const manager = new AgentManager(config, {
    ...managerOptions,
    shutdownTimeoutMs: 10,
    workerFactory: () => startup.promise,
  });

  const pendingPrompt = manager.prompt(12, "during startup");
  await Promise.resolve();
  await expect(manager.disposeAll()).resolves.toBeUndefined();
  await expect(pendingPrompt).rejects.toThrow();
  const lateWorker = fakeWorker();
  startup.resolve(lateWorker);
  await vi.waitFor(() => expect(lateWorker.stop).toHaveBeenCalledOnce());
});

it("loadUserSettings tolerates missing and corrupt settings files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "tg-bot-agent-settings-"));
  try {
    expect(await loadUserSettings(workspace)).toEqual({});
    const directory = path.join(workspace, ".pi", "agent");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "settings.json"), "{not valid json", "utf8");
    expect(await loadUserSettings(workspace)).toEqual({});
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("writeUserSettings merges patches and preserves untouched keys", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "tg-bot-agent-settings-"));
  try {
    const directory = path.join(workspace, ".pi", "agent");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({ custom: true, defaultProvider: "old" }),
      "utf8",
    );

    await writeUserSettings(workspace, { defaultProvider: "new", defaultModel: "claude" });
    await writeUserSettings(workspace, { defaultThinkingLevel: "high" });

    expect(await loadUserSettings(workspace)).toEqual({
      custom: true,
      defaultProvider: "new",
      defaultModel: "claude",
      defaultThinkingLevel: "high",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("setModel and setThinkingLevel persist defaults while preserving existing settings", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tg-bot-agent-data-"));
  const worker = fakeWorker();
  const manager = new AgentManager({ ...config, dataDir }, { ...managerOptions, workerFactory: () => worker });
  try {
    const directory = path.join(dataDir, "chats", "42", "workspace", ".pi", "agent");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "settings.json"), JSON.stringify({ custom: true }), "utf8");

    await manager.setModel(42, "anthropic", "claude");
    await manager.setThinkingLevel(42, "high");

    expect(worker.setModel).toHaveBeenCalledWith("anthropic", "claude");
    expect(worker.setThinkingLevel).toHaveBeenCalledWith("high");
    const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
    expect(settings).toEqual({
      custom: true,
      defaultProvider: "anthropic",
      defaultModel: "claude",
      defaultThinkingLevel: "high",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("status reports the worker session state through the per-chat queue", async () => {
  const worker = fakeWorker();
  vi.mocked(worker.getSessionState).mockResolvedValueOnce({
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "high",
    sessionId: "s1",
    sessionFile: "/workspace/.pi/session.json",
    messageCount: 3,
    autoCompactionEnabled: true,
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  await expect(manager.status(4)).resolves.toEqual({
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "high",
    sessionId: "s1",
    sessionFile: "/workspace/.pi/session.json",
    messageCount: 3,
    autoCompactionEnabled: true,
  });
  expect(worker.getSessionState).toHaveBeenCalledOnce();
});

it("getAvailableModels and getAvailableThinkingLevels route to the worker", async () => {
  const worker = fakeWorker();
  vi.mocked(worker.getAvailableModels).mockResolvedValueOnce([{ provider: "anthropic", id: "claude", name: "Claude" }]);
  vi.mocked(worker.getAvailableThinkingLevels).mockResolvedValueOnce(["low", "high"]);
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  await expect(manager.getAvailableModels(5)).resolves.toEqual([{ provider: "anthropic", id: "claude", name: "Claude" }]);
  await expect(manager.getAvailableThinkingLevels(5)).resolves.toEqual(["low", "high"]);
});

it("restart drains the active run before restarting the worker", async () => {
  const worker = fakeWorker("done");
  const activeDone = deferred<void>();
  vi.mocked(worker.prompt).mockImplementationOnce(async () => {
    await activeDone.promise;
  });
  const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

  const active = manager.prompt(9, "running");
  await vi.waitFor(() => expect(worker.prompt).toHaveBeenCalledOnce());
  const restart = manager.restart(9);
  await Promise.resolve();
  expect(worker.restart).not.toHaveBeenCalled();

  activeDone.resolve();
  await expect(active).resolves.toBe("done");
  await expect(restart).resolves.toBeUndefined();
  expect(worker.restart).toHaveBeenCalledOnce();
});

it("serializes configuration commands through the per-chat queue", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tg-bot-agent-data-"));
  const worker = fakeWorker();
  const firstDone = deferred<void>();
  vi.mocked(worker.setModel).mockImplementationOnce(async () => {
    await firstDone.promise;
  });
  const manager = new AgentManager({ ...config, dataDir }, { ...managerOptions, workerFactory: () => worker });
  try {
    const first = manager.setModel(3, "anthropic", "claude");
    await vi.waitFor(() => expect(worker.setModel).toHaveBeenCalledOnce());
    const second = manager.setThinkingLevel(3, "high");
    await Promise.resolve();
    expect(worker.setThinkingLevel).not.toHaveBeenCalled();

    firstDone.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(worker.setThinkingLevel).toHaveBeenCalledWith("high");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("stops an idle worker after two hours without activity", async () => {
  vi.useFakeTimers();
  try {
    const worker = fakeWorker("done");
    const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

    await manager.prompt(1, "hello");
    expect(worker.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_STOP_MS);
    expect(worker.stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("re-arms the idle timer when a prompt arrives before expiry", async () => {
  vi.useFakeTimers();
  try {
    const worker = fakeWorker("done");
    const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

    await manager.prompt(1, "first");
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_STOP_MS / 2);
    await manager.prompt(1, "second");
    // The original deadline has passed, but the second prompt re-armed the timer.
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_STOP_MS / 2);

    expect(worker.stop).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("re-arms instead of stopping while a run is active at expiry", async () => {
  vi.useFakeTimers();
  try {
    const worker = fakeWorker("done");
    const promptStarted = deferred<void>();
    const activeDone = deferred<void>();
    vi.mocked(worker.prompt).mockImplementationOnce(async () => {
      promptStarted.resolve();
      await activeDone.promise;
    });
    const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

    const active = manager.prompt(1, "long running");
    await promptStarted.promise;
    expect(worker.prompt).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_STOP_MS);
    expect(worker.stop).not.toHaveBeenCalled();

    activeDone.resolve();
    await expect(active).resolves.toBe("done");
  } finally {
    vi.useRealTimers();
  }
});

it("disposeAll clears the idle timer and stops the worker", async () => {
  vi.useFakeTimers();
  try {
    const worker = fakeWorker("done");
    const manager = new AgentManager(config, { ...managerOptions, workerFactory: () => worker });

    await manager.prompt(1, "hello");
    expect(worker.stop).not.toHaveBeenCalled();

    await manager.disposeAll();
    expect(worker.stop).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_STOP_MS * 2);
    expect(worker.stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
