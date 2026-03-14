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
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { TMP_DIR } from "../../shared/config.js";
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
  const page = tabHandle.page;

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
      await new Promise((r) => setTimeout(r, 500));
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
      "Type text or keyboard shortcut. " +
      "Actions: type('SelectAll'), type('Copy'), type('Cut'), type('Undo'). " +
      "Keys: type('Enter'), type('Backspace'), type('Tab'), type('Escape'). " +
      "Combos: type('Ctrl+A'), type('Shift+Enter'). " +
      "Plain text is typed character-by-character.",
    parameters: z.object({
      text: z.string().describe("Text to type, or a shortcut like 'SelectAll', 'Enter', 'Ctrl+A'"),
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
      await new Promise((r) => setTimeout(r, 300));
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
      "Paste text at the current cursor position using Input.insertText. " +
      "Two modes: (1) filePath — read from file and paste (for large content from repoToText/urlToText/pdfToText, " +
      "text never enters LLM context); (2) text — paste short text directly.",
    parameters: z.object({
      filePath: z.string().optional().describe("File path to read and paste (for large content from repoToText)"),
      text: z.string().optional().describe("Short text to paste directly"),
    }),
    handler: async (args: { filePath?: string; text?: string }) => {
      let content: string;
      if (args.filePath) {
        // Security: filePath must resolve within TMP_DIR to prevent
        // reading arbitrary files via path traversal.
        const resolved = resolve(args.filePath);
        const rel = relative(TMP_DIR, resolved);
        if (rel.startsWith("..") || resolve(TMP_DIR, rel) !== resolved) {
          return textResult(
            `Error: filePath must be within ${TMP_DIR}. Got: ${args.filePath}`,
          );
        }
        content = readFileSync(resolved, "utf-8");
      } else if (args.text) {
        content = args.text;
      } else {
        return textResult("Error: provide either filePath or text parameter.");
      }
      await dispatchPaste(cdp, content);
      return textResult(
        `Pasted ${content.length.toLocaleString()} character(s).`,
      );
    },
  });

  const findTool = defineTool("find", {
    description:
      "Find interactive elements on the page by text content, placeholder, aria-label, or CSS selector. " +
      "Returns tag, text, center coordinates, rect, disabled, and ariaExpanded for each match. " +
      "Searches buttons, links, inputs, textareas, selects, and elements with ARIA roles or tabindex. " +
      "Filters out visibility:hidden and display:none elements. " +
      "Falls back to CSS selector query if no text match is found.",
    parameters: z.object({
      query: z
        .string()
        .describe(
          "Text to search for in element content/aria-label/placeholder, OR a CSS selector",
        ),
    }),
    handler: async (args) => {
      const results = await page.evaluate((q: string) => {
        const matches: Array<{
          tag: string;
          text: string;
          ariaLabel: string | null;
          disabled: boolean;
          ariaExpanded: string | null;
          center: { x: number; y: number };
          rect: { x: number; y: number; w: number; h: number };
        }> = [];

        const INTERACTIVE = [
          "button", "a", "input", "textarea", "select",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
          "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
        ].join(", ");
        const all = document.querySelectorAll(INTERACTIVE);
        for (const el of all) {
          const text = el.textContent?.trim() ?? "";
          const ariaLabel = el.getAttribute("aria-label") ?? "";
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (
            text.includes(q) ||
            ariaLabel.includes(q) ||
            el.getAttribute("placeholder")?.includes(q)
          ) {
            matches.push({
              tag: el.tagName,
              text: text.slice(0, 80),
              ariaLabel: el.getAttribute("aria-label"),
              disabled:
                el.hasAttribute("disabled") ||
                el.getAttribute("aria-disabled") === "true",
              ariaExpanded: el.getAttribute("aria-expanded"),
              center: {
                x: Math.round(r.x + r.width / 2),
                y: Math.round(r.y + r.height / 2),
              },
              rect: {
                x: Math.round(r.x),
                y: Math.round(r.y),
                w: Math.round(r.width),
                h: Math.round(r.height),
              },
            });
          }
        }

        // Fallback: try as CSS selector
        if (matches.length === 0) {
          try {
            const els = document.querySelectorAll(q);
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const style = getComputedStyle(el);
              if (style.visibility === "hidden" || style.display === "none") continue;
              matches.push({
                tag: el.tagName,
                text: (el.textContent?.trim() ?? "").slice(0, 80),
                ariaLabel: el.getAttribute("aria-label"),
                disabled:
                  el.hasAttribute("disabled") ||
                  el.getAttribute("aria-disabled") === "true",
                ariaExpanded: el.getAttribute("aria-expanded"),
                center: {
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2),
                },
                rect: {
                  x: Math.round(r.x),
                  y: Math.round(r.y),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                },
              });
            }
          } catch {
            // Not a valid selector
          }
        }

        return matches;
      }, args.query);

      if (results.length === 0) {
        return textResult(
          `No elements found for: "${args.query}". Try a different search term or CSS selector.`,
        );
      }

      const lines = results.map((r) => {
        const attrs = [
          r.ariaLabel ? `aria="${r.ariaLabel}"` : "",
          r.disabled ? "DISABLED" : "",
          r.ariaExpanded !== null ? `expanded=${r.ariaExpanded}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          `[${r.tag}] "${r.text}" → center(${r.center.x}, ${r.center.y})  ` +
          `rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})` +
          (attrs ? `  ${attrs}` : "")
        );
      });
      return textResult(lines.join("\n"));
    },
  });

  const readTool = defineTool("read", {
    description:
      "Read page state using a CSS selector. Returns structured { count, items[] } with tag, text, and visible per item. " +
      "Key selector for NotebookLM answers: `.to-user-container .message-content`.",
    parameters: z.object({
      selector: z.string().describe("CSS selector to query"),
    }),
    handler: async (args) => {
      const result = await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        if (els.length === 0)
          return {
            count: 0,
            items: [] as Array<{ tag: string; text: string; visible: boolean }>,
          };
        const items = Array.from(els).map((el) => {
          const style = getComputedStyle(el);
          return {
            tag: el.tagName,
            text: (el.textContent?.trim() ?? "").slice(0, 500),
            visible:
              style.visibility !== "hidden" && style.display !== "none",
          };
        });
        return { count: items.length, items };
      }, args.selector);

      if (result.count === 0) {
        return textResult(`No elements matched "${args.selector}"`);
      }
      const lines = [
        `Found ${result.count} element(s) matching "${args.selector}":`,
      ];
      for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i];
        const vis = item.visible ? "" : " (HIDDEN)";
        const preview =
          item.text.length > 200
            ? item.text.slice(0, 200) + "..."
            : item.text;
        lines.push(`[${i + 1}] ${item.tag}${vis}: ${preview}`);
      }
      return textResult(lines.join("\n"));
    },
  });

  const navigateTool = defineTool("navigate", {
    description:
      "Navigate to a URL, wait for networkidle2, then return a screenshot of the loaded page.",
    parameters: z.object({
      url: z.string().describe("URL to navigate to"),
    }),
    handler: async (args) => {
      await page.goto(args.url, { waitUntil: "networkidle2", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 1000));
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(base64, "png", `Navigated to: ${args.url}`);
    },
  });

  const waitTool = defineTool("wait", {
    description:
      "Wait 1-30 seconds, then return a screenshot of the current page state.",
    parameters: z.object({
      seconds: z
        .number()
        .min(1)
        .max(30)
        .describe("Number of seconds to wait (1-30)"),
    }),
    handler: async (args) => {
      await new Promise((r) => setTimeout(r, args.seconds * 1000));
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(
        base64,
        "png",
        `Waited ${args.seconds} seconds. Screenshot shows current state.`,
      );
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [screenshotTool, clickTool, typeTool, scrollTool, pasteTool, findTool, readTool, navigateTool, waitTool] as any as Tool<unknown>[];
}
