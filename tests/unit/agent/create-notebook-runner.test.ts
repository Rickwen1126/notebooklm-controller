import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildScriptContext,
  mockRunRecoverySession,
  mockSaveRepairLog,
  mockCreateNotebook,
  mockRenameNotebook,
} = vi.hoisted(() => ({
  mockBuildScriptContext: vi.fn(() => ({
    cdp: {},
    page: {},
    uiMap: { locale: "en", verified: false, elements: {}, selectors: {} },
    helpers: {},
  })),
  mockRunRecoverySession: vi.fn(),
  mockSaveRepairLog: vi.fn(() => "/tmp/repair-log.json"),
  mockCreateNotebook: vi.fn(),
  mockRenameNotebook: vi.fn(),
}));

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
  scriptedCreateNotebook: mockCreateNotebook,
  scriptedRenameNotebook: mockRenameNotebook,
}));

import { runCreateNotebookTask } from "../../../src/agent/create-notebook-runner.js";
import type { AsyncTask, TabHandle } from "../../../src/shared/types.js";
import type { RunTaskDeps } from "../../../src/daemon/types.js";

function createMockTask(overrides?: Partial<AsyncTask>): AsyncTask {
  return {
    taskId: "task-001",
    notebookAlias: "__homepage__",
    runner: "createNotebook",
    runnerInput: { title: "My Research", alias: "my-research" },
    command: "create_notebook",
    context: null,
    status: "running",
    result: null,
    error: null,
    errorScreenshot: null,
    history: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockTabHandle(
  url = "https://notebooklm.google.com/notebook/new123",
  options?: { evaluatedTitle?: string | null },
): TabHandle {
  return {
    tabId: "tab-001",
    notebookAlias: "__homepage__",
    url: "https://notebooklm.google.com",
    state: "active",
    acquiredAt: new Date().toISOString(),
    timeoutAt: new Date().toISOString(),
    releasedAt: null,
    cdpSession: {} as any,
    page: {
      url: vi.fn(() => url),
      evaluate: vi.fn().mockResolvedValue(options?.evaluatedTitle ?? null),
    } as any,
  };
}

function createMockDeps(): RunTaskDeps {
  return {
    copilotClient: {} as any,
    tabManager: {} as any,
    stateManager: {
      getNotebook: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({ notebooks: {} }),
      addNotebook: vi.fn().mockResolvedValue(undefined),
    } as any,
    networkGate: {} as any,
    cacheManager: {} as any,
    locale: "en",
    uiMap: { locale: "en", verified: false, elements: {}, selectors: {} },
  };
}

function createSuccessResult(operation: string, result: string) {
  return {
    operation,
    status: "success" as const,
    result,
    log: [],
    totalMs: 100,
    failedAtStep: null,
    failedSelector: null,
  };
}

function createFailResult(operation: string, failedSelector = "selector") {
  return {
    operation,
    status: "fail" as const,
    result: null,
    log: [],
    totalMs: 100,
    failedAtStep: 1,
    failedSelector,
  };
}

describe("runCreateNotebookTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates, renames, and registers notebook on the happy path", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockCreateNotebook.mockResolvedValueOnce(
      createSuccessResult(
        "createNotebook",
        JSON.stringify({
          url: "https://notebooklm.google.com/notebook/new123",
          title: "Untitled notebook",
        }),
      ),
    );
    mockRenameNotebook.mockResolvedValueOnce(
      createSuccessResult("renameNotebook", 'Notebook renamed to "My Research"'),
    );

    const res = await runCreateNotebookTask(task, tabHandle, deps);

    expect(res.success).toBe(true);
    expect(res.result).toEqual({
      success: true,
      alias: "my-research",
      url: "https://notebooklm.google.com/notebook/new123",
      title: "My Research",
    });
    expect(mockCreateNotebook).toHaveBeenCalledOnce();
    expect(mockRenameNotebook).toHaveBeenCalledWith(expect.any(Object), "My Research");
    expect(deps.stateManager.addNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "my-research",
        url: "https://notebooklm.google.com/notebook/new123",
        title: "My Research",
      }),
    );
  });

  it("uses recovery and browser state authority when create script fails and title already matches", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle(
      "https://notebooklm.google.com/notebook/recovered456",
      { evaluatedTitle: "My Research" },
    );
    const deps = createMockDeps();

    mockCreateNotebook.mockResolvedValueOnce(createFailResult("createNotebook", "create_button"));
    mockRunRecoverySession.mockResolvedValueOnce({
      success: true,
      result: null,
      analysis: "Button moved",
      suggestedPatch: null,
      toolCalls: 3,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: null,
      durationMs: 1000,
    });

    const res = await runCreateNotebookTask(task, tabHandle, deps);

    expect(res.success).toBe(true);
    expect(res.result).toEqual({
      success: true,
      alias: "my-research",
      url: "https://notebooklm.google.com/notebook/recovered456",
      title: "My Research",
    });
    expect(mockRenameNotebook).not.toHaveBeenCalled();
    expect(mockSaveRepairLog).toHaveBeenCalledOnce();
    expect(deps.stateManager.addNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "my-research",
        url: "https://notebooklm.google.com/notebook/recovered456",
        title: "My Research",
      }),
    );
  });

  it("runs deterministic rename after recovery when browser title still mismatches", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle(
      "https://notebooklm.google.com/notebook/recovered456",
      { evaluatedTitle: "Untitled notebook" },
    );
    const deps = createMockDeps();

    mockCreateNotebook.mockResolvedValueOnce(createFailResult("createNotebook", "create_button"));
    mockRunRecoverySession.mockResolvedValueOnce({
      success: true,
      result: null,
      analysis: "Recovered create flow",
      suggestedPatch: null,
      toolCalls: 3,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: null,
      durationMs: 1000,
    });
    mockRenameNotebook.mockResolvedValueOnce(
      createSuccessResult("renameNotebook", 'Notebook renamed to "My Research"'),
    );

    const res = await runCreateNotebookTask(task, tabHandle, deps);

    expect(res.success).toBe(true);
    expect(mockRenameNotebook).toHaveBeenCalledWith(expect.any(Object), "My Research");
    expect(deps.stateManager.addNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "my-research",
        url: "https://notebooklm.google.com/notebook/recovered456",
        title: "My Research",
      }),
    );
  });

  it("fails clearly when rename fails after remote notebook was created", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle();
    const deps = createMockDeps();

    mockCreateNotebook.mockResolvedValueOnce(
      createSuccessResult(
        "createNotebook",
        JSON.stringify({
          url: "https://notebooklm.google.com/notebook/new123",
          title: "Untitled notebook",
        }),
      ),
    );
    mockRenameNotebook.mockResolvedValueOnce(createFailResult("renameNotebook", "edit_title"));
    mockRunRecoverySession.mockResolvedValueOnce({
      success: false,
      result: null,
      analysis: "Dialog never opened",
      suggestedPatch: null,
      toolCalls: 4,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: null,
      durationMs: 1200,
    });

    const res = await runCreateNotebookTask(task, tabHandle, deps);

    expect(res.success).toBe(false);
    expect(res.error).toContain("rename failed");
    expect(res.error).toContain("https://notebooklm.google.com/notebook/new123");
    expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();
  });

  it("rejects /notebook/creating from create script output", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle("https://notebooklm.google.com/notebook/creating");
    const deps = createMockDeps();

    mockCreateNotebook.mockResolvedValueOnce(
      createSuccessResult(
        "createNotebook",
        JSON.stringify({
          url: "https://notebooklm.google.com/notebook/creating",
          title: "Untitled notebook",
        }),
      ),
    );

    const res = await runCreateNotebookTask(task, tabHandle, deps);

    expect(res.success).toBe(false);
    expect(res.error).toContain("did not leave a NotebookLM notebook URL");
    expect(mockRenameNotebook).not.toHaveBeenCalled();
    expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();
  });

  it("rejects /notebook/creating from recovery browser state", async () => {
    const task = createMockTask();
    const tabHandle = createMockTabHandle("https://notebooklm.google.com/notebook/creating");
    const deps = createMockDeps();

    mockCreateNotebook.mockResolvedValueOnce(createFailResult("createNotebook", "create_button"));
    mockRunRecoverySession.mockResolvedValueOnce({
      success: true,
      result: null,
      analysis: "Recovered",
      suggestedPatch: null,
      toolCalls: 3,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: null,
      durationMs: 1000,
    });

    const res = await runCreateNotebookTask(task, tabHandle, deps);

    expect(res.success).toBe(false);
    expect(res.error).toContain("browser state does not show");
    expect(mockRenameNotebook).not.toHaveBeenCalled();
    expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();
  });
});
