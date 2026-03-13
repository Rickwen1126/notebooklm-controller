/**
 * Unified error module for notebooklm-controller.
 * All domain errors extend NbctlError for consistent handling and serialization.
 */

export class NbctlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }

  toJSON(): { success: false; error: string } {
    return { success: false, error: this.message };
  }
}

export class ChromeError extends NbctlError {
  constructor(message = "Chrome launch or connection failed") {
    super("CHROME_ERROR", message);
  }
}

export class NotebookNotFoundError extends NbctlError {
  readonly alias: string;

  constructor(alias: string) {
    super("NOTEBOOK_NOT_FOUND", `Notebook not found: "${alias}"`);
    this.alias = alias;
  }
}

export class AuthExpiredError extends NbctlError {
  constructor(message = "Google session expired; re-authentication required") {
    super("AUTH_EXPIRED", message);
  }
}

export class TabLimitError extends NbctlError {
  readonly maxTabs: number;

  constructor(maxTabs: number) {
    super("TAB_LIMIT_REACHED", `Tab limit reached: maximum ${maxTabs} tabs allowed`);
    this.maxTabs = maxTabs;
  }
}

export class InvalidUrlError extends NbctlError {
  readonly url: string;

  constructor(url: string) {
    super("INVALID_URL", `Invalid NotebookLM URL: "${url}"`);
    this.url = url;
  }
}

export class ContentTooLargeError extends NbctlError {
  readonly wordCount: number;
  readonly limit: number;

  constructor(wordCount: number, limit: number) {
    super(
      "CONTENT_TOO_LARGE",
      `Content too large: ${wordCount} words exceeds the ${limit}-word limit`,
    );
    this.wordCount = wordCount;
    this.limit = limit;
  }
}

export class TaskNotFoundError extends NbctlError {
  readonly taskId: string;

  constructor(taskId: string) {
    super("TASK_NOT_FOUND", `Task not found: "${taskId}"`);
    this.taskId = taskId;
  }
}

export class DaemonAlreadyRunningError extends NbctlError {
  readonly port: number;

  constructor(port: number) {
    super("DAEMON_ALREADY_RUNNING", `Daemon is already running on port ${port}`);
    this.port = port;
  }
}
