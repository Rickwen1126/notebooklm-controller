/**
 * Locale resolver — maps browser language to supported UI map locale.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UIMap } from "./types.js";

/** Directory containing built-in UI map JSON files. */
const UI_MAPS_DIR = join(import.meta.dirname, "..", "config", "ui-maps");

/** User-override directory (repair agent can edit). */
const USER_UI_MAPS_DIR = join(homedir(), ".nbctl", "ui-maps");

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
 * Resolution order:
 * 1. User override: ~/.nbctl/ui-maps/{locale}.json (repair agent can edit)
 * 2. Bundled: UI_MAPS_DIR/{locale}.json
 * 3. Fallback: UI_MAPS_DIR/en.json
 */
export function loadUIMap(locale: string): UIMap {
  // 1. User override (repair agent can edit)
  const userPath = join(USER_UI_MAPS_DIR, `${locale}.json`);
  if (existsSync(userPath)) {
    return JSON.parse(readFileSync(userPath, "utf-8")) as UIMap;
  }

  // 2. Bundled locale
  const bundledPath = join(UI_MAPS_DIR, `${locale}.json`);
  if (existsSync(bundledPath)) {
    return JSON.parse(readFileSync(bundledPath, "utf-8")) as UIMap;
  }

  // 3. Fallback to English
  return JSON.parse(readFileSync(join(UI_MAPS_DIR, "en.json"), "utf-8")) as UIMap;
}
