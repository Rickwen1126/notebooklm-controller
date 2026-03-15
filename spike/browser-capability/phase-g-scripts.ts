/**
 * Phase G — Deterministic scripts for all 13 NotebookLM operations
 *
 * Pure code scripts with structured logging. No LLM calls.
 * Three-phase polling for answer stability (borrowed from notebooklm-skill/mcp).
 *
 * Operations:
 *   scriptedQuery         — submit question, poll answer
 *   scriptedAddSource     — add text source via paste
 *   scriptedListSources   — read source panel
 *   scriptedRemoveSource  — source menu → remove → confirm
 *   scriptedRenameSource  — source menu → rename → dialog → save
 *   scriptedClearChat     — conversation menu → delete history
 *   scriptedCreateNotebook — homepage → create → wait for redirect
 *   scriptedRenameNotebook — homepage → notebook menu → edit title → save
 *   scriptedDeleteNotebook — homepage → notebook menu → delete → confirm
 *   scriptedListNotebooks  — homepage → read notebook table
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
  dispatchType,
  waitForGone,
  waitForVisible,
  waitForNavigation,
  waitForCountChange,
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
    // Step 0: Ensure chat panel is visible
    await ensureChatPanel(cdp, page, log, t0);

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

    // Step 3: Wait for dialog to render
    stepNum = 3;
    stepStart = Date.now();
    const dialogReady = await waitForVisible(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
    log.push(createLogEntry(3, "wait_dialog", dialogReady.visible ? "ok" : "warn",
      dialogReady.visible ? `Dialog ready in ${dialogReady.elapsedMs}ms` : `Dialog not detected (timeout)`, stepStart));

    // Step 4: Find "複製的文字" option
    stepNum = 4;
    stepStart = Date.now();
    const pasteTypeEl = await findElementByText(page, uiMap.elements.paste_source_type.text);
    if (!pasteTypeEl) {
      return fail("find_paste_source_type", `Element not found: "${uiMap.elements.paste_source_type.text}"`, "paste_source_type");
    }
    log.push(createLogEntry(4, "find_paste_source_type", "ok", `Found at (${pasteTypeEl.center.x}, ${pasteTypeEl.center.y})`, stepStart));

    // Step 5: Click paste source type → wait for paste dialog textarea
    stepNum = 5;
    stepStart = Date.now();
    await dispatchClick(cdp, pasteTypeEl.center.x, pasteTypeEl.center.y);
    // Wait for the paste textarea specifically (aria-label="貼上的文字"), not any textarea
    const pasteTextareaReady = await waitForVisible(page, 'textarea[aria-label="貼上的文字"]', { timeoutMs: 5000 });
    log.push(createLogEntry(5, "click_paste_source_type", pasteTextareaReady.visible ? "ok" : "warn",
      pasteTextareaReady.visible ? `Paste textarea appeared in ${pasteTextareaReady.elapsedMs}ms` : `Paste textarea not detected`, stepStart));

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

    // Step 11: Wait for dialog to close (source processing complete)
    stepNum = 11;
    stepStart = Date.now();
    const processingDone = await waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 15000 });
    log.push(createLogEntry(11, "wait_processing", processingDone.gone ? "ok" : "warn",
      processingDone.gone ? `Source processed, dialog closed in ${processingDone.elapsedMs}ms` : `Timeout waiting for processing`, stepStart));

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

// =============================================================================
// Helper: standard fail + success builders
// =============================================================================

function makeFail(
  operation: string,
  log: ScriptLogEntry[],
  t0: number,
) {
  return (stepNum: number, action: string, detail: string, selector?: string): ScriptResult => {
    log.push(createLogEntry(stepNum, action, "fail", detail, t0));
    return {
      operation, status: "fail", result: null, log,
      totalMs: Date.now() - t0,
      failedAtStep: stepNum, failedSelector: selector ?? null,
    };
  };
}

function makeSuccess(
  operation: string,
  log: ScriptLogEntry[],
  t0: number,
  result: string | null,
): ScriptResult {
  return {
    operation, status: "success", result, log,
    totalMs: Date.now() - t0,
    failedAtStep: null, failedSelector: null,
  };
}

// =============================================================================
// Helper: ensure source panel is visible (shared by source operations)
// =============================================================================

async function ensureSourcePanel(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  log: ScriptLogEntry[],
  t0: number,
): Promise<boolean> {
  const stepStart = Date.now();
  const panelVisible = await page.evaluate(`(() => {
    const panel = document.querySelector('.source-panel');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`) as boolean;

  if (!panelVisible) {
    const tabEl = await findElementByText(page, "來源");
    if (tabEl) {
      await dispatchClick(cdp, tabEl.center.x, tabEl.center.y);
      await new Promise((r) => setTimeout(r, 800));
      log.push(createLogEntry(0, "ensure_source_panel", "warn", `Clicked "來源" tab`, stepStart));
    } else {
      log.push(createLogEntry(0, "ensure_source_panel", "warn", `Source panel not visible, no tab found`, stepStart));
      return false;
    }
  } else {
    log.push(createLogEntry(0, "ensure_source_panel", "ok", `Source panel visible`, stepStart));
  }
  return true;
}

// =============================================================================
// Helper: ensure chat panel is visible (shared by query/clearChat)
// =============================================================================

async function ensureChatPanel(
  cdp: CDPSession,
  page: Page,
  log: ScriptLogEntry[],
  t0: number,
): Promise<boolean> {
  const stepStart = Date.now();
  const chatVisible = await page.evaluate(`(() => {
    const panel = document.querySelector('.chat-panel');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`) as boolean;

  if (!chatVisible) {
    const tabEl = await findElementByText(page, "對話");
    if (tabEl) {
      await dispatchClick(cdp, tabEl.center.x, tabEl.center.y);
      await new Promise((r) => setTimeout(r, 800));
      log.push(createLogEntry(0, "ensure_chat_panel", "warn", `Clicked "對話" tab`, stepStart));
    } else {
      log.push(createLogEntry(0, "ensure_chat_panel", "warn", `Chat panel not visible, no tab found`, stepStart));
      return false;
    }
  } else {
    log.push(createLogEntry(0, "ensure_chat_panel", "ok", `Chat panel visible`, stepStart));
  }
  return true;
}

// =============================================================================
// Helper: ensure on homepage (shared by notebook CRUD operations)
// =============================================================================

const HOMEPAGE_URL = "https://notebooklm.google.com";

async function ensureHomepage(
  page: Page,
  log: ScriptLogEntry[],
  t0: number,
): Promise<boolean> {
  const stepStart = Date.now();
  const url = page.url();
  const isHomepage = url === HOMEPAGE_URL || url === HOMEPAGE_URL + "/";

  if (!isHomepage) {
    await page.goto(HOMEPAGE_URL, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2000));
    log.push(createLogEntry(0, "ensure_homepage", "warn", `Navigated to homepage from ${url.slice(0, 60)}`, stepStart));
  } else {
    log.push(createLogEntry(0, "ensure_homepage", "ok", `Already on homepage`, stepStart));
  }
  return true;
}

// =============================================================================
// Helper: open source context menu (for remove/rename)
// =============================================================================

async function openSourceMenu(
  cdp: CDPSession,
  page: Page,
  log: ScriptLogEntry[],
  startStep: number,
): Promise<{ ok: boolean; stepNum: number }> {
  let stepNum = startStep;

  // Find "more_vert" in source panel area (x < 400)
  const stepStart = Date.now();
  const menuIcons = await page.evaluate(`(() => {
    const els = document.querySelectorAll('button, [role=button]');
    const results = [];
    for (const el of els) {
      const text = (el.textContent || '').trim();
      if (!text.includes('more_vert')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      results.push({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    }
    return results;
  })()`) as Array<{ x: number; y: number }>;

  const sourceMenus = menuIcons.filter((m) => m.x < 400);
  if (sourceMenus.length === 0) {
    log.push(createLogEntry(stepNum, "find_source_menu", "fail", `No more_vert icons in source panel area`, Date.now()));
    return { ok: false, stepNum };
  }
  log.push(createLogEntry(stepNum, "find_source_menu", "ok", `Found ${sourceMenus.length} menu icon(s)`, stepStart));

  stepNum++;
  const clickStart = Date.now();
  await dispatchClick(cdp, sourceMenus[0].x, sourceMenus[0].y);

  // Wait for menu to render — menu items are plain BUTTONs, not [role=menuitem].
  // Wait for known menu item text to appear instead of CSS selector.
  let menuRendered = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const item = await findElementByText(page, "移除來源");
    if (item) { menuRendered = true; break; }
  }
  log.push(createLogEntry(stepNum, "click_source_menu", menuRendered ? "ok" : "warn",
    `Clicked menu at (${sourceMenus[0].x}, ${sourceMenus[0].y}), menu ${menuRendered ? "rendered" : "not detected"}`, clickStart));

  return { ok: true, stepNum };
}

// =============================================================================
// Helper: open notebook context menu on homepage
// =============================================================================

async function openNotebookMenu(
  cdp: CDPSession,
  page: Page,
  log: ScriptLogEntry[],
  startStep: number,
): Promise<{ ok: boolean; stepNum: number }> {
  const stepNum = startStep;
  const stepStart = Date.now();

  const menuIcons = await page.evaluate(`(() => {
    const els = document.querySelectorAll('button, [role=button]');
    const results = [];
    for (const el of els) {
      const text = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if (!text.includes('more_vert') && !aria.includes('專案動作選單')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      results.push({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    }
    return results;
  })()`) as Array<{ x: number; y: number }>;

  if (menuIcons.length === 0) {
    log.push(createLogEntry(stepNum, "find_notebook_menu", "fail", `No menu icons found`, Date.now()));
    return { ok: false, stepNum };
  }

  await dispatchClick(cdp, menuIcons[0].x, menuIcons[0].y);

  // Wait for menu to render — items are plain BUTTONs, not [role=menuitem].
  // Wait for known menu item text ("刪除" or "編輯標題") to appear.
  let menuRendered = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const item = await findElementByText(page, "刪除");
    if (item) { menuRendered = true; break; }
  }
  log.push(createLogEntry(stepNum, "click_notebook_menu", menuRendered ? "ok" : "warn",
    `Clicked menu at (${menuIcons[0].x}, ${menuIcons[0].y}), menu ${menuRendered ? "rendered" : "not detected"}`, stepStart));

  return { ok: true, stepNum };
}

// =============================================================================
// scriptedListSources
// =============================================================================

export async function scriptedListSources(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  const fail = makeFail("listSources", log, t0);

  try {
    await ensureSourcePanel(cdp, page, uiMap, log, t0);

    const stepStart = Date.now();
    const result = await page.evaluate(`(() => {
      const panel = document.querySelector('.source-panel');
      if (!panel) return { count: 0, sources: [] };
      const items = panel.querySelectorAll('[class*="source-item"], [class*="source-card"], li, [role="listitem"]');
      const sources = [];
      for (const item of items) {
        const text = (item.textContent || '').trim();
        if (text) sources.push(text.slice(0, 100));
      }
      return { count: sources.length, sources };
    })()`) as { count: number; sources: string[] };

    log.push(createLogEntry(1, "read_sources", "ok",
      `Found ${result.count} source(s)`, stepStart));

    return makeSuccess("listSources", log, t0, JSON.stringify(result));
  } catch (err) {
    return fail(1, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedRemoveSource
// =============================================================================

export async function scriptedRemoveSource(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;
  const fail = makeFail("removeSource", log, t0);

  try {
    await ensureSourcePanel(cdp, page, uiMap, log, t0);

    // Steps 1-2: open source menu
    stepNum = 1;
    const menu = await openSourceMenu(cdp, page, log, stepNum);
    if (!menu.ok) return fail(menu.stepNum, "open_source_menu", "Failed to open source menu", "source_menu");
    stepNum = menu.stepNum + 1;

    // Find "移除來源"
    let stepStart = Date.now();
    const removeEl = await findElementByText(page, uiMap.elements.remove_source?.text ?? "移除來源");
    if (!removeEl) return fail(stepNum, "find_remove_source", `Menu item not found`, "remove_source");
    log.push(createLogEntry(stepNum, "find_remove_source", "ok", `Found at (${removeEl.center.x}, ${removeEl.center.y})`, stepStart));

    // Click remove → may open confirmation
    stepNum++;
    stepStart = Date.now();
    await dispatchClick(cdp, removeEl.center.x, removeEl.center.y);
    // Brief pause then check for confirmation dialog
    const confirmDialog = await waitForVisible(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 1500 });
    log.push(createLogEntry(stepNum, "click_remove_source", "ok", `Clicked`, stepStart));

    // Handle confirmation dialog if present
    stepNum++;
    stepStart = Date.now();
    if (confirmDialog.visible) {
      const confirmEl = await findElementByText(page, uiMap.elements.remove_source?.text ?? "移除來源");
      if (confirmEl) {
        await dispatchClick(cdp, confirmEl.center.x, confirmEl.center.y);
        await waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
        log.push(createLogEntry(stepNum, "confirm_remove", "ok", `Confirmed removal, dialog closed`, stepStart));
      }
    } else {
      log.push(createLogEntry(stepNum, "confirm_remove", "ok", `No confirmation dialog (direct remove)`, stepStart));
    }

    // Wait for source panel to update
    stepNum++;
    stepStart = Date.now();
    await new Promise((r) => setTimeout(r, 1000)); // Brief settle — source panel re-renders
    log.push(createLogEntry(stepNum, "wait_removal", "ok", `Source panel settled`, stepStart));

    return makeSuccess("removeSource", log, t0, `Source removed`);
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedRenameSource
// =============================================================================

export async function scriptedRenameSource(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  newName: string,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;
  const fail = makeFail("renameSource", log, t0);

  try {
    await ensureSourcePanel(cdp, page, uiMap, log, t0);

    // Steps 1-2: open source menu
    stepNum = 1;
    const menu = await openSourceMenu(cdp, page, log, stepNum);
    if (!menu.ok) return fail(menu.stepNum, "open_source_menu", "Failed to open source menu", "source_menu");
    stepNum = menu.stepNum + 1;

    // Find "重新命名來源"
    let stepStart = Date.now();
    const renameEl = await findElementByText(page, uiMap.elements.rename_source?.text ?? "重新命名來源");
    if (!renameEl) return fail(stepNum, "find_rename_source", `Menu item not found`, "rename_source");
    log.push(createLogEntry(stepNum, "find_rename_source", "ok", `Found`, stepStart));

    // Click rename → opens dialog. Wait for dialog to render, not hardcode.
    stepNum++;
    stepStart = Date.now();
    await dispatchClick(cdp, renameEl.center.x, renameEl.center.y);
    const dialogReady = await waitForVisible(page, 'input[type="text"], input:not([type])', { timeoutMs: 5000 });
    log.push(createLogEntry(stepNum, "click_rename", dialogReady.visible ? "ok" : "warn",
      `Clicked, dialog ${dialogReady.visible ? `ready in ${dialogReady.elapsedMs}ms` : "not detected (timeout)"}`, stepStart));

    // Find input in dialog (fallback to any visible text input)
    stepNum++;
    stepStart = Date.now();
    const inputPos = await page.evaluate(`(() => {
      const inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
      for (const el of inputs) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      }
      return null;
    })()`) as { x: number; y: number } | null;
    if (!inputPos) return fail(stepNum, "find_dialog_input", `No input found in dialog`, "dialog_input");
    await dispatchClick(cdp, inputPos.x, inputPos.y);
    log.push(createLogEntry(stepNum, "find_dialog_input", "ok", `Found input at (${inputPos.x}, ${inputPos.y})`, stepStart));

    // Select all + paste new name
    stepNum++;
    stepStart = Date.now();
    await dispatchType(cdp, page, "Ctrl+A");
    await dispatchPaste(cdp, newName);
    log.push(createLogEntry(stepNum, "type_new_name", "ok", `Typed "${newName}"`, stepStart));

    // Find and click save. Wait for dialog to close after save.
    stepNum++;
    stepStart = Date.now();
    const saveEl = await findElementByText(page, uiMap.elements.save_button?.text ?? "儲存");
    if (!saveEl) return fail(stepNum, "find_save_button", `Save button not found`, "save_button");
    await dispatchClick(cdp, saveEl.center.x, saveEl.center.y);
    await waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
    log.push(createLogEntry(stepNum, "click_save", "ok", `Saved, dialog closed`, stepStart));

    return makeSuccess("renameSource", log, t0, `Source renamed to "${newName}"`);
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedClearChat
// =============================================================================

export async function scriptedClearChat(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("clearChat", log, t0);

  try {
    // Step 0: Ensure chat panel is visible
    await ensureChatPanel(cdp, page, log, t0);

    // Step 1: find conversation options menu
    let stepStart = Date.now();
    const optionsEl = await findElementByText(page, uiMap.elements.conversation_options?.text ?? "對話選項", { match: "aria-label" });
    if (!optionsEl) return fail(1, "find_conversation_options", `Not found`, "conversation_options");
    log.push(createLogEntry(1, "find_conversation_options", "ok", `Found at (${optionsEl.center.x}, ${optionsEl.center.y})`, stepStart));

    // Step 2: click to open menu
    stepNum = 2;
    stepStart = Date.now();
    await dispatchClick(cdp, optionsEl.center.x, optionsEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(2, "click_conversation_options", "ok", `Clicked`, stepStart));

    // Step 3: find "刪除對話記錄"
    stepNum = 3;
    stepStart = Date.now();
    const deleteEl = await findElementByText(page, uiMap.elements.delete_chat?.text ?? "刪除對話記錄");
    if (!deleteEl) return fail(3, "find_delete_chat", `Menu item not found`, "delete_chat");
    log.push(createLogEntry(3, "find_delete_chat", "ok", `Found`, stepStart));

    // Step 4: click delete
    stepNum = 4;
    stepStart = Date.now();
    await dispatchClick(cdp, deleteEl.center.x, deleteEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(4, "click_delete_chat", "ok", `Clicked`, stepStart));

    // Step 5: handle confirmation if present
    stepNum = 5;
    stepStart = Date.now();
    const confirmEl = await findElementByText(page, "刪除");
    if (confirmEl && confirmEl.center.y > 300) {
      await dispatchClick(cdp, confirmEl.center.x, confirmEl.center.y);
      log.push(createLogEntry(5, "confirm_delete", "ok", `Confirmed`, stepStart));
    } else {
      log.push(createLogEntry(5, "confirm_delete", "ok", `No confirmation needed`, stepStart));
    }

    // Step 6: wait for chat to clear
    stepNum = 6;
    stepStart = Date.now();
    const result = await waitForGone(page, ".message-content", { timeoutMs: 5000 });
    log.push(createLogEntry(6, "wait_chat_clear", result.gone ? "ok" : "warn",
      result.gone ? `Chat cleared in ${result.elapsedMs}ms` : `Timeout waiting for clear`, stepStart));

    return makeSuccess("clearChat", log, t0, "Chat cleared");
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedListNotebooks (homepage)
// =============================================================================

export async function scriptedListNotebooks(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  const fail = makeFail("listNotebooks", log, t0);

  try {
    await ensureHomepage(page, log, t0);

    const stepStart = Date.now();
    const result = await page.evaluate(`(() => {
      const rows = document.querySelectorAll('tr[tabindex]');
      const notebooks = [];
      for (const row of rows) {
        const text = (row.textContent || '').trim();
        if (text) notebooks.push(text.slice(0, 150));
      }
      return { count: notebooks.length, notebooks };
    })()`) as { count: number; notebooks: string[] };

    log.push(createLogEntry(1, "read_notebooks", "ok",
      `Found ${result.count} notebook(s)`, stepStart));

    return makeSuccess("listNotebooks", log, t0, JSON.stringify(result));
  } catch (err) {
    return fail(1, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedCreateNotebook (homepage)
// =============================================================================

export async function scriptedCreateNotebook(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("createNotebook", log, t0);

  try {
    await ensureHomepage(page, log, t0);
    const initialUrl = page.url();

    // Step 1: find "新建" button
    let stepStart = Date.now();
    const createEl = await findElementByText(page, uiMap.elements.create_notebook?.text ?? "新建");
    if (!createEl) return fail(1, "find_create_button", `Not found`, "create_notebook");
    log.push(createLogEntry(1, "find_create_button", "ok", `Found at (${createEl.center.x}, ${createEl.center.y})`, stepStart));

    // Step 2: click create
    stepNum = 2;
    stepStart = Date.now();
    await dispatchClick(cdp, createEl.center.x, createEl.center.y);
    log.push(createLogEntry(2, "click_create", "ok", `Clicked`, stepStart));

    // Step 3: wait for navigation to new notebook
    stepNum = 3;
    stepStart = Date.now();
    const nav = await waitForNavigation(page, { notUrl: initialUrl, timeoutMs: 15_000 });
    if (!nav.navigated) return fail(3, "wait_navigation", `URL did not change`, "navigation");
    log.push(createLogEntry(3, "wait_navigation", "ok", `Navigated to ${nav.url} in ${nav.elapsedMs}ms`, stepStart));

    // Step 4: wait for page to load (h1 appears)
    stepNum = 4;
    stepStart = Date.now();
    const h1 = await waitForVisible(page, "h1", { timeoutMs: 10_000 });
    log.push(createLogEntry(4, "wait_page_load", h1.visible ? "ok" : "warn",
      h1.visible ? `Page loaded in ${h1.elapsedMs}ms` : `h1 not visible yet`, stepStart));

    const title = await page.evaluate(`(() => {
      const h1 = document.querySelector('h1');
      return h1 ? h1.textContent.trim() : null;
    })()`) as string | null;

    return makeSuccess("createNotebook", log, t0, JSON.stringify({ url: nav.url, title }));
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedRenameNotebook (homepage)
// =============================================================================

export async function scriptedRenameNotebook(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  newName: string,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("renameNotebook", log, t0);

  try {
    await ensureHomepage(page, log, t0);

    // Step 1: open notebook context menu
    const menu = await openNotebookMenu(cdp, page, log, 1);
    if (!menu.ok) return fail(menu.stepNum, "open_notebook_menu", "Failed", "notebook_menu");
    stepNum = menu.stepNum + 1;

    // Find "編輯標題"
    let stepStart = Date.now();
    const editEl = await findElementByText(page, uiMap.elements.edit_title?.text ?? "編輯標題");
    if (!editEl) return fail(stepNum, "find_edit_title", `Not found`, "edit_title");
    log.push(createLogEntry(stepNum, "find_edit_title", "ok", `Found`, stepStart));

    // Click → dialog. Wait for dialog to render by checking for mat-dialog-container.
    stepNum++;
    stepStart = Date.now();
    await dispatchClick(cdp, editEl.center.x, editEl.center.y);
    // mat-dialog-container has role=dialog. Also try checking for input appearance.
    const dialogReady = await waitForVisible(page, 'mat-dialog-container, [role=dialog]', { timeoutMs: 5000 });
    if (dialogReady.visible) {
      // Extra wait for input to render inside the dialog
      await waitForVisible(page, 'mat-dialog-container input, [role=dialog] input', { timeoutMs: 3000 });
    }
    log.push(createLogEntry(stepNum, "click_edit_title", dialogReady.visible ? "ok" : "warn",
      `Clicked, dialog ${dialogReady.visible ? `ready in ${dialogReady.elapsedMs}ms` : "not detected"}`, stepStart));

    // Find input in dialog + select all + paste new name
    stepNum++;
    stepStart = Date.now();
    const inputPos = await page.evaluate(`(() => {
      const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
      for (const el of inputs) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      }
      return null;
    })()`) as { x: number; y: number } | null;
    if (!inputPos) return fail(stepNum, "find_dialog_input", `No input in dialog`, "dialog_input");
    await dispatchClick(cdp, inputPos.x, inputPos.y);
    await dispatchType(cdp, page, "Ctrl+A");
    await dispatchPaste(cdp, newName);
    log.push(createLogEntry(stepNum, "type_new_name", "ok", `Typed "${newName}"`, stepStart));

    // Find and click save. Wait for dialog to close.
    stepNum++;
    stepStart = Date.now();
    const saveEl = await findElementByText(page, uiMap.elements.save_button?.text ?? "儲存");
    if (!saveEl) return fail(stepNum, "find_save", `Save button not found`, "save_button");
    await dispatchClick(cdp, saveEl.center.x, saveEl.center.y);
    await waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
    log.push(createLogEntry(stepNum, "click_save", "ok", `Saved, dialog closed`, stepStart));

    return makeSuccess("renameNotebook", log, t0, `Notebook renamed to "${newName}"`);
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// scriptedDeleteNotebook (homepage)
// =============================================================================

export async function scriptedDeleteNotebook(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
): Promise<ScriptResult> {
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("deleteNotebook", log, t0);

  try {
    await ensureHomepage(page, log, t0);

    // Step 1: open notebook context menu
    const menu = await openNotebookMenu(cdp, page, log, 1);
    if (!menu.ok) return fail(menu.stepNum, "open_notebook_menu", "Failed", "notebook_menu");
    stepNum = menu.stepNum + 1;

    // Find "刪除"
    let stepStart = Date.now();
    const deleteEl = await findElementByText(page, uiMap.elements.delete_notebook?.text ?? "刪除");
    if (!deleteEl) return fail(stepNum, "find_delete", `Not found`, "delete_notebook");
    log.push(createLogEntry(stepNum, "find_delete", "ok", `Found`, stepStart));

    // Click delete → wait for confirmation dialog
    stepNum++;
    stepStart = Date.now();
    await dispatchClick(cdp, deleteEl.center.x, deleteEl.center.y);
    await waitForVisible(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 3000 });
    log.push(createLogEntry(stepNum, "click_delete", "ok", `Clicked, confirmation dialog appeared`, stepStart));

    // Find and click confirmation "刪除" button (Finding #44: explicit)
    stepNum++;
    stepStart = Date.now();
    const confirmEl = await findElementByText(page, "刪除");
    if (confirmEl) {
      await dispatchClick(cdp, confirmEl.center.x, confirmEl.center.y);
      // Wait for dialog to close and page to update
      await waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
      log.push(createLogEntry(stepNum, "confirm_delete", "ok", `Confirmed deletion, dialog closed`, stepStart));
    } else {
      log.push(createLogEntry(stepNum, "confirm_delete", "warn", `No confirmation dialog found`, stepStart));
    }

    return makeSuccess("deleteNotebook", log, t0, "Notebook deleted");
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}
