/**
 * Scripted operations — 10 deterministic NotebookLM operations.
 *
 * Each function receives a ScriptContext (ctx injection pattern) and
 * operation-specific params. Zero imports from outside ./types.js.
 *
 * Notebook-page operations (6):
 *   scriptedQuery, scriptedAddSource, scriptedListSources,
 *   scriptedRemoveSource, scriptedRenameSource, scriptedClearChat
 *
 * Homepage operations (5):
 *   scriptedListNotebooks, scriptedCreateNotebook,
 *   scriptedRenameNotebook, scriptedDeleteNotebook,
 *   scriptedGetNotebookUrl
 */

import type { ScriptContext, ScriptLogEntry, ScriptResult } from "./types.js";
import { createLogEntry } from "./types.js";

// =============================================================================
// makeFail / makeSuccess helpers
// =============================================================================

function makeFail(operation: string, log: ScriptLogEntry[], t0: number) {
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
// Internal helper: openSourceMenu
// =============================================================================

async function openSourceMenu(
  ctx: ScriptContext,
  log: ScriptLogEntry[],
  startStep: number,
): Promise<{ ok: boolean; stepNum: number }> {
  const { cdp, page, helpers } = ctx;
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
  await helpers.dispatchClick(cdp, sourceMenus[0].x, sourceMenus[0].y);

  // Wait for menu overlay using waitForVisible (not hardcode sleep).
  const menuVisible = await helpers.waitForVisible(page, '.cdk-overlay-pane, [role=menu], [role=listbox]', { timeoutMs: 5000 });

  if (!menuVisible.visible) {
    // Retry click
    await helpers.dispatchClick(cdp, sourceMenus[0].x, sourceMenus[0].y);
    const retry = await helpers.waitForVisible(page, '.cdk-overlay-pane, [role=menu], [role=listbox]', { timeoutMs: 3000 });
    if (!retry.visible) {
      log.push(createLogEntry(stepNum, "click_source_menu", "fail",
        `Clicked twice, menu overlay not detected`, clickStart));
      return { ok: false, stepNum };
    }
  }

  // Confirm menu items rendered (use UIMap text, not hardcoded)
  const removeSourceText = ctx.uiMap.elements.remove_source?.text ?? "Remove source";
  const itemCheck = await helpers.waitForEnabled(page, removeSourceText, "text", { timeoutMs: 3000 });
  const menuRendered = itemCheck.enabled;
  log.push(createLogEntry(stepNum, "click_source_menu", menuRendered ? "ok" : "fail",
    `Clicked (${sourceMenus[0].x},${sourceMenus[0].y}), menu ${menuRendered ? `rendered in ${menuVisible.elapsedMs}ms` : "items not found"}`, clickStart));

  return { ok: menuRendered, stepNum };
}

// =============================================================================
// Internal helper: openNotebookMenu
// =============================================================================

async function openNotebookMenu(
  ctx: ScriptContext,
  log: ScriptLogEntry[],
  startStep: number,
): Promise<{ ok: boolean; stepNum: number }> {
  const { cdp, page, helpers } = ctx;
  const stepNum = startStep;
  const stepStart = Date.now();

  // Find more_vert icons (or aria-label "專案動作選單")
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
      // Only include icons in the visible viewport
      if (r.y + r.height / 2 > 1080) continue;
      results.push({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    }
    return results;
  })()`) as Array<{ x: number; y: number }>;

  if (menuIcons.length === 0) {
    log.push(createLogEntry(stepNum, "find_notebook_menu", "fail", `No menu icons found in viewport`, Date.now()));
    return { ok: false, stepNum };
  }

  await helpers.dispatchClick(cdp, menuIcons[0].x, menuIcons[0].y);

  // Wait for menu overlay to appear using waitForVisible (not hardcode sleep).
  // NotebookLM renders menu in .cdk-overlay-pane or [role=menu].
  const menuVisible = await helpers.waitForVisible(page, '.cdk-overlay-pane, [role=menu], [role=listbox]', { timeoutMs: 5000 });

  if (!menuVisible.visible) {
    // Retry click — first click may have been dismissed
    await helpers.dispatchClick(cdp, menuIcons[0].x, menuIcons[0].y);
    const retry = await helpers.waitForVisible(page, '.cdk-overlay-pane, [role=menu], [role=listbox]', { timeoutMs: 3000 });
    if (!retry.visible) {
      log.push(createLogEntry(stepNum, "click_notebook_menu", "fail",
        `Clicked (${menuIcons[0].x},${menuIcons[0].y}) twice, menu overlay not detected`, stepStart));
      return { ok: false, stepNum };
    }
  }

  // Confirm menu items are rendered (use UIMap text, not hardcoded)
  const deleteText = ctx.uiMap.elements.delete_notebook?.text ?? "Delete";
  const editTitleText = ctx.uiMap.elements.edit_title?.text ?? "Edit title";
  const itemCheck = await helpers.waitForEnabled(page, deleteText, "text", { timeoutMs: 3000 });
  if (!itemCheck.enabled) {
    // Try edit_title as alternate indicator
    const altCheck = await helpers.waitForEnabled(page, editTitleText, "text", { timeoutMs: 2000 });
    if (!altCheck.enabled) {
      log.push(createLogEntry(stepNum, "click_notebook_menu", "fail",
        `Menu overlay appeared but no menu items found`, stepStart));
      return { ok: false, stepNum };
    }
  }

  log.push(createLogEntry(stepNum, "click_notebook_menu", "ok",
    `Clicked (${menuIcons[0].x},${menuIcons[0].y}), menu rendered in ${menuVisible.elapsedMs}ms`, stepStart));

  return { ok: true, stepNum };
}

// =============================================================================
// 1. scriptedQuery
// =============================================================================

export async function scriptedQuery(
  ctx: ScriptContext,
  question: string,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;
  const fail = makeFail("query", log, t0);

  try {
    // Step 0: Ensure chat panel is visible
    const chatOk = await helpers.ensureChatPanel(ctx, log, t0);
    if (!chatOk) return fail(0, "ensure_chat_panel", "Chat panel not accessible");

    // Step 1: Find chat input
    stepNum = 1;
    let stepStart = Date.now();
    const chatInput = uiMap.elements.chat_input;
    const inputEl = await helpers.findElementByText(page, chatInput.text, {
      match: (chatInput.match as "placeholder") ?? "text",
    });
    if (!inputEl) {
      return fail(1, "find_chat_input", `Element not found: "${chatInput.text}"`, "chat_input");
    }
    log.push(createLogEntry(1, "find_chat_input", "ok", `Found at (${inputEl.center.x}, ${inputEl.center.y})`, stepStart));

    // Step 2: Click chat input
    stepNum = 2;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, inputEl.center.x, inputEl.center.y);
    await new Promise((r) => setTimeout(r, 300));
    log.push(createLogEntry(2, "click_chat_input", "ok", `Clicked (${inputEl.center.x}, ${inputEl.center.y})`, stepStart));

    // Step 3: Paste question
    stepNum = 3;
    stepStart = Date.now();
    await helpers.dispatchPaste(cdp, question);
    await new Promise((r) => setTimeout(r, 200));
    log.push(createLogEntry(3, "paste_question", "ok", `Pasted ${question.length} chars`, stepStart));

    // Step 4: Find submit button (disambiguate y > 400)
    stepNum = 4;
    stepStart = Date.now();
    const submitBtn = uiMap.elements.submit_button;
    const submitEl = await helpers.findElementByText(page, submitBtn.text, {
      match: (submitBtn.match as "text") ?? "text",
      disambiguate: submitBtn.disambiguate,
    });
    if (!submitEl) {
      return fail(4, "find_submit_button", `Element not found: "${submitBtn.text}"`, "submit_button");
    }
    if (submitEl.disabled) {
      return fail(4, "find_submit_button", `Submit button is disabled`, "submit_button");
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
    await helpers.dispatchClick(cdp, submitEl.center.x, submitEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(5, "click_submit", "ok", `Clicked (${submitEl.center.x}, ${submitEl.center.y})`, stepStart));

    // Step 6: Poll for answer (Node-side hash polling, baseline-aware)
    stepNum = 6;
    stepStart = Date.now();
    const answerSelector = answerSel;
    if (!answerSelector) {
      return fail(6, "poll_answer", `Selector not found in UIMap: "answer"`, "answer");
    }
    const pollResult = await helpers.pollForAnswer(page, answerSelector, { baselineHash });
    if (!pollResult.text) {
      return fail(6, "poll_answer", `No answer received (stable=${pollResult.stable}, ${pollResult.elapsedMs}ms)`, "answer");
    }
    log.push(createLogEntry(6, "poll_answer", "ok",
      `Got ${pollResult.text.length} chars in ${pollResult.elapsedMs}ms (stable=${pollResult.stable})`, stepStart));

    return makeSuccess("query", log, t0, pollResult.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(stepNum, `step_${stepNum}_exception`, msg);
  }
}

// =============================================================================
// 2. scriptedAddSource
// =============================================================================

export async function scriptedAddSource(
  ctx: ScriptContext,
  content: string,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;
  const fail = makeFail("addSource", log, t0);

  try {
    // Step 0: Ensure source panel is visible
    const srcOk = await helpers.ensureSourcePanel(ctx, log, t0);
    if (!srcOk) return fail(0, "ensure_source_panel", "Source panel not accessible");

    // Step 1: Find "新增來源" button — may need to collapse content first
    stepNum = 1;
    let stepStart = Date.now();
    let addSourceEl = await helpers.findElementByText(page, uiMap.elements.add_source.text);
    if (!addSourceEl) {
      // Try collapsing source panel to reveal button
      const collapseEl = await helpers.findElementByText(page, uiMap.elements.collapse_source?.text ?? "collapse_content");
      if (collapseEl) {
        await helpers.dispatchClick(cdp, collapseEl.center.x, collapseEl.center.y);
        await new Promise((r) => setTimeout(r, 500));
        addSourceEl = await helpers.findElementByText(page, uiMap.elements.add_source.text);
      }
    }
    if (!addSourceEl) {
      return fail(1, "find_add_source", `Element not found: "${uiMap.elements.add_source.text}"`, "add_source");
    }
    log.push(createLogEntry(1, "find_add_source", "ok", `Found at (${addSourceEl.center.x}, ${addSourceEl.center.y})`, stepStart));

    // Step 2: Click add source
    stepNum = 2;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, addSourceEl.center.x, addSourceEl.center.y);
    log.push(createLogEntry(2, "click_add_source", "ok", `Clicked`, stepStart));

    // Step 3: Wait for dialog to render
    stepNum = 3;
    stepStart = Date.now();
    const dialogReady = await helpers.waitForVisible(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
    log.push(createLogEntry(3, "wait_dialog", dialogReady.visible ? "ok" : "warn",
      dialogReady.visible ? `Dialog ready in ${dialogReady.elapsedMs}ms` : `Dialog not detected (timeout)`, stepStart));

    // Step 4: Find "複製的文字" option
    stepNum = 4;
    stepStart = Date.now();
    const pasteTypeEl = await helpers.findElementByText(page, uiMap.elements.paste_source_type.text);
    if (!pasteTypeEl) {
      return fail(4, "find_paste_source_type", `Element not found: "${uiMap.elements.paste_source_type.text}"`, "paste_source_type");
    }
    log.push(createLogEntry(4, "find_paste_source_type", "ok", `Found at (${pasteTypeEl.center.x}, ${pasteTypeEl.center.y})`, stepStart));

    // Step 5: Click paste source type -> wait for paste dialog textarea
    stepNum = 5;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, pasteTypeEl.center.x, pasteTypeEl.center.y);
    const pasteTextareaReady = await helpers.waitForVisible(page, 'textarea[aria-label="貼上的文字"]', { timeoutMs: 5000 });
    log.push(createLogEntry(5, "click_paste_source_type", pasteTextareaReady.visible ? "ok" : "warn",
      pasteTextareaReady.visible ? `Paste textarea appeared in ${pasteTextareaReady.elapsedMs}ms` : `Paste textarea not detected`, stepStart));

    // Step 6: Find textarea by placeholder
    stepNum = 6;
    stepStart = Date.now();
    const textareaEl = await helpers.findElementByText(page, uiMap.elements.paste_textarea.text, {
      match: "placeholder",
    });
    if (!textareaEl) {
      return fail(6, "find_paste_textarea", `Element not found: "${uiMap.elements.paste_textarea.text}"`, "paste_textarea");
    }
    log.push(createLogEntry(6, "find_paste_textarea", "ok", `Found at (${textareaEl.center.x}, ${textareaEl.center.y})`, stepStart));

    // Step 7: Click textarea
    stepNum = 7;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, textareaEl.center.x, textareaEl.center.y);
    await new Promise((r) => setTimeout(r, 200));
    log.push(createLogEntry(7, "click_textarea", "ok", `Clicked`, stepStart));

    // Step 8: Paste content
    stepNum = 8;
    stepStart = Date.now();
    await helpers.dispatchPaste(cdp, content);
    await new Promise((r) => setTimeout(r, 300));
    log.push(createLogEntry(8, "paste_content", "ok", `Pasted ${content.length} chars`, stepStart));

    // Step 9: Find insert button INSIDE dialog overlay + verify NOT disabled
    stepNum = 9;
    stepStart = Date.now();
    const insertBtnText = uiMap.elements.insert_button.text;
    let insertPos = await page.evaluate(`(() => {
      const overlays = document.querySelectorAll('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
      if (overlays.length === 0) return null;
      const btns = [];
      for (const o of overlays) for (const b of o.querySelectorAll('button, [role=button], a')) btns.push(b);
      for (const b of btns) {
        if (b.textContent.trim().includes(${JSON.stringify(insertBtnText)})) {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), disabled: !!b.disabled };
        }
      }
      return null;
    })()`) as { x: number; y: number; disabled: boolean } | null;
    if (!insertPos) {
      return fail(9, "find_insert_button", `Element not found in dialog overlay: "${insertBtnText}"`, "insert_button");
    }
    if (insertPos.disabled) {
      // Content may not have been registered yet, wait and retry
      await new Promise((r) => setTimeout(r, 500));
      const retryPos = await page.evaluate(`(() => {
        const overlay = document.querySelector('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
        if (!overlay) return null;
        const btns = overlay.querySelectorAll('button, [role=button], a');
        for (const b of btns) {
          if (b.textContent.trim().includes(${JSON.stringify(insertBtnText)})) {
            const r = b.getBoundingClientRect();
            if (r.width > 0) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), disabled: !!b.disabled };
          }
        }
        return null;
      })()`) as { x: number; y: number; disabled: boolean } | null;
      if (!retryPos || retryPos.disabled) {
        return fail(9, "find_insert_button", `Insert button is disabled (content not accepted?)`, "insert_button");
      }
      log.push(createLogEntry(9, "find_insert_button", "warn", `Button was disabled, retry OK at (${retryPos.x}, ${retryPos.y})`, stepStart));
      insertPos = retryPos;
    } else {
      log.push(createLogEntry(9, "find_insert_button", "ok", `Found in overlay at (${insertPos.x}, ${insertPos.y})`, stepStart));
    }

    // Step 10: Click insert
    stepNum = 10;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, insertPos.x, insertPos.y);
    log.push(createLogEntry(10, "click_insert", "ok", `Clicked`, stepStart));

    // Step 11: Wait for dialog to close (source processing complete)
    stepNum = 11;
    stepStart = Date.now();
    const processingDone = await helpers.waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 15000 });
    log.push(createLogEntry(11, "wait_processing", processingDone.gone ? "ok" : "warn",
      processingDone.gone ? `Source processed, dialog closed in ${processingDone.elapsedMs}ms` : `Timeout waiting for processing`, stepStart));

    // Step 12: Verify source was added by reading source panel
    stepNum = 12;
    stepStart = Date.now();
    const sourceCount = await page.evaluate(`(() => {
      const panel = document.querySelector(${JSON.stringify(uiMap.selectors.source_panel ?? ".source-panel")});
      if (!panel) return -1;
      const items = panel.querySelectorAll("[class*='source-item'], [class*='source-card'], li, .source");
      return items.length || -1;
    })()`) as number;
    log.push(createLogEntry(12, "verify_source_added", sourceCount > 0 ? "ok" : "warn",
      sourceCount > 0 ? `Source panel has ${sourceCount} items` : `Could not verify source count`, stepStart));

    return makeSuccess("addSource", log, t0, `Source added (panel items: ${sourceCount})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(stepNum, `step_${stepNum}_exception`, msg);
  }
}

