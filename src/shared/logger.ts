/**
 * Structured JSON logger (FR-051)
 *
 * - Outputs one JSON object per line to stderr so stdout stays clean for MCP protocol.
 * - Also writes to ~/.nbctl/logs/daemon.log for debugging.
 * - Correlation fields (taskId, notebookAlias, actionType) propagate via context / child loggers.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".nbctl", "logs");
const LOG_FILE = join(LOG_DIR, "daemon.log");

// Ensure log directory exists (best-effort).
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

interface LogContext {
  taskId?: string;
  notebookAlias?: string;
  actionType?: string;
  [key: string]: unknown;
}

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  taskId?: string;
  notebookAlias?: string;
  actionType?: string;
  [key: string]: unknown;
}

class Logger {
  private context: LogContext;

  constructor(context?: LogContext) {
    this.context = context ?? {};
  }

  /** Create a child logger that inherits this logger's context merged with additional fields. */
  child(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }

  private get debugEnabled(): boolean {
    return process.env.NBCTL_DEBUG === "1" || process.env.NBCTL_DEBUG === "true";
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.debugEnabled) this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...data,
    };

    const line = JSON.stringify(entry) + "\n";

    // Write to stderr so stdout remains available for MCP Streamable HTTP traffic.
    process.stderr.write(line);

    // Also write to log file for debugging.
    try { appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  }
}

/** Default logger instance (no preset context). */
const logger = new Logger();

export { Logger, logger };
export type { LogContext, LogEntry };
