/**
 * Shared browser tools for agent sessions.
 *
 * Provides 7 CDP-based tools: screenshot, find, click, paste, type, read, wait.
 * Used by both Recovery and (future) Exec agent sessions.
 */

import type { Tool } from "@github/copilot-sdk";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { CDPSession, Page } from "puppeteer-core";

export function createBrowserTools(cdp: CDPSession, page: Page): Tool<any>[] {
  const screenshotTool = defineTool("screenshot", {
    description: "Capture a screenshot of the current browser tab.",
    parameters: z.object({}),
    handler: async () => {
      const result = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return {
        textResultForLlm: "Screenshot captured.",
        resultType: "success" as const,
        binaryResultsForLlm: [{ data: result.data, mimeType: "image/png", type: "image" as const }],
      };
    },
  });

  const findTool = defineTool("find", {
    description: "Find interactive elements by text/aria-label/placeholder. Returns coordinates. Use '*' to list all.",
    parameters: z.object({ query: z.string().describe("Text to search for, or '*' for all") }),
    handler: async (args: { query: string }) => {
      const results = await page.evaluate(`(async () => {
        const q = ${JSON.stringify(args.query)};
        const INTERACTIVE = [
          "button", "a", "input", "textarea", "select",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
          "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
        ].join(", ");
        const matches = [];
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const text = (el.textContent || "").trim();
          const ariaLabel = el.getAttribute("aria-label");
          const placeholder = el.getAttribute("placeholder");
          if (q === "*" || text.includes(q) || (ariaLabel && ariaLabel.includes(q)) || (placeholder && placeholder.includes(q))) {
            matches.push({
              tag: el.tagName, text: text.slice(0, 80),
              ariaLabel, placeholder,
              disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
              center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            });
          }
        }
        return matches;
      })()`) as Array<Record<string, unknown>>;
      if (results.length === 0) return { textResultForLlm: `No elements found for: "${args.query}"`, resultType: "success" as const };
      return {
        textResultForLlm: results.map((r: any) =>
          `[${r.tag}] text="${r.text}" aria="${r.ariaLabel ?? ""}" placeholder="${r.placeholder ?? ""}"${r.disabled ? " DISABLED" : ""} → click(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})`,
        ).join("\n"),
        resultType: "success" as const,
      };
    },
  });

  const clickTool = defineTool("click", {
    description: "Click at coordinates. Use find() first to get coordinates.",
    parameters: z.object({ x: z.number(), y: z.number() }),
    handler: async (args: { x: number; y: number }) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: args.x, y: args.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: args.x, y: args.y, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 500));
      const ss = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return {
        textResultForLlm: `Clicked at (${args.x}, ${args.y}).`,
        resultType: "success" as const,
        binaryResultsForLlm: [{ data: ss.data, mimeType: "image/png", type: "image" as const }],
      };
    },
  });

  const pasteTool = defineTool("paste", {
    description: "Paste text at cursor position.",
    parameters: z.object({ text: z.string() }),
    handler: async (args: { text: string }) => {
      await cdp.send("Input.insertText", { text: args.text });
      return { textResultForLlm: `Pasted ${args.text.length} chars.`, resultType: "success" as const };
    },
  });

  const typeTool = defineTool("type", {
    description: "Type text or special keys (Escape, Enter, Tab, Ctrl+A).",
    parameters: z.object({ text: z.string() }),
    handler: async (args: { text: string }) => {
      const specialKeys: Record<string, { key: string; code: string; keyCode: number }> = {
        Escape: { key: "Escape", code: "Escape", keyCode: 27 },
        Enter: { key: "Enter", code: "Enter", keyCode: 13 },
        Tab: { key: "Tab", code: "Tab", keyCode: 9 },
        Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      };
      if (args.text === "Ctrl+A" || args.text === "ctrl+a") {
        await page.evaluate(`(() => {
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.select(); return; }
          const sel = window.getSelection();
          if (sel && document.activeElement) sel.selectAllChildren(document.activeElement);
        })()`);
        return { textResultForLlm: "Selected all.", resultType: "success" as const };
      }
      const special = specialKeys[args.text];
      if (special) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
        return { textResultForLlm: `Typed: "${args.text}"`, resultType: "success" as const };
      }
      for (const char of args.text) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
      }
      return { textResultForLlm: `Typed: "${args.text}"`, resultType: "success" as const };
    },
  });

  const readTool = defineTool("read", {
    description: `Read DOM elements by CSS selector. Key selectors: ".to-user-container .message-content" (answer), ".source-panel" (sources).`,
    parameters: z.object({ selector: z.string() }),
    handler: async (args: { selector: string }) => {
      const result = await page.evaluate(`(() => {
        const sel = ${JSON.stringify(args.selector)};
        const els = document.querySelectorAll(sel);
        if (els.length === 0) return { count: 0, items: [] };
        return {
          count: els.length,
          items: Array.from(els).map((el) => ({
            tag: el.tagName,
            text: ((el.textContent || "").trim()).slice(0, 500),
            visible: getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none",
          })),
        };
      })()`) as { count: number; items: Array<{ tag: string; text: string; visible: boolean }> };
      if (result.count === 0) return { textResultForLlm: `(no match for "${args.selector}")`, resultType: "success" as const };
      return {
        textResultForLlm: [`Found ${result.count} element(s):`,
          ...result.items.map((item, i) => {
            const vis = item.visible ? "" : " (HIDDEN)";
            return `[${i + 1}] ${item.tag}${vis}: ${item.text.slice(0, 200)}${item.text.length > 200 ? "..." : ""}`;
          }),
        ].join("\n"),
        resultType: "success" as const,
      };
    },
  });

  const waitTool = defineTool("wait", {
    description: "Wait N seconds.",
    parameters: z.object({ seconds: z.number().min(1).max(60) }),
    handler: async (args: { seconds: number }) => {
      await new Promise((r) => setTimeout(r, args.seconds * 1000));
      const ss = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return {
        textResultForLlm: `Waited ${args.seconds}s.`,
        resultType: "success" as const,
        binaryResultsForLlm: [{ data: ss.data, mimeType: "image/png", type: "image" as const }],
      };
    },
  });

  return [screenshotTool, findTool, clickTool, pasteTool, typeTool, readTool, waitTool] as Tool<any>[];
}
