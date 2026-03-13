import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the SDK module before importing the module under test.
// We simulate the CopilotClient from @github/copilot-sdk.
// ---------------------------------------------------------------------------

/** Fake process-exit callback captured during construction. */
let onProcessExitCallback: (() => void) | null = null;

const mockStart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockStop = vi
  .fn<() => Promise<Error[]>>()
  .mockResolvedValue([]);
const mockForceStop = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const mockGetState = vi
  .fn<() => string>()
  .mockReturnValue("disconnected");
const mockCreateSession = vi.fn();
const mockPing = vi.fn();

class FakeCopilotClient {
  options: Record<string, unknown>;

  constructor(options?: Record<string, unknown>) {
    this.options = options ?? {};
  }

  start = mockStart;
  stop = mockStop;
  forceStop = mockForceStop;
  getState = mockGetState;
  createSession = mockCreateSession;
  ping = mockPing;
  on = vi.fn().mockReturnValue(() => {});
}

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: FakeCopilotClient,
}));

// Import after mock is set up.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let CopilotClientSingleton: typeof import("../../../src/agent/client.js").CopilotClientSingleton;

beforeEach(async () => {
  // Dynamic import to get a fresh module per test file.
  const mod = await import("../../../src/agent/client.js");
  CopilotClientSingleton = mod.CopilotClientSingleton;

  // Always reset the singleton between tests.
  CopilotClientSingleton.resetInstance();

  // Reset all mocks.
  vi.clearAllMocks();
  mockGetState.mockReturnValue("disconnected");
  onProcessExitCallback = null;
});

afterEach(() => {
  CopilotClientSingleton.resetInstance();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CopilotClientSingleton", () => {
  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const a = CopilotClientSingleton.getInstance();
      const b = CopilotClientSingleton.getInstance();
      expect(a).toBe(b);
    });

    it("should return same instance across multiple calls", () => {
      const instances = Array.from({ length: 5 }, () =>
        CopilotClientSingleton.getInstance(),
      );
      for (const inst of instances) {
        expect(inst).toBe(instances[0]);
      }
    });
  });

  describe("resetInstance", () => {
    it("should create a fresh instance after reset", () => {
      const first = CopilotClientSingleton.getInstance();
      CopilotClientSingleton.resetInstance();
      const second = CopilotClientSingleton.getInstance();
      expect(first).not.toBe(second);
    });
  });

  describe("start", () => {
    it("should initialize the underlying client", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState.mockReturnValue("connected");

      await client.start();

      expect(mockStart).toHaveBeenCalledOnce();
      expect(client.isRunning()).toBe(true);
    });

    it("should throw if start is called twice without stop", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState.mockReturnValue("connected");

      await client.start();

      await expect(client.start()).rejects.toThrow(
        /already running/i,
      );
    });
  });

  describe("stop", () => {
    it("should clean up the underlying client", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState
        .mockReturnValueOnce("connected") // after start
        .mockReturnValue("disconnected"); // after stop

      await client.start();
      await client.stop();

      expect(mockStop).toHaveBeenCalledOnce();
      expect(client.isRunning()).toBe(false);
    });

    it("should allow start again after stop", async () => {
      const client = CopilotClientSingleton.getInstance();

      // First cycle: start → stop
      mockGetState.mockReturnValue("connected");
      await client.start();
      mockGetState.mockReturnValue("disconnected");
      await client.stop();

      // Second cycle: start again
      mockGetState.mockReturnValue("connected");
      await client.start();

      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(client.isRunning()).toBe(true);
    });

    it("should be a no-op if not running", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState.mockReturnValue("disconnected");

      // Should not throw.
      await client.stop();
      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe("isRunning", () => {
    it("should return false before start", () => {
      const client = CopilotClientSingleton.getInstance();
      expect(client.isRunning()).toBe(false);
    });

    it("should return true after start", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState.mockReturnValue("connected");
      await client.start();
      expect(client.isRunning()).toBe(true);
    });
  });

  describe("getClient", () => {
    it("should return the underlying SDK client after start", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState.mockReturnValue("connected");
      await client.start();

      const underlying = client.getClient();
      expect(underlying).toBeDefined();
      // Verify it has the expected SDK methods.
      expect(typeof underlying.createSession).toBe("function");
      expect(typeof underlying.getState).toBe("function");
    });

    it("should throw if accessed before start", () => {
      const client = CopilotClientSingleton.getInstance();
      expect(() => client.getClient()).toThrow(/not running/i);
    });
  });

  describe("autoRestart", () => {
    it("should restart the client when it exits unexpectedly", async () => {
      const client = CopilotClientSingleton.getInstance();

      // Simulate: start succeeds, then process exits, triggering auto-restart.
      mockGetState.mockReturnValue("connected");
      await client.start();
      expect(mockStart).toHaveBeenCalledOnce();

      // Simulate the underlying client disconnecting unexpectedly.
      // Our implementation polls getState or uses the SDK's event system.
      // We simulate by changing state to "disconnected" and triggering
      // the restart check.
      mockGetState.mockReturnValue("disconnected");

      // Trigger the restart logic.
      await client._handleUnexpectedExit();

      // The SDK client.start() should have been called again.
      expect(mockStart).toHaveBeenCalledTimes(2);
    });

    it("should not restart when stop is called intentionally", async () => {
      const client = CopilotClientSingleton.getInstance();
      mockGetState.mockReturnValue("connected");
      await client.start();

      mockGetState.mockReturnValue("disconnected");
      await client.stop();

      // After intentional stop, start should not have been called again.
      expect(mockStart).toHaveBeenCalledOnce();
    });
  });
});
