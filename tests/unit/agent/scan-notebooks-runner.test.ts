import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — declare mock fns that vi.mock factories reference.
// vi.mock factories are hoisted above all imports, so only vi.hoisted vars
// are accessible inside them.
// ---------------------------------------------------------------------------

const {
  mockBuildScriptContext,
  mockRunRecoverySession,
  mockSaveRepairLog,
  mockExtractNotebookNames,
  mockGetNotebookUrl,
} = vi.hoisted(() => ({
  mockBuildScriptContext: vi.fn(() => ({
    cdp: {},
    page: {},
    uiMap: { locale: "en", verified: false, elements: {}, selectors: {} },
    helpers: {},
  })),
  mockRunRecoverySession: vi.fn(),
  mockSaveRepairLog: vi.fn(() => "/tmp/repair-log.json"),
  mockExtractNotebookNames: vi.fn(),
  mockGetNotebookUrl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// vi.mock — module-level mocks (hoisted to top of file).
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => childLogger,
  };
  return { logger: childLogger };
});

vi.mock("../../../src/agent/session-runner.js", () => ({
  buildScriptContext: mockBuildScriptContext,
}));

vi.mock("../../../src/agent/recovery-session.js", () => ({
  runRecoverySession: mockRunRecoverySession,
}));

vi.mock("../../../src/agent/repair-log.js", () => ({
  saveRepairLog: mockSaveRepairLog,
}));

vi.mock("../../../src/scripts/operations.js", () => ({
  scriptedExtractNotebookNames: mockExtractNotebookNames,
  scriptedGetNotebookUrl: mockGetNotebookUrl,
}));

// ---------------------------------------------------------------------------
// Import SUT + types after mocks are established.
// ---------------------------------------------------------------------------

import { runScanAllNotebooksTask } from "../../../src/agent/scan-notebooks-runner.js";
import type { ScanAllNotebooksResult } from "../../../src/agent/scan-notebooks-runner.js";
import type { AsyncTask, TabHandle } from "../../../src/shared/types.js";
import type { RunTaskDeps } from "../../../src/daemon/index.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createMockTask(): AsyncTask {
  return {
    taskId: "test-task-001",
    notebookAlias: "__homepage__",
    runner: "scanAllNotebooks",
    runnerInput: null,
    command: "register_all_notebooks",
    context: null,
    status: "running",
    result: null,
    error: null,
    errorScreenshot: null,
    history: [],
    createdAt: new Date().toISOString(),
  };
}

