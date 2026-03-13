/**
 * Browser tools for the Copilot SDK agent.
 *
 * Each tool wraps a CDP helper and returns a ToolResultObject.
 * Design principle: Tool self-containment — visual operations (click, scroll)
 * automatically capture and return a screenshot so the agent sees the result.
 */

import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import type { TabHandle } from "../../shared/types.js";
import {
  captureScreenshot,
  dispatchClick,
  dispatchType,
  dispatchScroll,
  dispatchPaste,
} from "../../tab-manager/cdp-helpers.js";

/** Build a ToolResultObject containing a screenshot as binary data. */
function screenshotResult(
  base64: string,
  format: "png" | "jpeg",
  text?: string,
): ToolResultObject {
  return {
    textResultForLlm: text ?? "Screenshot captured.",
    resultType: "success",
    binaryResultsForLlm: [
      {
        data: base64,
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        type: "image",
      },
    ],
  };
}

/** Build a simple text ToolResultObject. */
function textResult(text: string): ToolResultObject {
  return {
    textResultForLlm: text,
    resultType: "success",
  };
}

/**
 * Create browser interaction tools bound to a specific TabHandle.
 *
 * Returns an array of Tool instances (Copilot SDK `defineTool` format)
 * that operate on the tab's CDP session.
 */
export function createBrowserTools(tabHandle: TabHandle): Tool[] {
  const cdp = tabHandle.cdpSession;

  const screenshotTool = defineTool("screenshot", {
    description:
      "Capture a screenshot of the current browser tab. Returns the image directly.",
    parameters: z.object({
      format: z
        .enum(["png", "jpeg"])
        .optional()
        .describe("Image format (default: png)"),
      quality: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("JPEG quality 0-100 (only used when format is jpeg)"),
    }),
    handler: async (args) => {
      const format = args.format ?? "png";
      const base64 = await captureScreenshot(cdp, {
        format,
        quality: args.quality,
      });
      return screenshotResult(base64, format);
    },
  });

  const clickTool = defineTool("click", {
    description:
      "Click at the given x,y coordinates in the browser tab, then return a screenshot of the result.",
    parameters: z.object({
      x: z.number().describe("X coordinate in pixels"),
      y: z.number().describe("Y coordinate in pixels"),
      button: z
        .enum(["left", "right"])
        .optional()
        .describe("Mouse button (default: left)"),
    }),
    handler: async (args) => {
      await dispatchClick(cdp, args.x, args.y, {
        button: args.button,
      });
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(
        base64,
        "png",
        `Clicked at (${args.x}, ${args.y}) with ${args.button ?? "left"} button.`,
      );
    },
  });

  const typeTool = defineTool("type", {
    description:
      "Type text character-by-character into the currently focused element.",
    parameters: z.object({
      text: z.string().describe("Text to type"),
    }),
    handler: async (args) => {
      await dispatchType(cdp, args.text);
      return textResult(
        `Typed ${args.text.length} character(s).`,
      );
    },
  });

  const scrollTool = defineTool("scroll", {
    description:
      "Scroll the page at the given coordinates by the specified delta, then return a screenshot.",
    parameters: z.object({
      x: z.number().describe("X coordinate for scroll origin"),
      y: z.number().describe("Y coordinate for scroll origin"),
      deltaX: z
        .number()
        .optional()
        .describe("Horizontal scroll delta in pixels (default: 0)"),
      deltaY: z.number().describe("Vertical scroll delta in pixels"),
    }),
    handler: async (args) => {
      const deltaX = args.deltaX ?? 0;
      await dispatchScroll(cdp, args.x, args.y, deltaX, args.deltaY);
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(
        base64,
        "png",
        `Scrolled at (${args.x}, ${args.y}) by (${deltaX}, ${args.deltaY}).`,
      );
    },
  });

  const pasteTool = defineTool("paste", {
    description:
      "Paste text at the current cursor position using Input.insertText (bypasses keyboard events).",
    parameters: z.object({
      text: z.string().describe("Text to paste"),
    }),
    handler: async (args) => {
      await dispatchPaste(cdp, args.text);
      return textResult(
        `Pasted ${args.text.length} character(s).`,
      );
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [screenshotTool, clickTool, typeTool, scrollTool, pasteTool] as any as Tool<unknown>[];
}
