import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @github/copilot-sdk before importing anything that uses it.
// We only need defineTool, which is trivial: (name, config) => { name, ...config }.
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: Record<string, unknown>) => ({
    name,
    ...config,
  }),
}));

// Mock config for TMP_DIR (used by paste tool path validation)
vi.mock("../../../../src/shared/config.js", () => ({
  TMP_DIR: "/tmp/nbctl-test",
}));

import { createBrowserTools } from "../../../../src/agent/tools/browser-tools.js";
import type { TabHandle } from "../../../../src/shared/types.js";

/** ToolResultObject shape from @github/copilot-sdk (inline to avoid import). */
interface ToolResultObject {
  textResultForLlm: string;
  resultType: string;
  binaryResultsForLlm?: Array<{
    data: string;
    mimeType: string;
    type: string;
  }>;
}

// ---------------------------------------------------------------------------
// Mock CDPSession
// ---------------------------------------------------------------------------

function createMockCDPSession() {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    send: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "Page.captureScreenshot") {
        return { data: "base64screenshotdata" };
      }
      return {};
    }),
    calls,
  };
}

function createMockPage() {
  return {
    evaluate: vi.fn(async (_fn: (...a: unknown[]) => unknown, ..._args: unknown[]) => {
      // Default: return empty results for find/read
      return { count: 0, items: [] };
    }),
    goto: vi.fn(async () => {}),
  };
}

