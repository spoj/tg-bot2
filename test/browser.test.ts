import type { spawn } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import hostTools from "../extensions/host-tools.js";
import { HostBrowserManager, resolveChromeExecutable } from "../src/browser.js";
import { WorkspaceEventLog, type BotEvent } from "../src/events.js";
import { WorkspaceRequestBus, parseCommand } from "../src/request-bus.js";

describe("browser automation and lifecycle", () => {
  it("resolves chrome executable on the system", () => {
    const executable = resolveChromeExecutable();
    expect(executable).toBeDefined();
    expect(typeof executable).toBe("string");
  });

  it("registers start_browser tool with the host-tools extension", () => {
    const registered: ToolDefinition[] = [];
    const fakePi: ExtensionAPI = {
      registerTool: (tool: ToolDefinition) => {
        registered.push(tool);
      },
    } as unknown as ExtensionAPI;

    const prev = process.env.PI_HOST_TOOLS;
    process.env.PI_HOST_TOOLS = "send,spawn,cancel,start_browser";
    try {
      hostTools(fakePi);
      const startBrowserTool = registered.find((t) => t.name === "start_browser");
      expect(startBrowserTool).toBeDefined();
      expect(startBrowserTool?.label).toBe("Start browser");
    } finally {
      process.env.PI_HOST_TOOLS = prev;
    }
  });

  it("executes start_browser tool and appends browser_requested event", async () => {
    const prev = process.env.PI_HOST_TOOLS;
    process.env.PI_HOST_TOOLS = "start_browser";
    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});
    try {
      const registered: ToolDefinition[] = [];
      const fakePi: ExtensionAPI = {
        registerTool: (tool: ToolDefinition) => {
          registered.push(tool);
        },
      } as unknown as ExtensionAPI;

      hostTools(fakePi);
      const tool = registered.find((t) => t.name === "start_browser");
      expect(tool).toBeDefined();

      const res = await tool!.execute("call-1", {}, undefined as never, undefined as never, undefined as never);
      const first = res.content[0];
      expect(first?.type).toBe("text");
      if (first?.type === "text") {
        expect(first.text).toContain("Browser requested");
      }
      expect(appendSpy).toHaveBeenCalledWith(
        "/workspace/.tg-bot/events.jsonl",
        expect.stringContaining('"type":"browser_requested"'),
        expect.anything(),
      );
    } finally {
      appendSpy.mockRestore();
      process.env.PI_HOST_TOOLS = prev;
    }
  });

  it("HostBrowserManager launches Chrome, proxies to UNIX socket, and supports Puppeteer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-manager-test-"));
    const emittedEvents: BotEvent[] = [];
    const eventsMock = {
      emit: async (event: BotEvent) => {
        emittedEvents.push(event);
        return undefined;
      },
    } as unknown as WorkspaceEventLog;

    const hostBrowser = new HostBrowserManager({
      workspace: root,
      events: eventsMock,
    });

    try {
      // 1. Initial start request
      const startRes = await hostBrowser.handleStartBrowserRequest({ requestId: "req-1" });
      expect(startRes).toBeDefined();
      expect(startRes?.status).toBe("started");
      expect(startRes?.socketPath).toBe(path.join(root, ".browser", "cdp.sock"));
      expect(startRes?.wsEndpoint).toBe(`ws+unix://${path.join(root, ".browser", "cdp.sock")}`);
      expect(existsSync(hostBrowser.getSocketPath())).toBe(true);

      const readyEvent = emittedEvents.find((e) => e.type === "browser_ready");
      expect(readyEvent).toBeDefined();
      if (readyEvent && readyEvent.type === "browser_ready") {
        expect(readyEvent.status).toBe("started");
        expect(readyEvent.requestId).toBe("req-1");
      }

      // 2. Connect Puppeteer over ws+unix
      const browser = await puppeteer.connect({
        browserWSEndpoint: hostBrowser.getWsEndpoint(),
      });
      const page = await browser.newPage();
      await page.setContent("<title>Test Page</title><h1>Hello CDP</h1>");
      const title = await page.title();
      expect(title).toBe("Test Page");
      await page.close();
      await browser.disconnect();

      // 3. Second start request reuses existing instance
      emittedEvents.length = 0;
      const secondRes = await hostBrowser.handleStartBrowserRequest({ requestId: "req-2" });
      expect(secondRes?.status).toBe("existing");
      const existingEvent = emittedEvents.find((e) => e.type === "browser_ready");
      expect(existingEvent).toBeDefined();
      if (existingEvent && existingEvent.type === "browser_ready") {
        expect(existingEvent.status).toBe("existing");
        expect(existingEvent.requestId).toBe("req-2");
      }
    } finally {
      await hostBrowser.stop("host_shutdown");
      expect(existsSync(hostBrowser.getSocketPath())).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("HostBrowserManager emits browser_request_failed when launch fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-fail-test-"));
    const emittedEvents: BotEvent[] = [];
    const eventsMock = {
      emit: async (event: BotEvent) => {
        emittedEvents.push(event);
        return undefined;
      },
    } as unknown as WorkspaceEventLog;

    const fakeSpawn = (() => {
      throw new Error("Simulated spawn failure");
    }) as unknown as typeof spawn;

    const hostBrowser = new HostBrowserManager({
      workspace: root,
      events: eventsMock,
      spawnProcess: fakeSpawn,
    });

    try {
      const res = await hostBrowser.handleStartBrowserRequest({ requestId: "fail-req-1" });
      expect(res).toBeUndefined();

      const failedEvent = emittedEvents.find((e) => e.type === "browser_request_failed");
      expect(failedEvent).toBeDefined();
      if (failedEvent && failedEvent.type === "browser_request_failed") {
        expect(failedEvent.requestId).toBe("fail-req-1");
        expect(failedEvent.error).toContain("Simulated spawn failure");
      }
    } finally {
      await hostBrowser.stop("host_shutdown");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up stale socket and pid files across boot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-test-"));
    const browserDir = path.join(root, ".browser");
    await mkdir(browserDir, { recursive: true });
    const pidFile = path.join(browserDir, "chrome.pid");
    const socketFile = path.join(browserDir, "cdp.sock");

    await writeFile(pidFile, "999999999", "utf8");
    await writeFile(socketFile, "", "utf8");

    const hostBrowser = new HostBrowserManager({ workspace: root });
    await hostBrowser.cleanupStaleArtifacts();

    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(socketFile)).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  it("WorkspaceRequestBus routes browser_requested commands and ignores consumed ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-bus-test-"));
    const eventsDir = path.join(root, ".tg-bot");
    await mkdir(eventsDir, { recursive: true });
    const eventsFile = path.join(eventsDir, "events.jsonl");

    const browserRequests: string[] = [];
    const bus = new WorkspaceRequestBus({
      workspace: root,
      onSend: async () => {},
      onSpawn: async () => "claimed",
      onCancel: async () => {},
      onStartBrowser: async (record) => {
        browserRequests.push(record.requestId);
      },
      pollIntervalMs: 100,
    });

    try {
      // 1. Parse command directly
      const cmd = parseCommand(JSON.stringify({ type: "browser_requested", requestId: "test-req-1" }));
      expect(cmd).toEqual({ type: "browser_requested", requestId: "test-req-1" });

      // 2. Append command to events.jsonl
      await writeFile(
        eventsFile,
        `${JSON.stringify({ v: 1, t: new Date().toISOString(), type: "browser_requested", requestId: "test-req-1" })}\n`,
        "utf8",
      );

      await bus.poll();
      expect(browserRequests).toContain("test-req-1");
    } finally {
      await bus.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent launch requests and preserves origins on browser_ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-coalesce-test-"));
    const emittedEvents: BotEvent[] = [];
    const eventsMock = {
      emit: async (event: BotEvent) => {
        emittedEvents.push(event);
      },
    } as unknown as WorkspaceEventLog;

    const hostBrowser = new HostBrowserManager({
      workspace: root,
      events: eventsMock,
    });

    try {
      // Concurrent requests from Topic 9534 and Topic 9479
      const req1 = hostBrowser.handleStartBrowserRequest({ requestId: "req-1", origin: "829096380:9534" });
      const req2 = hostBrowser.handleStartBrowserRequest({ requestId: "req-2", origin: "829096380:9479" });

      const [res1, res2] = await Promise.all([req1, req2]);
      expect(res1).toBeDefined();
      expect(res2).toBeDefined();
      expect(res1?.socketPath).toBe(res2?.socketPath);

      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[0]).toMatchObject({
        type: "browser_ready",
        requestId: "req-1",
        origin: "829096380:9534",
        status: "started",
      });
      expect(emittedEvents[1]).toMatchObject({
        type: "browser_ready",
        requestId: "req-2",
        origin: "829096380:9479",
        status: "existing",
      });
    } finally {
      await hostBrowser.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
