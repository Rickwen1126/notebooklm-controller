import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const NBCTL_HOME = join(homedir(), ".nbctl");
export const STATE_FILE = join(NBCTL_HOME, "state.json");
export const TASKS_DIR = join(NBCTL_HOME, "tasks");
export const CACHE_DIR = join(NBCTL_HOME, "cache");
export const PROFILES_DIR = join(NBCTL_HOME, "profiles");
export const LOGS_DIR = join(NBCTL_HOME, "logs");
export const TMP_DIR = join(NBCTL_HOME, "tmp");

// Agent configs directories (checked in order, first existing one wins).
// User-local override > project bundled.
export const AGENTS_DIR_USER = join(NBCTL_HOME, "agents");
export const AGENTS_DIR_BUNDLED = join(process.cwd(), "agents");

// ---------------------------------------------------------------------------
// Per-notebook cache paths (factory functions)
// ---------------------------------------------------------------------------

export function notebookCacheDir(alias: string): string {
  return join(CACHE_DIR, alias);
}

export function sourcesFile(alias: string): string {
  return join(CACHE_DIR, alias, "sources.json");
}

export function artifactsFile(alias: string): string {
  return join(CACHE_DIR, alias, "artifacts.json");
}

export function operationsFile(alias: string): string {
  return join(CACHE_DIR, alias, "operations.json");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const MCP_PORT = 19224 as const;
export const MCP_HOST = "127.0.0.1" as const;

// ---------------------------------------------------------------------------
// TabManager
// ---------------------------------------------------------------------------

export const MAX_TABS = 10 as const;

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

export const DIR_PERMISSION = 0o700 as const;
export const FILE_PERMISSION = 0o600 as const;

// ---------------------------------------------------------------------------
// Timeouts (initial values, to be tuned after testing)
// ---------------------------------------------------------------------------

export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000 as const; // 2 min
export const DEFAULT_SESSION_TIMEOUT_MS = 300_000 as const; // 5 min

// ---------------------------------------------------------------------------
// NetworkGate
// ---------------------------------------------------------------------------

export const BACKOFF_INITIAL_MS = 5_000 as const;
export const BACKOFF_MAX_MS = 300_000 as const; // 5 min

// ---------------------------------------------------------------------------
// Content limits
// ---------------------------------------------------------------------------

export const CONTENT_WORD_LIMIT = 500_000 as const;

// ---------------------------------------------------------------------------
// Chrome path discovery for macOS
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

export function findChromePath(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// NotebookLM URL validation
// ---------------------------------------------------------------------------

export const NOTEBOOKLM_URL_PATTERN =
  /^https:\/\/notebooklm\.google\.com\/notebook\/.+/;

export function isValidNotebookUrl(url: string): boolean {
  return NOTEBOOKLM_URL_PATTERN.test(url);
}

// ---------------------------------------------------------------------------
// Agent model
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_MODEL = "gpt-4.1" as const;
