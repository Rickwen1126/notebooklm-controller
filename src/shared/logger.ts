/**
 * Structured JSON logger (FR-051)
 *
 * - Outputs one JSON object per line to stderr so stdout stays clean for MCP protocol.
 * - Correlation fields (taskId, notebookAlias, actionType) propagate via context / child loggers.
 */

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
  private debugEnabled: boolean;

  constructor(context?: LogContext) {
    this.context = context ?? {};
    this.debugEnabled = process.env.NBCTL_DEBUG === "1" || process.env.NBCTL_DEBUG === "true";
  }

  /** Create a child logger that inherits this logger's context merged with additional fields. */
  child(context: LogContext): Logger {
    const child = new Logger({ ...this.context, ...context });
    child.debugEnabled = this.debugEnabled;
    return child;
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

    // Write to stderr so stdout remains available for MCP Streamable HTTP traffic.
    process.stderr.write(JSON.stringify(entry) + "\n");
  }
}

/** Default logger instance (no preset context). */
const logger = new Logger();

export { Logger, logger };
export type { LogContext, LogEntry };