// =============================================================================
// 3. scriptedListSources
// =============================================================================

export async function scriptedListSources(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { page, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  const fail = makeFail("listSources", log, t0);

  try {
    // Step 0: Ensure source panel
    const srcOk = await helpers.ensureSourcePanel(ctx, log, t0);
    if (!srcOk) return fail(0, "ensure_source_panel", "Source panel not accessible");

    // Step 1: Read source panel contents
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
// 4. scriptedRemoveSource
// =============================================================================

export async function scriptedRemoveSource(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;
  const fail = makeFail("removeSource", log, t0);

  try {
    // Step 0: Ensure source panel
    const srcOk = await helpers.ensureSourcePanel(ctx, log, t0);
    if (!srcOk) return fail(0, "ensure_source_panel", "Source panel not accessible");

    // Steps 1-2: open source menu
    stepNum = 1;
    const menu = await openSourceMenu(ctx, log, stepNum);
    if (!menu.ok) return fail(menu.stepNum, "open_source_menu", "Failed to open source menu", "source_menu");
    stepNum = menu.stepNum + 1;

    // Find "移除來源"
    let stepStart = Date.now();
    const removeEl = await helpers.findElementByText(page, uiMap.elements.remove_source?.text ?? "移除來源");
    if (!removeEl) return fail(stepNum, "find_remove_source", `Menu item not found`, "remove_source");
    log.push(createLogEntry(stepNum, "find_remove_source", "ok", `Found at (${removeEl.center.x}, ${removeEl.center.y})`, stepStart));

    // Click remove -> may open confirmation
    stepNum++;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, removeEl.center.x, removeEl.center.y);
    const confirmDialog = await helpers.waitForVisible(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 1500 });
    log.push(createLogEntry(stepNum, "click_remove_source", "ok", `Clicked`, stepStart));

    // Handle confirmation dialog if present — search INSIDE overlay only
    stepNum++;
    stepStart = Date.now();
    if (confirmDialog.visible) {
      const confirmBtnText = uiMap.elements.remove_source?.text ?? "移除來源";
      const confirmPos = await page.evaluate(`(() => {
        const overlay = document.querySelector('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
        if (!overlay) return null;
        const btns = overlay.querySelectorAll('button, [role=button], a');
        for (const b of btns) {
          if (b.textContent.trim().includes(${JSON.stringify(confirmBtnText)})) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && !b.disabled) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
          }
        }
        return null;
      })()`) as { x: number; y: number } | null;
      if (confirmPos) {
        await helpers.dispatchClick(cdp, confirmPos.x, confirmPos.y);
        await helpers.waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
        log.push(createLogEntry(stepNum, "confirm_remove", "ok", `Confirmed removal, dialog closed`, stepStart));
      }
    } else {
      log.push(createLogEntry(stepNum, "confirm_remove", "ok", `No confirmation dialog (direct remove)`, stepStart));
    }

    // Wait for source panel to update
    stepNum++;
    stepStart = Date.now();
    await new Promise((r) => setTimeout(r, 1000));
    log.push(createLogEntry(stepNum, "wait_removal", "ok", `Source panel settled`, stepStart));

    return makeSuccess("removeSource", log, t0, `Source removed`);
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// 5. scriptedRenameSource
// =============================================================================

export async function scriptedRenameSource(
  ctx: ScriptContext,
  newName: string,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 0;
  const fail = makeFail("renameSource", log, t0);

  try {
    // Step 0: Ensure source panel
    const srcOk = await helpers.ensureSourcePanel(ctx, log, t0);
    if (!srcOk) return fail(0, "ensure_source_panel", "Source panel not accessible");

    // Steps 1-2: open source menu
    stepNum = 1;
    const menu = await openSourceMenu(ctx, log, stepNum);
    if (!menu.ok) return fail(menu.stepNum, "open_source_menu", "Failed to open source menu", "source_menu");
    stepNum = menu.stepNum + 1;

    // Find "重新命名來源"
    let stepStart = Date.now();
    const renameEl = await helpers.findElementByText(page, uiMap.elements.rename_source?.text ?? "重新命名來源");
    if (!renameEl) return fail(stepNum, "find_rename_source", `Menu item not found`, "rename_source");
    log.push(createLogEntry(stepNum, "find_rename_source", "ok", `Found`, stepStart));

    // Click rename -> opens dialog
    stepNum++;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, renameEl.center.x, renameEl.center.y);
    const dialogReady = await helpers.waitForVisible(page, 'input[type="text"], input:not([type])', { timeoutMs: 5000 });
    log.push(createLogEntry(stepNum, "click_rename", dialogReady.visible ? "ok" : "warn",
      `Clicked, dialog ${dialogReady.visible ? `ready in ${dialogReady.elapsedMs}ms` : "not detected (timeout)"}`, stepStart));

    // Find input in dialog
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
    await helpers.dispatchClick(cdp, inputPos.x, inputPos.y);
    log.push(createLogEntry(stepNum, "find_dialog_input", "ok", `Found input at (${inputPos.x}, ${inputPos.y})`, stepStart));

    // Select all + paste new name
    stepNum++;
    stepStart = Date.now();
    await helpers.dispatchType(cdp, page, "Ctrl+A");
    await helpers.dispatchPaste(cdp, newName);
    log.push(createLogEntry(stepNum, "type_new_name", "ok", `Typed "${newName}"`, stepStart));

    // Find and click save INSIDE dialog overlay (not full page — "儲存" may appear in source names)
    stepNum++;
    stepStart = Date.now();
    const saveBtnText = uiMap.elements.save_button?.text ?? "儲存";
    const savePos = await page.evaluate(`(() => {
      const overlays = document.querySelectorAll('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
      if (overlays.length === 0) return null;
      const btns = [];
      for (const o of overlays) for (const b of o.querySelectorAll('button, [role=button], a')) btns.push(b);
      for (const b of btns) {
        if (b.textContent.trim().includes(${JSON.stringify(saveBtnText)})) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && !b.disabled) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        }
      }
      return null;
    })()`) as { x: number; y: number } | null;
    if (!savePos) return fail(stepNum, "find_save_button", `Save button not found in dialog overlay`, "save_button");
    await helpers.dispatchClick(cdp, savePos.x, savePos.y);
    await helpers.waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
    log.push(createLogEntry(stepNum, "click_save", "ok", `Saved at (${savePos.x},${savePos.y}), dialog closed`, stepStart));

    return makeSuccess("renameSource", log, t0, `Source renamed to "${newName}"`);
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// 6. scriptedClearChat
// =============================================================================

export async function scriptedClearChat(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("clearChat", log, t0);

  try {
    // Step 0: Ensure chat panel is visible
    const chatOk = await helpers.ensureChatPanel(ctx, log, t0);
    if (!chatOk) return fail(0, "ensure_chat_panel", "Chat panel not accessible");

    // Step 1: find conversation options menu (aria-label)
    let stepStart = Date.now();
    const optionsEl = await helpers.findElementByText(page, uiMap.elements.conversation_options?.text ?? "對話選項", { match: "aria-label" });
    if (!optionsEl) return fail(1, "find_conversation_options", `Not found`, "conversation_options");
    log.push(createLogEntry(1, "find_conversation_options", "ok", `Found at (${optionsEl.center.x}, ${optionsEl.center.y})`, stepStart));

    // Step 2: click to open menu
    stepNum = 2;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, optionsEl.center.x, optionsEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(2, "click_conversation_options", "ok", `Clicked`, stepStart));

    // Step 3: find "刪除對話記錄"
    stepNum = 3;
    stepStart = Date.now();
    const deleteEl = await helpers.findElementByText(page, uiMap.elements.delete_chat?.text ?? "刪除對話記錄");
    if (!deleteEl) return fail(3, "find_delete_chat", `Menu item not found`, "delete_chat");
    log.push(createLogEntry(3, "find_delete_chat", "ok", `Found`, stepStart));

    // Step 4: click delete
    stepNum = 4;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, deleteEl.center.x, deleteEl.center.y);
    await new Promise((r) => setTimeout(r, 500));
    log.push(createLogEntry(4, "click_delete_chat", "ok", `Clicked`, stepStart));

    // Step 5: handle confirmation if present — search INSIDE overlay only
    stepNum = 5;
    stepStart = Date.now();
    const deleteChatConfirmText = uiMap.elements.delete_notebook?.text ?? "Delete";
    const confirmDeletePos = await page.evaluate(`((searchText) => {
      const overlays = document.querySelectorAll('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
      if (overlays.length === 0) return null;
      const btns = [];
      for (const o of overlays) for (const b of o.querySelectorAll('button, [role=button], a')) btns.push(b);
      for (const b of btns) {
        if (b.textContent.trim().includes(searchText)) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && !b.disabled) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        }
      }
      return null;
    })(${JSON.stringify(deleteChatConfirmText)})`) as { x: number; y: number } | null;
    if (confirmDeletePos) {
      await helpers.dispatchClick(cdp, confirmDeletePos.x, confirmDeletePos.y);
      log.push(createLogEntry(5, "confirm_delete", "ok", `Confirmed at (${confirmDeletePos.x},${confirmDeletePos.y})`, stepStart));
    } else {
      log.push(createLogEntry(5, "confirm_delete", "ok", `No confirmation needed`, stepStart));
    }

    // Step 6: wait for chat to clear
    stepNum = 6;
    stepStart = Date.now();
    const result = await helpers.waitForGone(page, ".message-content", { timeoutMs: 5000 });
    log.push(createLogEntry(6, "wait_chat_clear", result.gone ? "ok" : "warn",
      result.gone ? `Chat cleared in ${result.elapsedMs}ms` : `Timeout waiting for clear`, stepStart));

    return makeSuccess("clearChat", log, t0, "Chat cleared");
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// 7. scriptedListNotebooks
// =============================================================================

export async function scriptedListNotebooks(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { page, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  const fail = makeFail("listNotebooks", log, t0);

  try {
    // Step 0: Ensure homepage
    const homeOk = await helpers.ensureHomepage(ctx, log, t0);
    if (!homeOk) return fail(0, "ensure_homepage", "Could not navigate to homepage");

    // Step 1: Read notebook table
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
// 8. scriptedCreateNotebook
// =============================================================================

export async function scriptedCreateNotebook(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("createNotebook", log, t0);

  try {
    // Step 0: Ensure homepage
    const homeOk = await helpers.ensureHomepage(ctx, log, t0);
    if (!homeOk) return fail(0, "ensure_homepage", "Could not navigate to homepage");
    const initialUrl = page.url();

    // Step 1: find "新建" button
    let stepStart = Date.now();
    const createEl = await helpers.findElementByText(page, uiMap.elements.create_notebook?.text ?? "新建");
    if (!createEl) return fail(1, "find_create_button", `Not found`, "create_notebook");
    log.push(createLogEntry(1, "find_create_button", "ok", `Found at (${createEl.center.x}, ${createEl.center.y})`, stepStart));

    // Step 2: click create
    stepNum = 2;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, createEl.center.x, createEl.center.y);
    log.push(createLogEntry(2, "click_create", "ok", `Clicked`, stepStart));

    // Step 3: wait for navigation to new notebook
    stepNum = 3;
    stepStart = Date.now();
    const nav = await helpers.waitForNavigation(page, { notUrl: initialUrl, timeoutMs: 15_000 });
    if (!nav.navigated) return fail(3, "wait_navigation", `URL did not change`, "navigation");
    log.push(createLogEntry(3, "wait_navigation", "ok", `Navigated to ${nav.url} in ${nav.elapsedMs}ms`, stepStart));

    // Step 4: wait for page to load (h1 appears)
    stepNum = 4;
    stepStart = Date.now();
    const h1 = await helpers.waitForVisible(page, "h1", { timeoutMs: 10_000 });
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
// 9. scriptedGetNotebookUrl — click notebook by name → capture URL → back
// =============================================================================

/**
 * Wait for notebook rows to stabilize (all rendered).
 * Polls tr[tabindex] count until it stops changing for 500ms.
 * Prevents cold-start race where ensureHomepage sees 1 row but 90 exist.
 */
async function waitForRowsStable(
  page: ScriptContext["page"],
  maxWaitMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let lastCount = 0;
  let stableRounds = 0;

  while (Date.now() < deadline) {
    const count = await page.evaluate(
      `document.querySelectorAll('tr[tabindex]').length`,
    ) as number;
    if (count === lastCount && count > 0) {
      stableRounds++;
      if (stableRounds >= 2) return count; // stable for 2 rounds (~500ms)
    } else {
      stableRounds = 0;
    }
    lastCount = count;
    await new Promise((r) => setTimeout(r, 250));
  }
  return lastCount;
}

export async function scriptedGetNotebookUrl(
  ctx: ScriptContext,
  notebookName: string,
): Promise<ScriptResult> {
  const { cdp, page, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("getNotebookUrl", log, t0);

  try {
    // Step 0: Ensure homepage + wait for all rows to render
    const homeOk = await helpers.ensureHomepage(ctx, log, t0);
    if (!homeOk) return fail(0, "ensure_homepage", "Could not navigate to homepage");

    const stepStart0 = Date.now();
    const rowCount = await waitForRowsStable(page);
    log.push(createLogEntry(0, "rows_stable", "ok",
      `${rowCount} rows rendered in ${Date.now() - stepStart0}ms`, stepStart0));

    const initialUrl = page.url();

    // Step 1: find notebook row by name
    let stepStart = Date.now();
    const el = await helpers.findElementByText(page, notebookName);
    if (!el) return fail(1, "find_notebook", `Notebook "${notebookName}" not found (${rowCount} rows on page)`, "notebook_row");
    log.push(createLogEntry(1, "find_notebook", "ok",
      `Found "${notebookName}" at (${el.center.x}, ${el.center.y})`, stepStart));

    // Step 2: scroll into view if outside viewport, then click
    stepNum = 2;
    stepStart = Date.now();

    // Scroll the matching row into view and get its post-scroll position.
    // Uses tr[tabindex] (notebook row selector) — avoids duplicating findElementByText internals.
    const pos = await page.evaluate(`(() => {
      const text = ${JSON.stringify(notebookName)};
      for (const row of document.querySelectorAll('tr[tabindex]')) {
        if ((row.textContent || '').includes(text)) {
          row.scrollIntoView({ block: 'center' });
          const r = row.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    })()`) as { x: number; y: number } | null;

    const clickX = pos?.x ?? el.center.x;
    const clickY = pos?.y ?? el.center.y;

    await helpers.dispatchClick(cdp, clickX, clickY);
    log.push(createLogEntry(2, "click_notebook", "ok",
      `Clicked at (${clickX}, ${clickY})`, stepStart));

    // Step 3: wait for navigation to /notebook/{id}
    stepNum = 3;
    stepStart = Date.now();
    const nav = await helpers.waitForNavigation(page, { notUrl: initialUrl, timeoutMs: 15_000 });
    if (!nav.navigated) return fail(3, "wait_navigation", `URL did not change`, "navigation");
    log.push(createLogEntry(3, "wait_navigation", "ok",
      `Navigated to ${nav.url} in ${nav.elapsedMs}ms`, stepStart));

    // Step 4: go back to homepage + wait for rows to re-render
    stepNum = 4;
    stepStart = Date.now();
    await page.goBack();
    const backRowCount = await waitForRowsStable(page);
    log.push(createLogEntry(4, "go_back", backRowCount > 0 ? "ok" : "warn",
      `Back to homepage, ${backRowCount} rows in ${Date.now() - stepStart}ms`, stepStart));

    return makeSuccess("getNotebookUrl", log, t0,
      JSON.stringify({ name: notebookName, url: nav.url }));
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// 9. scriptedRenameNotebook
// =============================================================================

export async function scriptedRenameNotebook(
  ctx: ScriptContext,
  newName: string,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("renameNotebook", log, t0);

  try {
    // Step 0: Ensure homepage
    const homeOk = await helpers.ensureHomepage(ctx, log, t0);
    if (!homeOk) return fail(0, "ensure_homepage", "Could not navigate to homepage");

    // Step 1: open notebook context menu
    const menu = await openNotebookMenu(ctx, log, 1);
    if (!menu.ok) return fail(menu.stepNum, "open_notebook_menu", "Failed", "notebook_menu");
    stepNum = menu.stepNum + 1;

    // Find "編輯標題" and click immediately (menu may auto-close on focus loss)
    let stepStart = Date.now();
    const editEl = await helpers.findElementByText(page, uiMap.elements.edit_title?.text ?? "編輯標題");
    if (!editEl) return fail(stepNum, "find_edit_title", `Not found`, "edit_title");
    await helpers.dispatchClick(cdp, editEl.center.x, editEl.center.y);
    log.push(createLogEntry(stepNum, "click_edit_title", "ok", `Found and clicked`, stepStart));

    // Wait for dialog with input to appear
    stepNum++;
    stepStart = Date.now();
    const dialogReady = await helpers.waitForVisible(page, '.cdk-overlay-pane input, [role=dialog] input, mat-dialog-container input', { timeoutMs: 8000 });
    if (!dialogReady.visible) {
      // Retry: re-open menu and click again
      const retry = await openNotebookMenu(ctx, log, stepNum);
      if (retry.ok) {
        const retryEdit = await helpers.findElementByText(page, uiMap.elements.edit_title?.text ?? "編輯標題");
        if (retryEdit) {
          await helpers.dispatchClick(cdp, retryEdit.center.x, retryEdit.center.y);
          await helpers.waitForVisible(page, '.cdk-overlay-pane input, [role=dialog] input', { timeoutMs: 5000 });
        }
      }
    }
    log.push(createLogEntry(stepNum, "wait_dialog", dialogReady.visible ? "ok" : "warn",
      dialogReady.visible ? `Dialog ready in ${dialogReady.elapsedMs}ms` : "Dialog not detected, retried", stepStart));

    // Find input in dialog, set value via JS native setter + input event.
    // CDP Input.insertText does NOT trigger Angular Material change detection.
    // Must use HTMLInputElement.prototype.value setter + dispatchEvent('input').
    stepNum++;
    stepStart = Date.now();
    await helpers.waitForVisible(page, '[role=dialog] input, mat-dialog-container input, [role=dialog] textarea, .cdk-overlay-pane input', { timeoutMs: 5000 });
    const inputSet = await page.evaluate(`((newName) => {
      const sels = ['.cdk-overlay-pane input', '[role=dialog] input', 'mat-dialog-container input', 'input:not([type])'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().width > 0) {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, newName);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    })(${JSON.stringify(newName)})`) as boolean;
    if (!inputSet) return fail(stepNum, "find_dialog_input", `No input in dialog or value set failed`, "dialog_input");
    log.push(createLogEntry(stepNum, "type_new_name", "ok", `Set value "${newName}" via native setter`, stepStart));

    // Find save button INSIDE dialog (not full page — "儲存" may appear in notebook titles)
    stepNum++;
    stepStart = Date.now();
    const savePos = await page.evaluate(`(() => {
      const overlay = document.querySelector('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
      if (!overlay) return null;
      const btns = overlay.querySelectorAll('button, [role=button]');
      for (const b of btns) {
        if (b.textContent.trim() === '${uiMap.elements.save_button?.text ?? "儲存"}') {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && !b.disabled) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        }
      }
      return null;
    })()`) as { x: number; y: number } | null;
    if (!savePos) return fail(stepNum, "find_save", `Save button not found in dialog overlay`, "save_button");
    await helpers.dispatchClick(cdp, savePos.x, savePos.y);
    await helpers.waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
    log.push(createLogEntry(stepNum, "click_save", "ok", `Saved at (${savePos.x},${savePos.y}), dialog closed`, stepStart));

    return makeSuccess("renameNotebook", log, t0, `Notebook renamed to "${newName}"`);
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// 10. scriptedDeleteNotebook
// =============================================================================

export async function scriptedDeleteNotebook(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { cdp, page, uiMap, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  let stepNum = 1;
  const fail = makeFail("deleteNotebook", log, t0);

  try {
    // Step 0: Ensure homepage
    const homeOk = await helpers.ensureHomepage(ctx, log, t0);
    if (!homeOk) return fail(0, "ensure_homepage", "Could not navigate to homepage");

    // Step 1: open notebook context menu
    const menu = await openNotebookMenu(ctx, log, 1);
    if (!menu.ok) return fail(menu.stepNum, "open_notebook_menu", "Failed", "notebook_menu");
    stepNum = menu.stepNum + 1;

    // Find "刪除"
    let stepStart = Date.now();
    const deleteEl = await helpers.findElementByText(page, uiMap.elements.delete_notebook?.text ?? "刪除");
    if (!deleteEl) return fail(stepNum, "find_delete", `Not found`, "delete_notebook");
    log.push(createLogEntry(stepNum, "find_delete", "ok", `Found`, stepStart));

    // Click delete -> wait for confirmation dialog
    stepNum++;
    stepStart = Date.now();
    await helpers.dispatchClick(cdp, deleteEl.center.x, deleteEl.center.y);
    await helpers.waitForVisible(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 3000 });
    log.push(createLogEntry(stepNum, "click_delete", "ok", `Clicked, confirmation dialog appeared`, stepStart));

    // Find and click confirmation delete button INSIDE dialog overlay
    stepNum++;
    stepStart = Date.now();
    const deleteConfirmText = uiMap.elements.delete_notebook?.text ?? "Delete";
    const confirmDeletePos = await page.evaluate(`((searchText) => {
      const overlays = document.querySelectorAll('.cdk-overlay-pane, [role=dialog], mat-dialog-container');
      if (overlays.length === 0) return null;
      const btns = [];
      for (const o of overlays) for (const b of o.querySelectorAll('button, [role=button], a')) btns.push(b);
      for (const b of btns) {
        if (b.textContent.trim().includes(searchText)) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && !b.disabled) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        }
      }
      return null;
    })(${JSON.stringify(deleteConfirmText)})`) as { x: number; y: number } | null;
    if (confirmDeletePos) {
      await helpers.dispatchClick(cdp, confirmDeletePos.x, confirmDeletePos.y);
      await helpers.waitForGone(page, '[role=dialog], .cdk-overlay-pane', { timeoutMs: 5000 });
      log.push(createLogEntry(stepNum, "confirm_delete", "ok", `Confirmed deletion at (${confirmDeletePos.x},${confirmDeletePos.y}), dialog closed`, stepStart));
    } else {
      log.push(createLogEntry(stepNum, "confirm_delete", "warn", `No confirmation button found in dialog overlay`, stepStart));
    }

    return makeSuccess("deleteNotebook", log, t0, "Notebook deleted");
  } catch (err) {
    return fail(stepNum, "exception", err instanceof Error ? err.message : String(err));
  }
}
