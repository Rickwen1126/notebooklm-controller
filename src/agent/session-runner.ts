/**
 * Session runner — executes agent tasks within Copilot SDK sessions.
 *
 * Two-level API:
 *   - `runSession()` — low-level primitive: single session lifecycle
 *   - `runDualSession()` — high-level: Planner+Executor orchestration
 *
 * The dual-session architecture (Phase 5.5) replaces the original CustomAgent
 * sub-agent approach because sub-agents cannot access defineTool() custom tools
 * (Finding #39). Instead:
 *   - Planner session: NL intent → structured ExecutionPlan (via submitPlan tool)
 *   - Executor session(s): per-step browser automation with filtered tools
 */

import type { CopilotSession } from "@github/copilot-sdk";
import type {
  CustomAgentConfig,
  Tool,
  PermissionHandler,
  SessionConfig,
} from "@github/copilot-sdk";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { CopilotClientSingleton } from "./client.js";
import { buildPlannerCatalog } from "./agent-loader.js";
import { DEFAULT_SESSION_TIMEOUT_MS, PLANNER_MODEL, EXECUTOR_MODEL, DEFAULT_AGENT_MODEL, NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { AgentConfig, ExecutionPlan, ExecutionStep } from "../shared/types.js";

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
// Dual Session: Types
// ---------------------------------------------------------------------------

export interface DualSessionOptions {
  client: CopilotClientSingleton;
  /** All available browser + state tools (will be filtered per step). */
  tools: Tool<any>[];
  /** Loaded agent configs (Planner reads catalog, Executor reads prompt). */
  agentConfigs: AgentConfig[];
  /** Hooks forwarded to Executor sessions. */
  hooks?: SessionConfig['hooks'];
  /** Resolved locale string (e.g. "zh-TW"). */
  locale: string;
  /** Target notebook alias — injected as canonical context into Executor prompt. */
  notebookAlias: string;
  /** Current tab URL — used for pre-navigate anchor check. */
  tabUrl?: string;
  /** Model for Planner session. Defaults to DEFAULT_AGENT_MODEL. */
  plannerModel?: string;
  /** Model for Executor sessions. Defaults to DEFAULT_AGENT_MODEL. */
  executorModel?: string;
  /** Timeout for Planner. Defaults to 60s. */
  plannerTimeoutMs?: number;
  /** Timeout per Executor step. Defaults to DEFAULT_SESSION_TIMEOUT_MS. */
  executorTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Dual Session: Planner
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
  options: DualSessionOptions,
  prompt: string,
): Promise<PlannerResult> {
  const {
    client,
    agentConfigs,
    locale,
    plannerModel = PLANNER_MODEL,
    plannerTimeoutMs = PLANNER_TIMEOUT_MS,
  } = options;

  const log = logger.child({ module: "session-runner:planner" });

  // Build agent catalog for the Planner's system message.
  const agentCatalog = buildPlannerCatalog(agentConfigs);

  // Canonical notebook context for Planner (T-HF03)
  const notebookAlias = options.notebookAlias;

  const plannerSystemMessage = `You are the Planner for a NotebookLM controller. Your task is to analyze the user's natural-language instruction, select the correct agent config, and assemble a structured prompt for the Executor to carry out.

## Target Notebook

Target: ${notebookAlias}
(This notebook alias has already been resolved by the system — do not guess it from the user's instruction.)

## Available Agent Configs

${agentCatalog}

## Your Output

Call the submitPlan tool to submit an execution plan. Each step contains:
- agentName: the name of the agent config to use
- executorPrompt: a clear, specific instruction for the Executor (include concrete parameter values)
- tools: the list of tool names needed for this step (taken from the agent config's tools field)

## Rules

1. A single operation produces exactly 1 step.
2. A compound operation (e.g. "add a source then ask a question") produces multiple steps in order.
3. executorPrompt describes **WHAT to achieve**, not HOW to operate the UI. Examples:
   - Good: "建立新筆記本，標題為 nbctl-test"
   - Good: "把 https://example.com 的內容加入來源"
   - Bad: "點擊新建按鈕，然後回首頁找到 more_vert 選單..." (不要指定 UI 操作步驟)
   The Executor's agent prompt defines the operation method — your job is only to specify the goal and parameters.
4. executorPrompt must include concrete parameter values. For example, not "ask a question" but "Ask NotebookLM: What are the advantages of TypeScript?"
5. Do not execute operations yourself — only plan.
6. If the user's request is unrelated to NotebookLM operations, harmful, ambiguous, missing required context, or unsupported, call the rejectInput tool with a category and reason. Do not call submitPlan.
7. The user's input may be in any language. Always understand their intent regardless of language.
8. Current locale: ${locale}`;

  // Capture plan or rejection via closure.
  // Use `as` to preserve full union type — TS control flow can't track closure assignments.
  let capturedPlan = null as ExecutionPlan | null;
  let capturedRejection = null as { category: RejectionCategory; reason: string } | null;

  const submitPlanTool = defineTool("submitPlan", {
    description: "Submit the execution plan for the Executor to carry out.",
    parameters: z.object({
      reasoning: z.string().describe("Brief explanation of why these steps were chosen"),
      steps: z.array(z.object({
        agentName: z.string().describe("Name of the agent config to use"),
        executorPrompt: z.string().describe("Clear instruction for the Executor"),
        tools: z.array(z.string()).describe("Tool names needed for this step"),
      })),
    }),
    handler: async (args: { reasoning: string; steps: ExecutionStep[] }) => {
      capturedPlan = { steps: args.steps, reasoning: args.reasoning };
      return {
        textResultForLlm: `Plan accepted: ${args.steps.length} step(s).`,
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
    agentCount: agentConfigs.length,
    locale,
  });
  log.debug("Planner input", {
    prompt: prompt.slice(0, 1000),
    systemMessageLength: plannerSystemMessage.length,
    agentCatalog: agentCatalog.slice(0, 1000),
  });

  // Run Planner as a single session with submitPlan + rejectInput tools.
  // System message is passed via createSession({ systemMessage }) to separate
  // session-level policy from step-level instruction (T-HF04).
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

  // Check rejection first — if the Planner rejected, return early.
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
    steps: capturedPlan.steps.map((s) => s.agentName),
  });

  return { kind: "plan", plan: capturedPlan };
}

// ---------------------------------------------------------------------------
// Dual Session: Executor
// ---------------------------------------------------------------------------

/** Tool constraint preamble prepended to Executor systemMessage. */
const TOOL_CONSTRAINT_PREAMBLE = `## 重要：工具限制

你只能使用以下 browser tools 完成任務：{TOOL_LIST}
**禁止使用** bash, view, edit, grep 等任何其他內建工具。所有操作必須透過上述 browser tools 完成。
如果你覺得需要讀取檔案或執行 shell 命令，那是錯誤的方向 — 你操作的是瀏覽器，不是檔案系統。

`;

/**
 * Run a single Executor session for one step of the plan.
 *
 * Looks up the agent config by name, filters tools to what the step needs,
 * and prepends the tool constraint preamble to the agent's prompt.
 */
export async function runExecutorSession(
  options: DualSessionOptions,
  step: ExecutionStep,
): Promise<SessionResult> {
  const {
    client,
    tools: allTools,
    agentConfigs,
    hooks,
    executorModel = EXECUTOR_MODEL,
    executorTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = options;

  const log = logger.child({ module: "session-runner:executor", agent: step.agentName });

  // 1. Look up the agent config.
  const agentConfig = agentConfigs.find((c) => c.name === step.agentName);
  if (!agentConfig) {
    return {
      success: false,
      error: `Unknown agent: ${step.agentName}`,
      durationMs: 0,
    };
  }

  // 2. Filter tools to only what this step needs.
  const toolNameSet = new Set(step.tools);
  const filteredTools = allTools.filter(
    (t) => toolNameSet.has((t as { name?: string }).name ?? ""),
  );
  // Always include screenshot for observability.
  if (!toolNameSet.has("screenshot")) {
    const screenshotTool = allTools.find(
      (t) => (t as { name?: string }).name === "screenshot",
    );
    if (screenshotTool) filteredTools.push(screenshotTool);
  }

  // Warn if any requested tools (excluding auto-included "screenshot") were not found.
  const matchedNames = new Set(
    filteredTools.map((t) => (t as { name?: string }).name ?? ""),
  );
  const expectedCount = Array.from(toolNameSet).filter((n) => n !== "screenshot").length;
  const foundCount = Array.from(toolNameSet).filter((n) => n !== "screenshot" && matchedNames.has(n)).length;
  if (foundCount < expectedCount) {
    const unmatched = Array.from(toolNameSet).filter(
      (n) => n !== "screenshot" && !matchedNames.has(n),
    );
    log.warn("Executor tool filtering: unmatched tool names (possible typo in plan)", {
      agentName: step.agentName,
      unmatched,
    });
  }

  // 3. Build Executor systemMessage: tool constraint + canonical context + agent prompt.
  const toolList = [...step.tools, "screenshot"].join(", ");
  const constraint = TOOL_CONSTRAINT_PREAMBLE.replace("{TOOL_LIST}", toolList);

  // Canonical notebook context (explicitly injected so agent knows target)
  const notebookContext = `## 系統背景\n\n目標 Notebook: ${options.notebookAlias}\n\n`;

  // FR-179: Pre-navigate hint (O(1) URL exact match, hint not assertion)
  let navigateHint = "";
  if (options.tabUrl && agentConfig.startPage) {
    const expectHomepage = agentConfig.startPage === "homepage";
    const isOnHomepage = options.tabUrl === NOTEBOOKLM_HOMEPAGE || options.tabUrl === NOTEBOOKLM_HOMEPAGE + "/";
    const isOnNotebook = options.tabUrl.startsWith(NOTEBOOKLM_HOMEPAGE + "/notebook/");

    if (expectHomepage && !isOnHomepage) {
      navigateHint = `[系統提示: 此 agent 預期在 homepage 操作，但目前頁面為 ${options.tabUrl}。建議先 navigate 至 ${NOTEBOOKLM_HOMEPAGE}]\n\n`;
    } else if (!expectHomepage && !isOnNotebook) {
      navigateHint = `[系統提示: 此 agent 預期在 notebook 頁面操作，但目前頁面為 ${options.tabUrl}]\n\n`;
    }
  }

  const systemMessage = constraint + notebookContext + navigateHint + agentConfig.prompt;

  log.info("Starting Executor session", {
    agentName: step.agentName,
    toolCount: filteredTools.length,
    promptLength: step.executorPrompt.length,
  });
  log.debug("Executor input", {
    executorPrompt: step.executorPrompt.slice(0, 1000),
    systemMessageLength: systemMessage.length,
    tools: filteredTools.map((t) => (t as { name?: string }).name ?? "?"),
  });

  // 4. Run via the low-level runSession primitive.
  //    Session-level policy (tool constraints, notebook context, agent prompt) is
  //    passed via createSession({ systemMessage }); step-level instruction goes
  //    as the sendAndWait prompt (T-HF04).
  return runSession(
    {
      client,
      tools: filteredTools,
      customAgents: [],
      hooks,
      model: executorModel,
      systemMessage,
      timeoutMs: executorTimeoutMs,
    },
    step.executorPrompt,
  );
}

// ---------------------------------------------------------------------------
// Dual Session: Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full dual-session flow: Planner → Executor(s) → aggregate result.
 *
 * This is the main entry point called by the Scheduler's `runTask`.
 */
export async function runDualSession(
  options: DualSessionOptions,
  prompt: string,
): Promise<SessionResult> {
  const log = logger.child({ module: "session-runner:dual" });
  const startTime = Date.now();

  try {
    // 1. Planner: parse intent → ExecutionPlan or rejection.
    const plannerResult = await runPlannerSession(options, prompt);

    // 1a. If Planner rejected the input, return early with rejection metadata.
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

    // 2. Executor: run each step sequentially.
    const stepResults: SessionResult[] = [];
    for (const [i, step] of plan.steps.entries()) {
      log.info("Executing step", {
        stepIndex: i + 1,
        totalSteps: plan.steps.length,
        agentName: step.agentName,
      });

      const stepResult = await runExecutorSession(options, step);
      stepResults.push(stepResult);

      // If a step fails, stop and propagate the error.
      if (!stepResult.success) {
        const durationMs = Date.now() - startTime;
        log.error("Executor step failed", {
          stepIndex: i + 1,
          agentName: step.agentName,
          error: stepResult.error,
        });
        return {
          success: false,
          error: `Step ${i + 1}/${plan.steps.length} [${step.agentName}] failed: ${stepResult.error}`,
          durationMs,
        };
      }
    }

    // 3. Aggregate results.
    const durationMs = Date.now() - startTime;
    const lastResult = stepResults[stepResults.length - 1];

    log.info("Dual session completed", {
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

    log.error("Dual session failed", { error: errorMessage, durationMs });

    return {
      success: false,
      error: errorMessage,
      durationMs,
    };
  }
}
