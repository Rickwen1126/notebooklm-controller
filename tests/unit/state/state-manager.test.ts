import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager, createDefaultState } from "../../../src/state/state-manager.js";
import type { DaemonState, NotebookEntry } from "../../../src/shared/types.js";
import { NotebookNotFoundError } from "../../../src/shared/errors.js";
import { FILE_PERMISSION, DIR_PERMISSION } from "../../../src/shared/config.js";

function makeNotebookEntry(alias: string): NotebookEntry {
  return {
    alias,
    url: `https://notebooklm.google.com/notebook/${alias}`,
    title: `Test Notebook ${alias}`,
    description: "A test notebook",
    active: true,
    status: "ready",
    registeredAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    sourceCount: 0,
  };
}

describe("StateManager", () => {
  let tmpDir: string;
  let statePath: string;
  let manager: StateManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nbctl-test-"));
    statePath = join(tmpDir, "subdir", "state.json");
    manager = new StateManager(statePath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  describe("load", () => {
    it("returns persisted state from file", async () => {
      const state = createDefaultState();
      state.pid = 1234;
      state.startedAt = "2026-01-01T00:00:00.000Z";

      await mkdir(join(tmpDir, "subdir"), { recursive: true });
      await writeFile(statePath, JSON.stringify(state), "utf-8");

      const loaded = await manager.load();
      expect(loaded).toEqual(state);
    });

    it("returns default state when file does not exist", async () => {
      const loaded = await manager.load();
      expect(loaded).toEqual(createDefaultState());
    });

    it("returns default state with warning on corrupt JSON", async () => {
      await mkdir(join(tmpDir, "subdir"), { recursive: true });
      await writeFile(statePath, "NOT-VALID-JSON!!!", "utf-8");

      const loaded = await manager.load();
      expect(loaded).toEqual(createDefaultState());
    });
  });

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  describe("save", () => {
    it("writes state atomically via temp + rename", async () => {
      const state = createDefaultState();
      state.pid = 42;

      await manager.save(state);

      const raw = await readFile(statePath, "utf-8");
      expect(JSON.parse(raw)).toEqual(state);
    });

    it("creates parent directory if it does not exist", async () => {
      const deepPath = join(tmpDir, "a", "b", "state.json");
      const deepManager = new StateManager(deepPath);

      await deepManager.save(createDefaultState());

      const info = await stat(join(tmpDir, "a", "b"));
      expect(info.isDirectory()).toBe(true);
    });

    it("enforces file permission 600", async () => {
      await manager.save(createDefaultState());

      const info = await stat(statePath);
      const mode = info.mode & 0o777;
      expect(mode).toBe(FILE_PERMISSION);
    });

    it("enforces directory permission 700", async () => {
      await manager.save(createDefaultState());

      const dirInfo = await stat(join(tmpDir, "subdir"));
      const mode = dirInfo.mode & 0o777;
      expect(mode).toBe(DIR_PERMISSION);
    });
  });

  // -------------------------------------------------------------------------
  // Notebook CRUD
  // -------------------------------------------------------------------------

  describe("notebook CRUD", () => {
    it("addNotebook + getNotebook round-trips correctly", async () => {
      const entry = makeNotebookEntry("my-nb");
      await manager.addNotebook(entry);

      const retrieved = await manager.getNotebook("my-nb");
      expect(retrieved).toEqual(entry);
    });

    it("getNotebook returns undefined for non-existent alias", async () => {
      const result = await manager.getNotebook("nope");
      expect(result).toBeUndefined();
    });

    it("updateNotebook merges partial updates", async () => {
      const entry = makeNotebookEntry("upd");
      await manager.addNotebook(entry);

      await manager.updateNotebook("upd", { sourceCount: 5, status: "operating" });

      const updated = await manager.getNotebook("upd");
      expect(updated?.sourceCount).toBe(5);
      expect(updated?.status).toBe("operating");
      // Unchanged field preserved
      expect(updated?.title).toBe(entry.title);
    });

    it("updateNotebook throws NotebookNotFoundError for missing alias", async () => {
      await expect(
        manager.updateNotebook("missing", { sourceCount: 1 }),
      ).rejects.toThrow(NotebookNotFoundError);
    });

    it("removeNotebook deletes the entry", async () => {
      const entry = makeNotebookEntry("rm-me");
      await manager.addNotebook(entry);
      await manager.removeNotebook("rm-me");

      const result = await manager.getNotebook("rm-me");
      expect(result).toBeUndefined();
    });

    it("removeNotebook throws NotebookNotFoundError for missing alias", async () => {
      await expect(manager.removeNotebook("ghost")).rejects.toThrow(
        NotebookNotFoundError,
      );
    });

    it("removeNotebook clears defaultNotebook if it matches", async () => {
      const entry = makeNotebookEntry("default-nb");
      await manager.addNotebook(entry);
      await manager.setDefault("default-nb");

      await manager.removeNotebook("default-nb");

      const state = await manager.load();
      expect(state.defaultNotebook).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Default notebook
  // -------------------------------------------------------------------------

  describe("setDefault", () => {
    it("sets the default notebook alias", async () => {
      const entry = makeNotebookEntry("def");
      await manager.addNotebook(entry);
      await manager.setDefault("def");

      const state = await manager.load();
      expect(state.defaultNotebook).toBe("def");
    });

    it("clears default when set to null", async () => {
      const entry = makeNotebookEntry("def2");
      await manager.addNotebook(entry);
      await manager.setDefault("def2");
      await manager.setDefault(null);

      const state = await manager.load();
      expect(state.defaultNotebook).toBeNull();
    });

    it("throws NotebookNotFoundError when alias does not exist", async () => {
      await expect(manager.setDefault("no-such")).rejects.toThrow(
        NotebookNotFoundError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Daemon metadata
  // -------------------------------------------------------------------------

  describe("updateDaemon", () => {
    it("updates pid and startedAt", async () => {
      const now = new Date().toISOString();
      await manager.updateDaemon({ pid: 9999, startedAt: now });

      const state = await manager.load();
      expect(state.pid).toBe(9999);
      expect(state.startedAt).toBe(now);
    });

    it("updates port", async () => {
      await manager.updateDaemon({ port: 3000 });

      const state = await manager.load();
      expect(state.port).toBe(3000);
    });

    it("clears pid and startedAt with null", async () => {
      await manager.updateDaemon({ pid: 100, startedAt: "2026-01-01T00:00:00Z" });
      await manager.updateDaemon({ pid: null, startedAt: null });

      const state = await manager.load();
      expect(state.pid).toBeNull();
      expect(state.startedAt).toBeNull();
    });

    it("does not alter fields that are not provided", async () => {
      await manager.updateDaemon({ pid: 42, port: 8080 });
      await manager.updateDaemon({ pid: 99 });

      const state = await manager.load();
      expect(state.pid).toBe(99);
      expect(state.port).toBe(8080); // unchanged
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent mutation safety (write mutex)
  // -------------------------------------------------------------------------

  describe("concurrent mutation safety", () => {
    it("two concurrent addNotebook calls both persist", async () => {
      const entryA = makeNotebookEntry("nb-a");
      const entryB = makeNotebookEntry("nb-b");

      // Fire both without awaiting — they run concurrently
      await Promise.all([
        manager.addNotebook(entryA),
        manager.addNotebook(entryB),
      ]);

      const state = await manager.load();
      expect(state.notebooks["nb-a"]).toEqual(entryA);
      expect(state.notebooks["nb-b"]).toEqual(entryB);
    });

    it("concurrent updateDaemon + addNotebook both persist", async () => {
      const entry = makeNotebookEntry("nb-c");

      await Promise.all([
        manager.updateDaemon({ pid: 7777, port: 5555 }),
        manager.addNotebook(entry),
      ]);

      const state = await manager.load();
      expect(state.pid).toBe(7777);
      expect(state.port).toBe(5555);
      expect(state.notebooks["nb-c"]).toEqual(entry);
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  describe("crash recovery", () => {
    it("returns default state when file contains partial JSON", async () => {
      await mkdir(join(tmpDir, "subdir"), { recursive: true });
      await writeFile(statePath, '{"version":1, "pid":', "utf-8");

      const loaded = await manager.load();
      expect(loaded).toEqual(createDefaultState());
    });

    it("returns default state when file is empty", async () => {
      await mkdir(join(tmpDir, "subdir"), { recursive: true });
      await writeFile(statePath, "", "utf-8");

      const loaded = await manager.load();
      expect(loaded).toEqual(createDefaultState());
    });
  });
});
