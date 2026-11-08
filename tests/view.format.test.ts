import { describe, expect, it } from "vite-plus/test";
import {
  amountText,
  cacheHit,
  formatCount,
  formatDuration,
  formatShare,
  formatTokens,
  formatUsd,
  sessionTokensText,
} from "../src/view/format.js";

describe("locale-aware shared formatters", () => {
  it("formats request counts exactly without compact notation in English and Chinese", () => {
    expect(formatCount(1_234_567, "en-US")).toBe("1,234,567");
    expect(formatCount(1_234_567, "zh-Hans")).toBe("1,234,567");
  });

  it("localizes number, currency and percent formatting without changing their values", () => {
    expect(formatTokens(12_345, "zh-Hans")).toBe("1.23万");
    expect(formatUsd(1_234.5, "zh-Hans")).toBe("US$1,234.50");
    expect(formatShare(0.125, "zh-Hans")).toBe("12.5%");
    expect(formatShare(0.0004, "zh-Hans")).toBe("<0.1%");
  });

  it("translates durations and unit pluralization while keeping time and amount semantics", () => {
    expect(formatDuration(90 * 60_000, "decimal", 1, "zh-Hans")).toBe("1.5小时");
    expect(amountText({ decimal: "2", unit: { kind: "count", unit: "request" } }, "zh-Hans")).toBe(
      "2 request",
    );
  });

  it("preserves the existing rounded-down cache-hit percentage in each locale", () => {
    const input = { input: 100, cacheRead: 800, cacheWrite: 0 };
    expect(cacheHit(input, "en-US")?.text).toBe("88%");
    expect(cacheHit(input, "zh-Hans")?.text).toBe("88%");
  });

  it("formats session token counts with localized number separators and labels", () => {
    expect(sessionTokensText({ input: 234, cachedInput: 678, output: 912 }, "zh-Hans")).toBe(
      "234 (678) 输入 · 912 输出",
    );
  });
});
