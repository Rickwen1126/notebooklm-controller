import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ── Mock puppeteer-core ──────────────────────────────────────────────

function createMockPage() {
  return {
    goto: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({})) })),
    url: vi.fn(() => "https://notebooklm.google.com/notebook/test"),
  };
}

function createMockBrowser() {
  type EventHandler = (...args: unknown[]) => void;
  const pages: ReturnType<typeof createMockPage>[] = [];
  const listeners: Record<string, EventHandler[]> = {};
  return {
    newPage: vi.fn(async () => {
      const page = createMockPage();
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: EventHandler) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    }),
    pages: vi.fn(async () => pages),
    _emit: (event: string) => listeners[event]?.forEach((h) => h()),
    _pages: pages,
  };
}

let mockBrowser: ReturnType<typeof createMockBrowser>;

vi.mock("puppeteer-core", () => ({
  default: {
    launch: vi.fn(async () => mockBrowser),
  },
}));

// ── Mock config.findChromePath ──────────────────────────────────────

vi.mock("../../../src/shared/config.js", async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import("../../../src/shared/config.js");
  return {
    ...original,
    findChromePath: vi.fn(
      () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
  };
});

// ── Import after mocks ──────────────────────────────────────────────

import { TabManager } from "../../../src/tab-manager/tab-manager.js";
import { TabLimitError, ChromeError } from "../../../src/shared/errors.js";
import { MAX_TABS } from "../../../src/shared/config.js";
import puppeteer from "puppeteer-core";

// ── Tests ───────────────────────────────────────────────────────────

