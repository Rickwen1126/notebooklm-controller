/**
 * Locale resolver — maps browser language to supported UI map locale.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { UIMap } from "./types.js";

/** Directory containing built-in UI map JSON files. */
const UI_MAPS_DIR = join(import.meta.dirname, "..", "config", "ui-maps");

/**
 * Resolve a browser `navigator.language` string to a supported locale key.
 *
 * Supported locales: "zh-TW", "zh-CN", "en" (fallback).
 */
export function resolveLocale(browserLang: string): string {
  if (browserLang.startsWith("zh-TW") || browserLang.includes("Hant")) return "zh-TW";
  if (browserLang.startsWith("zh")) return "zh-CN";
  return "en";
}

/**
 * Load a UIMap JSON file for the given locale.
 *
 * Falls back to "en" if the requested locale file does not exist.
 */
export function loadUIMap(locale: string): UIMap {
  const filepath = join(UI_MAPS_DIR, `${locale}.json`);
  if (!existsSync(filepath)) {
    return JSON.parse(readFileSync(join(UI_MAPS_DIR, "en.json"), "utf-8")) as UIMap;
  }
  return JSON.parse(readFileSync(filepath, "utf-8")) as UIMap;
}
