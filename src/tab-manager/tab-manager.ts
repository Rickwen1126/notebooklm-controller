/**
 * TabManager — single Chrome instance, multi-tab management.
 *
 * Manages the lifecycle of a Chrome browser and its tabs via puppeteer-core.
 * Each tab corresponds to one NotebookLM notebook and is tracked as a TabHandle.
 */

import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TabHandle } from "../shared/types.js";
import { MAX_TABS, DEFAULT_SESSION_TIMEOUT_MS, findChromePath } from "../shared/config.js";
import { ChromeError, TabLimitError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { createTabHandle } from "./tab-handle.js";

const log = logger.child({ module: "TabManager" });

export class TabManager extends EventEmitter {
  private browser: Browser | null = null;
  private tabs: Map<string, TabHandle> = new Map();
  private headless = true;

  /**
   * Launch Chrome with the given options.
   * Throws ChromeError if no Chrome executable is found or launch fails.
   */
  async launch(options?: {
    headless?: boolean;
    userDataDir?: string;
    chromePath?: string;
  }): Promise<void> {
    if (this.browser) {
      throw new ChromeError("Browser is already launched");
    }

    const headless = options?.headless ?? true;
    this.headless = headless;

    const executablePath =
      options?.chromePath ?? findChromePath() ?? undefined;

    if (!executablePath) {
      throw new ChromeError(
        "Chrome executable not found. Provide chromePath or install Chrome.",
      );
    }

    const userDataDir =
      options?.userDataDir ?? join(homedir(), ".nbctl", "chrome-profile");

    try {
      this.browser = await puppeteer.launch({
        executablePath,
        headless,
        userDataDir,
        // null = use Chrome's own viewport, not Puppeteer's 800x600 default.
        defaultViewport: null,
        // Remove --enable-automation so Google doesn't block login.
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1440,900",
        ],
      });

      this.browser.on("disconnected", () => {
        log.error("Chrome disconnected unexpectedly");
        this.browser = null;
        this.tabs.clear();
        this.emit("chrome-error", new ChromeError("Chrome process exited unexpectedly"));
        this.emit("disconnected");
      });

      log.info("Chrome launched", {
        headless,
        userDataDir,
        executablePath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EACCES") || msg.includes("permission denied")) {
        throw new ChromeError(
          `Chrome userDataDir permission denied: ${userDataDir}. Check directory permissions.`,
        );
      }
      if (msg.includes("ENOENT") && msg.includes(executablePath)) {
        throw new ChromeError(
          `Chrome executable not found at ${executablePath}. Install Chrome or provide correct path.`,
        );
      }
      throw new ChromeError(
        `Failed to launch Chrome: ${msg}`,
      );
    }
  }

  /**
   * Open a new tab, navigate to the given URL, create a CDP session, and return a TabHandle.
   * Throws TabLimitError if the maximum number of tabs has been reached.
   */
  async openTab(notebookAlias: string, url: string): Promise<TabHandle> {
    if (!this.browser) {
      throw new ChromeError("Browser is not launched");
    }

    if (this.tabs.size >= MAX_TABS) {
      throw new TabLimitError(MAX_TABS);
    }

    const page = await this.browser.newPage();
    await page.goto(url);
    const cdpSession = await page.createCDPSession();

    const handle = createTabHandle({
      notebookAlias,
      url,
      cdpSession,
      page,
    });

    this.tabs.set(handle.tabId, handle);

    log.info("Tab opened", {
      tabId: handle.tabId,
      notebookAlias,
      url,
    });

    return handle;
  }

  /**
   * Acquire a tab from the pool for a task.
   *
   * Priority: 1) idle tab with same notebookAlias (weak affinity),
   * 2) any idle tab, 3) open a new tab if under limit.
   * Throws TabLimitError if pool is at capacity with no idle tabs.
   */
  async acquireTab(params: {
    notebookAlias: string;
    url: string;
  }): Promise<TabHandle> {
    if (!this.browser) {
      throw new ChromeError("Browser is not launched");
    }

    // 1. Prefer idle tab with matching notebook (weak affinity)
    for (const tab of this.tabs.values()) {
      if (tab.state === "idle" && tab.notebookAlias === params.notebookAlias) {
        tab.state = "active";
        tab.acquiredAt = new Date().toISOString();
        tab.timeoutAt = new Date(Date.now() + DEFAULT_SESSION_TIMEOUT_MS).toISOString();
        tab.releasedAt = null;
        log.info("Tab acquired (affinity)", { tabId: tab.tabId, notebookAlias: params.notebookAlias });
        return tab;
      }
    }

    // 2. Any idle tab — mark active before async navigate to prevent race condition
    for (const tab of this.tabs.values()) {
      if (tab.state === "idle") {
        // Mark as active immediately so concurrent callers skip this tab.
        tab.state = "active";
        tab.notebookAlias = params.notebookAlias;
        tab.url = params.url;
        tab.acquiredAt = new Date().toISOString();
        tab.timeoutAt = new Date(Date.now() + DEFAULT_SESSION_TIMEOUT_MS).toISOString();
        tab.releasedAt = null;

        try {
          await tab.page.goto(params.url);
        } catch (err) {
          // Navigate failed — rollback state so the tab can be reused.
          tab.state = "idle";
          tab.releasedAt = new Date().toISOString();
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("Tab navigate failed during acquire, rolling back to idle", {
            tabId: tab.tabId,
            error: msg,
          });
          throw err;
        }

        log.info("Tab acquired (reuse)", { tabId: tab.tabId, notebookAlias: params.notebookAlias });
        return tab;
      }
    }

    // 3. Open new tab if under limit
    if (this.tabs.size >= MAX_TABS) {
      throw new TabLimitError(MAX_TABS);
    }

    return await this.openTab(params.notebookAlias, params.url);
  }

  /**
   * Release a tab back to the pool (mark idle, keep open for reuse).
   */
  async releaseTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab.state = "idle";
    tab.releasedAt = new Date().toISOString();
    log.info("Tab released to pool", { tabId, notebookAlias: tab.notebookAlias });
  }

  /**
   * Close a specific tab by its tabId and remove it from tracking.
   */
  async closeTab(tabId: string): Promise<void> {
    const handle = this.tabs.get(tabId);
    if (!handle) {
      return;
    }

    await handle.page.close();
    this.tabs.delete(tabId);

    log.info("Tab closed", { tabId, notebookAlias: handle.notebookAlias });
  }

  /**
   * Get a specific tab by its tabId.
   */
  getTab(tabId: string): TabHandle | undefined {
    return this.tabs.get(tabId);
  }

  /**
   * List all TabHandles (both active and idle).
   */
  listTabs(): TabHandle[] {
    return Array.from(this.tabs.values());
  }

  /**
   * List only idle (available) tabs.
   */
  listIdleTabs(): TabHandle[] {
    return Array.from(this.tabs.values()).filter((t) => t.state === "idle");
  }

  /**
   * List only active (in-use) tabs.
   */
  listActiveTabs(): TabHandle[] {
    return Array.from(this.tabs.values()).filter((t) => t.state === "active");
  }

  /**
   * Check if the browser is still connected.
   */
  isConnected(): boolean {
    return this.browser !== null;
  }

  /**
   * Close all tabs and the browser.
   */
  async shutdown(): Promise<void> {
    for (const [tabId, handle] of this.tabs) {
      try {
        await handle.page.close();
      } catch {
        // Tab may already be closed
      }
      this.tabs.delete(tabId);
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    log.info("TabManager shut down");
  }

  /**
   * Switch between headed and headless mode.
   * Closes the current browser and relaunches with the new mode.
   */
  async switchMode(headless: boolean): Promise<void> {
    if (!this.browser) {
      throw new ChromeError("Browser is not launched");
    }

    const activeCount = Array.from(this.tabs.values()).filter(
      (t) => t.state === "active",
    ).length;
    if (activeCount > 0) {
      throw new ChromeError(
        `Cannot switch mode: ${activeCount} active tab(s). Close them first.`,
      );
    }

    log.info("Switching browser mode", {
      from: this.headless ? "headless" : "headed",
      to: headless ? "headless" : "headed",
    });

    await this.shutdown();
    await this.launch({ headless });
  }
}
