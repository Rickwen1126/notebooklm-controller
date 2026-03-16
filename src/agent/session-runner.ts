/**
 * Session runner — executes agent tasks within Copilot SDK sessions.
 *
 * Two-level API:
 *   - `runSession()` — low-level primitive: single session lifecycle
 *   - `runPipeline()` — high-level: Planner → Script → Recovery orchestration
 *
 * G2 architecture: deterministic scripts replace LLM Executor sessions.
 * Happy path = 0 LLM (script only). Failure = Recovery session (GPT-5-mini).
 */

import type { CopilotSession } from "@github/copilot-sdk";
import type { CDPSession, Page } from "puppeteer-core";
import type {
  CustomAgentConfig,
  Tool,
  PermissionHandler,
  SessionConfig,
} from "@github/copilot-sdk";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { CopilotClientSingleton } from "./client.js";
import { buildScriptCatalog, runScript } from "../scripts/index.js";
import { runRecoverySession } from "./recovery-session.js";
import { saveRepairLog, saveScreenshot } from "./repair-log.js";
import { runAgentSession } from "./agent-session.js";
import { loadAgentConfig } from "./agent-loader.js";
import { DEFAULT_SESSION_TIMEOUT_MS, PLANNER_MODEL, DEFAULT_AGENT_MODEL, AGENTS_DIR_USER, AGENTS_DIR_BUNDLED } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { ExecutionPlan, ExecutionStep, UIMap } from "../shared/types.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ScriptContext } from "../scripts/types.js";
import { findElementByText } from "../scripts/find-element.js";
import { pollForAnswer, waitForGone, waitForVisible, waitForEnabled, waitForNavigation, waitForCountChange } from "../scripts/wait-primitives.js";
import { ensureChatPanel, ensureSourcePanel, ensureHomepage } from "../scripts/ensure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRunnerOptions {
  client: CopilotClientSingleton;
  tools: Tool<any>[];
  customAgents: CustomAgentConfig[];
  hooks?: SessionConfig['hooks'];
  /** Permission handler forwarded to createSession. Defaults to auto-approve. */
  onPermissionRequest?: PermissionHandler;
  /** Model to use for the session. Defaults to DEFAULT_AGENT_MODEL. */
  model?: string;
  /** Session-level system message forwarded to createSession({ systemMessage }). */
  systemMessage?: string;
  /** Timeout in ms for sendAndWait. Defaults to DEFAULT_SESSION_TIMEOUT_MS (5 min). */
  timeoutMs?: number;
}

export interface SessionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  /** Base64-encoded screenshot captured on error (if available). */
  errorScreenshot?: string;
  /** Duration of the session in milliseconds. Present when returned by session-runner. */
  durationMs?: number;
  /** Set to true when the Planner rejects the input instead of producing a plan. */
  rejected?: boolean;
  /** Rejection category. Present only when rejected is true. */
  rejectionCategory?: string;
  /** Human-readable explanation of why the input was rejected. */
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Default permission handler (auto-approve all)
// ---------------------------------------------------------------------------

const autoApprove: PermissionHandler = () => ({ kind: "approved" as const });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single agent session: create → sendAndWait → disconnect.
 *
 * @param options - Session configuration (client, tools, agents, hooks, timeout).
 * @param prompt  - The prompt to send to the agent.
 * @returns A SessionResult indicating success/failure, duration, and optional result.
 */
