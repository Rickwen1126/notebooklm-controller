import { describe, it, expect, vi } from "vitest";
import { ensureChatPanel, ensureSourcePanel, ensureHomepage } from "../../../src/scripts/ensure.js";
import type { ScriptContext, ScriptLogEntry } from "../../../src/scripts/types.js";

function makeCtx(overrides: {
  chatVisible?: boolean;
  sourceVisible?: boolean;
  url?: string;
  tabFound?: boolean;
} = {}): ScriptContext {
  const { chatVisible = true, sourceVisible = true, url = "https://notebooklm.google.com", tabFound = true } = overrides;

  const page = {
    evaluate: vi.fn().mockImplementation((script: string) => {
      if (script.includes("chat-panel")) return Promise.resolve(chatVisible);
      if (script.includes("source-panel")) return Promise.resolve(sourceVisible);
      return Promise.resolve(false);
    }),
    url: vi.fn().mockReturnValue(url),
    goto: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("puppeteer-core").Page;

  const cdp = {} as import("puppeteer-core").CDPSession;

  const findResult = tabFound
    ? { tag: "BUTTON", text: "Tab", center: { x: 100, y: 50 }, rect: { x: 80, y: 30, w: 40, h: 40 }, disabled: false }
    : null;

  return {
    cdp,
    page,
    uiMap: { locale: "zh-TW", verified: true, elements: {}, selectors: {} },
    helpers: {
      findElementByText: vi.fn().mockResolvedValue(findResult),
      dispatchClick: vi.fn().mockResolvedValue(undefined),
      dispatchPaste: vi.fn(),
      dispatchType: vi.fn(),
      captureScreenshot: vi.fn(),
      pollForAnswer: vi.fn(),
      waitForGone: vi.fn(),
      waitForVisible: vi.fn(),
      waitForEnabled: vi.fn(),
      waitForNavigation: vi.fn(),
      waitForCountChange: vi.fn(),
      ensureChatPanel: vi.fn(),
      ensureSourcePanel: vi.fn(),
      ensureHomepage: vi.fn(),
    },
  };
}

describe("ensureChatPanel", () => {
  it("does nothing when chat panel is already visible", async () => {
    const ctx = makeCtx({ chatVisible: true });
    const log: ScriptLogEntry[] = [];
    const result = await ensureChatPanel(ctx, log, Date.now());
    expect(result).toBe(true);
    expect(log[0].status).toBe("ok");
    expect(ctx.helpers.dispatchClick).not.toHaveBeenCalled();
  });

  it("clicks 對話 tab when chat panel is hidden", async () => {
    const ctx = makeCtx({ chatVisible: false, tabFound: true });
    const log: ScriptLogEntry[] = [];
    const result = await ensureChatPanel(ctx, log, Date.now());
    expect(result).toBe(true);
    expect(log[0].status).toBe("warn");
    expect(ctx.helpers.dispatchClick).toHaveBeenCalled();
  });

  it("returns false when tab not found", async () => {
    const ctx = makeCtx({ chatVisible: false, tabFound: false });
    const log: ScriptLogEntry[] = [];
    const result = await ensureChatPanel(ctx, log, Date.now());
    expect(result).toBe(false);
  });
});

describe("ensureSourcePanel", () => {
  it("does nothing when source panel is already visible", async () => {
    const ctx = makeCtx({ sourceVisible: true });
    const log: ScriptLogEntry[] = [];
    const result = await ensureSourcePanel(ctx, log, Date.now());
    expect(result).toBe(true);
    expect(log[0].status).toBe("ok");
  });

  it("clicks 來源 tab when source panel is hidden", async () => {
    const ctx = makeCtx({ sourceVisible: false, tabFound: true });
    const log: ScriptLogEntry[] = [];
    const result = await ensureSourcePanel(ctx, log, Date.now());
    expect(result).toBe(true);
    expect(ctx.helpers.dispatchClick).toHaveBeenCalled();
  });
});

describe("ensureHomepage", () => {
  it("does nothing when already on homepage", async () => {
    const ctx = makeCtx({ url: "https://notebooklm.google.com" });
    const log: ScriptLogEntry[] = [];
    const result = await ensureHomepage(ctx, log, Date.now());
    expect(result).toBe(true);
    expect(log[0].status).toBe("ok");
    expect(ctx.page.goto).not.toHaveBeenCalled();
  });

  it("navigates when on notebook page", async () => {
    const ctx = makeCtx({ url: "https://notebooklm.google.com/notebook/abc123" });
    const log: ScriptLogEntry[] = [];
    const result = await ensureHomepage(ctx, log, Date.now());
    expect(result).toBe(true);
    expect(log[0].status).toBe("warn");
    expect(ctx.page.goto).toHaveBeenCalledWith("https://notebooklm.google.com", expect.anything());
  });

  it("treats homepage with trailing slash as valid", async () => {
    const ctx = makeCtx({ url: "https://notebooklm.google.com/" });
    const log: ScriptLogEntry[] = [];
    await ensureHomepage(ctx, log, Date.now());
    expect(log[0].status).toBe("ok");
    expect(ctx.page.goto).not.toHaveBeenCalled();
  });
});
