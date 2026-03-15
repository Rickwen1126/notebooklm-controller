import { describe, it, expect, vi } from "vitest";
import { waitForGone, waitForVisible, waitForNavigation, waitForCountChange } from "../../../src/scripts/wait-primitives.js";

function makeMockPage(evaluateResults: unknown[]) {
  let callIndex = 0;
  return {
    evaluate: vi.fn().mockImplementation(() => {
      const result = evaluateResults[callIndex] ?? evaluateResults[evaluateResults.length - 1];
      callIndex++;
      return Promise.resolve(result);
    }),
    url: vi.fn().mockReturnValue("https://example.com"),
  } as unknown as import("puppeteer-core").Page;
}

describe("waitForGone", () => {
  it("returns immediately when element is already gone", async () => {
    const page = makeMockPage([false]); // first poll: not visible
    const result = await waitForGone(page, ".dialog", { timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result.gone).toBe(true);
  });

  it("times out when element stays visible", async () => {
    const page = makeMockPage([true, true, true, true, true]); // always visible
    const result = await waitForGone(page, ".dialog", { timeoutMs: 200, pollIntervalMs: 50 });
    expect(result.gone).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(150);
  });
});

describe("waitForVisible", () => {
  it("returns immediately when element is already visible", async () => {
    const page = makeMockPage([true]);
    const result = await waitForVisible(page, ".panel", { timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result.visible).toBe(true);
  });

  it("times out when element stays hidden", async () => {
    const page = makeMockPage([false, false, false, false, false]);
    const result = await waitForVisible(page, ".panel", { timeoutMs: 200, pollIntervalMs: 50 });
    expect(result.visible).toBe(false);
  });
});

describe("waitForNavigation", () => {
  it("detects URL change via notUrl", async () => {
    const page = {
      evaluate: vi.fn(),
      url: vi.fn().mockReturnValue("https://example.com/new"),
    } as unknown as import("puppeteer-core").Page;

    const result = await waitForNavigation(page, { notUrl: "https://example.com/old", timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result.navigated).toBe(true);
    expect(result.url).toBe("https://example.com/new");
  });

  it("detects URL change via urlContains", async () => {
    const page = {
      evaluate: vi.fn(),
      url: vi.fn().mockReturnValue("https://notebooklm.google.com/notebook/abc123"),
    } as unknown as import("puppeteer-core").Page;

    const result = await waitForNavigation(page, { urlContains: "notebook/", timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result.navigated).toBe(true);
  });
});

describe("waitForCountChange", () => {
  it("detects count increase", async () => {
    const page = makeMockPage([3, 3, 4]); // baseline was 3, becomes 4
    const result = await waitForCountChange(page, ".source-item", 3, { timeoutMs: 1000, pollIntervalMs: 50 });
    expect(result.changed).toBe(true);
    expect(result.newCount).toBe(4);
  });

  it("times out when count stays the same", async () => {
    const page = makeMockPage([3, 3, 3, 3, 3]);
    const result = await waitForCountChange(page, ".source-item", 3, { timeoutMs: 200, pollIntervalMs: 50 });
    expect(result.changed).toBe(false);
    expect(result.newCount).toBe(3);
  });
});
