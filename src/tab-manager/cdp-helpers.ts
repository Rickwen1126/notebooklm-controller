/**
 * Low-level CDP helpers for browser interaction.
 *
 * Each function takes a CDPSession and issues raw CDP commands.
 * These are the building blocks used by higher-level tab-manager operations.
 */

import type { CDPSession } from "puppeteer-core";

/**
 * Capture a screenshot via CDP and return the base64-encoded image data.
 */
export async function captureScreenshot(
  cdp: CDPSession,
  options?: { format?: "png" | "jpeg"; quality?: number },
): Promise<string> {
  const result = (await cdp.send("Page.captureScreenshot", {
    format: options?.format ?? "png",
    ...(options?.quality !== undefined ? { quality: options.quality } : {}),
  })) as { data: string };

  return result.data;
}

/**
 * Dispatch a mouse click (mousePressed + mouseReleased) at the given coordinates.
 */
export async function dispatchClick(
  cdp: CDPSession,
  x: number,
  y: number,
  options?: { button?: "left" | "right"; clickCount?: number },
): Promise<void> {
  const button = options?.button ?? "left";
  const clickCount = options?.clickCount ?? 1;

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    clickCount,
  });

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    clickCount,
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcut support
// ---------------------------------------------------------------------------

const MODIFIER_BITS: Record<string, number> = {
  Ctrl: 2, Control: 2,
  Alt: 1,
  Meta: 4, Cmd: 4, Command: 4,
  Shift: 8,
};

const SPECIAL_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter:      { key: "Enter",     code: "Enter",      keyCode: 13 },
  Tab:        { key: "Tab",       code: "Tab",        keyCode: 9 },
  Backspace:  { key: "Backspace", code: "Backspace",  keyCode: 8 },
  Delete:     { key: "Delete",    code: "Delete",     keyCode: 46 },
  Escape:     { key: "Escape",    code: "Escape",     keyCode: 27 },
  ArrowUp:    { key: "ArrowUp",   code: "ArrowUp",    keyCode: 38 },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown",  keyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft",  keyCode: 37 },
  ArrowRight: { key: "ArrowRight",code: "ArrowRight", keyCode: 39 },
  Home:       { key: "Home",      code: "Home",       keyCode: 36 },
  End:        { key: "End",       code: "End",        keyCode: 35 },
  Space:      { key: " ",         code: "Space",      keyCode: 32 },
};

/**
 * Platform-agnostic high-level actions.
 * Agent prompts use these instead of OS-specific shortcuts.
 * Maps to Cmd on macOS, Ctrl on Windows/Linux.
 */
const PLATFORM_MOD = process.platform === "darwin" ? 4 : 2; // Meta(Cmd) vs Ctrl

const ACTION_ALIASES: Record<string, { modifiers: number; key: string; code: string; keyCode: number }> = {
  SelectAll: { modifiers: PLATFORM_MOD, key: "a", code: "KeyA", keyCode: 65 },
  Copy:      { modifiers: PLATFORM_MOD, key: "c", code: "KeyC", keyCode: 67 },
  Cut:       { modifiers: PLATFORM_MOD, key: "x", code: "KeyX", keyCode: 88 },
  Undo:      { modifiers: PLATFORM_MOD, key: "z", code: "KeyZ", keyCode: 90 },
  Redo:      { modifiers: PLATFORM_MOD | 8, key: "z", code: "KeyZ", keyCode: 90 }, // +Shift
};

/** Pattern: "Ctrl+A", "Shift+Enter", "Backspace", "SelectAll", etc. */
const SHORTCUT_PATTERN = /^((?:(?:Ctrl|Control|Alt|Meta|Cmd|Command|Shift)\+)*)(\w+)$/;

/**
 * Check if text looks like a keyboard shortcut (e.g. "Ctrl+A", "Enter").
 * Returns null if it's plain text.
 */
function parseShortcut(text: string): { modifiers: number; key: string; code: string; keyCode: number } | null {
  // Check platform-agnostic action aliases first (SelectAll, Copy, etc.)
  if (text in ACTION_ALIASES) {
    return { ...ACTION_ALIASES[text] };
  }

  const match = SHORTCUT_PATTERN.exec(text);
  if (!match) return null;

  const modifierStr = match[1]; // e.g. "Ctrl+" or "Ctrl+Shift+"
  const keyName = match[2];    // e.g. "A" or "Enter"

  // Must have modifiers OR be a recognized special key.
  const hasModifiers = modifierStr.length > 0;
  const isSpecial = keyName in SPECIAL_KEYS;

  if (!hasModifiers && !isSpecial) return null;

  // Parse modifiers
  let modifiers = 0;
  if (hasModifiers) {
    for (const mod of modifierStr.split("+").filter(Boolean)) {
      const bits = MODIFIER_BITS[mod];
      if (bits === undefined) return null;
      modifiers |= bits;
    }
  }

  // Resolve key
  if (isSpecial) {
    const spec = SPECIAL_KEYS[keyName];
    return { modifiers, ...spec };
  }

  // Single letter key (e.g. "A" in "Ctrl+A")
  if (keyName.length === 1) {
    const lower = keyName.toLowerCase();
    return {
      modifiers,
      key: lower,
      code: `Key${keyName.toUpperCase()}`,
      keyCode: lower.charCodeAt(0),
    };
  }

  return null;
}

/**
 * Dispatch a keyboard shortcut (e.g. Ctrl+A) via CDP.
 */
async function dispatchKeyCombo(
  cdp: CDPSession,
  combo: { modifiers: number; key: string; code: string; keyCode: number },
): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: combo.modifiers,
    key: combo.key,
    code: combo.code,
    windowsVirtualKeyCode: combo.keyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: combo.modifiers,
    key: combo.key,
    code: combo.code,
    windowsVirtualKeyCode: combo.keyCode,
  });
}

/**
 * Type text or dispatch a keyboard shortcut.
 *
 * If `text` matches a shortcut pattern (e.g. "Ctrl+A", "Enter", "Backspace"),
 * dispatches the corresponding key combo with modifiers.
 * Otherwise, types text character-by-character.
 */
export async function dispatchType(
  cdp: CDPSession,
  text: string,
): Promise<void> {
  // Check if it's a keyboard shortcut
  const shortcut = parseShortcut(text);
  if (shortcut) {
    await dispatchKeyCombo(cdp, shortcut);
    return;
  }

  // Plain text — type character by character
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
    });

    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      text: char,
    });
  }
}

/**
 * Dispatch a mouse wheel scroll event at the given coordinates.
 */
export async function dispatchScroll(
  cdp: CDPSession,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

/**
 * Paste text directly using the Input.insertText CDP command.
 * This bypasses keyboard events and inserts text at the current cursor position.
 */
export async function dispatchPaste(
  cdp: CDPSession,
  text: string,
): Promise<void> {
  await cdp.send("Input.insertText", {
    text,
  });
}
