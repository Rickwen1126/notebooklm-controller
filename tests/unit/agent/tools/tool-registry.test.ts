import { describe, it, expect, vi } from "vitest";

// Mock @github/copilot-sdk before importing anything that uses it.
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: Record<string, unknown>) => ({
    name,
    ...config,
  }),
}));

// Mock cdp-helpers to avoid loading puppeteer-core internals.
vi.mock("../../../../src/tab-manager/cdp-helpers.js", () => ({
  captureScreenshot: vi.fn().mockResolvedValue("base64data"),
  dispatchClick: vi.fn().mockResolvedValue(undefined),
  dispatchType: vi.fn().mockResolvedValue(undefined),
  dispatchScroll: vi.fn().mockResolvedValue(undefined),
  dispatchPaste: vi.fn().mockResolvedValue(undefined),
}));

// Suppress logger output during tests.
vi.mock("../../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

import { buildToolsForTab } from "../../../../src/agent/tools/index.js";
import type { TabHandle } from "../../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Minimal Tool shape (avoids importing the real SDK module)
// ---------------------------------------------------------------------------

interface TestTool {
  name: string;
  description?: string;
  parameters?: unknown;
  handler: (args: any, invocation: any) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockTabHandle(overrides?: Partial<TabHandle>): TabHandle {
  return {
    tabId: "tab-1",
    notebookAlias: "test-notebook",
    url: "https://notebooklm.google.com/notebook/abc",
    acquiredAt: new Date().toISOString(),
    timeoutAt: new Date(Date.now() + 300_000).toISOString(),
    cdpSession: { send: vi.fn() } as never,
    page: {} as never,
    ...overrides,
  };
}

function createMockNetworkGate() {
  return {
    reportAnomaly: vi.fn(),
    acquirePermit: vi.fn().mockResolvedValue(undefined),
    getHealth: vi.fn().mockReturnValue({ status: "healthy" }),
    reset: vi.fn(),
  };
}

function createMockCacheManager() {
  return {
    addSource: vi.fn().mockResolvedValue(undefined),
    updateSource: vi.fn().mockResolvedValue(undefined),
    removeSource: vi.fn().mockResolvedValue(undefined),
    addArtifact: vi.fn().mockResolvedValue(undefined),
    removeArtifact: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Expected tool names
// ---------------------------------------------------------------------------

/** Browser tools: screenshot, click, type, scroll, paste, find, read, navigate, wait */
const BROWSER_TOOL_NAMES = ["screenshot", "click", "type", "scroll", "paste", "find", "read", "navigate", "wait", "waitForContent"];

/** State tools: reportRateLimit, updateCache, writeFile */
const STATE_TOOL_NAMES = ["reportRateLimit", "updateCache", "writeFile"];
const CONTENT_TOOL_NAMES = ["repoToText", "urlToText", "pdfToText"];

const ALL_TOOL_NAMES = [...BROWSER_TOOL_NAMES, ...STATE_TOOL_NAMES, ...CONTENT_TOOL_NAMES].sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool-registry (buildToolsForTab)", () => {
  it("returns combined array of browser + state tools", () => {
    const tabHandle = createMockTabHandle();
    const tools = buildToolsForTab(tabHandle, "my-notebook", {
      networkGate: createMockNetworkGate() as any,
      cacheManager: createMockCacheManager() as any,
    }) as unknown as TestTool[];

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(ALL_TOOL_NAMES);
  });

  it("tools from different tabs are isolated (different TabHandle → different tool instances)", () => {
    const tabA = createMockTabHandle({ tabId: "tab-A", notebookAlias: "nb-a" });
    const tabB = createMockTabHandle({ tabId: "tab-B", notebookAlias: "nb-b" });

    const sharedGate = createMockNetworkGate();
    const sharedCache = createMockCacheManager();
    const deps = {
      networkGate: sharedGate as any,
      cacheManager: sharedCache as any,
    };

    const toolsA = buildToolsForTab(tabA, "nb-a", deps) as unknown as TestTool[];
    const toolsB = buildToolsForTab(tabB, "nb-b", deps) as unknown as TestTool[];

    // Same number of tools
    expect(toolsA).toHaveLength(toolsB.length);

    // But they are distinct object instances
    for (let i = 0; i < toolsA.length; i++) {
      expect(toolsA[i]).not.toBe(toolsB[i]);
    }

    // Verify handler functions are different references (bound to different tabs)
    const screenshotA = toolsA.find((t) => t.name === "screenshot")!;
    const screenshotB = toolsB.find((t) => t.name === "screenshot")!;
    expect(screenshotA.handler).not.toBe(screenshotB.handler);
  });

  it("all expected tool names are present", () => {
    const tabHandle = createMockTabHandle();
    const tools = buildToolsForTab(tabHandle, "my-notebook", {
      networkGate: createMockNetworkGate() as any,
      cacheManager: createMockCacheManager() as any,
    }) as unknown as TestTool[];

    const names = tools.map((t) => t.name);

    // Check each expected name individually for clear failure messages
    for (const expected of ALL_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it("tools count matches expected total (10 browser + 3 state + 3 content = 16)", () => {
    const tabHandle = createMockTabHandle();
    const tools = buildToolsForTab(tabHandle, "my-notebook", {
      networkGate: createMockNetworkGate() as any,
      cacheManager: createMockCacheManager() as any,
    });

    expect(tools).toHaveLength(BROWSER_TOOL_NAMES.length + STATE_TOOL_NAMES.length + CONTENT_TOOL_NAMES.length);
    expect(tools).toHaveLength(16);
  });

  it("browser tools appear before state tools in the returned array", () => {
    const tabHandle = createMockTabHandle();
    const tools = buildToolsForTab(tabHandle, "my-notebook", {
      networkGate: createMockNetworkGate() as any,
      cacheManager: createMockCacheManager() as any,
    }) as unknown as TestTool[];

    const names = tools.map((t) => t.name);

    // First 10 should be browser tools, next 3 state tools, last 3 content tools
    expect(names.slice(0, 10)).toEqual(BROWSER_TOOL_NAMES);
    expect(names.slice(10, 13)).toEqual(STATE_TOOL_NAMES);
    expect(names.slice(13)).toEqual(CONTENT_TOOL_NAMES);
  });

  it("each tool has name, description, parameters, and handler", () => {
    const tabHandle = createMockTabHandle();
    const tools = buildToolsForTab(tabHandle, "my-notebook", {
      networkGate: createMockNetworkGate() as any,
      cacheManager: createMockCacheManager() as any,
    }) as unknown as TestTool[];

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    }
  });
});
