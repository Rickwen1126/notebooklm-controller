/**
 * CacheManager — per-notebook cache persistence for sources, artifacts, and operation logs.
 *
 * Storage layout: <baseDir>/<notebookAlias>/sources.json | artifacts.json | operations.json
 * Each file stores a JSON array. All writes use temp-file + rename for crash safety.
 * Directory permission: 700, file permission: 600.
 */

import { mkdir, readFile, writeFile, rename, chmod, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SourceRecord, ArtifactRecord, OperationLogEntry } from "../shared/types.js";
import { CACHE_DIR, DIR_PERMISSION, FILE_PERMISSION } from "../shared/config.js";
import { logger } from "../shared/logger.js";

class CacheManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? CACHE_DIR;
  }

  // ---------------------------------------------------------------------------
  // SourceRecord CRUD
  // ---------------------------------------------------------------------------

  async addSource(record: SourceRecord): Promise<void> {
    const filePath = this.sourcesPath(record.notebookAlias);
    const records = await this.loadArray<SourceRecord>(filePath);
    records.push(record);
    await this.atomicWrite(filePath, records);
  }

  async getSource(notebookAlias: string, id: string): Promise<SourceRecord | null> {
    const records = await this.loadArray<SourceRecord>(this.sourcesPath(notebookAlias));
    return records.find((r) => r.id === id) ?? null;
  }

  async listSources(
    notebookAlias: string,
    options?: { includeRemoved?: boolean },
  ): Promise<SourceRecord[]> {
    const records = await this.loadArray<SourceRecord>(this.sourcesPath(notebookAlias));
    if (options?.includeRemoved) {
      return records;
    }
    return records.filter((r) => r.removedAt === null);
  }

  async updateSource(
    notebookAlias: string,
    id: string,
    updates: Partial<SourceRecord>,
  ): Promise<void> {
    const filePath = this.sourcesPath(notebookAlias);
    const records = await this.loadArray<SourceRecord>(filePath);
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) {
      return;
    }
    records[index] = { ...records[index], ...updates };
    await this.atomicWrite(filePath, records);
  }

  async removeSource(notebookAlias: string, id: string): Promise<void> {
    const filePath = this.sourcesPath(notebookAlias);
    const records = await this.loadArray<SourceRecord>(filePath);
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) {
      return;
    }
    records[index] = { ...records[index], removedAt: new Date().toISOString() };
    await this.atomicWrite(filePath, records);
  }

  // ---------------------------------------------------------------------------
  // ArtifactRecord CRUD
  // ---------------------------------------------------------------------------

  async addArtifact(record: ArtifactRecord): Promise<void> {
    const filePath = this.artifactsPath(record.notebookAlias);
    const records = await this.loadArray<ArtifactRecord>(filePath);
    records.push(record);
    await this.atomicWrite(filePath, records);
  }

  async getArtifact(notebookAlias: string, id: string): Promise<ArtifactRecord | null> {
    const records = await this.loadArray<ArtifactRecord>(this.artifactsPath(notebookAlias));
    return records.find((r) => r.id === id) ?? null;
  }

  async listArtifacts(
    notebookAlias: string,
    options?: { includeRemoved?: boolean },
  ): Promise<ArtifactRecord[]> {
    const records = await this.loadArray<ArtifactRecord>(this.artifactsPath(notebookAlias));
    if (options?.includeRemoved) {
      return records;
    }
    return records.filter((r) => r.removedAt === null);
  }

  async removeArtifact(notebookAlias: string, id: string): Promise<void> {
    const filePath = this.artifactsPath(notebookAlias);
    const records = await this.loadArray<ArtifactRecord>(filePath);
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) {
      return;
    }
    records[index] = { ...records[index], removedAt: new Date().toISOString() };
    await this.atomicWrite(filePath, records);
  }

  // ---------------------------------------------------------------------------
  // OperationLogEntry CRUD
  // ---------------------------------------------------------------------------

  async addOperation(entry: OperationLogEntry): Promise<void> {
    const filePath = this.operationsPath(entry.notebookAlias);
    const entries = await this.loadArray<OperationLogEntry>(filePath);
    entries.push(entry);
    await this.atomicWrite(filePath, entries);
  }

  async listOperations(
    notebookAlias: string,
    options?: { limit?: number },
  ): Promise<OperationLogEntry[]> {
    const entries = await this.loadArray<OperationLogEntry>(this.operationsPath(notebookAlias));
    // Sort by startedAt descending (newest first)
    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (options?.limit !== undefined && options.limit > 0) {
      return entries.slice(0, options.limit);
    }
    return entries;
  }

  // ---------------------------------------------------------------------------
  // Internal: paths
  // ---------------------------------------------------------------------------

  private sourcesPath(alias: string): string {
    return join(this.baseDir, alias, "sources.json");
  }

  private artifactsPath(alias: string): string {
    return join(this.baseDir, alias, "artifacts.json");
  }

  private operationsPath(alias: string): string {
    return join(this.baseDir, alias, "operations.json");
  }

  // ---------------------------------------------------------------------------
  // Internal: file I/O
  // ---------------------------------------------------------------------------

  private async loadArray<T>(filePath: string): Promise<T[]> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as T[];
      }
      logger.warn("Cache file does not contain an array; returning empty", { path: filePath });
      return [];
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return [];
      }
      logger.warn("Corrupt or unreadable cache file; returning empty", {
        path: filePath,
        error: String(err),
      });
      return [];
    }
  }

  private async atomicWrite(filePath: string, data: unknown[]): Promise<void> {
    const dir = dirname(filePath);
    await this.ensureDirectory(dir);

    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await chmod(tmpPath, FILE_PERMISSION);
    await rename(tmpPath, filePath);
  }

  private async ensureDirectory(dir: string): Promise<void> {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) {
        throw new Error(`Path exists but is not a directory: ${dir}`);
      }
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

export { CacheManager };
