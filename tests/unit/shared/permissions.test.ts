/**
 * T104: Unit tests for file permission enforcement.
 *
 * Tests enforcePermissions(): directory creation, permission fixing,
 * recursive walk of subdirectories and files.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
}));

// Mock config
vi.mock("../../../src/shared/config.js", () => ({
  NBCTL_HOME: "/home/testuser/.nbctl",
  DIR_PERMISSION: 0o700,
  FILE_PERMISSION: 0o600,
}));

// Mock logger
vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

import { stat, chmod, mkdir, readdir } from "node:fs/promises";
import { enforcePermissions } from "../../../src/shared/permissions.js";

const mockStat = vi.mocked(stat);
const mockChmod = vi.mocked(chmod);
const mockMkdir = vi.mocked(mkdir);
const mockReaddir = vi.mocked(readdir);

// Helper to create a mock stat result
function mockStatResult(opts: { isDir: boolean; mode: number }) {
  return {
    isDirectory: () => opts.isDir,
    isFile: () => !opts.isDir,
    mode: opts.mode,
  } as unknown as Awaited<ReturnType<typeof stat>>;
}

// Helper to create mock dirent
function mockDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

describe("enforcePermissions", () => {
  const ROOT = "/home/testuser/.nbctl";

  beforeEach(() => {
    vi.clearAllMocks();
    mockChmod.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it("creates root directory with 0o700 when it does not exist", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockStat.mockRejectedValue(enoent);

    await enforcePermissions(ROOT);

    expect(mockMkdir).toHaveBeenCalledWith(ROOT, {
      mode: 0o700,
      recursive: true,
    });
  });

  it("does not walk if root was just created", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockStat.mockRejectedValue(enoent);

    await enforcePermissions(ROOT);

    // readdir should not be called since directory was just created
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("fixes root directory permissions when wrong", async () => {
    // Root dir exists with 0o755 (too open)
    mockStat.mockResolvedValue(mockStatResult({ isDir: true, mode: 0o40755 }));
    mockReaddir.mockResolvedValue([] as any);

    await enforcePermissions(ROOT);

    expect(mockChmod).toHaveBeenCalledWith(ROOT, 0o700);
  });

  it("does not chmod root directory when permissions are correct", async () => {
    mockStat.mockResolvedValue(mockStatResult({ isDir: true, mode: 0o40700 }));
    mockReaddir.mockResolvedValue([] as any);

    await enforcePermissions(ROOT);

    expect(mockChmod).not.toHaveBeenCalled();
  });

  it("fixes file permissions from 0o644 to 0o600", async () => {
    // Root dir is ok
    mockStat
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40700 }))
      // File with wrong permissions
      .mockResolvedValueOnce(mockStatResult({ isDir: false, mode: 0o100644 }));

    mockReaddir.mockResolvedValue([
      mockDirent("state.json", false),
    ] as any);

    await enforcePermissions(ROOT);

    expect(mockChmod).toHaveBeenCalledWith(
      join(ROOT, "state.json"),
      0o600,
    );
  });

  it("fixes subdirectory permissions from 0o755 to 0o700", async () => {
    // Root dir is ok
    mockStat
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40700 }))
      // Subdir with wrong permissions
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40755 }));

    mockReaddir
      // Root readdir
      .mockResolvedValueOnce([mockDirent("cache", true)] as any)
      // Subdir readdir (empty)
      .mockResolvedValueOnce([] as any);

    await enforcePermissions(ROOT);

    expect(mockChmod).toHaveBeenCalledWith(join(ROOT, "cache"), 0o700);
  });

  it("recursively walks nested directories", async () => {
    // Root dir is ok
    mockStat
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40700 }))
      // cache/ subdir ok
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40700 }))
      // cache/notebook/ subdir wrong
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40755 }))
      // cache/notebook/sources.json file wrong
      .mockResolvedValueOnce(mockStatResult({ isDir: false, mode: 0o100644 }));

    mockReaddir
      // Root has cache/
      .mockResolvedValueOnce([mockDirent("cache", true)] as any)
      // cache/ has notebook/
      .mockResolvedValueOnce([mockDirent("notebook", true)] as any)
      // cache/notebook/ has sources.json
      .mockResolvedValueOnce([mockDirent("sources.json", false)] as any);

    await enforcePermissions(ROOT);

    expect(mockChmod).toHaveBeenCalledWith(
      join(ROOT, "cache", "notebook"),
      0o700,
    );
    expect(mockChmod).toHaveBeenCalledWith(
      join(ROOT, "cache", "notebook", "sources.json"),
      0o600,
    );
  });

  it("skips files already with correct permissions (0o600)", async () => {
    mockStat
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40700 }))
      .mockResolvedValueOnce(mockStatResult({ isDir: false, mode: 0o100600 }));

    mockReaddir.mockResolvedValue([
      mockDirent("state.json", false),
    ] as any);

    await enforcePermissions(ROOT);

    expect(mockChmod).not.toHaveBeenCalled();
  });

  it("throws when root path exists but is not a directory", async () => {
    mockStat.mockResolvedValue(mockStatResult({ isDir: false, mode: 0o100644 }));

    await expect(enforcePermissions(ROOT)).rejects.toThrow(
      "exists but is not a directory",
    );
  });

  it("re-throws unexpected errors from stat", async () => {
    const eperm = new Error("EPERM") as NodeJS.ErrnoException;
    eperm.code = "EPERM";
    mockStat.mockRejectedValue(eperm);

    await expect(enforcePermissions(ROOT)).rejects.toThrow("EPERM");
  });

  it("handles stat errors on individual entries gracefully (skips)", async () => {
    mockStat
      .mockResolvedValueOnce(mockStatResult({ isDir: true, mode: 0o40700 }))
      // First entry stat fails (file removed between readdir and stat)
      .mockRejectedValueOnce(new Error("ENOENT"))
      // Second entry is fine
      .mockResolvedValueOnce(mockStatResult({ isDir: false, mode: 0o100644 }));

    mockReaddir.mockResolvedValue([
      mockDirent("removed.json", false),
      mockDirent("state.json", false),
    ] as any);

    // Should not throw
    await enforcePermissions(ROOT);

    // Only the second file should be fixed
    expect(mockChmod).toHaveBeenCalledTimes(1);
    expect(mockChmod).toHaveBeenCalledWith(
      join(ROOT, "state.json"),
      0o600,
    );
  });
});
