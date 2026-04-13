import { describe, it, expect } from "vitest";
import { resolveLocale, loadUIMap } from "../../../src/shared/locale.js";

describe("resolveLocale", () => {
  it('resolveLocale("zh-TW") → "zh-TW"', () => {
    expect(resolveLocale("zh-TW")).toBe("zh-TW");
  });

  it('resolveLocale("zh-Hant-TW") → "zh-TW"', () => {
    expect(resolveLocale("zh-Hant-TW")).toBe("zh-TW");
  });

  it('resolveLocale("zh-CN") → "zh-CN"', () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
  });

  it('resolveLocale("zh") → "zh-CN"', () => {
    expect(resolveLocale("zh")).toBe("zh-CN");
  });

  it('resolveLocale("en-US") → "en"', () => {
    expect(resolveLocale("en-US")).toBe("en");
  });

  it('resolveLocale("ja") → "en" (fallback)', () => {
    expect(resolveLocale("ja")).toBe("en");
  });
});

describe("loadUIMap", () => {
  it('loadUIMap("zh-TW") returns UIMap with locale "zh-TW" and verified: true', () => {
    const map = loadUIMap("zh-TW");
    expect(map.locale).toBe("zh-TW");
    expect(map.verified).toBe(true);
  });

  it('loadUIMap("en") returns UIMap with locale "en"', () => {
    const map = loadUIMap("en");
    expect(map.locale).toBe("en");
  });

  it('loadUIMap("nonexistent") falls back to "en" locale', () => {
    const map = loadUIMap("nonexistent");
    expect(map.locale).toBe("en");
  });

  it('loadUIMap("zh-TW") has expected elements (create_notebook, submit_button)', () => {
    const map = loadUIMap("zh-TW");
    expect(map.elements).toHaveProperty("create_notebook");
    expect(map.elements["create_notebook"].text).toBe("新建");
    expect(map.elements).toHaveProperty("submit_button");
    expect(map.elements["submit_button"].text).toBe("提交");
    expect(map.elements["submit_button"].match).toBe("aria-label");
  });

  it('loadUIMap("zh-TW") has expected selectors (answer, source_panel)', () => {
    const map = loadUIMap("zh-TW");
    expect(map.selectors).toHaveProperty("answer");
    expect(map.selectors["answer"]).toBe(".to-user-container .message-content");
    expect(map.selectors).toHaveProperty("source_panel");
    expect(map.selectors["source_panel"]).toBe(".source-panel");
  });
});
