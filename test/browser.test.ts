import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Page } from "puppeteer-core";
import browserExtension, {
  applyStorageState,
  executeBrowserEval,
  getBrowserSession,
  resolveChromeExecutable,
  resolveStoragePath,
} from "../extensions/browser.js";
import { HostBrowserManager } from "../src/browser.js";
import { EventSink, type BotEvent } from "../src/events.js";

describe("browser extension", () => {
  it("resolves chrome executable on the system", () => {
    const executable = resolveChromeExecutable();
    expect(executable).toBeDefined();
    expect(typeof executable).toBe("string");
  });

  it("resolves explicit and implicit storage state paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-test-auth-"));
    try {
      const explicit = path.join(root, "custom-auth.json");
      await writeFile(explicit, "{}", "utf8");
      expect(resolveStoragePath(root, "https://example.com", "custom-auth.json")).toBe(explicit);

      const domainAuth = path.join(root, ".browser", "auth", "example.com.json");
      await mkdir(path.dirname(domainAuth), { recursive: true });
      await writeFile(domainAuth, "{}", "utf8");
      expect(resolveStoragePath(root, "https://example.com")).toBe(domainAuth);

      expect(resolveStoragePath(root, "https://unknown-site.org")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies cookies and localStorage to page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-test-state-"));
    const stateFile = path.join(root, "auth.json");
    try {
      await writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            { name: "session", value: "secret123", domain: ".example.com", path: "/" },
          ],
          origins: [
            {
              origin: "https://example.com",
              localStorage: [{ name: "token", value: "jwt456" }],
            },
          ],
        }),
        "utf8",
      );

      const setCookieMock = vi.fn().mockResolvedValue(undefined);
      const evaluateOnNewDocumentMock = vi.fn().mockResolvedValue(undefined);
      const fakePage = {
        setCookie: setCookieMock,
        evaluateOnNewDocument: evaluateOnNewDocumentMock,
      } as unknown as Page;

      const result = await applyStorageState(fakePage, stateFile);
      expect(result.cookiesCount).toBe(1);
      expect(result.originsCount).toBe(1);
      expect(setCookieMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "session", value: "secret123" }),
      );
      expect(evaluateOnNewDocumentMock).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers browser_eval tool with the extension API", () => {
    const registered: ToolDefinition[] = [];
    const fakePi: ExtensionAPI = {
      registerTool: (tool: ToolDefinition) => {
        registered.push(tool);
      },
    } as unknown as ExtensionAPI;

    browserExtension(fakePi);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("browser_eval");
  });

  it("executes browser_eval tool with custom code, relative paths, and display logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-test-eval-"));
    const fakeCtx = { cwd: root } as unknown as ExtensionContext;
    try {
      const code = `
        display("Log message from script");
        const title = await page.title();
        const pdfFile = await savePage("pdf", "my-report.pdf");
        return { custom: "data", title, pdfFile };
      `;
      const result = await executeBrowserEval(
        {
          url: "data:text/html,<html><head><title>Script Test</title></head><body><h1>Content</h1></body></html>",
          code,
        },
        undefined,
        fakeCtx,
      );

      expect(result.content[0]?.text).toContain("Log message from script");
      expect(result.content[0]?.text).toContain('"custom": "data"');
      expect(result.details.result).toEqual(
        expect.objectContaining({ custom: "data", title: "Script Test" }),
      );
      expect(existsSync(path.join(root, "my-report.pdf"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows browser_eval to manually load auth.json via loadAuth helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-test-loadauth-"));
    const fakeCtx = { cwd: root } as unknown as ExtensionContext;
    const authFile = path.join(root, "my-auth.json");
    try {
      await writeFile(
        authFile,
        JSON.stringify({
          cookies: [
            { name: "auth_token", value: "secret_val", domain: "example.com", path: "/" },
          ],
        }),
        "utf8",
      );

      const code = `
        const authResult = await loadAuth("my-auth.json");
        display("Loaded " + authResult.cookiesCount + " cookies");
        return { loaded: authResult.cookiesCount };
      `;
      const result = await executeBrowserEval(
        {
          url: "data:text/html,<html><head><title>Auth Test</title></head><body><h1>Content</h1></body></html>",
          code,
        },
        undefined,
        fakeCtx,
      );

      expect(result.content[0]?.text).toContain("Loaded 1 cookies");
      expect(result.details.result).toEqual({ loaded: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports stateful tab reuse and subsequent addressing via tab_id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-test-stateful-"));
    const hostBrowser = new HostBrowserManager({ workspace: root });
    const fakeCtx = { cwd: root } as unknown as ExtensionContext;
    try {
      await hostBrowser.start();

      // 1. Open tab (stays open by default)
      const first = await executeBrowserEval(
        {
          url: "data:text/html,<html><head><title>Page One</title></head><body><div id='target'>Step 1</div></body></html>",
          code: `
            const text = await page.evaluate(() => document.getElementById('target')?.innerText);
            return { text };
          `,
        },
        undefined,
        fakeCtx,
      );

      const tabId = first.details.tab_id as string;
      expect(tabId).toBeDefined();

      // 2. Address existing tab via tab_id and close it
      const second = await executeBrowserEval(
        {
          tab_id: tabId,
          code: `
            const text = await page.evaluate(() => document.getElementById('target')?.innerText);
            return { readText: text };
          `,
          close: true,
        },
        undefined,
        fakeCtx,
      );

      expect(second.details.result).toEqual(
        expect.objectContaining({ readText: "Step 1" }),
      );
    } finally {
      await hostBrowser.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("HostBrowserManager tracks tab events and evicts idle tabs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-test-host-events-"));
    const emittedEvents: BotEvent[] = [];
    const eventsMock = {
      emit: async (event: BotEvent) => {
        emittedEvents.push(event);
        return undefined;
      },
    } as unknown as EventSink;

    // 100ms idle timeout for testing
    const hostBrowser = new HostBrowserManager({
      workspace: root,
      events: eventsMock,
      tabIdleTimeoutMs: 100,
    });

    try {
      const cdpInfo = await hostBrowser.start();
      expect(cdpInfo.endpoint).toBeDefined();
      expect(existsSync(path.join(root, ".browser", "cdp.json"))).toBe(true);

      const session = await getBrowserSession(root);
      expect(session.isHostAttached).toBe(true);

      const page = await session.browser.newPage();
      await page.goto("data:text/html,<html><head><title>Tab Test</title></head><body>Active</body></html>");

      // Verify opened event
      expect(emittedEvents.some((e) => e.type === "browser_tab_opened")).toBe(true);

      // Wait for idle eviction window to elapse
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });
      await hostBrowser.evictIdleTabs();

      // Verify closed event with idle_timeout reason
      const closedEvent = emittedEvents.find((e) => e.type === "browser_tab_closed");
      expect(closedEvent).toBeDefined();
      if (closedEvent && closedEvent.type === "browser_tab_closed") {
        expect(closedEvent.reason).toBe("idle_timeout");
      }

      await session.close();
    } finally {
      await hostBrowser.stop();
      expect(existsSync(path.join(root, ".browser", "cdp.json"))).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  });
});
