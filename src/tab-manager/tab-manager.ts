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
import { MAX_TABS, findChromePath } from "../shared/config.js";
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
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
        ],
      });

      this.browser.on("disconnected", () => {
        log.error("Chrome disconnected unexpectedly");
        this.emit("disconnected");
        this.browser = null;
        this.tabs.clear();
      });

      log.info("Chrome launched", {
        headless,
        userDataDir,
        executablePath,
      });
    } catch (err) {
      throw new ChromeError(
        `Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`,
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
   * List all active TabHandles.
   */
  listTabs(): TabHandle[] {
    return Array.from(this.tabs.values());
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

    if (this.tabs.size > 0) {
      throw new ChromeError(
        `Cannot switch mode: ${this.tabs.size} active tab(s). Close them first.`,
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
