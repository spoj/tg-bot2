import { existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BROWSER_EVAL_SCHEMA = Type.Object({
  code: Type.String({ description: "Async JavaScript automation code. Variables in scope: page (Puppeteer Page), browser (Puppeteer Browser), display ((...args: unknown[]) => void), loadAuth ((authPath: string) => Promise<{ cookiesCount: number; originsCount: number }>), savePage ((format: 'pdf' | 'mhtml' | 'html', filename?: string) => Promise<string>), url (string | undefined), tab_id (string). Relative file paths resolve to workspace." }),
  url: Type.Optional(Type.String({ description: "Optional initial URL to navigate to before executing the script" })),
  tab_id: Type.Optional(Type.String({ description: "Optional existing tab ID to execute code in (omit to open a new tab)" })),
  auth: Type.Optional(Type.String({ description: "Optional path to Playwright/Puppeteer storageState JSON file (relative or absolute)" })),
  close: Type.Optional(Type.Boolean({ description: "Explicitly close this tab after script completes (default false: tab remains open in background for up to 2 hours of inactivity)" })),
  timeout_ms: Type.Optional(Type.Number({ description: "Execution timeout in milliseconds (default 60000)" })),
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

const DEFAULT_EXECUTABLES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => typeof p === "string" && p.length > 0);

export function resolveChromeExecutable(): string {
  for (const candidate of DEFAULT_EXECUTABLES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome/Chromium executable found (checked PUPPETEER_EXECUTABLE_PATH, /usr/bin/google-chrome-stable, /usr/bin/chromium)");
}

export interface StorageStateCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | string;
}

export interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies?: StorageStateCookie[];
  origins?: StorageStateOrigin[];
}

export function resolveStoragePath(cwd: string, url?: string, explicitAuth?: string): string | undefined {
  if (explicitAuth) {
    const candidate = path.isAbsolute(explicitAuth) ? explicitAuth : path.resolve(cwd, explicitAuth);
    if (existsSync(candidate)) return candidate;
    throw new Error(`Auth file not found at ${explicitAuth}`);
  }

  if (url) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      const candidates = [
        path.join(cwd, ".browser", "auth", `${hostname}.json`),
        path.join(cwd, ".browser", "auth.json"),
        path.join(cwd, "auth.json"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    } catch {
      // Ignore invalid target URL during path probe
    }
  }
  return undefined;
}

export async function applyStorageState(page: Page, storagePath: string): Promise<{ cookiesCount: number; originsCount: number }> {
  const raw = await fs.readFile(storagePath, "utf8");
  const state: StorageState = JSON.parse(raw);
  let cookiesCount = 0;
  let originsCount = 0;

  if (Array.isArray(state.cookies) && state.cookies.length > 0) {
    const validCookies = state.cookies.map((c) => {
      const cookie: {
        name: string;
        value: string;
        path: string;
        domain?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "None" | "Strict" | "Lax";
      } = {
        name: c.name,
        value: c.value,
        path: c.path ?? "/",
      };
      if (typeof c.domain === "string") cookie.domain = c.domain;
      if (typeof c.expires === "number" && c.expires > 0) cookie.expires = c.expires;
      if (typeof c.httpOnly === "boolean") cookie.httpOnly = c.httpOnly;
      if (typeof c.secure === "boolean") cookie.secure = c.secure;
      if (c.sameSite === "None" || c.sameSite === "Strict" || c.sameSite === "Lax") cookie.sameSite = c.sameSite;
      return cookie;
    });
    await page.setCookie(...validCookies);
    cookiesCount = validCookies.length;
  }

  if (Array.isArray(state.origins) && state.origins.length > 0) {
    await page.evaluateOnNewDocument((origins) => {
      for (const origin of origins) {
        if (window.location.origin === origin.origin && Array.isArray(origin.localStorage)) {
          for (const item of origin.localStorage) {
            window.localStorage.setItem(item.name, item.value);
          }
        }
      }
    }, state.origins);
    originsCount = state.origins.length;
  }

  return { cookiesCount, originsCount };
}

export async function resolveCdpInfo(cwd: string): Promise<{ endpoint?: string; wsEndpoint?: string } | undefined> {
  const envUrl = process.env.CDP_REMOTE_URL ?? process.env.PUPPETEER_REMOTE_URL;
  if (envUrl) return { endpoint: envUrl };

  const cdpFile = path.join(cwd, ".browser", "cdp.json");
  if (existsSync(cdpFile)) {
    try {
      const raw = await fs.readFile(cdpFile, "utf8");
      return JSON.parse(raw);
    } catch {
      // Ignore parse error
    }
  }
  return undefined;
}

export async function launchBrowser(cwd: string, signal?: AbortSignal): Promise<Browser> {
  const executablePath = resolveChromeExecutable();
  const profileDir = path.join(cwd, ".browser", "profile");
  mkdirSync(profileDir, { recursive: true });

  const lockFile = path.join(profileDir, "SingletonLock");
  if (existsSync(lockFile)) {
    try {
      await fs.unlink(lockFile);
    } catch {
      // Ignore if locked
    }
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profileDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  if (signal) {
    if (signal.aborted) {
      await browser.close().catch(() => {});
      throw new Error("Browser operation aborted");
    }
    signal.addEventListener("abort", () => {
      browser.close().catch(() => {});
    }, { once: true });
  }

  return browser;
}

export interface BrowserSession {
  browser: Browser;
  isHostAttached: boolean;
  close: () => Promise<void>;
}

export async function getBrowserSession(cwd: string, signal?: AbortSignal): Promise<BrowserSession> {
  const cdp = await resolveCdpInfo(cwd);
  if (cdp?.wsEndpoint || cdp?.endpoint) {
    try {
      const connectOptions: { defaultViewport: null; browserWSEndpoint?: string; browserURL?: string } = {
        defaultViewport: null,
      };
      if (typeof cdp.wsEndpoint === "string") {
        connectOptions.browserWSEndpoint = cdp.wsEndpoint;
      } else if (typeof cdp.endpoint === "string") {
        connectOptions.browserURL = cdp.endpoint;
      }
      const browser = await puppeteer.connect(connectOptions);
      return {
        browser,
        isHostAttached: true,
        close: async () => {
          browser.disconnect();
        },
      };
    } catch {
      // Fallback to local launch if host connection fails
    }
  }

  const browser = await launchBrowser(cwd, signal);
  return {
    browser,
    isHostAttached: false,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

export async function resolvePage(browser: Browser, tabId?: string): Promise<{ page: Page; tabId: string }> {
  if (tabId) {
    const targets = browser.targets();
    for (const target of targets) {
      if (target.type() === "page") {
        const raw = target as unknown as { _targetId?: string; _targetInfo?: { targetId?: string } };
        const id = raw._targetId ?? raw._targetInfo?.targetId;
        if (id === tabId) {
          const page = await target.page();
          if (page) return { page, tabId };
        }
      }
    }
  }

  const page = await browser.newPage();
  const rawTarget = page.target() as unknown as { _targetId?: string; _targetInfo?: { targetId?: string } };
  const resolvedId = rawTarget._targetId ?? rawTarget._targetInfo?.targetId ?? String(Date.now());
  return { page, tabId: resolvedId };
}

export async function setupPageDownloads(page: Page, cwd: string): Promise<string> {
  const downloadDir = path.join(cwd, ".browser", "downloads");
  mkdirSync(downloadDir, { recursive: true });
  try {
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });
  } catch {
    // Ignore if unsupported in custom transport
  }
  return downloadDir;
}

export async function savePageArtifact(
  page: Page,
  cwd: string,
  format: string,
  customFilename?: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let targetPath: string;

  if (customFilename) {
    targetPath = path.isAbsolute(customFilename) ? customFilename : path.resolve(cwd, customFilename);
  } else {
    const downloadDir = path.join(cwd, ".browser", "downloads");
    const ext = format.toLowerCase() === "pdf" ? "pdf" : format.toLowerCase() === "mhtml" ? "mhtml" : "html";
    targetPath = path.join(downloadDir, `page-${timestamp}.${ext}`);
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });

  switch (format.toLowerCase()) {
    case "pdf": {
      const finalPath = targetPath.endsWith(".pdf") ? targetPath : `${targetPath}.pdf`;
      await page.pdf({ path: finalPath, format: "A4", printBackground: true });
      return finalPath;
    }
    case "mhtml": {
      const finalPath = targetPath.endsWith(".mhtml") ? targetPath : `${targetPath}.mhtml`;
      const client = await page.createCDPSession();
      const response = await client.send("Page.captureSnapshot", { format: "mhtml" });
      const data = typeof response === "object" && response && "data" in response ? String(response.data) : "";
      await fs.writeFile(finalPath, data, "utf8");
      return finalPath;
    }
    case "html": {
      const finalPath = targetPath.endsWith(".html") ? targetPath : `${targetPath}.html`;
      const html = await page.content();
      await fs.writeFile(finalPath, html, "utf8");
      return finalPath;
    }
    default:
      throw new Error(`Unsupported save format '${format}'; use 'pdf', 'mhtml', or 'html'`);
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function executeBrowserEval(
  params: {
    code: string;
    url?: string;
    tab_id?: string;
    close?: boolean;
    auth?: string;
    timeout_ms?: number;
  },
  _signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult> {
  let session: BrowserSession | undefined;
  let pageInstance: { page: Page; tabId: string } | undefined;
  const logs: string[] = [];
  const display = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  };

  try {
    session = await getBrowserSession(ctx.cwd, _signal);
    pageInstance = await resolvePage(session.browser, params.tab_id);
    const { page, tabId } = pageInstance;
    const timeout = params.timeout_ms ?? 60000;
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    await setupPageDownloads(page, ctx.cwd);

    if (params.url) {
      const storagePath = resolveStoragePath(ctx.cwd, params.url, params.auth);
      if (storagePath) {
        await applyStorageState(page, storagePath);
      }
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout });
    } else if (params.auth) {
      const candidate = path.isAbsolute(params.auth) ? params.auth : path.resolve(ctx.cwd, params.auth);
      if (existsSync(candidate)) {
        await applyStorageState(page, candidate);
      }
    }

    const loadAuth = (authPath: string) =>
      applyStorageState(page, path.isAbsolute(authPath) ? authPath : path.resolve(ctx.cwd, authPath));
    const savePage = (format: string, filename?: string) =>
      savePageArtifact(page, ctx.cwd, format, filename);

    const runner = new AsyncFunction("page", "browser", "display", "url", "tab_id", "loadAuth", "savePage", params.code);
    const result = await runner(page, session.browser, display, params.url, tabId, loadAuth, savePage);

    const outputParts: string[] = [`Tab ID: ${tabId}`];
    if (logs.length > 0) {
      outputParts.push(`Logs:\n${logs.join("\n")}`);
    }
    if (result !== undefined) {
      outputParts.push(`Result:\n${typeof result === "object" ? JSON.stringify(result, null, 2) : String(result)}`);
    }

    const outputText = outputParts.join("\n\n");
    return {
      content: [{ type: "text", text: outputText }],
      details: {
        tab_id: tabId,
        result,
        logs,
      },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Browser eval failed: ${String(error)}\n${logs.length > 0 ? `\nLogs before failure:\n${logs.join("\n")}` : ""}` }],
      details: {},
    };
  } finally {
    if (pageInstance && params.close) {
      await pageInstance.page.close().catch(() => {});
    }
    if (session) {
      await session.close().catch(() => {});
    }
  }
}

export default function browserExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "browser_eval",
    label: "Browser Automation",
    description: "Execute async Puppeteer automation script in headless Chrome. Variables in scope: page, browser, display, loadAuth, savePage, url, tab_id. Relative paths resolve to workspace. Tabs stay open in background by default.",
    promptSnippet: "browser_eval: Run Puppeteer JS script with page, browser, display, loadAuth, savePage",
    parameters: BROWSER_EVAL_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeBrowserEval(params as Parameters<typeof executeBrowserEval>[0], signal, ctx);
    },
  });
}
