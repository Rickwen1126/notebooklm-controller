import { describe, it, expect, vi } from "vitest";
import { findElementByText } from "../../../src/scripts/find-element.js";

// Mock Page
function makeMockPage(evaluateResult: unknown) {
  return {
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
  } as unknown as import("puppeteer-core").Page;
}

describe("findElementByText", () => {
  it("returns null when no elements match", async () => {
    const page = makeMockPage([]);
    const result = await findElementByText(page, "Submit");
    expect(result).toBeNull();
  });

  it("returns first match when multiple elements found", async () => {
    const elements = [
      { tag: "BUTTON", text: "Submit", center: { x: 100, y: 200 }, rect: { x: 80, y: 180, w: 40, h: 40 }, disabled: false },
      { tag: "BUTTON", text: "Submit Form", center: { x: 300, y: 500 }, rect: { x: 280, y: 480, w: 40, h: 40 }, disabled: false },
    ];
    const page = makeMockPage(elements);
    const result = await findElementByText(page, "Submit");
    expect(result).toEqual(elements[0]);
  });

  it("applies y > N disambiguate filter", async () => {
    const elements = [
      { tag: "BUTTON", text: "Submit", center: { x: 100, y: 200 }, rect: { x: 80, y: 180, w: 40, h: 40 }, disabled: false },
      { tag: "BUTTON", text: "Submit", center: { x: 300, y: 500 }, rect: { x: 280, y: 480, w: 40, h: 40 }, disabled: false },
    ];
    const page = makeMockPage(elements);
    const result = await findElementByText(page, "Submit", { disambiguate: "y > 400" });
    expect(result).toEqual(elements[1]);
  });

  it("applies x < N disambiguate filter", async () => {
    const elements = [
      { tag: "BUTTON", text: "Menu", center: { x: 100, y: 300 }, rect: { x: 80, y: 280, w: 40, h: 40 }, disabled: false },
      { tag: "BUTTON", text: "Menu", center: { x: 500, y: 300 }, rect: { x: 480, y: 280, w: 40, h: 40 }, disabled: false },
    ];
    const page = makeMockPage(elements);
    const result = await findElementByText(page, "Menu", { disambiguate: "x < 200" });
    expect(result).toEqual(elements[0]);
  });

  it("falls back to first result when disambiguate matches nothing", async () => {
    const elements = [
      { tag: "BUTTON", text: "OK", center: { x: 100, y: 100 }, rect: { x: 80, y: 80, w: 40, h: 40 }, disabled: false },
    ];
    const page = makeMockPage(elements);
    const result = await findElementByText(page, "OK", { disambiguate: "y > 999" });
    expect(result).toEqual(elements[0]);
  });

  it("passes match type in evaluate call", async () => {
    const page = makeMockPage([]);
    await findElementByText(page, "Search", { match: "placeholder" });
    expect(page.evaluate).toHaveBeenCalledOnce();
    // Verify the evaluate string includes the matchType
    const evalArg = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(evalArg).toContain('"placeholder"');
  });
});
