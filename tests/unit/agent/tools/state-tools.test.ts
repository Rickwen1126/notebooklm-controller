import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Mock the Copilot SDK to avoid loading vscode-jsonrpc (not available in test env).
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: Record<string, unknown>) => ({
    name,
    ...config,
  }),
}));

/** Minimal Tool shape matching the SDK Tool interface (avoids importing the real module). */
interface TestTool {
  name: string;
  description?: string;
  parameters?: unknown;
  handler: (args: any, invocation: any) => Promise<unknown> | unknown;
}

/** Minimal ToolResultObject shape. */
interface TestToolResult {
  textResultForLlm: string;
  resultType: string;
  error?: string;
}

// Suppress logger output during tests.
vi.mock("../../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

// Create a temp dir for writeFile tests that serves as NBCTL_HOME.
const writeFileTestDir = await mkdtemp(join(tmpdir(), "nbctl-home-test-"));

// Mock NBCTL_HOME to point to our temp dir so writeFile path validation passes.
vi.mock("../../../../src/shared/config.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    NBCTL_HOME: writeFileTestDir,
  };
});

// Import after mocks are set up.
const { createStateTools } = await import(
  "../../../../src/agent/tools/state-tools.js"
);

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

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

/** Dummy invocation for handler calls. */
const dummyInvocation = {
  sessionId: "test-session",
  toolCallId: "call-1",
  toolName: "",
  arguments: {},
};

