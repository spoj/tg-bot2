import { existsSync, mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Target } from "puppeteer-core";
import { resolveChromeExecutable } from "../extensions/browser.js";
import type { EventSink } from "./events.js";

export interface HostBrowserOptions {
  workspace: string;
  events?: EventSink | undefined;
  tabIdleTimeoutMs?: number | undefined;
  cdpRemoteUrl?: string | undefined;
  port?: number | undefined;
}

export interface CdpInfo {
  endpoint: string;
  wsEndpoint?: string | undefined;
}

export interface TrackedTab {
  tabId: string;
  targetId: string;
  url: string;
  title?: string | undefined;
  createdAt: number;
  lastActivityAt: number;
}

export const DEFAULT_TAB_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
export const IDLE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

export class HostBrowserManager {
  private readonly workspace: string;
  private readonly events: EventSink | undefined;
  private readonly tabIdleTimeoutMs: number;
  private readonly cdpRemoteUrl: string | undefined;
  private readonly port: number;
  private browser: Browser | undefined;
  private cdpInfo: CdpInfo | undefined;
  private readonly tabs = new Map<string, TrackedTab>();
  private idleCheckTimer: NodeJS.Timeout | undefined;
  private isStopping = false;

  constructor(options: HostBrowserOptions) {
    this.workspace = options.workspace;
    this.events = options.events;
    this.tabIdleTimeoutMs = options.tabIdleTimeoutMs ?? DEFAULT_TAB_IDLE_TIMEOUT_MS;
    this.cdpRemoteUrl = options.cdpRemoteUrl ?? process.env.CDP_REMOTE_URL;
    this.port = options.port ?? 0;
  }

  async start(): Promise<CdpInfo> {
    if (this.cdpInfo && this.browser) {
      return this.cdpInfo;
    }

    const browserDir = path.join(this.workspace, ".browser");
    mkdirSync(browserDir, { recursive: true });
    const cdpFile = path.join(browserDir, "cdp.json");

    if (this.cdpRemoteUrl) {
      this.cdpInfo = { endpoint: this.cdpRemoteUrl };
      await writeFile(cdpFile, JSON.stringify(this.cdpInfo, null, 2), "utf8");
      return this.cdpInfo;
    }

    const executablePath = resolveChromeExecutable();
    const profileDir = path.join(browserDir, "profile");
    mkdirSync(profileDir, { recursive: true });

    const lockFile = path.join(profileDir, "SingletonLock");
    if (existsSync(lockFile)) {
      try {
        await rm(lockFile, { force: true });
      } catch {
        // Ignore if locked
      }
    }

    this.browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profileDir,
      args: [
        `--remote-debugging-port=${this.port}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    const wsEndpoint = this.browser.wsEndpoint();
    const parsed = new URL(wsEndpoint);
    const endpoint = `http://${parsed.host}`;

    this.cdpInfo = { endpoint, wsEndpoint };
    await writeFile(cdpFile, JSON.stringify(this.cdpInfo, null, 2), "utf8");

    this.browser.on("targetcreated", (target: Target) => {
      this.handleTargetCreated(target);
    });

    this.browser.on("targetdestroyed", (target: Target) => {
      this.handleTargetDestroyed(target);
    });

    this.browser.on("targetchanged", (target: Target) => {
      this.handleTargetChanged(target);
    });

    clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = setInterval(() => {
      void this.evictIdleTabs();
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref();

    return this.cdpInfo;
  }

  private handleTargetCreated(target: Target): void {
    if (target.type() !== "page") return;
    const targetId = this.extractTargetId(target);
    const tabId = targetId;
    const now = Date.now();
    const tracked: TrackedTab = {
      tabId,
      targetId,
      url: target.url(),
      createdAt: now,
      lastActivityAt: now,
    };
    this.tabs.set(targetId, tracked);

    void this.events?.emit({
      type: "browser_tab_opened",
      tabId,
      targetId,
      url: target.url(),
    });
  }

  private handleTargetChanged(target: Target): void {
    if (target.type() !== "page") return;
    const targetId = this.extractTargetId(target);
    const tracked = this.tabs.get(targetId);
    const newUrl = target.url();
    if (tracked) {
      tracked.lastActivityAt = Date.now();
      if (newUrl && newUrl !== tracked.url && !newUrl.startsWith("about:blank")) {
        tracked.url = newUrl;
        void this.events?.emit({
          type: "browser_tab_navigated",
          tabId: tracked.tabId,
          url: newUrl,
        });
      }
    }
  }

  private handleTargetDestroyed(target: Target): void {
    if (target.type() !== "page") return;
    const targetId = this.extractTargetId(target);
    const tracked = this.tabs.get(targetId);
    if (tracked) {
      const now = Date.now();
      const durationMs = now - tracked.createdAt;
      this.tabs.delete(targetId);

      void this.events?.emit({
        type: "browser_tab_closed",
        tabId: tracked.tabId,
        reason: "explicit",
        url: tracked.url,
        durationMs,
      });
    }

    this.checkAutoShutdown();
  }

  private extractTargetId(target: Target): string {
    const rawTarget = target as unknown as { _targetId?: string; _targetInfo?: { targetId?: string } };
    return rawTarget._targetId ?? rawTarget._targetInfo?.targetId ?? target.url() ?? String(Date.now());
  }

  touchTab(targetId: string): void {
    const tracked = this.tabs.get(targetId);
    if (tracked) {
      tracked.lastActivityAt = Date.now();
    }
  }

  async recordNavigation(targetId: string, url: string, title?: string): Promise<void> {
    const tracked = this.tabs.get(targetId);
    if (tracked) {
      tracked.url = url;
      if (title) tracked.title = title;
      tracked.lastActivityAt = Date.now();
      await this.events?.emit({
        type: "browser_tab_navigated",
        tabId: tracked.tabId,
        url,
        title,
      });
    }
  }

  async evictIdleTabs(): Promise<void> {
    if (!this.browser || this.isStopping) return;
    const now = Date.now();
    const targets = this.browser.targets();

    for (const target of targets) {
      if (target.type() !== "page") continue;
      const targetId = this.extractTargetId(target);
      const tracked = this.tabs.get(targetId);
      if (tracked && now - tracked.lastActivityAt >= this.tabIdleTimeoutMs) {
        try {
          const page = await target.page();
          if (page) {
            const durationMs = now - tracked.createdAt;
            this.tabs.delete(targetId);
            await this.events?.emit({
              type: "browser_tab_closed",
              tabId: tracked.tabId,
              reason: "idle_timeout",
              url: tracked.url,
              durationMs,
            });
            await page.close().catch(() => {});
          }
        } catch {
          // Ignore eviction failure
        }
      }
    }

    this.checkAutoShutdown();
  }

  private checkAutoShutdown(): void {
    if (this.isStopping || !this.browser) return;
    const pageTargets = this.browser.targets().filter((t) => t.type() === "page");
    if (pageTargets.length === 0) {
      void this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;
    try {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = undefined;

      const cdpFile = path.join(this.workspace, ".browser", "cdp.json");
      try {
        await rm(cdpFile, { force: true });
      } catch {
        // Ignore file cleanup error
      }

      this.tabs.clear();
      this.cdpInfo = undefined;

      if (this.browser) {
        try {
          await this.browser.close();
        } catch {
          // Ignore close error
        }
        this.browser = undefined;
      }
    } finally {
      this.isStopping = false;
    }
  }

  getInfo(): CdpInfo | undefined {
    return this.cdpInfo;
  }

  getOpenTabs(): TrackedTab[] {
    return Array.from(this.tabs.values());
  }
}