describe("TabManager", () => {
  let tm: TabManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = createMockBrowser();
    tm = new TabManager();
  });

  describe("launch", () => {
    it("launches Chrome with correct userDataDir and headless args", async () => {
      await tm.launch({ headless: true });

      expect(puppeteer.launch).toHaveBeenCalledTimes(1);
      const callArgs = (puppeteer.launch as Mock).mock.calls[0][0];
      expect(callArgs.headless).toBe(true);
      expect(callArgs.userDataDir).toContain(".nbctl");
      expect(callArgs.executablePath).toBe(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );
      expect(callArgs.args).toEqual(
        expect.arrayContaining(["--no-first-run"]),
      );
    });

    it("uses provided chromePath and userDataDir", async () => {
      await tm.launch({
        headless: false,
        chromePath: "/custom/chrome",
        userDataDir: "/custom/profile",
      });

      const callArgs = (puppeteer.launch as Mock).mock.calls[0][0];
      expect(callArgs.executablePath).toBe("/custom/chrome");
      expect(callArgs.userDataDir).toBe("/custom/profile");
      expect(callArgs.headless).toBe(false);
    });

    it("throws ChromeError if browser is already launched", async () => {
      await tm.launch();
      await expect(tm.launch()).rejects.toThrow(ChromeError);
    });

    it("throws ChromeError with permission message for EACCES", async () => {
      (puppeteer.launch as Mock).mockRejectedValueOnce(
        new Error("EACCES: permission denied, mkdir '/bad/path'"),
      );

      await expect(tm.launch()).rejects.toThrow(ChromeError);
      // Verify the error message mentions permission denied.
      (puppeteer.launch as Mock).mockRejectedValueOnce(
        new Error("EACCES: permission denied, mkdir '/bad/path'"),
      );
      const freshTm = new TabManager();
      await expect(freshTm.launch()).rejects.toThrow(/permission denied/);
    });

    it("throws ChromeError with ENOENT message when chrome path missing", async () => {
      (puppeteer.launch as Mock).mockRejectedValueOnce(
        new Error(
          "ENOENT: no such file or directory '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'",
        ),
      );

      await expect(tm.launch()).rejects.toThrow(/Chrome executable not found/);
    });

    it("throws ChromeError with generic message for unknown errors", async () => {
      (puppeteer.launch as Mock).mockRejectedValueOnce(
        new Error("something unexpected"),
      );

      await expect(tm.launch()).rejects.toThrow(/Failed to launch Chrome/);
    });
  });

  describe("openTab", () => {
    it("creates new page, navigates to URL, returns TabHandle", async () => {
      await tm.launch();
      const url = "https://notebooklm.google.com/notebook/abc123";

      const handle = await tm.openTab("my-notebook", url);

      expect(handle.notebookAlias).toBe("my-notebook");
      expect(handle.url).toBe(url);
      expect(handle.tabId).toBeDefined();
      expect(handle.acquiredAt).toBeDefined();
      expect(handle.timeoutAt).toBeDefined();
      expect(handle.page).toBeDefined();
      expect(handle.cdpSession).toBeDefined();

      // Verify page interactions
      const page = mockBrowser._pages[0];
      expect(page.goto).toHaveBeenCalledWith(url);
      expect(page.createCDPSession).toHaveBeenCalled();
    });

    it("throws TabLimitError when max tabs reached", async () => {
      await tm.launch();

      // Fill up to MAX_TABS
      for (let i = 0; i < MAX_TABS; i++) {
        await tm.openTab(
          `notebook-${i}`,
          `https://notebooklm.google.com/notebook/${i}`,
        );
      }

      await expect(
        tm.openTab(
          "one-too-many",
          "https://notebooklm.google.com/notebook/overflow",
        ),
      ).rejects.toThrow(TabLimitError);
    });

    it("throws ChromeError if browser is not launched", async () => {
      await expect(
        tm.openTab("alias", "https://notebooklm.google.com/notebook/x"),
      ).rejects.toThrow(ChromeError);
    });
  });

  describe("closeTab", () => {
    it("closes page and removes from tracking", async () => {
      await tm.launch();
      const handle = await tm.openTab(
        "nb",
        "https://notebooklm.google.com/notebook/1",
      );

      expect(tm.listTabs()).toHaveLength(1);

      await tm.closeTab(handle.tabId);

      expect(tm.listTabs()).toHaveLength(0);
      expect(tm.getTab(handle.tabId)).toBeUndefined();

      const page = mockBrowser._pages[0];
      expect(page.close).toHaveBeenCalled();
    });

    it("does nothing for unknown tabId", async () => {
      await tm.launch();
      // Should not throw
      await tm.closeTab("non-existent-id");
    });
  });

  describe("listTabs", () => {
    it("returns all active TabHandles", async () => {
      await tm.launch();
      const h1 = await tm.openTab(
        "nb1",
        "https://notebooklm.google.com/notebook/1",
      );
      const h2 = await tm.openTab(
        "nb2",
        "https://notebooklm.google.com/notebook/2",
      );

      const tabs = tm.listTabs();

      expect(tabs).toHaveLength(2);
      expect(tabs.map((t) => t.tabId)).toContain(h1.tabId);
      expect(tabs.map((t) => t.tabId)).toContain(h2.tabId);
    });

    it("returns empty array when no tabs are open", async () => {
      await tm.launch();
      expect(tm.listTabs()).toEqual([]);
    });
  });

  describe("getTab", () => {
    it("returns specific tab by tabId", async () => {
      await tm.launch();
      const handle = await tm.openTab(
        "nb",
        "https://notebooklm.google.com/notebook/1",
      );

      const found = tm.getTab(handle.tabId);

      expect(found).toBeDefined();
      expect(found!.tabId).toBe(handle.tabId);
      expect(found!.notebookAlias).toBe("nb");
    });

    it("returns undefined for unknown tabId", async () => {
      await tm.launch();
      expect(tm.getTab("unknown")).toBeUndefined();
    });
  });

  describe("Chrome crash detection", () => {
    it("emits disconnected event and clears state on browser disconnect", async () => {
      await tm.launch();
      await tm.openTab("nb", "https://notebooklm.google.com/notebook/1");

      expect(tm.listTabs()).toHaveLength(1);
      expect(tm.isConnected()).toBe(true);

      const disconnectedPromise = new Promise<void>((resolve) => {
        tm.on("disconnected", resolve);
      });

      // Simulate browser crash
      mockBrowser._emit("disconnected");

      await disconnectedPromise;

      expect(tm.isConnected()).toBe(false);
      expect(tm.listTabs()).toHaveLength(0);
    });

    it("emits chrome-error event with ChromeError on disconnect", async () => {
      await tm.launch();

      const errorPromise = new Promise<Error>((resolve) => {
        tm.on("chrome-error", resolve);
      });

      mockBrowser._emit("disconnected");

      const err = await errorPromise;
      expect(err).toBeInstanceOf(ChromeError);
      expect(err.message).toContain("unexpectedly");
    });
  });

  describe("shutdown", () => {
    it("closes all tabs and browser", async () => {
      await tm.launch();
      await tm.openTab("nb1", "https://notebooklm.google.com/notebook/1");
      await tm.openTab("nb2", "https://notebooklm.google.com/notebook/2");

      expect(tm.listTabs()).toHaveLength(2);

      await tm.shutdown();

      expect(tm.listTabs()).toHaveLength(0);
      expect(tm.isConnected()).toBe(false);
      expect(mockBrowser.close).toHaveBeenCalled();

      // Each page should have been closed
      expect(mockBrowser._pages[0].close).toHaveBeenCalled();
      expect(mockBrowser._pages[1].close).toHaveBeenCalled();
    });

    it("handles shutdown when no browser is launched", async () => {
      // Should not throw
      await tm.shutdown();
    });
  });

  describe("Mode switching", () => {
    it("switches between headed and headless modes", async () => {
      await tm.launch({ headless: true });

      // Create a fresh mock browser for the relaunch
      const originalBrowser = mockBrowser;
      mockBrowser = createMockBrowser();

      await tm.switchMode(false);

      // Old browser should have been closed
      expect(originalBrowser.close).toHaveBeenCalled();

      // New browser should be launched in headed mode
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      const secondCallArgs = (puppeteer.launch as Mock).mock.calls[1][0];
      expect(secondCallArgs.headless).toBe(false);

      expect(tm.isConnected()).toBe(true);
    });

    it("throws ChromeError if browser is not launched", async () => {
      await expect(tm.switchMode(true)).rejects.toThrow(ChromeError);
    });

    it("throws ChromeError if there are active tabs", async () => {
      await tm.launch({ headless: true });
      await tm.openTab("nb", "https://notebooklm.google.com/notebook/1");

      await expect(tm.switchMode(false)).rejects.toThrow(ChromeError);
      await expect(tm.switchMode(false)).rejects.toThrow(/active tab/);

      // Browser should still be running (not shut down).
      expect(tm.isConnected()).toBe(true);
    });

    it("succeeds after all tabs are closed", async () => {
      await tm.launch({ headless: true });
      const handle = await tm.openTab("nb", "https://notebooklm.google.com/notebook/1");
      await tm.closeTab(handle.tabId);

      mockBrowser = createMockBrowser();
      await tm.switchMode(false);

      expect(tm.isConnected()).toBe(true);
    });
  });

  // ── Tab Pool: acquireTab / releaseTab ─────────────────────────────

  describe("acquireTab", () => {
    it("opens new tab when pool is empty", async () => {
      await tm.launch();
      const handle = await tm.acquireTab({
        notebookAlias: "nb1",
        url: "https://notebooklm.google.com/notebook/1",
      });

      expect(handle.notebookAlias).toBe("nb1");
      expect(handle.state).toBe("active");
      expect(handle.releasedAt).toBeNull();
      expect(tm.listTabs()).toHaveLength(1);
    });

    it("returns idle tab with matching alias (affinity)", async () => {
      await tm.launch();
      const original = await tm.openTab("nb1", "https://notebooklm.google.com/notebook/1");
      await tm.releaseTab(original.tabId);
      expect(original.state).toBe("idle");

      const reacquired = await tm.acquireTab({
        notebookAlias: "nb1",
        url: "https://notebooklm.google.com/notebook/1",
      });

      expect(reacquired.tabId).toBe(original.tabId);
      expect(reacquired.state).toBe("active");
      expect(reacquired.releasedAt).toBeNull();
      // Should not have opened a new tab
      expect(tm.listTabs()).toHaveLength(1);
    });

    it("reuses any idle tab when no affinity match", async () => {
      await tm.launch();
      const other = await tm.openTab("other-nb", "https://notebooklm.google.com/notebook/other");
      await tm.releaseTab(other.tabId);

      const acquired = await tm.acquireTab({
        notebookAlias: "nb1",
        url: "https://notebooklm.google.com/notebook/1",
      });

      expect(acquired.tabId).toBe(other.tabId);
      expect(acquired.notebookAlias).toBe("nb1");
      expect(acquired.state).toBe("active");
      // Page should have been navigated
      const page = mockBrowser._pages[0];
      expect(page.goto).toHaveBeenCalledWith("https://notebooklm.google.com/notebook/1");
    });

    it("throws TabLimitError when pool is full with no idle tabs", async () => {
      await tm.launch();
      for (let i = 0; i < MAX_TABS; i++) {
        await tm.openTab(`nb-${i}`, `https://notebooklm.google.com/notebook/${i}`);
      }

      await expect(
        tm.acquireTab({ notebookAlias: "overflow", url: "https://notebooklm.google.com/notebook/overflow" }),
      ).rejects.toThrow(TabLimitError);
    });

    it("reuses idle tab even when pool is at capacity", async () => {
      await tm.launch();
      const tabs = [];
      for (let i = 0; i < MAX_TABS; i++) {
        tabs.push(await tm.openTab(`nb-${i}`, `https://notebooklm.google.com/notebook/${i}`));
      }
      // Release one tab
      await tm.releaseTab(tabs[0].tabId);

      const acquired = await tm.acquireTab({
        notebookAlias: "new-nb",
        url: "https://notebooklm.google.com/notebook/new",
      });

      expect(acquired.tabId).toBe(tabs[0].tabId);
      expect(acquired.notebookAlias).toBe("new-nb");
      expect(acquired.state).toBe("active");
    });

    it("throws ChromeError if browser is not launched", async () => {
      await expect(
        tm.acquireTab({ notebookAlias: "nb", url: "https://notebooklm.google.com/notebook/1" }),
      ).rejects.toThrow(ChromeError);
    });
  });

  describe("releaseTab", () => {
    it("marks tab as idle and sets releasedAt", async () => {
      await tm.launch();
      const handle = await tm.openTab("nb", "https://notebooklm.google.com/notebook/1");
      expect(handle.state).toBe("active");

      await tm.releaseTab(handle.tabId);

      expect(handle.state).toBe("idle");
      expect(handle.releasedAt).not.toBeNull();
    });

    it("is a no-op for unknown tabId", async () => {
      await tm.launch();
      // Should not throw
      await tm.releaseTab("nonexistent-id");
    });

    it("tab remains in pool after release", async () => {
      await tm.launch();
      const handle = await tm.openTab("nb", "https://notebooklm.google.com/notebook/1");
      await tm.releaseTab(handle.tabId);

      expect(tm.listTabs()).toHaveLength(1);
      expect(tm.listIdleTabs()).toHaveLength(1);
      expect(tm.listActiveTabs()).toHaveLength(0);
    });
  });

  describe("listIdleTabs / listActiveTabs", () => {
    it("correctly partitions tabs by state", async () => {
      await tm.launch();
      const h1 = await tm.openTab("nb1", "https://notebooklm.google.com/notebook/1");
      const h2 = await tm.openTab("nb2", "https://notebooklm.google.com/notebook/2");
      await tm.releaseTab(h1.tabId);

      expect(tm.listTabs()).toHaveLength(2);
      expect(tm.listActiveTabs()).toHaveLength(1);
      expect(tm.listActiveTabs()[0].tabId).toBe(h2.tabId);
      expect(tm.listIdleTabs()).toHaveLength(1);
      expect(tm.listIdleTabs()[0].tabId).toBe(h1.tabId);
    });
  });
});
