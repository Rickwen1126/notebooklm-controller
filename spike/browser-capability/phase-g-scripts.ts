/**
 * Phase G — Deterministic scripts: scriptedQuery, scriptedAddSource
 *
 * Pure code scripts with structured logging. No LLM calls.
 * Three-phase polling for answer stability (borrowed from notebooklm-skill/mcp).
 */

import type { CDPSession, Page } from "puppeteer-core";
import {
  type UIMap,
  type ScriptLogEntry,
  type ScriptResult,
  createLogEntry,
  findElementByText,
  dispatchClick,
  dispatchPaste,
  captureScreenshot,
} from "./phase-g-shared.js";

// =============================================================================
// pollForAnswer — In-browser hash-based polling (same strategy as waitForContent tool)
// =============================================================================

interface PollOptions {
  maxWaitMs?: number;
  stableCount?: number;
  pollIntervalMs?: number;
  rejectPattern?: string;
  baselineHash?: string; // hash of pre-existing answer to skip
}

/**
 * All polling runs inside page.evaluate() — zero serialization during wait.
 * Uses djb2 hash comparison, same as production waitForContent tool.
 * Final text fetched in one serialization after stability confirmed.
 */
async function pollForAnswer(
  page: Page,
  answerSelector: string,
  options?: PollOptions,
): Promise<{ text: string | null; elapsedMs: number; stable: boolean }> {
  const maxWait = options?.maxWaitMs ?? 60_000;
  const stableCount = options?.stableCount ?? 3;
  const pollInterval = options?.pollIntervalMs ?? 1000;
  const rejectPattern = options?.rejectPattern ?? "Thinking|Refining|Checking|正在思考|正在整理|正在檢查";

  const startTime = Date.now();

  // Node-side polling with in-browser hash computation.
  // Cannot use in-browser async loop because Chrome throttles background tab
  // setTimeout to ~1/min, making stability checks impossible.
  // Instead: each poll is a synchronous page.evaluate (fast, ~1ms) returning
  // only a hash string — minimal serialization. Stability logic runs in Node.
  const baselineHash = options?.baselineHash ?? "";
  const rejectRe = rejectPattern ? new RegExp(rejectPattern, "i") : null;
  let lastHash = "";
  let sameCount = 0;
  let stable = false;

  while (Date.now() - startTime < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval)); // Node-side sleep, not throttled

    // Layer 1: .thinking-message visibility check (most reliable indicator).
    // When visible, NotebookLM is still processing — all transitional messages
    // ("Checking...", "Reading...", "Thinking...") appear during this phase.
    // Ref: notebooklm-skill ask_question.py — same pattern, proven reliable.
    const isThinking = await page.evaluate(`(() => {
      const el = document.querySelector('div.thinking-message');
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })()`) as boolean;

    if (isThinking) { sameCount = 0; lastHash = ""; continue; }

    // Layer 2: text hash stability check
    const check = await page.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(answerSelector)});
      if (els.length === 0) return { hash: "", len: 0, sample: "" };
      const target = els[els.length - 1];
      const text = (target.textContent || "").trim();
      let h = 5381;
      for (let i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; }
      return { hash: h.toString(36), len: text.length, sample: text.slice(0, 60) };
    })()`) as { hash: string; len: number; sample: string };

    // Empty or no match
    if (!check.hash || check.len === 0) { sameCount = 0; lastHash = ""; continue; }

    // Defense-in-depth: reject short transitional content that may linger briefly
    // after .thinking-message disappears (e.g. "Checking...", "Reading...")
    if (check.len < 50) { sameCount = 0; lastHash = ""; continue; }
    if (rejectRe && rejectRe.test(check.sample)) { sameCount = 0; lastHash = ""; continue; }

    // Skip if still showing old answer (same hash as before submit)
    if (baselineHash && check.hash === baselineHash) { sameCount = 0; lastHash = ""; continue; }

    // Stability check
    if (check.hash === lastHash) {
      sameCount++;
      if (sameCount >= stableCount) { stable = true; break; }
    } else {
      lastHash = check.hash;
      sameCount = 1;
    }
  }

  // One full serialization to fetch final text
  const text = await page.evaluate(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(answerSelector)});
    if (els.length === 0) return null;
    const target = els[els.length - 1];
    return ((target.textContent || "").trim()).slice(0, 5000) || null;
  })()`) as string | null;

  return {
    text,
    elapsedMs: Date.now() - startTime,
    stable,
  };
}

