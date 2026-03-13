/**
 * StateManager — persistent daemon state with atomic writes.
 *
 * State is stored at ~/.nbctl/state.json (configurable via constructor).
 * All writes use a temp-file + rename pattern for crash safety.
 * Directory permission: 700, file permission: 600.
 */

import { mkdir, readFile, writeFile, rename, chmod, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { DaemonState, NotebookEntry } from "../shared/types.js";
import { STATE_FILE, DIR_PERMISSION, FILE_PERMISSION } from "../shared/config.js";
import { NotebookNotFoundError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

function createDefaultState(): DaemonState {
  return {
    version: 1,
    defaultNotebook: null,
    pid: null,
    port: 19224,
    startedAt: null,
    notebooks: {},
  };
}

class StateManager {
  private readonly statePath: string;

  constructor(statePath?: string) {
    this.statePath = statePath ?? STATE_FILE;
  }

  // ---------------------------------------------------------------------------
  // Core I/O
  // ---------------------------------------------------------------------------

  async load(): Promise<DaemonState> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      return JSON.parse(raw) as DaemonState;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return createDefaultState();
      }
      logger.warn("Corrupt or unreadable state file; returning default state", {
        path: this.statePath,
        error: String(err),
      });
      return createDefaultState();
    }
  }

  async save(state: DaemonState): Promise<void> {
    const dir = dirname(this.statePath);
    await this.ensureDirectory(dir);

    const tmpPath = this.statePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await chmod(tmpPath, FILE_PERMISSION);
    await rename(tmpPath, this.statePath);
  }

  // ---------------------------------------------------------------------------
  // Notebook CRUD
  // ---------------------------------------------------------------------------

  getNotebook(alias: string): Promise<NotebookEntry | undefined> {
    return this.load().then((s) => s.notebooks[alias]);
  }

  async addNotebook(entry: NotebookEntry): Promise<void> {
    const state = await this.load();
    state.notebooks[entry.alias] = entry;
    await this.save(state);
  }

  async updateNotebook(alias: string, updates: Partial<NotebookEntry>): Promise<void> {
    const state = await this.load();
    const existing = state.notebooks[alias];
    if (!existing) {
      throw new NotebookNotFoundError(alias);
    }
    state.notebooks[alias] = { ...existing, ...updates };
    await this.save(state);
  }

  async removeNotebook(alias: string): Promise<void> {
    const state = await this.load();
    if (!state.notebooks[alias]) {
      throw new NotebookNotFoundError(alias);
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete state.notebooks[alias];
    if (state.defaultNotebook === alias) {
      state.defaultNotebook = null;
    }
    await this.save(state);
  }

  // ---------------------------------------------------------------------------
  // Default notebook
  // ---------------------------------------------------------------------------

  async setDefault(alias: string | null): Promise<void> {
    const state = await this.load();
    if (alias !== null && !state.notebooks[alias]) {
      throw new NotebookNotFoundError(alias);
    }
    state.defaultNotebook = alias;
    await this.save(state);
  }

  // ---------------------------------------------------------------------------
  // Daemon metadata
  // ---------------------------------------------------------------------------

  async updateDaemon(updates: {
    pid?: number | null;
    startedAt?: string | null;
    port?: number;
  }): Promise<void> {
    const state = await this.load();
    if (updates.pid !== undefined) state.pid = updates.pid;
    if (updates.startedAt !== undefined) state.startedAt = updates.startedAt;
    if (updates.port !== undefined) state.port = updates.port;
    await this.save(state);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async ensureDirectory(dir: string): Promise<void> {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) {
        throw new Error(`Path exists but is not a directory: ${dir}`);
      }
      // Ensure correct permissions on existing directory
      const mode = info.mode & 0o777;
      if (mode !== DIR_PERMISSION) {
        await chmod(dir, DIR_PERMISSION);
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        await mkdir(dir, { recursive: true, mode: DIR_PERMISSION });
        return;
      }
      throw err;
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export { StateManager, createDefaultState };