function createMockTabHandle(overrides?: {
  pageUrlFn?: () => string;
}): TabHandle {
  return {
    tabId: "tab-001",
    notebookAlias: "__homepage__",
    url: "https://notebooklm.google.com/",
    state: "active",
    acquiredAt: new Date().toISOString(),
    timeoutAt: new Date().toISOString(),
    releasedAt: null,
    cdpSession: {} as any,
    page: {
      url: overrides?.pageUrlFn ?? vi.fn(() => "https://notebooklm.google.com/notebook/abc123"),
      goBack: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function createMockDeps(overrides?: {
  notebooks?: Record<string, any>;
}): RunTaskDeps {
  const notebooks = overrides?.notebooks ?? {};
  return {
    copilotClient: {} as any,
    tabManager: {} as any,
    stateManager: {
      load: vi.fn(async () => ({ notebooks })),
      addNotebook: vi.fn(),
    } as any,
    networkGate: {} as any,
    cacheManager: {} as any,
    locale: "en",
    uiMap: { locale: "en", verified: false, elements: {}, selectors: {} },
  };
}

// ---------------------------------------------------------------------------
// Script result helpers
// ---------------------------------------------------------------------------

function mockExtractSuccess(names: string[]) {
  return {
    operation: "extractNotebookNames",
    status: "success" as const,
    result: JSON.stringify(names.map((n) => ({ name: n }))),
    log: [],
    totalMs: 100,
    failedAtStep: null,
    failedSelector: null,
  };
}

function mockUrlSuccess(name: string, url: string) {
  return {
    operation: "getNotebookUrl",
    status: "success" as const,
    result: JSON.stringify({ name, url }),
    log: [],
    totalMs: 1800,
    failedAtStep: null,
    failedSelector: null,
  };
}

function mockUrlFailure(step: number) {
  return {
    operation: "getNotebookUrl",
    status: "fail" as const,
    result: null,
    log: [
      {
        step,
        action: "test",
        status: "fail" as const,
        detail: "click failed",
        durationMs: 100,
      },
    ],
    totalMs: 500,
    failedAtStep: step,
    failedSelector: "notebook_row",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runScanAllNotebooksTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Happy path — 3 names, all getNotebookUrl succeed
  // -----------------------------------------------------------------------
  it("happy path — 3 names, all URLs succeed → 3 registered, 0 skipped, 0 errors", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockExtractNotebookNames.mockResolvedValueOnce(
      mockExtractSuccess(["Alpha Project", "Beta Notes", "Gamma Research"]),
    );

    mockGetNotebookUrl
      .mockResolvedValueOnce(
        mockUrlSuccess("Alpha Project", "https://notebooklm.google.com/notebook/aaa"),
      )
      .mockResolvedValueOnce(
        mockUrlSuccess("Beta Notes", "https://notebooklm.google.com/notebook/bbb"),
      )
      .mockResolvedValueOnce(
        mockUrlSuccess("Gamma Research", "https://notebooklm.google.com/notebook/ccc"),
      );

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    expect(res.success).toBe(true);
    expect(result.total).toBe(3);
    expect(result.registered).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.recovered).toHaveLength(0);
    expect(result.errorReport.finalFailures).toHaveLength(0);

    // Verify each notebook was registered with correct alias
    expect(result.registered[0]).toMatchObject({
      alias: "alpha-project",
      url: "https://notebooklm.google.com/notebook/aaa",
      title: "Alpha Project",
    });
    expect(result.registered[1]).toMatchObject({
      alias: "beta-notes",
      url: "https://notebooklm.google.com/notebook/bbb",
      title: "Beta Notes",
    });
    expect(result.registered[2]).toMatchObject({
      alias: "gamma-research",
      url: "https://notebooklm.google.com/notebook/ccc",
      title: "Gamma Research",
    });

    // Verify stateManager.addNotebook called 3 times
    expect(deps.stateManager.addNotebook).toHaveBeenCalledTimes(3);
    expect(deps.stateManager.addNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "alpha-project",
        url: "https://notebooklm.google.com/notebook/aaa",
        title: "Alpha Project",
        status: "ready",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 2. URL dedup — 1 already registered, 1 new
  // -----------------------------------------------------------------------
  it("URL dedup — 2 names, 1 already in state → 1 registered + 1 skipped", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps({
      notebooks: {
        "existing-nb": {
          alias: "existing-nb",
          url: "https://notebooklm.google.com/notebook/aaa",
          title: "Existing",
          description: "",
          status: "ready",
          registeredAt: "2026-01-01T00:00:00.000Z",
          lastAccessedAt: "2026-01-01T00:00:00.000Z",
          sourceCount: 0,
        },
      },
    });

    mockExtractNotebookNames.mockResolvedValueOnce(
      mockExtractSuccess(["Existing Notebook", "New Notebook"]),
    );

    mockGetNotebookUrl
      .mockResolvedValueOnce(
        mockUrlSuccess(
          "Existing Notebook",
          "https://notebooklm.google.com/notebook/aaa",
        ),
      )
      .mockResolvedValueOnce(
        mockUrlSuccess(
          "New Notebook",
          "https://notebooklm.google.com/notebook/bbb",
        ),
      );

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    expect(res.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.registered).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      name: "Existing Notebook",
      reason: "URL already registered",
    });
    expect(result.registered[0]).toMatchObject({
      alias: "new-notebook",
      url: "https://notebooklm.google.com/notebook/bbb",
      title: "New Notebook",
    });

    // Only 1 addNotebook call (the new one)
    expect(deps.stateManager.addNotebook).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 3. Script failure + recovery success
  // -----------------------------------------------------------------------
  it("script failure + recovery success → appears in recovered", async () => {
    const task = createMockTask();
    const recoveryUrl = "https://notebooklm.google.com/notebook/recovered-xyz";
    const tabHandle = createMockTabHandle({
      pageUrlFn: vi.fn(() => recoveryUrl),
    });
    const deps = createMockDeps();

    mockExtractNotebookNames.mockResolvedValueOnce(
      mockExtractSuccess(["Broken Notebook"]),
    );

    mockGetNotebookUrl.mockResolvedValueOnce(mockUrlFailure(3));

    mockRunRecoverySession.mockResolvedValueOnce({
      success: true,
      result: "Navigated to notebook",
      analysis: "Click target shifted",
      suggestedPatch: null,
      toolCalls: 3,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: null,
      durationMs: 5000,
    });

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    expect(res.success).toBe(true);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]).toMatchObject({
      alias: "broken-notebook",
      url: "https://notebooklm.google.com/notebook/recovered-xyz",
      title: "Broken Notebook",
    });
    expect(result.registered).toHaveLength(0);
    expect(result.errorReport.scriptFailures).toBe(1);
    expect(result.errorReport.recoveryAttempts).toBe(1);
    expect(result.errorReport.recoverySuccesses).toBe(1);
    expect(result.errorReport.finalFailures).toHaveLength(0);

    // Recovery was called
    expect(mockRunRecoverySession).toHaveBeenCalledTimes(1);
    expect(mockRunRecoverySession).toHaveBeenCalledWith(
      expect.objectContaining({
        client: deps.copilotClient,
        cdp: tabHandle.cdpSession,
        page: tabHandle.page,
        goal: expect.stringContaining("Broken Notebook"),
      }),
    );

    // Repair log saved (on success path)
    expect(mockSaveRepairLog).toHaveBeenCalledTimes(1);

    // addNotebook called once for the recovered notebook
    expect(deps.stateManager.addNotebook).toHaveBeenCalledTimes(1);
    expect(deps.stateManager.addNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "broken-notebook",
        url: "https://notebooklm.google.com/notebook/recovered-xyz",
        title: "Broken Notebook",
      }),
    );

    // goto called to return to homepage (not goBack — recovery may navigate multiple times)
    expect((tabHandle.page as any).goto).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 4. Script failure + recovery failure → appears in finalFailures
  // -----------------------------------------------------------------------
  it("script failure + recovery failure → appears in errorReport.finalFailures", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockExtractNotebookNames.mockResolvedValueOnce(
      mockExtractSuccess(["Doomed Notebook"]),
    );

    mockGetNotebookUrl.mockResolvedValueOnce(mockUrlFailure(2));

    mockRunRecoverySession.mockResolvedValueOnce({
      success: false,
      result: null,
      analysis: "Could not find notebook row",
      suggestedPatch: null,
      toolCalls: 10,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: "base64screenshot",
      durationMs: 15000,
    });

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    // Overall success=false because of finalFailures
    expect(res.success).toBe(false);
    expect(result.total).toBe(1);
    expect(result.registered).toHaveLength(0);
    expect(result.recovered).toHaveLength(0);
    expect(result.errorReport.scriptFailures).toBe(1);
    expect(result.errorReport.recoveryAttempts).toBe(1);
    expect(result.errorReport.recoverySuccesses).toBe(0);
    expect(result.errorReport.finalFailures).toHaveLength(1);
    expect(result.errorReport.finalFailures[0]).toMatchObject({
      name: "Doomed Notebook",
      scriptStep: 2,
      scriptError: "notebook_row",
      recoveryError: "Could not find notebook row",
      repairLogPath: "/tmp/repair-log.json",
    });

    // saveRepairLog called for failure path
    expect(mockSaveRepairLog).toHaveBeenCalledTimes(1);

    // addNotebook NOT called
    expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();

    // goto still called (best-effort return to homepage)
    expect((tabHandle.page as any).goto).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 5. Empty name list → success with total: 0
  // -----------------------------------------------------------------------
  it("empty name list → success with total: 0", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockExtractNotebookNames.mockResolvedValueOnce(mockExtractSuccess([]));

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    expect(res.success).toBe(true);
    expect(result.total).toBe(0);
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.recovered).toHaveLength(0);
    expect(result.errorReport.finalFailures).toHaveLength(0);

    // No script calls for getNotebookUrl
    expect(mockGetNotebookUrl).not.toHaveBeenCalled();
    expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. Alias dedup — 2 Chinese names that both generate "notebook" alias
  // -----------------------------------------------------------------------
  it("alias dedup — 2 names generating same base alias → deduplicated with suffix", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    // Two Chinese-only names that both strip to empty → fallback "notebook"
    mockExtractNotebookNames.mockResolvedValueOnce(
      mockExtractSuccess(["筆記本一", "筆記本二"]),
    );

    mockGetNotebookUrl
      .mockResolvedValueOnce(
        mockUrlSuccess("筆記本一", "https://notebooklm.google.com/notebook/cn1"),
      )
      .mockResolvedValueOnce(
        mockUrlSuccess("筆記本二", "https://notebooklm.google.com/notebook/cn2"),
      );

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    expect(res.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.registered).toHaveLength(2);

    // First gets "notebook", second gets "notebook-2"
    expect(result.registered[0].alias).toBe("notebook");
    expect(result.registered[1].alias).toBe("notebook-2");

    // Both URLs are different — no dedup
    expect(result.registered[0].url).toBe(
      "https://notebooklm.google.com/notebook/cn1",
    );
    expect(result.registered[1].url).toBe(
      "https://notebooklm.google.com/notebook/cn2",
    );

    // Both registered
    expect(deps.stateManager.addNotebook).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  it("extractNotebookNames fails → returns error", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockExtractNotebookNames.mockResolvedValueOnce({
      operation: "extractNotebookNames",
      status: "fail",
      result: null,
      log: [],
      totalMs: 200,
      failedAtStep: 1,
      failedSelector: "notebook_list",
    });

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);

    expect(res.success).toBe(false);
    expect(res.error).toContain("extractNotebookNames failed");
    expect(res.error).toContain("step 1");
    expect(res.result).toBeUndefined();

    // No further calls
    expect(mockGetNotebookUrl).not.toHaveBeenCalled();
    expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();
  });

  it("URL normalization strips query params and trailing slashes", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockExtractNotebookNames.mockResolvedValueOnce(
      mockExtractSuccess(["My Notebook"]),
    );

    mockGetNotebookUrl.mockResolvedValueOnce(
      mockUrlSuccess(
        "My Notebook",
        "https://notebooklm.google.com/notebook/abc?authuser=0#section",
      ),
    );

    const res = await runScanAllNotebooksTask(task, tabHandle, deps);
    const result = res.result as ScanAllNotebooksResult;

    expect(res.success).toBe(true);
    expect(result.registered[0].url).toBe(
      "https://notebooklm.google.com/notebook/abc",
    );
  });
});