export async function runSession(
  options: SessionRunnerOptions,
  prompt: string,
): Promise<SessionResult> {
  const {
    client,
    tools,
    customAgents,
    hooks,
    onPermissionRequest = autoApprove,
    model = DEFAULT_AGENT_MODEL,
    systemMessage,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = options;

  const log = logger.child({ module: "session-runner" });
  const startTime = Date.now();
  let session: CopilotSession | undefined;

  try {
    // 1. Obtain the underlying SDK client.
    const sdkClient = client.getClient();

    log.info("Creating session", {
      model,
      toolCount: tools.length,
      agentCount: customAgents.length,
      timeoutMs,
    });
    log.debug("Session systemMessage", {
      systemMessage: systemMessage?.slice(0, 2000),
      systemMessageLength: systemMessage?.length,
    });

    // 2. Create a session with tools, custom agents, hooks, and permission handler.
    session = await sdkClient.createSession({
      model,
      tools,
      customAgents,
      hooks,
      onPermissionRequest,
      ...(systemMessage ? { systemMessage: { mode: "replace" as const, content: systemMessage } } : {}),
    });

    log.info("Session created, sending prompt", {
      sessionId: session.sessionId,
      promptLength: prompt.length,
    });
    log.debug("Session prompt", {
      prompt: prompt.slice(0, 2000),
    });

    // 3. Send prompt and wait for completion with timeout.
    const response = await session.sendAndWait({ prompt }, timeoutMs);

    // T041.6: Response validation — log response shape for debugging.
    if (!response) {
      log.warn("sendAndWait returned null response", {
        sessionId: session.sessionId,
      });
    }

    const content = response?.data?.content ?? undefined;
    const durationMs = Date.now() - startTime;

    log.info("Session completed successfully", {
      sessionId: session.sessionId,
      durationMs,
      hasResponse: response != null,
    });

    return {
      success: true,
      result: content,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    log.error("Session failed", {
      error: errorMessage,
      durationMs,
    });

    return {
      success: false,
      error: errorMessage,
      durationMs,
    };
  } finally {
    // 4. Always disconnect the session to release resources.
    //    T041.7: Wrap with timeout guard so a hanging disconnect() doesn't block the scheduler.
    if (session) {
      try {
        await Promise.race([
          session.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("disconnect timeout")), 5_000),
          ),
        ]);
      } catch (disconnectErr: unknown) {
        const msg =
          disconnectErr instanceof Error
            ? disconnectErr.message
            : String(disconnectErr);
        log.warn("Failed to disconnect session", { error: msg });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline: Types
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  client: CopilotClientSingleton;
  /** All available browser + state tools (Recovery session uses these). */
  tools: Tool<any>[];
  /** CDP session for deterministic scripts. */
  cdpSession: CDPSession;
  /** Puppeteer page for deterministic scripts. */
  page: Page;
  /** Loaded UIMap for the current locale. */
  uiMap: UIMap;
  /** Resolved locale string (e.g. "zh-TW"). */
  locale: string;
  /** Target notebook alias — injected as canonical context. */
  notebookAlias: string;
  /** Task ID for screenshot persistence. */
  taskId?: string;
  /** NetworkGate for rate-limit protection. Acquired per-operation before each script. */
  networkGate?: { acquirePermit: () => Promise<void> };
  /** Model for Planner session. Defaults to PLANNER_MODEL. */
  plannerModel?: string;
  /** Timeout for Planner. Defaults to 60s. */
  plannerTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Pipeline: Planner
// ---------------------------------------------------------------------------

const PLANNER_TIMEOUT_MS = 60_000;

/** Valid rejection categories for the rejectInput tool. */
export const REJECTION_CATEGORIES = [
  "off_topic",
  "harmful",
  "ambiguous",
  "unsupported",
  "missing_context",
  "system",
] as const;

export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

/** Discriminated union: Planner either produces a plan or rejects the input. */
export type PlannerResult =
  | { kind: "plan"; plan: ExecutionPlan }
  | { kind: "rejected"; category: RejectionCategory; reason: string };

/**
 * Run the Planner session: parse NL intent → select agent → output ExecutionPlan,
 * or reject the input if it falls outside NotebookLM scope.
 *
 * The Planner has two tools:
 *   - `submitPlan` — captures the structured plan via a closure
 *   - `rejectInput` — captures a rejection with category + reason
 *
 * Returns a discriminated PlannerResult so the caller can distinguish plans
 * from rejections without exceptions.
 */
export async function runPlannerSession(
  options: PipelineOptions,
  prompt: string,
): Promise<PlannerResult> {
  const {
    client,
    locale,
    plannerModel = PLANNER_MODEL,
    plannerTimeoutMs = PLANNER_TIMEOUT_MS,
  } = options;

  const log = logger.child({ module: "session-runner:planner" });

  // Build script catalog for the Planner's system message.
  const scriptCatalog = buildScriptCatalog();

  // Canonical notebook context for Planner (T-HF03)
  const notebookAlias = options.notebookAlias;

  const plannerSystemMessage = `You are the Planner for a NotebookLM controller. Your task is to analyze the user's natural-language instruction and select the correct scripted operation(s) with parameters.

## Target Notebook

Target: ${notebookAlias}
(This notebook alias has already been resolved by the system — do not guess it from the user's instruction.)

## Available Operations

${scriptCatalog}

## Your Output

Call the submitPlan tool to submit an execution plan. Each step contains:
- operation: the name of the scripted operation to run
- params: a JSON object with the required parameters for that operation

## Rules

1. A single operation produces exactly 1 step.
2. A compound operation (e.g. "add a source then ask a question") produces multiple steps in order.
3. params must include concrete values. For example, not just "ask a question" but \`{ "question": "What are the advantages of TypeScript?" }\`.
4. For addSource: ALWAYS provide a sourceName. Derive it from the input:
   - repo path → repo folder name + "(repo)", e.g. "my-project (repo)"
   - URL → domain + path + "(web)", e.g. "en.wikipedia.org/TypeScript (web)"
   - PDF path → filename without extension + "(PDF)", e.g. "Copilot SDK 簡報 (PDF)"
   - plain text → brief description from user prompt, e.g. "TypeScript 測試內容"
5. Do not execute operations yourself — only plan.
6. If the user's request is unrelated to NotebookLM operations, harmful, ambiguous, missing required context, or unsupported, call the rejectInput tool with a category and reason. Do not call submitPlan.
7. The user's input may be in any language. Always understand their intent regardless of language.
8. Current locale: ${locale}`;

  // Capture plan or rejection via closure.
  let capturedPlan = null as ExecutionPlan | null;
  let capturedRejection = null as { category: RejectionCategory; reason: string } | null;

  // Copilot SDK defineTool does NOT support z.record() — use expanded optional fields.
  // The Planner fills in whichever params the operation needs.
  const submitPlanTool = defineTool("submitPlan", {
    description: "Submit the execution plan with operations (script or agent mode).",
    parameters: z.object({
      reasoning: z.string().describe("Brief explanation of why these steps were chosen"),
      steps: z.array(z.object({
        operation: z.string().describe("Name of the operation to run"),
        mode: z.string().optional().describe("Execution mode: 'script' (default) or 'agent' (LLM with browser tools)"),
        question: z.string().optional().describe("For query: the question to ask"),
        content: z.string().optional().describe("For addSource: the text content (for plain text sources)"),
        newName: z.string().optional().describe("For renameSource/renameNotebook: new name"),
        sourceType: z.string().optional().describe("For addSource: text | repo | url | pdf (default: text)"),
        sourcePath: z.string().optional().describe("For addSource with repo/pdf: absolute file path"),
        sourceUrl: z.string().optional().describe("For addSource with url: the URL to fetch and convert"),
        sourceName: z.string().optional().describe("For addSource: human-readable name for the source (auto-rename after paste)"),
      })),
    }),
    handler: async (args: { reasoning: string; steps: Array<{ operation: string; mode?: string; question?: string; content?: string; newName?: string; sourceType?: string; sourcePath?: string; sourceUrl?: string; sourceName?: string }> }) => {
      // Convert expanded fields into params Record<string, string>
      const steps: ExecutionStep[] = args.steps.map((s) => {
        const params: Record<string, string> = {};
        if (s.question) params.question = s.question;
        if (s.content) params.content = s.content;
        if (s.newName) params.newName = s.newName;
        if (s.sourceType) params.sourceType = s.sourceType;
        if (s.sourcePath) params.sourcePath = s.sourcePath;
        if (s.sourceUrl) params.sourceUrl = s.sourceUrl;
        if (s.sourceName) params.sourceName = s.sourceName;
        const mode = (s.mode === "agent" ? "agent" : "script") as "script" | "agent";
        return { operation: s.operation, params, mode };
      });
      capturedPlan = { steps, reasoning: args.reasoning };
      return {
        textResultForLlm: `Plan accepted: ${steps.length} step(s).`,
        resultType: "success" as const,
      };
    },
  });

  const rejectInputTool = defineTool("rejectInput", {
    description: "Reject the user's input when it cannot be handled by NotebookLM operations.",
    parameters: z.object({
      category: z.enum(REJECTION_CATEGORIES).describe("Rejection category"),
      reason: z.string().describe("Human-readable explanation of why the input was rejected"),
    }),
    handler: async (args: { category: RejectionCategory; reason: string }) => {
      capturedRejection = { category: args.category, reason: args.reason };
      return {
        textResultForLlm: `Input rejected (${args.category}): ${args.reason}`,
        resultType: "success" as const,
      };
    },
  });

  log.info("Starting Planner session", {
    promptLength: prompt.length,
    locale,
  });

  await runSession(
    {
      client,
      tools: [submitPlanTool, rejectInputTool] as Tool<any>[],
      customAgents: [],
      hooks: {},
      model: plannerModel,
      systemMessage: plannerSystemMessage,
      timeoutMs: plannerTimeoutMs,
    },
    prompt,
  );

  if (capturedRejection) {
    log.info("Planner rejected input", {
      category: capturedRejection.category,
      reason: capturedRejection.reason,
    });
    return {
      kind: "rejected",
      category: capturedRejection.category,
      reason: capturedRejection.reason,
    };
  }

  if (!capturedPlan) {
    throw new Error("Planner did not submit a plan — request may be outside NotebookLM scope");
  }

  log.info("Planner completed", {
    reasoning: capturedPlan.reasoning,
    stepCount: capturedPlan.steps.length,
    steps: capturedPlan.steps.map((s) => s.operation),
  });

  return { kind: "plan", plan: capturedPlan };
}

// ---------------------------------------------------------------------------
// Pipeline: ScriptContext builder
// ---------------------------------------------------------------------------

/**
 * Build a ScriptContext from PipelineOptions.
 * Injects all CDP helpers + wait primitives + ensure helpers into ctx.
 */
function buildScriptContext(options: PipelineOptions): ScriptContext {
  const { cdpSession: cdp, page, uiMap } = options;

  // CDP helpers (imported from tab-manager pattern)
  const dispatchClick = async (c: CDPSession, x: number, y: number) => {
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const dispatchPaste = async (c: CDPSession, text: string) => {
    await c.send("Input.insertText", { text });
  };
  const dispatchType = async (c: CDPSession, p: Page, text: string) => {
    const specialKeys: Record<string, { key: string; code: string; keyCode: number }> = {
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    };
    if (text === "Ctrl+A" || text === "ctrl+a") {
      await p.evaluate(`(() => {
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.select(); return; }
        const sel = window.getSelection();
        if (sel && document.activeElement) sel.selectAllChildren(document.activeElement);
      })()`);
      return;
    }
    const special = specialKeys[text];
    if (special) {
      await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
      return;
    }
    for (const char of text) {
      await c.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
    }
  };
  const captureScreenshot = async (c: CDPSession) => {
    const result = await c.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    return result.data;
  };

  return {
    cdp,
    page,
    uiMap,
    helpers: {
      findElementByText,
      dispatchClick,
      dispatchPaste,
      dispatchType,
      captureScreenshot,
      pollForAnswer,
      waitForGone,
      waitForVisible,
      waitForEnabled,
      waitForNavigation,
      waitForCountChange,
      ensureChatPanel,
      ensureSourcePanel,
      ensureHomepage,
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline: Orchestrator (G2: Planner → Script → Recovery)
// ---------------------------------------------------------------------------

/**
 * Run the full G2 flow: Planner → Script(s) → Recovery-on-fail → aggregate result.
 *
 * Happy path: Planner → deterministic script → done (0 LLM for execution).
 * Failure:    Script fails → Recovery LLM session completes + analyzes + patches.
 *
 * This is the main entry point called by the Scheduler's `runTask`.
 */
export async function runPipeline(
  options: PipelineOptions,
  prompt: string,
): Promise<SessionResult> {
  const log = logger.child({ module: "session-runner:pipeline" });
  const startTime = Date.now();

  try {
    // 1. Planner: parse intent → ExecutionPlan or rejection.
    const plannerResult = await runPlannerSession(options, prompt);

    if (plannerResult.kind === "rejected") {
      const durationMs = Date.now() - startTime;
      log.info("Planner rejected input", {
        category: plannerResult.category,
        reason: plannerResult.reason,
        durationMs,
      });
      return {
        success: false,
        rejected: true,
        rejectionCategory: plannerResult.category,
        rejectionReason: plannerResult.reason,
        durationMs,
      };
    }

    const plan = plannerResult.plan;
    const ctx = buildScriptContext(options);

    // 2. Execute each step: Script → (fail? Recovery) → continue.
    const stepResults: Array<{ result?: unknown }> = [];
    for (const [i, step] of plan.steps.entries()) {
      const mode = step.mode ?? "script";
      log.info("Executing step", {
        stepIndex: i + 1,
        totalSteps: plan.steps.length,
        operation: step.operation,
        mode,
      });

      // 2a. Acquire NetworkGate permit (rate-limit protection, per-operation).
      if (options.networkGate) {
        await options.networkGate.acquirePermit();
      }

      // 2b. Dispatch by mode: script (deterministic) or agent (LLM).
      if (mode === "agent") {
        // --- Agent path: LLM + browser tools ---
        const agentsDir = existsSync(AGENTS_DIR_USER) ? AGENTS_DIR_USER : AGENTS_DIR_BUNDLED;
        const agentConfig = await loadAgentConfig(join(agentsDir, `${step.operation}.md`), {}, options.locale);
        if (!agentConfig) {
          const durationMs = Date.now() - startTime;
          return {
            success: false,
            error: `Agent config not found: agents/${step.operation}.md`,
            durationMs,
          };
        }

        const goal = `Operation: ${step.operation}, Params: ${JSON.stringify(step.params)}`;
        const agentResult = await runAgentSession({
          client: options.client,
          cdp: options.cdpSession,
          page: options.page,
          agentConfig,
          goal,
        });

        // Persist screenshot after agent step.
        if (options.taskId) {
          try {
            const ss = await options.cdpSession.send("Page.captureScreenshot", { format: "png" }) as { data: string };
            saveScreenshot(ss.data, options.taskId, `step${i + 1}_${step.operation}_agent`);
          } catch { /* non-critical */ }
        }

        if (agentResult.success) {
          log.info("Agent succeeded", {
            stepIndex: i + 1,
            operation: step.operation,
            toolCalls: agentResult.toolCalls,
            durationMs: agentResult.durationMs,
          });
          stepResults.push({ result: agentResult.result });
          continue;
        }

        // Agent failed → propagate error (no Recovery for agent steps).
        const durationMs = Date.now() - startTime;
        log.error("Agent failed", {
          stepIndex: i + 1,
          operation: step.operation,
          toolCalls: agentResult.toolCalls,
        });
        return {
          success: false,
          error: `Step ${i + 1}/${plan.steps.length} [${step.operation}] agent failed after ${agentResult.toolCalls} tool calls`,
          durationMs,
        };
      }

      // --- Script path: deterministic, 0 LLM ---
      const scriptResult = await runScript(step.operation, step.params, ctx);

      // Persist screenshot after each step (if taskId available).
      if (options.taskId) {
        try {
          const ss = await ctx.helpers.captureScreenshot(ctx.cdp);
          saveScreenshot(ss, options.taskId, `step${i + 1}_${step.operation}`);
        } catch { /* non-critical */ }
      }

      if (scriptResult.status === "success") {
        log.info("Script succeeded", {
          stepIndex: i + 1,
          operation: step.operation,
          totalMs: scriptResult.totalMs,
        });
        stepResults.push({ result: scriptResult.result });
        continue;
      }

      // Script failed → Recovery session.
      log.warn("Script failed, starting Recovery", {
        stepIndex: i + 1,
        operation: step.operation,
        failedAtStep: scriptResult.failedAtStep,
        failedSelector: scriptResult.failedSelector,
      });

      const goal = `Operation: ${step.operation}, Params: ${JSON.stringify(step.params)}`;
      const recoveryResult = await runRecoverySession({
        client: options.client,
        cdp: ctx.cdp,
        page: ctx.page,
        scriptResult,
        goal,
      });

      // Always save repair log (for learning + UIMap patching).
      try {
        saveRepairLog(scriptResult, options.uiMap, recoveryResult);
      } catch { /* non-critical */ }

      if (recoveryResult.success) {
        log.info("Recovery succeeded", {
          stepIndex: i + 1,
          operation: step.operation,
          toolCalls: recoveryResult.toolCalls,
          durationMs: recoveryResult.durationMs,
        });
        stepResults.push({ result: recoveryResult.result });
        continue;
      }

      // Recovery also failed → propagate error.
      const durationMs = Date.now() - startTime;
      log.error("Recovery failed", {
        stepIndex: i + 1,
        operation: step.operation,
        error: recoveryResult.analysis ?? "No analysis",
      });
      return {
        success: false,
        error: `Step ${i + 1}/${plan.steps.length} [${step.operation}] failed: script error at step ${scriptResult.failedAtStep} (${scriptResult.failedSelector}), recovery also failed`,
        errorScreenshot: recoveryResult.finalScreenshot ?? undefined,
        durationMs,
      };
    }

    // 3. Aggregate results.
    const durationMs = Date.now() - startTime;
    const lastResult = stepResults[stepResults.length - 1];

    log.info("Pipeline completed", {
      stepCount: plan.steps.length,
      durationMs,
    });

    return {
      success: true,
      result: lastResult?.result,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    log.error("Pipeline failed", { error: errorMessage, durationMs });

    return {
      success: false,
      error: errorMessage,
      durationMs,
    };
  }
}