/** Helper to find a tool by name. */
function findTool(tools: TestTool[], name: string): TestTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool "${name}" not found`);
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("state-tools", () => {
  const NOTEBOOK_ALIAS = "test-notebook";

  describe("reportRateLimit", () => {
    it("calls networkGate.reportAnomaly with the provided signal", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "reportRateLimit");
      const result = (await tool.handler(
        { signal: "HTTP 429" },
        { ...dummyInvocation, toolName: "reportRateLimit" },
      )) as TestToolResult;

      expect(mockGate.reportAnomaly).toHaveBeenCalledOnce();
      expect(mockGate.reportAnomaly).toHaveBeenCalledWith("HTTP 429");
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("HTTP 429");
    });

    it("works with CAPTCHA signal", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "reportRateLimit");
      const result = (await tool.handler(
        { signal: "CAPTCHA" },
        { ...dummyInvocation, toolName: "reportRateLimit" },
      )) as TestToolResult;

      expect(mockGate.reportAnomaly).toHaveBeenCalledWith("CAPTCHA");
      expect(result.resultType).toBe("success");
    });
  });

  describe("updateCache", () => {
    it("adds a source record via cacheManager.addSource", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const sourceData = {
        id: "src-1",
        notebookAlias: NOTEBOOK_ALIAS,
        displayName: "test source",
      };

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "source", action: "add", data: sourceData },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(mockCache.addSource).toHaveBeenCalledOnce();
      expect(mockCache.addSource).toHaveBeenCalledWith(sourceData);
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("added");
    });

    it("updates a source record via cacheManager.updateSource", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const updateData = { id: "src-1", displayName: "updated name" };

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "source", action: "update", data: updateData },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(mockCache.updateSource).toHaveBeenCalledOnce();
      expect(mockCache.updateSource).toHaveBeenCalledWith(
        NOTEBOOK_ALIAS,
        "src-1",
        updateData,
      );
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("src-1");
    });

    it("removes a source record via cacheManager.removeSource", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "source", action: "remove", data: { id: "src-2" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(mockCache.removeSource).toHaveBeenCalledOnce();
      expect(mockCache.removeSource).toHaveBeenCalledWith(NOTEBOOK_ALIAS, "src-2");
      expect(result.resultType).toBe("success");
    });

    it("adds an artifact record via cacheManager.addArtifact", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const artifactData = {
        id: "art-1",
        notebookAlias: NOTEBOOK_ALIAS,
        type: "audio",
      };

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "artifact", action: "add", data: artifactData },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(mockCache.addArtifact).toHaveBeenCalledOnce();
      expect(mockCache.addArtifact).toHaveBeenCalledWith(artifactData);
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("Artifact");
    });

    it("removes an artifact record via cacheManager.removeArtifact", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "artifact", action: "remove", data: { id: "art-2" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(mockCache.removeArtifact).toHaveBeenCalledOnce();
      expect(mockCache.removeArtifact).toHaveBeenCalledWith(NOTEBOOK_ALIAS, "art-2");
      expect(result.resultType).toBe("success");
    });

    it("returns failure when source add is missing required fields", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "source", action: "add", data: { id: "src-1" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("required fields");
      expect(mockCache.addSource).not.toHaveBeenCalled();
    });

    it("returns failure when artifact add is missing required fields", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "artifact", action: "add", data: { id: "art-1" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("required fields");
      expect(mockCache.addArtifact).not.toHaveBeenCalled();
    });

    it("returns failure when source update is missing id", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "source", action: "update", data: { displayName: "no id" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("id");
      expect(mockCache.updateSource).not.toHaveBeenCalled();
    });

    it("returns failure when artifact update is attempted", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "artifact", action: "update", data: { id: "art-1" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("not supported");
    });

    it("returns failure when cacheManager throws", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      mockCache.addSource.mockRejectedValue(new Error("disk full"));

      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "updateCache");
      const result = (await tool.handler(
        { type: "source", action: "add", data: { id: "src-fail", notebookAlias: NOTEBOOK_ALIAS, displayName: "fail source" } },
        { ...dummyInvocation, toolName: "updateCache" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("disk full");
    });
  });

  describe("writeFile", () => {
    afterEach(async () => {
      // Clean up files created during tests (but keep the dir itself).
    });

    it("writes content to a file path within NBCTL_HOME", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const filePath = join(writeFileTestDir, "output.txt");
      const tool = findTool(tools, "writeFile");
      const result = (await tool.handler(
        { path: filePath, content: "hello world" },
        { ...dummyInvocation, toolName: "writeFile" },
      )) as TestToolResult;

      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain(filePath);

      const written = await readFile(filePath, "utf-8");
      expect(written).toBe("hello world");
    });

    it("creates parent directories if they do not exist", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const filePath = join(writeFileTestDir, "nested", "dir", "file.txt");
      const tool = findTool(tools, "writeFile");
      const result = (await tool.handler(
        { path: filePath, content: "nested content" },
        { ...dummyInvocation, toolName: "writeFile" },
      )) as TestToolResult;

      expect(result.resultType).toBe("success");

      const written = await readFile(filePath, "utf-8");
      expect(written).toBe("nested content");
    });

    it("rejects path traversal outside NBCTL_HOME", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "writeFile");

      // Absolute path outside NBCTL_HOME
      const result = (await tool.handler(
        { path: "/etc/passwd", content: "malicious" },
        { ...dummyInvocation, toolName: "writeFile" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("must be within");
    });

    it("rejects relative path traversal with ..", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "writeFile");
      const result = (await tool.handler(
        { path: "../../.ssh/authorized_keys", content: "malicious" },
        { ...dummyInvocation, toolName: "writeFile" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("must be within");
    });

    it("returns failure for path outside NBCTL_HOME", async () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const tool = findTool(tools, "writeFile");
      const result = (await tool.handler(
        { path: "/tmp/outside-nbctl/evil.txt", content: "should fail" },
        { ...dummyInvocation, toolName: "writeFile" },
      )) as TestToolResult;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("must be within");
    });
  });

  describe("tool factory", () => {
    it("returns exactly 3 tools", () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      expect(tools).toHaveLength(3);
    });

    it("all tools have name, description, parameters, and handler", () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeDefined();
        expect(typeof tool.handler).toBe("function");
      }
    });

    it("tool names are reportRateLimit, updateCache, writeFile", () => {
      const mockGate = createMockNetworkGate();
      const mockCache = createMockCacheManager();
      const tools = createStateTools({
        networkGate: mockGate as any,
        cacheManager: mockCache as any,
        notebookAlias: NOTEBOOK_ALIAS,
      });

      const names = tools.map((t) => t.name);
      expect(names).toEqual(["reportRateLimit", "updateCache", "writeFile"]);
    });
  });
});
