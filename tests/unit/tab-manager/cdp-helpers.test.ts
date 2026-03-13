import { describe, it, expect, vi } from "vitest";
import {
  captureScreenshot,
  dispatchClick,
  dispatchType,
  dispatchScroll,
  dispatchPaste,
} from "../../../src/tab-manager/cdp-helpers.js";

function createMockCDPSession() {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    send: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "Page.captureScreenshot") {
        return { data: "base64screenshotdata" };
      }
      return {};
    }),
    calls,
  };
}

describe("cdp-helpers", () => {
  describe("captureScreenshot", () => {
    it("sends Page.captureScreenshot and returns base64 data", async () => {
      const cdp = createMockCDPSession();

      const result = await captureScreenshot(cdp as never);

      expect(result).toBe("base64screenshotdata");
      expect(cdp.send).toHaveBeenCalledWith("Page.captureScreenshot", {
        format: "png",
      });
    });

    it("passes format and quality options", async () => {
      const cdp = createMockCDPSession();

      await captureScreenshot(cdp as never, {
        format: "jpeg",
        quality: 80,
      });

      expect(cdp.send).toHaveBeenCalledWith("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
      });
    });
  });

  describe("dispatchClick", () => {
    it("sends mousePressed then mouseReleased at given coordinates", async () => {
      const cdp = createMockCDPSession();

      await dispatchClick(cdp as never, 100, 200);

      expect(cdp.calls).toHaveLength(2);
      expect(cdp.calls[0]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 100,
          y: 200,
          button: "left",
          clickCount: 1,
        },
      });
      expect(cdp.calls[1]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseReleased",
          x: 100,
          y: 200,
          button: "left",
          clickCount: 1,
        },
      });
    });

    it("supports right button and custom clickCount", async () => {
      const cdp = createMockCDPSession();

      await dispatchClick(cdp as never, 50, 75, {
        button: "right",
        clickCount: 2,
      });

      expect(cdp.calls[0]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 50,
          y: 75,
          button: "right",
          clickCount: 2,
        },
      });
      expect(cdp.calls[1]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseReleased",
          x: 50,
          y: 75,
          button: "right",
          clickCount: 2,
        },
      });
    });
  });

  describe("dispatchType", () => {
    it("sends keyDown and keyUp for each character", async () => {
      const cdp = createMockCDPSession();

      await dispatchType(cdp as never, "hi");

      expect(cdp.calls).toHaveLength(4);
      expect(cdp.calls[0]).toEqual({
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", text: "h" },
      });
      expect(cdp.calls[1]).toEqual({
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", text: "h" },
      });
      expect(cdp.calls[2]).toEqual({
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", text: "i" },
      });
      expect(cdp.calls[3]).toEqual({
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", text: "i" },
      });
    });

    it("handles empty string without sending events", async () => {
      const cdp = createMockCDPSession();

      await dispatchType(cdp as never, "");

      expect(cdp.calls).toHaveLength(0);
    });
  });

  describe("dispatchScroll", () => {
    it("sends mouseWheel event with scroll delta", async () => {
      const cdp = createMockCDPSession();

      await dispatchScroll(cdp as never, 300, 400, 0, -120);

      expect(cdp.calls).toHaveLength(1);
      expect(cdp.calls[0]).toEqual({
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: 300,
          y: 400,
          deltaX: 0,
          deltaY: -120,
        },
      });
    });
  });

  describe("dispatchPaste", () => {
    it("sends Input.insertText with the given text", async () => {
      const cdp = createMockCDPSession();

      await dispatchPaste(cdp as never, "pasted content");

      expect(cdp.calls).toHaveLength(1);
      expect(cdp.calls[0]).toEqual({
        method: "Input.insertText",
        params: { text: "pasted content" },
      });
    });
  });
});
