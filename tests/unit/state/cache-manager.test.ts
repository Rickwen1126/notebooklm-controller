import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheManager } from "../../../src/state/cache-manager.js";
import type {
  SourceRecord,
  ArtifactRecord,
  OperationLogEntry,
} from "../../../src/shared/types.js";
import { DIR_PERMISSION, FILE_PERMISSION } from "../../../src/shared/config.js";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSource(overrides?: Partial<SourceRecord>): SourceRecord {
  return {
    id: "src-1",
    notebookAlias: "nb-a",
    displayName: "My Source",
    expectedName: "My Source",
    renameStatus: "done",
    origin: { type: "url", path: null, url: "https://example.com", repomixConfig: null },
    wordCount: 1000,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    removedAt: null,
    ...overrides,
  };
}

function makeArtifact(overrides?: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    id: "art-1",
    notebookAlias: "nb-a",
    type: "audio",
    prompt: "Generate audio overview",
    localPath: null,
    duration: "5:30",
    size: "12MB",
    createdAt: "2026-01-01T00:00:00.000Z",
    removedAt: null,
    ...overrides,
  };
}

function makeOperation(overrides?: Partial<OperationLogEntry>): OperationLogEntry {
  return {
    id: "op-1",
    taskId: null,
    notebookAlias: "nb-a",
    command: "add-source",
    actionType: "add-source",
    status: "success",
    resultSummary: "Source added",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CacheManager", () => {
  let tmpDir: string;
  let manager: CacheManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nbctl-cache-test-"));
    manager = new CacheManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // SourceRecord CRUD
  // -------------------------------------------------------------------------

  describe("SourceRecord CRUD", () => {
    it("addSource + getSource round-trips correctly", async () => {
      const source = makeSource();
      await manager.addSource(source);

      const retrieved = await manager.getSource("nb-a", "src-1");
      expect(retrieved).toEqual(source);
    });

    it("getSource returns null for non-existent id", async () => {
      const result = await manager.getSource("nb-a", "no-such");
      expect(result).toBeNull();
    });

    it("listSources returns all non-removed sources", async () => {
      await manager.addSource(makeSource({ id: "s1" }));
      await manager.addSource(makeSource({ id: "s2" }));
      await manager.addSource(
        makeSource({ id: "s3", removedAt: "2026-01-02T00:00:00.000Z" }),
      );

      const list = await manager.listSources("nb-a");
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id)).toEqual(["s1", "s2"]);
    });

    it("listSources with includeRemoved returns all sources", async () => {
      await manager.addSource(makeSource({ id: "s1" }));
      await manager.addSource(
        makeSource({ id: "s2", removedAt: "2026-01-02T00:00:00.000Z" }),
      );

      const list = await manager.listSources("nb-a", { includeRemoved: true });
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id)).toEqual(["s1", "s2"]);
    });

    it("updateSource merges partial updates", async () => {
      await manager.addSource(makeSource({ id: "upd-1", wordCount: 100 }));

      await manager.updateSource("nb-a", "upd-1", {
        wordCount: 999,
        renameStatus: "failed",
      });

      const updated = await manager.getSource("nb-a", "upd-1");
      expect(updated?.wordCount).toBe(999);
      expect(updated?.renameStatus).toBe("failed");
      // Unchanged field preserved
      expect(updated?.displayName).toBe("My Source");
    });

    it("removeSource sets removedAt (soft delete)", async () => {
      await manager.addSource(makeSource({ id: "rm-1" }));

      await manager.removeSource("nb-a", "rm-1");

      const removed = await manager.getSource("nb-a", "rm-1");
      expect(removed).not.toBeNull();
      expect(removed!.removedAt).not.toBeNull();
      // Verify it's a valid ISO string
      expect(new Date(removed!.removedAt!).toISOString()).toBe(removed!.removedAt);

      // Default list excludes it
      const list = await manager.listSources("nb-a");
      expect(list).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ArtifactRecord CRUD
  // -------------------------------------------------------------------------

  describe("ArtifactRecord CRUD", () => {
    it("addArtifact + getArtifact round-trips correctly", async () => {
      const artifact = makeArtifact();
      await manager.addArtifact(artifact);

      const retrieved = await manager.getArtifact("nb-a", "art-1");
      expect(retrieved).toEqual(artifact);
    });

    it("getArtifact returns null for non-existent id", async () => {
      const result = await manager.getArtifact("nb-a", "no-such");
      expect(result).toBeNull();
    });

    it("listArtifacts excludes soft-deleted by default", async () => {
      await manager.addArtifact(makeArtifact({ id: "a1" }));
      await manager.addArtifact(
        makeArtifact({ id: "a2", removedAt: "2026-01-02T00:00:00.000Z" }),
      );

      const list = await manager.listArtifacts("nb-a");
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("a1");
    });

    it("removeArtifact sets removedAt (soft delete)", async () => {
      await manager.addArtifact(makeArtifact({ id: "rm-art" }));

      await manager.removeArtifact("nb-a", "rm-art");

      const removed = await manager.getArtifact("nb-a", "rm-art");
      expect(removed).not.toBeNull();
      expect(removed!.removedAt).not.toBeNull();

      // Default list excludes it
      const list = await manager.listArtifacts("nb-a");
      expect(list).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // OperationLogEntry
  // -------------------------------------------------------------------------

  describe("OperationLogEntry", () => {
    it("addOperation + listOperations round-trips correctly", async () => {
      const op = makeOperation();
      await manager.addOperation(op);

      const list = await manager.listOperations("nb-a");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(op);
    });

    it("listOperations returns sorted by startedAt desc", async () => {
      await manager.addOperation(
        makeOperation({ id: "op-old", startedAt: "2026-01-01T00:00:00.000Z" }),
      );
      await manager.addOperation(
        makeOperation({ id: "op-new", startedAt: "2026-01-03T00:00:00.000Z" }),
      );
      await manager.addOperation(
        makeOperation({ id: "op-mid", startedAt: "2026-01-02T00:00:00.000Z" }),
      );

      const list = await manager.listOperations("nb-a");
      expect(list.map((o) => o.id)).toEqual(["op-new", "op-mid", "op-old"]);
    });

    it("listOperations respects limit option", async () => {
      await manager.addOperation(
        makeOperation({ id: "op-1", startedAt: "2026-01-01T00:00:00.000Z" }),
      );
      await manager.addOperation(
        makeOperation({ id: "op-2", startedAt: "2026-01-02T00:00:00.000Z" }),
      );
      await manager.addOperation(
        makeOperation({ id: "op-3", startedAt: "2026-01-03T00:00:00.000Z" }),
      );

      const list = await manager.listOperations("nb-a", { limit: 2 });
      expect(list).toHaveLength(2);
      expect(list.map((o) => o.id)).toEqual(["op-3", "op-2"]);
    });
  });

  // -------------------------------------------------------------------------
  // File creation / directory auto-creation
  // -------------------------------------------------------------------------

  describe("file creation", () => {
    it("auto-creates cache directory for notebook alias", async () => {
      await manager.addSource(makeSource({ notebookAlias: "new-nb" }));

      const dirInfo = await stat(join(tmpDir, "new-nb"));
      expect(dirInfo.isDirectory()).toBe(true);
    });

    it("creates directory with DIR_PERMISSION (700)", async () => {
      await manager.addSource(makeSource({ notebookAlias: "perm-nb" }));

      const dirInfo = await stat(join(tmpDir, "perm-nb"));
      const mode = dirInfo.mode & 0o777;
      expect(mode).toBe(DIR_PERMISSION);
    });

    it("creates file with FILE_PERMISSION (600)", async () => {
      await manager.addSource(makeSource({ notebookAlias: "file-perm-nb" }));

      const filePath = join(tmpDir, "file-perm-nb", "sources.json");
      const fileInfo = await stat(filePath);
      const mode = fileInfo.mode & 0o777;
      expect(mode).toBe(FILE_PERMISSION);
    });

    it("returns empty array when file does not exist", async () => {
      const sources = await manager.listSources("nonexistent");
      expect(sources).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple notebooks isolation
  // -------------------------------------------------------------------------

  describe("multiple notebooks", () => {
    it("operations are isolated per notebook alias", async () => {
      await manager.addSource(makeSource({ id: "s1", notebookAlias: "nb-x" }));
      await manager.addSource(makeSource({ id: "s2", notebookAlias: "nb-y" }));
      await manager.addArtifact(makeArtifact({ id: "a1", notebookAlias: "nb-x" }));
      await manager.addOperation(makeOperation({ id: "op1", notebookAlias: "nb-y" }));

      const xSources = await manager.listSources("nb-x");
      const ySources = await manager.listSources("nb-y");
      const xArtifacts = await manager.listArtifacts("nb-x");
      const yArtifacts = await manager.listArtifacts("nb-y");
      const xOps = await manager.listOperations("nb-x");
      const yOps = await manager.listOperations("nb-y");

      expect(xSources).toHaveLength(1);
      expect(xSources[0].id).toBe("s1");
      expect(ySources).toHaveLength(1);
      expect(ySources[0].id).toBe("s2");
      expect(xArtifacts).toHaveLength(1);
      expect(yArtifacts).toHaveLength(0);
      expect(xOps).toHaveLength(0);
      expect(yOps).toHaveLength(1);
    });

    it("each notebook has separate JSON files", async () => {
      await manager.addSource(makeSource({ notebookAlias: "iso-a" }));
      await manager.addSource(makeSource({ notebookAlias: "iso-b" }));

      const rawA = await readFile(join(tmpDir, "iso-a", "sources.json"), "utf-8");
      const rawB = await readFile(join(tmpDir, "iso-b", "sources.json"), "utf-8");

      const parsedA = JSON.parse(rawA) as SourceRecord[];
      const parsedB = JSON.parse(rawB) as SourceRecord[];

      expect(parsedA).toHaveLength(1);
      expect(parsedB).toHaveLength(1);
      expect(parsedA[0].notebookAlias).toBe("iso-a");
      expect(parsedB[0].notebookAlias).toBe("iso-b");
    });
  });
});
