import type { CDPSession, Page } from "puppeteer-core";
import type { UIMap } from "../shared/types.js";

// --- Reexport FoundElement from find-element (will be created in T4) ---
// For now, define inline to avoid circular deps

export interface FoundElement {
  tag: string;
  text: string;
  center: { x: number; y: number };
  rect: { x: number; y: number; w: number; h: number };
  disabled: boolean;
}

export interface ScriptLogEntry {
  step: number;
  action: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  durationMs: number;
}

export interface ScriptResult {
  operation: string;
  status: "success" | "partial" | "fail";
  result: string | null;
  log: ScriptLogEntry[];
  totalMs: number;
  failedAtStep: number | null;
  failedSelector: string | null;
}

export interface PollOptions {
  maxWaitMs?: number;
  stableCount?: number;
  pollIntervalMs?: number;
  rejectPattern?: string;
  baselineHash?: string;
}

/** All dependencies injected into scripts — zero imports in script files. */
export interface ScriptContext {
  cdp: CDPSession;
  page: Page;
  uiMap: UIMap;
  helpers: {
    findElementByText: (
      page: Page,
      text: string,
      options?: { match?: "text" | "placeholder" | "aria-label"; disambiguate?: string },
    ) => Promise<FoundElement | null>;
    dispatchClick: (cdp: CDPSession, x: number, y: number) => Promise<void>;
    dispatchPaste: (cdp: CDPSession, text: string) => Promise<void>;
    dispatchType: (cdp: CDPSession, page: Page, text: string) => Promise<void>;
    captureScreenshot: (cdp: CDPSession) => Promise<string>;
    pollForAnswer: (
      page: Page,
      answerSelector: string,
      options?: PollOptions,
    ) => Promise<{ text: string | null; elapsedMs: number; stable: boolean }>;
    waitForGone: (
      page: Page,
      selector: string,
      options?: { timeoutMs?: number; pollIntervalMs?: number },
    ) => Promise<{ gone: boolean; elapsedMs: number }>;
    waitForVisible: (
      page: Page,
      selector: string,
      options?: { timeoutMs?: number; pollIntervalMs?: number },
    ) => Promise<{ visible: boolean; elapsedMs: number }>;
    waitForEnabled: (
      page: Page,
      text: string,
      matchType?: "text" | "placeholder" | "aria-label",
      options?: { timeoutMs?: number; pollIntervalMs?: number },
    ) => Promise<{ enabled: boolean; element: FoundElement | null; elapsedMs: number }>;
    waitForNavigation: (
      page: Page,
      opts?: { timeoutMs?: number; pollIntervalMs?: number; urlContains?: string; notUrl?: string },
    ) => Promise<{ navigated: boolean; url: string; elapsedMs: number }>;
    waitForCountChange: (
      page: Page,
      selector: string,
      baselineCount: number,
      options?: { timeoutMs?: number; pollIntervalMs?: number },
    ) => Promise<{ changed: boolean; newCount: number; elapsedMs: number }>;
    ensureChatPanel: (ctx: ScriptContext, log: ScriptLogEntry[], t0: number) => Promise<boolean>;
    ensureSourcePanel: (ctx: ScriptContext, log: ScriptLogEntry[], t0: number) => Promise<boolean>;
    ensureHomepage: (ctx: ScriptContext, log: ScriptLogEntry[], t0: number) => Promise<boolean>;
  };
}

/** Create a structured log entry with computed duration. */
export function createLogEntry(
  step: number,
  action: string,
  status: "ok" | "warn" | "fail",
  detail: string,
  startMs: number,
): ScriptLogEntry {
  return { step, action, status, detail, durationMs: Date.now() - startMs };
}

/** Format script log entries for agent consumption. */
export function formatLogForAgent(log: ScriptLogEntry[]): string {
  const lines = log.map((entry) => {
    const icon = entry.status === "ok" ? "✓" : entry.status === "warn" ? "⚠" : "✗";
    return `  [${icon}] Step ${entry.step}: ${entry.action} (${entry.durationMs}ms) — ${entry.detail}`;
  });
  return lines.join("\n");
}
