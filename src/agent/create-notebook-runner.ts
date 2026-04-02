/**
 * createNotebook runner — formal homepage runner for create_notebook.
 *
 * Flow:
 * 1. Create notebook via scriptedCreateNotebook
 * 2. Rename on homepage if NotebookLM did not use the requested title
 * 3. Register the created notebook in local state
 *
 * Receives a tabHandle from the dispatcher (already acquired, viewport set).
 * Does NOT manage tab lifecycle.
 */

import { buildScriptContext } from "./session-runner.js";
import { runRecoverySession } from "./recovery-session.js";
import { saveRepairLog } from "./repair-log.js";
import { scriptedCreateNotebook, scriptedRenameNotebook } from "../scripts/operations.js";
import { isFinalNotebookUrl } from "../shared/config.js";
import { normalizeUrl } from "../shared/notebook-utils.js";
import { logger } from "../shared/logger.js";
import type { RunTaskDeps } from "../daemon/types.js";
import type { AsyncTask, NotebookEntry, TabHandle } from "../shared/types.js";

interface CreateNotebookRunnerInput {
  title: string;
  alias: string;
}

interface CreateNotebookScriptResult {
  url: string;
  title: string | null;
}

export interface CreateNotebookResult {
  success: boolean;
  alias: string;
  url: string;
  title: string;
}

function parseRunnerInput(task: AsyncTask): CreateNotebookRunnerInput {
  const input = task.runnerInput;
  if (!input || typeof input !== "object") {
    throw new Error("createNotebook runner requires runnerInput");
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  const alias = typeof input.alias === "string" ? input.alias.trim() : "";
  if (!title) {
    throw new Error("createNotebook runner requires runnerInput.title");
  }
  if (!alias) {
    throw new Error("createNotebook runner requires runnerInput.alias");
  }

  return { title, alias };
}

function parseCreateScriptResult(raw: string): CreateNotebookScriptResult {
  const parsed = JSON.parse(raw) as Partial<CreateNotebookScriptResult>;
  if (typeof parsed.url !== "string" || parsed.url.length === 0) {
    throw new Error("createNotebook script returned invalid URL");
  }
  return {
    url: parsed.url,
    title: typeof parsed.title === "string" ? parsed.title : null,
  };
}

function buildEntry(alias: string, url: string, title: string): NotebookEntry {
  const now = new Date().toISOString();
  return {
    alias,
    url,
    title,
    description: "",
    status: "ready",
    registeredAt: now,
    lastAccessedAt: now,
    sourceCount: 0,
  };
}

function remoteCreationError(url: string | null, message: string): string {
  if (!url) return message;
  return `${message} Remote notebook may already exist at ${url}.`;
}

async function readNotebookTitle(tabHandle: TabHandle): Promise<string | null> {
  const rawTitle = await tabHandle.page.evaluate(`(() => {
    const candidates = [
      document.querySelector("h1.notebook-title")?.textContent,
      document.querySelector(".title-label-inner")?.textContent,
      document.querySelector("input.title-input")?.value,
      document.querySelector("h1")?.textContent,
    ];

    for (const value of candidates) {
      if (typeof value !== "string") continue;
      const normalized = value.trim();
      if (normalized) return normalized;
    }

    return null;
  })()`) as string | null;

  return typeof rawTitle === "string" ? rawTitle.trim() || null : null;
}

export async function runCreateNotebookTask(
  task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
): Promise<{ success: boolean; result?: object; error?: string }> {
  const log = logger.child({ module: "createNotebook" });

  try {
    if (task.notebookAlias !== "__homepage__") {
      return {
        success: false,
        error: "createNotebook runner must execute on __homepage__",
      };
    }

    const input = parseRunnerInput(task);
    const ctx = buildScriptContext({
      cdpSession: tabHandle.cdpSession,
      page: tabHandle.page,
      uiMap: deps.uiMap,
    });

    let createdUrl: string | null = null;
    let observedTitle: string | null = null;

    const createResult = await scriptedCreateNotebook(ctx);
    if (createResult.status === "success" && createResult.result) {
      const parsed = parseCreateScriptResult(createResult.result);
      createdUrl = normalizeUrl(parsed.url);
      if (!isFinalNotebookUrl(createdUrl)) {
        return {
          success: false,
          error: "createNotebook script completed but did not leave a NotebookLM notebook URL",
        };
      }
      observedTitle = parsed.title?.trim() || await readNotebookTitle(tabHandle);
    } else {
      const recoveryResult = await runRecoverySession({
        client: deps.copilotClient,
        cdp: tabHandle.cdpSession,
        page: tabHandle.page,
        scriptResult: createResult,
        goal:
          `Create a new NotebookLM notebook titled "${input.title}". ` +
          "Complete the creation flow and leave the browser on the created notebook page.",
      });

      if (!recoveryResult.success) {
        try {
          saveRepairLog(createResult, deps.uiMap, recoveryResult);
        } catch {
          /* non-critical */
        }
        return {
          success: false,
          error: `Failed to create notebook: ${recoveryResult.analysis ?? "Recovery failed"}`,
        };
      }

      try {
        saveRepairLog(createResult, deps.uiMap, recoveryResult);
      } catch {
        /* non-critical */
      }

      createdUrl = normalizeUrl(tabHandle.page.url());
      if (!isFinalNotebookUrl(createdUrl)) {
        return {
          success: false,
          error:
            "Recovery reported success, but browser state does not show a NotebookLM notebook URL.",
        };
      }
      observedTitle = await readNotebookTitle(tabHandle);
    }

    const renameNeeded = observedTitle !== input.title;

    if (renameNeeded) {
      const renameResult = await scriptedRenameNotebook(ctx, input.title);
      if (renameResult.status !== "success") {
        const recoveryResult = await runRecoverySession({
          client: deps.copilotClient,
          cdp: tabHandle.cdpSession,
          page: tabHandle.page,
          scriptResult: renameResult,
          goal:
            `Rename the newly created notebook to "${input.title}". ` +
            `The created notebook URL is ${createdUrl}.`,
        });

        if (!recoveryResult.success) {
          try {
            saveRepairLog(renameResult, deps.uiMap, recoveryResult);
          } catch {
            /* non-critical */
          }
          return {
            success: false,
            error: remoteCreationError(
              createdUrl,
              `Notebook creation succeeded but rename failed: ${recoveryResult.analysis ?? "Recovery failed"}`,
            ),
          };
        }

        try {
          saveRepairLog(renameResult, deps.uiMap, recoveryResult);
        } catch {
          /* non-critical */
        }
      }
    }

    const currentByAlias = await deps.stateManager.getNotebook(input.alias);
    if (currentByAlias) {
      return {
        success: false,
        error: remoteCreationError(
          createdUrl,
          `Alias already exists locally: "${input.alias}"`,
        ),
      };
    }

    const state = await deps.stateManager.load();
    const existingByUrl = Object.values(state.notebooks).find(
      (notebook) => normalizeUrl(notebook.url) === createdUrl,
    );
    if (existingByUrl) {
      return {
        success: false,
        error: remoteCreationError(
          createdUrl,
          `Created notebook URL is already registered under alias "${existingByUrl.alias}"`,
        ),
      };
    }

    const entry = buildEntry(input.alias, createdUrl, input.title);
    await deps.stateManager.addNotebook(entry);

    const result: CreateNotebookResult = {
      success: true,
      alias: input.alias,
      url: createdUrl,
      title: input.title,
    };

    log.info("Notebook created and registered", {
      alias: input.alias,
      url: createdUrl,
      title: input.title,
    });

    return {
      success: true,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}