function createMockTabHandle(
  cdp: ReturnType<typeof createMockCDPSession>,
  page?: ReturnType<typeof createMockPage>,
): TabHandle {
  return {
    tabId: "tab-1",
    notebookAlias: "test-notebook",
    url: "https://notebooklm.google.com/notebook/abc",
    acquiredAt: new Date().toISOString(),
    timeoutAt: new Date(Date.now() + 300_000).toISOString(),
    cdpSession: cdp as never,
    page: (page ?? createMockPage()) as never,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a tool by name from the array returned by createBrowserTools. */
function findTool(tools: ReturnType<typeof createBrowserTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

/** Invoke a tool handler with the given args and return the result as ToolResultObject. */
async function invoke(
  tool: ReturnType<typeof findTool>,
  args: unknown,
): Promise<ToolResultObject> {
  const invocation = {
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: tool.name,
    arguments: args,
  };
  return (await tool.handler(args as never, invocation)) as ToolResultObject;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("browser-tools", () => {
  let cdp: ReturnType<typeof createMockCDPSession>;
  let mockPage: ReturnType<typeof createMockPage>;
  let tools: ReturnType<typeof createBrowserTools>;

  beforeEach(() => {
    cdp = createMockCDPSession();
    mockPage = createMockPage();
    const tabHandle = createMockTabHandle(cdp, mockPage);
    tools = createBrowserTools(tabHandle);
  });

  it("creates all nine tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "click", "find", "navigate", "paste", "read",
      "screenshot", "scroll", "type", "wait",
    ]);
  });

  it("each tool has a description", () => {
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
    }
  });

  it("each tool has a Zod parameters schema with toJSONSchema()", () => {
    for (const tool of tools) {
      expect(tool.parameters).toBeDefined();
      // Zod v4 schemas expose toJSONSchema()
      const schema = tool.parameters as { toJSONSchema: () => unknown };
      expect(typeof schema.toJSONSchema).toBe("function");
      const jsonSchema = schema.toJSONSchema();
      expect(jsonSchema).toBeDefined();
      expect(typeof jsonSchema).toBe("object");
    }
  });

  // -----------------------------------------------------------------------
  // screenshot
  // -----------------------------------------------------------------------

  describe("screenshot", () => {
    it("calls captureScreenshot and returns binaryResultsForLlm with base64 data", async () => {
      const tool = findTool(tools, "screenshot");
      const result = await invoke(tool, {});

      expect(cdp.send).toHaveBeenCalledWith("Page.captureScreenshot", {
        format: "png",
      });
      expect(result.resultType).toBe("success");
      expect(result.binaryResultsForLlm).toHaveLength(1);
      expect(result.binaryResultsForLlm![0]).toEqual({
        data: "base64screenshotdata",
        mimeType: "image/png",
        type: "image",
      });
    });

    it("passes format and quality options through", async () => {
      const tool = findTool(tools, "screenshot");
      await invoke(tool, { format: "jpeg", quality: 75 });

      expect(cdp.send).toHaveBeenCalledWith("Page.captureScreenshot", {
        format: "jpeg",
        quality: 75,
      });
    });

    it("returns image/jpeg mimeType for jpeg format", async () => {
      const tool = findTool(tools, "screenshot");
      const result = await invoke(tool, { format: "jpeg", quality: 80 });

      expect(result.binaryResultsForLlm![0].mimeType).toBe("image/jpeg");
    });

    it("returns image data directly (tool self-containment)", async () => {
      const tool = findTool(tools, "screenshot");
      const result = await invoke(tool, {});

      // The tool must return binary image data, not just text.
      expect(result.binaryResultsForLlm).toBeDefined();
      expect(result.binaryResultsForLlm!.length).toBeGreaterThan(0);
      expect(result.binaryResultsForLlm![0].data).toBe("base64screenshotdata");
    });
  });

  // -----------------------------------------------------------------------
  // click
  // -----------------------------------------------------------------------

  describe("click", () => {
    it("calls dispatchClick with x,y coordinates then captures screenshot", async () => {
      const tool = findTool(tools, "click");
      const result = await invoke(tool, { x: 100, y: 200 });

      // First: mouse events (dispatchClick sends 2 CDP calls)
      expect(cdp.calls[0]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 100,
          y: 200,
          button: "left",
          clickCount: 1,
        },
      });
      expect(cdp.calls[1]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseReleased",
          x: 100,
          y: 200,
          button: "left",
          clickCount: 1,
        },
      });
      // Then: screenshot
      expect(cdp.calls[2]).toEqual({
        method: "Page.captureScreenshot",
        params: { format: "png" },
      });

      // Returns screenshot so agent can see the result
      expect(result.binaryResultsForLlm).toHaveLength(1);
      expect(result.binaryResultsForLlm![0].data).toBe("base64screenshotdata");
      expect(result.textResultForLlm).toContain("100");
      expect(result.textResultForLlm).toContain("200");
    });

    it("supports right button", async () => {
      const tool = findTool(tools, "click");
      await invoke(tool, { x: 50, y: 75, button: "right" });

      expect(cdp.calls[0].params).toEqual(
        expect.objectContaining({ button: "right" }),
      );
    });

    it("defaults to left button", async () => {
      const tool = findTool(tools, "click");
      const result = await invoke(tool, { x: 10, y: 20 });

      expect(cdp.calls[0].params).toEqual(
        expect.objectContaining({ button: "left" }),
      );
      expect(result.textResultForLlm).toContain("left");
    });
  });

  // -----------------------------------------------------------------------
  // type
  // -----------------------------------------------------------------------

  describe("type", () => {
    it("calls dispatchType with text", async () => {
      const tool = findTool(tools, "type");
      const result = await invoke(tool, { text: "hello" });

      // dispatchType sends keyDown+keyUp for each character = 10 calls
      const keyCalls = cdp.calls.filter(
        (c) => c.method === "Input.dispatchKeyEvent",
      );
      expect(keyCalls).toHaveLength(10);

      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("5");
    });

    it("returns confirmation text (no screenshot)", async () => {
      const tool = findTool(tools, "type");
      const result = await invoke(tool, { text: "ab" });

      expect(result.textResultForLlm).toContain("2");
      expect(result.binaryResultsForLlm).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // scroll
  // -----------------------------------------------------------------------

  describe("scroll", () => {
    it("calls dispatchScroll with deltas then captures screenshot", async () => {
      const tool = findTool(tools, "scroll");
      const result = await invoke(tool, { x: 300, y: 400, deltaY: -120 });

      expect(cdp.calls[0]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: 300,
          y: 400,
          deltaX: 0,
          deltaY: -120,
        },
      });
      // Screenshot follows
      expect(cdp.calls[1]).toEqual({
        method: "Page.captureScreenshot",
        params: { format: "png" },
      });

      expect(result.binaryResultsForLlm).toHaveLength(1);
      expect(result.binaryResultsForLlm![0].data).toBe("base64screenshotdata");
    });

    it("supports horizontal scroll via deltaX", async () => {
      const tool = findTool(tools, "scroll");
      await invoke(tool, { x: 0, y: 0, deltaX: 50, deltaY: 0 });

      expect(cdp.calls[0].params).toEqual(
        expect.objectContaining({ deltaX: 50, deltaY: 0 }),
      );
    });

    it("defaults deltaX to 0 when omitted", async () => {
      const tool = findTool(tools, "scroll");
      await invoke(tool, { x: 10, y: 20, deltaY: 100 });

      expect(cdp.calls[0].params).toEqual(
        expect.objectContaining({ deltaX: 0 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // paste
  // -----------------------------------------------------------------------

  describe("paste", () => {
    it("calls dispatchPaste with text", async () => {
      const tool = findTool(tools, "paste");
      const result = await invoke(tool, { text: "pasted content" });

      expect(cdp.calls[0]).toEqual({
        method: "Input.insertText",
        params: { text: "pasted content" },
      });
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("14");
    });

    it("returns confirmation text (no screenshot)", async () => {
      const tool = findTool(tools, "paste");
      const result = await invoke(tool, { text: "xyz" });

      expect(result.binaryResultsForLlm).toBeUndefined();
      expect(result.textResultForLlm).toContain("3");
    });

    // T105: Security — filePath must be within TMP_DIR
    it("rejects filePath outside TMP_DIR (security: prevent reading arbitrary files)", async () => {
      const tool = findTool(tools, "paste");
      const result = await invoke(tool, { filePath: "/etc/passwd" });

      expect(result.textResultForLlm).toContain("must be within");
      expect(result.textResultForLlm).toContain("/tmp/nbctl-test");
      // Should NOT have called dispatchPaste
      expect(cdp.calls).toHaveLength(0);
    });

    it("rejects filePath with path traversal (security)", async () => {
      const tool = findTool(tools, "paste");
      const result = await invoke(tool, {
        filePath: "/tmp/nbctl-test/../../etc/shadow",
      });

      expect(result.textResultForLlm).toContain("must be within");
      expect(cdp.calls).toHaveLength(0);
    });

    it("rejects relative filePath (security)", async () => {
      const tool = findTool(tools, "paste");
      const result = await invoke(tool, {
        filePath: "../../etc/passwd",
      });

      expect(result.textResultForLlm).toContain("must be within");
      expect(cdp.calls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // find (T030.2)
  // -----------------------------------------------------------------------

  describe("find", () => {
    it("calls page.evaluate with the query and returns results", async () => {
      mockPage.evaluate.mockResolvedValueOnce([
        {
          tag: "BUTTON",
          text: "Submit",
          ariaLabel: null,
          disabled: false,
          ariaExpanded: null,
          center: { x: 100, y: 500 },
          rect: { x: 50, y: 480, w: 100, h: 40 },
        },
      ]);

      const tool = findTool(tools, "find");
      const result = await invoke(tool, { query: "Submit" });

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("BUTTON");
      expect(result.textResultForLlm).toContain("Submit");
      expect(result.textResultForLlm).toContain("center(100, 500)");
    });

    it("returns no-match message when nothing found", async () => {
      mockPage.evaluate.mockResolvedValueOnce([]);

      const tool = findTool(tools, "find");
      const result = await invoke(tool, { query: "nonexistent" });

      expect(result.textResultForLlm).toContain("No elements found");
      expect(result.textResultForLlm).toContain("nonexistent");
    });

    it("includes disabled and ariaExpanded in output", async () => {
      mockPage.evaluate.mockResolvedValueOnce([
        {
          tag: "BUTTON",
          text: "Expand",
          ariaLabel: "Toggle panel",
          disabled: true,
          ariaExpanded: "false",
          center: { x: 200, y: 300 },
          rect: { x: 150, y: 280, w: 100, h: 40 },
        },
      ]);

      const tool = findTool(tools, "find");
      const result = await invoke(tool, { query: "Expand" });

      expect(result.textResultForLlm).toContain("DISABLED");
      expect(result.textResultForLlm).toContain("expanded=false");
      expect(result.textResultForLlm).toContain('aria="Toggle panel"');
    });
  });

  // -----------------------------------------------------------------------
  // read (T030.3)
  // -----------------------------------------------------------------------

  describe("read", () => {
    it("returns structured count and items", async () => {
      mockPage.evaluate.mockResolvedValueOnce({
        count: 2,
        items: [
          { tag: "DIV", text: "First answer", visible: true },
          { tag: "DIV", text: "Second answer", visible: true },
        ],
      });

      const tool = findTool(tools, "read");
      const result = await invoke(tool, { selector: ".message-content" });

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("Found 2 element(s)");
      expect(result.textResultForLlm).toContain("First answer");
      expect(result.textResultForLlm).toContain("Second answer");
    });

    it("returns no-match message when count is 0", async () => {
      mockPage.evaluate.mockResolvedValueOnce({ count: 0, items: [] });

      const tool = findTool(tools, "read");
      const result = await invoke(tool, { selector: ".nonexistent" });

      expect(result.textResultForLlm).toContain("No elements matched");
    });

    it("marks hidden elements", async () => {
      mockPage.evaluate.mockResolvedValueOnce({
        count: 1,
        items: [{ tag: "SPAN", text: "Hidden text", visible: false }],
      });

      const tool = findTool(tools, "read");
      const result = await invoke(tool, { selector: ".hidden" });

      expect(result.textResultForLlm).toContain("(HIDDEN)");
    });
  });

  // -----------------------------------------------------------------------
  // navigate (T030.4)
  // -----------------------------------------------------------------------

  describe("navigate", () => {
    it("calls page.goto and returns screenshot", async () => {
      const tool = findTool(tools, "navigate");
      const result = await invoke(tool, { url: "https://notebooklm.google.com" });

      expect(mockPage.goto).toHaveBeenCalledWith(
        "https://notebooklm.google.com",
        { waitUntil: "networkidle2", timeout: 30_000 },
      );
      expect(result.binaryResultsForLlm).toHaveLength(1);
      expect(result.textResultForLlm).toContain("Navigated to");
    });
  });

  // -----------------------------------------------------------------------
  // wait (T030.5)
  // -----------------------------------------------------------------------

  describe("wait", () => {
    it("returns screenshot after waiting", async () => {
      const tool = findTool(tools, "wait");
      const result = await invoke(tool, { seconds: 1 });

      expect(result.binaryResultsForLlm).toHaveLength(1);
      expect(result.textResultForLlm).toContain("Waited 1 seconds");
    });
  });
});