// =============================================================================
// scriptedQuery
// =============================================================================

export async function scriptedQuery(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  question: string,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;

  const fail = (action: string, detail: string, selector?: string): ScriptResult => {
    const entry = createLogEntry(stepNum, action, "fail", detail, t0);
    log.push(entry);
    return {
      operation: "query",
      status: "fail",
      result: null,
      log,
      totalMs: Date.now() - t0,
      failedAtStep: stepNum,
      failedSelector: selector ?? null,
    };
  };

  try {
    // Step 1: Find chat input
    stepNum = 1;
    let stepStart = Date.now();
    const chatInput = uiMap.elements.chat_input;
    const inputEl = await findElementByText(page, chatInput.text, {
      match: (chatInput.match as "placeholder") ?? "text",
    });
    if (!inputEl) {
      return fail("find_chat_input", `Element not found: "${chatInput.text}"`, "chat_input");
    }
    log.push(createLogEntry(1, "find_chat_input", "ok", `Found at (${inputEl.center.x}, ${inputEl.center.y})`, stepStart));

    // Step 2: Click chat input
    stepNum = 2;
    stepStart = Date.now();
    await dispatchClick(cdp, inputEl.center.x, inputEl.center.y);
    await new Promise((r) => setTimeout(r, 300));
    log.push(createLogEntry(2, "click_chat_input", "ok", `Clicked (${inputEl.center.x}, ${inputEl.center.y})`, stepStart));

    // Step 3: Paste question
    stepNum = 3;
    stepStart = Date.now();
    await dispatchPaste(cdp, question);
    await new Promise((r) => setTimeout(r, 200));
    log.push(createLogEntry(3, "paste_question", "ok", `Pasted ${question.length} chars`, stepStart));

    // Step 4: Find submit button
    stepNum = 4;
    stepStart = Date.now();
    const submitBtn = uiMap.elements.submit_button;
    const submitEl = await findElementByText(page, submitBtn.text, {
      match: (submitBtn.match as "text") ?? "text",
      disambiguate: submitBtn.disambiguate,
    });
    if (!submitEl) {
      return fail("find_submit_button", `Element not found: "${submitBtn.text}"`, "submit_button");
    }
    if (submitEl.disabled) {
      return fail("find_submit_button", `Submit button is disabled`, "submit_button");
    }
    log.push(createLogEntry(4, "find_submit_button", "ok", `Found at (${submitEl.center.x}, ${submitEl.center.y})`, stepStart));

    // Capture baseline hash of existing answer BEFORE submit
    const answerSel = uiMap.selectors.answer;
    const baselineHash = answerSel ? await page.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(answerSel)});
      if (els.length === 0) return "";
      const text = (els[els.length - 1].textContent || "").trim();
      let h = 5381;
      for (let i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; }
      return h.toString(36);
    })()`) as string : "";

    // Step 5: Click submit
    stepNum = 5;
    stepStart = Date.now();
    await dispatchClick(cdp, submitEl.center.x, submitEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(5, "click_submit", "ok", `Clicked (${submitEl.center.x}, ${submitEl.center.y})`, stepStart));

    // Step 6: Poll for answer (Node-side hash polling, baseline-aware)
    stepNum = 6;
    stepStart = Date.now();
    const answerSelector = answerSel;
    if (!answerSelector) {
      return fail("poll_answer", `Selector not found in UIMap: "answer"`, "answer");
    }
    const pollResult = await pollForAnswer(page, answerSelector, { baselineHash });
    if (!pollResult.text) {
      return fail("poll_answer", `No answer received (stable=${pollResult.stable}, ${pollResult.elapsedMs}ms)`, "answer");
    }
    log.push(createLogEntry(6, "poll_answer", "ok",
      `Got ${pollResult.text.length} chars in ${pollResult.elapsedMs}ms (stable=${pollResult.stable})`, stepStart));

    const finalText = pollResult.text;

    return {
      operation: "query",
      status: "success",
      result: finalText,
      log,
      totalMs: Date.now() - t0,
      failedAtStep: null,
      failedSelector: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`step_${stepNum}_exception`, msg);
  }
}

// =============================================================================
// scriptedAddSource
// =============================================================================

export async function scriptedAddSource(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  content: string,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;

  const fail = (action: string, detail: string, selector?: string): ScriptResult => {
    const entry = createLogEntry(stepNum, action, "fail", detail, t0);
    log.push(entry);
    return {
      operation: "addSource",
      status: "fail",
      result: null,
      log,
      totalMs: Date.now() - t0,
      failedAtStep: stepNum,
      failedSelector: selector ?? null,
    };
  };

  try {
    // Step 0: Ensure source panel is visible (may be collapsed or on wrong tab)
    stepNum = 0;
    let stepStart = Date.now();
    const sourcePanelVisible = await page.evaluate(`(() => {
      const panel = document.querySelector('.source-panel');
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`) as boolean;

    if (!sourcePanelVisible) {
      // Try to find and click the source panel expand button (dock_to_right icon)
      // or a "來源" tab to switch panels
      const expandEl = await findElementByText(page, "來源");
      if (expandEl) {
        await dispatchClick(cdp, expandEl.center.x, expandEl.center.y);
        await new Promise((r) => setTimeout(r, 800));
        log.push(createLogEntry(0, "ensure_source_panel", "warn", `Source panel not visible, clicked "來源" tab`, stepStart));
      } else {
        log.push(createLogEntry(0, "ensure_source_panel", "warn", `Source panel not visible, no tab found — proceeding anyway`, stepStart));
      }
    } else {
      log.push(createLogEntry(0, "ensure_source_panel", "ok", `Source panel visible`, stepStart));
    }

    // Step 1: Find "新增來源" button — may need to collapse content first
    stepNum = 1;
    stepStart = Date.now();
    let addSourceEl = await findElementByText(page, uiMap.elements.add_source.text);
    if (!addSourceEl) {
      // Try collapsing source panel to reveal button
      const collapseEl = await findElementByText(page, uiMap.elements.collapse_source?.text ?? "collapse_content");
      if (collapseEl) {
        await dispatchClick(cdp, collapseEl.center.x, collapseEl.center.y);
        await new Promise((r) => setTimeout(r, 500));
        addSourceEl = await findElementByText(page, uiMap.elements.add_source.text);
      }
    }
    if (!addSourceEl) {
      return fail("find_add_source", `Element not found: "${uiMap.elements.add_source.text}"`, "add_source");
    }
    log.push(createLogEntry(1, "find_add_source", "ok", `Found at (${addSourceEl.center.x}, ${addSourceEl.center.y})`, stepStart));

    // Step 2: Click add source
    stepNum = 2;
    stepStart = Date.now();
    await dispatchClick(cdp, addSourceEl.center.x, addSourceEl.center.y);
    log.push(createLogEntry(2, "click_add_source", "ok", `Clicked`, stepStart));

    // Step 3: Wait for dialog
    stepNum = 3;
    stepStart = Date.now();
    await new Promise((r) => setTimeout(r, 1000));
    log.push(createLogEntry(3, "wait_dialog", "ok", `Waited 1000ms for dialog`, stepStart));

    // Step 4: Find "複製的文字" option
    stepNum = 4;
    stepStart = Date.now();
    const pasteTypeEl = await findElementByText(page, uiMap.elements.paste_source_type.text);
    if (!pasteTypeEl) {
      return fail("find_paste_source_type", `Element not found: "${uiMap.elements.paste_source_type.text}"`, "paste_source_type");
    }
    log.push(createLogEntry(4, "find_paste_source_type", "ok", `Found at (${pasteTypeEl.center.x}, ${pasteTypeEl.center.y})`, stepStart));

    // Step 5: Click paste source type
    stepNum = 5;
    stepStart = Date.now();
    await dispatchClick(cdp, pasteTypeEl.center.x, pasteTypeEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(5, "click_paste_source_type", "ok", `Clicked`, stepStart));

    // Step 6: Find textarea by placeholder
    stepNum = 6;
    stepStart = Date.now();
    const textareaEl = await findElementByText(page, uiMap.elements.paste_textarea.text, {
      match: "placeholder",
    });
    if (!textareaEl) {
      return fail("find_paste_textarea", `Element not found: "${uiMap.elements.paste_textarea.text}"`, "paste_textarea");
    }
    log.push(createLogEntry(6, "find_paste_textarea", "ok", `Found at (${textareaEl.center.x}, ${textareaEl.center.y})`, stepStart));

    // Step 7: Click textarea
    stepNum = 7;
    stepStart = Date.now();
    await dispatchClick(cdp, textareaEl.center.x, textareaEl.center.y);
    await new Promise((r) => setTimeout(r, 200));
    log.push(createLogEntry(7, "click_textarea", "ok", `Clicked`, stepStart));

    // Step 8: Paste content
    stepNum = 8;
    stepStart = Date.now();
    await dispatchPaste(cdp, content);
    await new Promise((r) => setTimeout(r, 300));
    log.push(createLogEntry(8, "paste_content", "ok", `Pasted ${content.length} chars`, stepStart));

    // Step 9: Find insert button + verify NOT disabled
    stepNum = 9;
    stepStart = Date.now();
    const insertEl = await findElementByText(page, uiMap.elements.insert_button.text);
    if (!insertEl) {
      return fail("find_insert_button", `Element not found: "${uiMap.elements.insert_button.text}"`, "insert_button");
    }
    if (insertEl.disabled) {
      // Content may not have been registered yet, wait and retry
      await new Promise((r) => setTimeout(r, 500));
      const retryEl = await findElementByText(page, uiMap.elements.insert_button.text);
      if (!retryEl || retryEl.disabled) {
        return fail("find_insert_button", `Insert button is disabled (content not accepted?)`, "insert_button");
      }
      log.push(createLogEntry(9, "find_insert_button", "warn", `Button was disabled, retry OK at (${retryEl.center.x}, ${retryEl.center.y})`, stepStart));
      // Use retry element for click
      Object.assign(insertEl, retryEl);
    } else {
      log.push(createLogEntry(9, "find_insert_button", "ok", `Found at (${insertEl.center.x}, ${insertEl.center.y})`, stepStart));
    }

    // Step 10: Click insert
    stepNum = 10;
    stepStart = Date.now();
    await dispatchClick(cdp, insertEl.center.x, insertEl.center.y);
    log.push(createLogEntry(10, "click_insert", "ok", `Clicked`, stepStart));

    // Step 11: Wait for processing
    stepNum = 11;
    stepStart = Date.now();
    await new Promise((r) => setTimeout(r, 3000));
    log.push(createLogEntry(11, "wait_processing", "ok", `Waited 3000ms for source processing`, stepStart));

    // Step 12: Verify source was added by reading source panel
    stepNum = 12;
    stepStart = Date.now();
    const sourceCount = await page.evaluate((sel: string) => {
      const panel = document.querySelector(sel);
      if (!panel) return -1;
      // Count source items (typically list items or cards in the panel)
      const items = panel.querySelectorAll("[class*='source-item'], [class*='source-card'], li, .source");
      return items.length || -1;
    }, uiMap.selectors.source_panel ?? ".source-panel");
    log.push(createLogEntry(12, "verify_source_added", sourceCount > 0 ? "ok" : "warn",
      sourceCount > 0 ? `Source panel has ${sourceCount} items` : `Could not verify source count`, stepStart));

    return {
      operation: "addSource",
      status: "success",
      result: `Source added (panel items: ${sourceCount})`,
      log,
      totalMs: Date.now() - t0,
      failedAtStep: null,
      failedSelector: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`step_${stepNum}_exception`, msg);
  }
}
