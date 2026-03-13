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

/**
 * Type text by dispatching individual keyDown/keyUp events for each character.
 */
export async function dispatchType(
  cdp: CDPSession,
  text: string,
): Promise<void> {
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
