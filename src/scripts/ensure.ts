/**
 * Ensure helpers — verify page state before script operations.
 *
 * Each helper checks if the expected panel/page is active and
 * switches to it if needed. Uses ctx injection pattern.
 */

import type { ScriptLogEntry, ScriptContext } from "./types.js";
import { createLogEntry } from "./types.js";

const HOMEPAGE_URL = "https://notebooklm.google.com";

/**
 * Ensure the chat panel is visible. If not, clicks the chat tab.
 */
export async function ensureChatPanel(
  ctx: ScriptContext,
  log: ScriptLogEntry[],
  _t0: number,
): Promise<boolean> {
  const { cdp, page, uiMap, helpers } = ctx;
  const stepStart = Date.now();
  const chatTabText = uiMap.elements.chat_tab?.text ?? "Chat";

  const chatVisible = await page.evaluate(`(() => {
    const panel = document.querySelector('.chat-panel');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`) as boolean;

  if (!chatVisible) {
    const tabEl = await helpers.findElementByText(page, chatTabText);
    if (tabEl) {
      await helpers.dispatchClick(cdp, tabEl.center.x, tabEl.center.y);
      await new Promise((r) => setTimeout(r, 800));
      log.push(createLogEntry(0, "ensure_chat_panel", "warn", `Clicked "${chatTabText}" tab`, stepStart));
    } else {
      log.push(createLogEntry(0, "ensure_chat_panel", "warn", `Chat panel not visible, no tab found`, stepStart));
      return false;
    }
  } else {
    log.push(createLogEntry(0, "ensure_chat_panel", "ok", `Chat panel visible`, stepStart));
  }
  return true;
}

/**
 * Ensure the source panel is visible. If not, clicks the source tab.
 * Also handles collapsed source panel (collapse_content).
 */
export async function ensureSourcePanel(
  ctx: ScriptContext,
  log: ScriptLogEntry[],
  _t0: number,
): Promise<boolean> {
  const { cdp, page, uiMap, helpers } = ctx;
  const stepStart = Date.now();
  const sourceTabText = uiMap.elements.source_tab?.text ?? "Sources";

  const panelVisible = await page.evaluate(`(() => {
    const panel = document.querySelector('.source-panel');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`) as boolean;

  if (!panelVisible) {
    const tabEl = await helpers.findElementByText(page, sourceTabText);
    if (tabEl) {
      await helpers.dispatchClick(cdp, tabEl.center.x, tabEl.center.y);
      await new Promise((r) => setTimeout(r, 800));
      log.push(createLogEntry(0, "ensure_source_panel", "warn", `Clicked "${sourceTabText}" tab`, stepStart));
    } else {
      log.push(createLogEntry(0, "ensure_source_panel", "warn", `Source panel not visible, no tab found`, stepStart));
      return false;
    }
  } else {
    log.push(createLogEntry(0, "ensure_source_panel", "ok", `Source panel visible`, stepStart));
  }
  return true;
}

/**
 * Ensure the page is on the NotebookLM homepage. Navigate if not.
 */
export async function ensureHomepage(
  ctx: ScriptContext,
  log: ScriptLogEntry[],
  _t0: number,
): Promise<boolean> {
  const { page, helpers } = ctx;
  const stepStart = Date.now();
  const url = page.url();
  const isHomepage = url === HOMEPAGE_URL || url === HOMEPAGE_URL + "/";

  if (!isHomepage) {
    await page.goto(HOMEPAGE_URL, { waitUntil: "domcontentloaded" });
    // Wait for notebook rows to render (not hardcode sleep).
    // Homepage may have 100+ notebooks — rendering takes time.
    await helpers.waitForVisible(page, 'tr[tabindex]', { timeoutMs: 10000 });
    log.push(createLogEntry(0, "ensure_homepage", "warn", `Navigated to homepage from ${url.slice(0, 60)}`, stepStart));
  } else {
    log.push(createLogEntry(0, "ensure_homepage", "ok", `Already on homepage`, stepStart));
  }
  return true;
}
