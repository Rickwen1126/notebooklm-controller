/**
 * findElementByText — targeted DOM query for interactive elements.
 *
 * Searches 16 interactive selectors (button, a, input, textarea, select,
 * role=button/link/tab/menuitem/option/checkbox/radio/switch/combobox,
 * tabindex, contenteditable) by text/placeholder/aria-label match.
 * Supports disambiguate filter (e.g., "y > 400") for multiple matches.
 */

import type { Page } from "puppeteer-core";
import type { FoundElement } from "./types.js";

export async function findElementByText(
  page: Page,
  text: string,
  options?: { match?: "text" | "placeholder" | "aria-label"; disambiguate?: string },
): Promise<FoundElement | null> {
  const matchType = options?.match ?? "text";
  const disambiguate = options?.disambiguate;

  // String-form evaluate to avoid esbuild __name injection bug
  const results = await page.evaluate(
    `(async () => {
      const searchText = ${JSON.stringify(text)};
      const matchType = ${JSON.stringify(matchType)};
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

        let found = false;
        if (matchType === "placeholder") {
          found = (el.getAttribute("placeholder") || "").includes(searchText);
        } else if (matchType === "aria-label") {
          found = (el.getAttribute("aria-label") || "").includes(searchText);
        } else {
          found = ((el.textContent || "").trim()).includes(searchText);
        }

        if (found) {
          matches.push({
            tag: el.tagName,
            text: ((el.textContent || "").trim()).slice(0, 80),
            disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
            center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        }
      }
      return matches;
    })()`,
  ) as FoundElement[];

  if (results.length === 0) return null;

  // Apply disambiguate filter (e.g., "y > 400")
  if (disambiguate) {
    const match = disambiguate.match(/^([xy])\s*([><])\s*(\d+)$/);
    if (match) {
      const [, axis, op, val] = match;
      const threshold = parseInt(val, 10);
      const filtered = results.filter((r) => {
        const v = axis === "y" ? r.center.y : r.center.x;
        return op === ">" ? v > threshold : v < threshold;
      });
      if (filtered.length > 0) return filtered[0];
    }
  }

  return results[0];
}
