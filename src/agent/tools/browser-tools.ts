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
      "Type text or press a special key. " +
      "Special keys: type('Enter'), type('Backspace'), type('Tab'), type('Escape'), " +
      "type('ArrowUp'), type('ArrowDown'). " +
      "Plain text is typed character-by-character. " +
      "Do NOT use for select-all or copy/paste — use the paste tool instead.",
    parameters: z.object({
      text: z.string().describe("Text to type, or a special key like 'Enter', 'Backspace', 'Tab'"),
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
      "Set clear=true to replace all existing text in the focused input (select-all + paste). " +
      "Two content modes: (1) filePath — read from file and paste (for large content from repoToText/urlToText/pdfToText, " +
      "text never enters LLM context); (2) text — paste short text directly.",
    parameters: z.object({
      filePath: z.string().optional().describe("File path to read and paste (for large content from repoToText)"),
      text: z.string().optional().describe("Short text to paste directly"),
      clear: z.boolean().optional().describe("If true, select all existing text first so paste replaces it"),
    }),
    handler: async (args: { filePath?: string; text?: string; clear?: boolean }) => {
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
      await dispatchPaste(cdp, content, { clear: args.clear });
      return textResult(
        `Pasted ${content.length.toLocaleString()} character(s)${args.clear ? " (replaced existing)" : ""}.`,
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

  // ---------------------------------------------------------------------------
  // waitForContent — poll until element content is stable
  // ---------------------------------------------------------------------------

  const waitForContentTool = defineTool("waitForContent", {
    description:
      "Poll a CSS selector until its text content is stable (no changes across multiple checks). " +
      "Returns the stable content directly — no need for a separate read() call. " +
      "Use this instead of wait() + read() for any scenario where you need to wait for content: " +
      "query answers, source panel updates, dialog appearance, page loads, etc. " +
      "Much faster than fixed wait() — returns as soon as content stabilizes.",
    parameters: z.object({
      selector: z.string().describe("CSS selector to monitor (e.g. '.to-user-container .message-content')"),
      interval: z.number().optional().describe("Seconds between checks (default: 1)"),
      stableCount: z.number().optional().describe("Consecutive identical reads to consider stable (default: 3)"),
      timeout: z.number().optional().describe("Maximum seconds to wait (default: 60)"),
      rejectIf: z.string().optional().describe("Regex pattern — if content matches, keep waiting (default: 'Thinking|Refining|正在思考|正在整理')"),
      lastOnly: z.boolean().optional().describe("If multiple elements match, only check the last one (default: true)"),
    }),
    handler: async (args) => {
      const interval = (args.interval ?? 1) * 1000;
      const stableCount = args.stableCount ?? 3;
      const timeout = (args.timeout ?? 60) * 1000;
      // Default: reject transitional states so we don't stabilize on "Thinking..."
      const rejectIf = args.rejectIf ?? "Thinking|Refining|正在思考|正在整理";
      const lastOnly = args.lastOnly ?? true;

      const startTime = Date.now();

      // Phase 1: Poll with hash comparison IN the browser (fast, no serialization).
      // Uses string-form evaluate to avoid esbuild __name injection breaking serialized functions.
      const pollResult = await page.evaluate(`(async () => {
        const sel = ${JSON.stringify(args.selector)};
        const intervalMs = ${interval};
        const stableN = ${stableCount};
        const timeoutMs = ${timeout};
        const rejectRe = ${rejectIf ? `new RegExp(${JSON.stringify(rejectIf)}, "i")` : "null"};
        const last = ${lastOnly};
        const start = Date.now();
        let lastHash = "";
        let sameCount = 0;

        function hash(s) {
          let h = 5381;
          for (let i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
          }
          return h.toString(36);
        }

        while (Date.now() - start < timeoutMs) {
          await new Promise(r => setTimeout(r, intervalMs));
          const els = document.querySelectorAll(sel);
          if (els.length === 0) { sameCount = 0; lastHash = ""; continue; }
          const target = last ? els[els.length - 1] : els[0];
          const text = (target.textContent || "").trim();
          if (!text || (rejectRe && rejectRe.test(text))) { sameCount = 0; lastHash = ""; continue; }
          const h = hash(text);
          if (h === lastHash) {
            sameCount++;
            if (sameCount >= stableN) return { stable: true, elapsed: Date.now() - start };
          } else { lastHash = h; sameCount = 1; }
        }
        return { stable: false, elapsed: Date.now() - start };
      })()`) as { stable: boolean; elapsed: number };

      // Phase 2: Fetch the final stable text (one serialization)
      const text = await page.evaluate(`(() => {
        const els = document.querySelectorAll(${JSON.stringify(args.selector)});
        if (els.length === 0) return "";
        const target = ${lastOnly} ? els[els.length - 1] : els[0];
        return ((target.textContent || "").trim()).slice(0, 5000);
      })()`) as string;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (pollResult.stable && text) {
        return textResult(
          `Content stable after ${elapsed}s:\n\n${text}`,
        );
      }
      if (text) {
        return textResult(
          `Timeout after ${elapsed}s. Last content (may be incomplete):\n\n${text}`,
        );
      }
      return textResult(
        `Timeout after ${elapsed}s. No content found for "${args.selector}".`,
      );
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [screenshotTool, clickTool, typeTool, scrollTool, pasteTool, findTool, readTool, navigateTool, waitTool, waitForContentTool] as any as Tool<unknown>[];
}
