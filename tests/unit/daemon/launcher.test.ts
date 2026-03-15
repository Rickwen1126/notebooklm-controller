import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

// Mock readFileSync before importing the module under test.
const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Mock daemon index (startDaemon / stopDaemon).
const mockStartDaemon = vi.fn();
const mockStopDaemon = vi.fn();
vi.mock("../../../src/daemon/index.js", () => ({
  startDaemon: (...args: unknown[]) => mockStartDaemon(...args),
  stopDaemon: (...args: unknown[]) => mockStopDaemon(...args),
}));

// Mock logger to suppress output.
vi.mock("../../../src/shared/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ── Import after mocks ──────────────────────────────────────────────

import {
  isProcessAlive,
  checkAlreadyRunning,
  launch,
} from "../../../src/daemon/launcher.js";
import { DaemonAlreadyRunningError } from "../../../src/shared/errors.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("launcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------
  // isProcessAlive
  // -------------------------------------------------------------------

  describe("isProcessAlive", () => {
    it("returns true for the current process PID", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a non-existent PID", () => {
      // PID 2^30 is extremely unlikely to exist.
      expect(isProcessAlive(2 ** 30)).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // checkAlreadyRunning
  // -------------------------------------------------------------------

  describe("checkAlreadyRunning", () => {
    it("does nothing when state file does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      // Should not throw.
      expect(() => checkAlreadyRunning()).not.toThrow();
    });

    it("does nothing when state file has null pid", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ pid: null, port: 19224 }),
      );

      expect(() => checkAlreadyRunning()).not.toThrow();
    });

    it("does nothing when state file has a dead PID", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ pid: 2 ** 30, port: 19224 }),
      );

      expect(() => checkAlreadyRunning()).not.toThrow();
    });

    it("throws DaemonAlreadyRunningError when PID is alive", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ pid: process.pid, port: 19224 }),
      );

      expect(() => checkAlreadyRunning()).toThrow(DaemonAlreadyRunningError);
    });

    it("includes port number in error", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ pid: process.pid, port: 12345 }),
      );

      try {
        checkAlreadyRunning();
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
        expect((err as DaemonAlreadyRunningError).port).toBe(12345);
      }
    });

    it("does nothing when state file contains invalid JSON", () => {
      mockReadFileSync.mockReturnValue("not json{{{");

      expect(() => checkAlreadyRunning()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // launch
  // -------------------------------------------------------------------

  describe("launch", () => {
    // Prevent actual signal handlers from leaking between tests.
    type SignalHandler = (...args: unknown[]) => void;
    const signalHandlers: Record<string, SignalHandler[]> = {};

    beforeEach(() => {
      signalHandlers.SIGTERM = [];
      signalHandlers.SIGINT = [];

      vi.spyOn(process, "on").mockImplementation(
        (event: string, handler: SignalHandler) => {
          if (event === "SIGTERM" || event === "SIGINT") {
            signalHandlers[event].push(handler);
          }
          return process;
        },
      );

      // Default: no state file (safe to start).
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("calls startDaemon with provided options", async () => {
      const runtime = { mcpServer: {}, tabManager: {} };
      mockStartDaemon.mockResolvedValue(runtime);

      await launch({ headless: false, chromePath: "/custom/chrome" });

      expect(mockStartDaemon).toHaveBeenCalledWith({
        headless: false,
        chromePath: "/custom/chrome",
      });
    });

    it("registers SIGTERM and SIGINT handlers", async () => {
      mockStartDaemon.mockResolvedValue({ mcpServer: {}, tabManager: {} });

      await launch();

      expect(signalHandlers.SIGTERM).toHaveLength(1);
      expect(signalHandlers.SIGINT).toHaveLength(1);
    });

    it("throws DaemonAlreadyRunningError if daemon is already running", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ pid: process.pid, port: 19224 }),
      );

      await expect(launch()).rejects.toThrow(DaemonAlreadyRunningError);
      expect(mockStartDaemon).not.toHaveBeenCalled();
    });

    it("calls stopDaemon when signal handler is invoked", async () => {
      const runtime = { mcpServer: {}, tabManager: {} };
      mockStartDaemon.mockResolvedValue(runtime);
      mockStopDaemon.mockResolvedValue(undefined);

      // Mock process.exit to prevent actually exiting.
      const mockExit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as never);

      await launch();

      // Simulate SIGTERM.
      expect(signalHandlers.SIGTERM).toHaveLength(1);
      await signalHandlers.SIGTERM[0]();

      expect(mockStopDaemon).toHaveBeenCalledWith(runtime);
      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
    });
  });
});
