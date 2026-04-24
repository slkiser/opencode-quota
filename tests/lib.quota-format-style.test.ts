import { describe, expect, it } from "vitest";

import {
  getQuotaFormatStyleDefinition,
  getQuotaFormatStyleLabel,
  isQuotaFormatStyle,
  resolveQuotaFormatStyle,
} from "../src/lib/quota-format-style.js";

describe("quota format style helpers", () => {
  it("accepts canonical values and legacy aliases", () => {
    expect(isQuotaFormatStyle("singleWindow")).toBe(true);
    expect(isQuotaFormatStyle("allWindows")).toBe(true);
    expect(isQuotaFormatStyle("classic")).toBe(true);
    expect(isQuotaFormatStyle("grouped")).toBe(true);
    expect(isQuotaFormatStyle("single_window_per_provider")).toBe(false);
    expect(isQuotaFormatStyle("all_windows")).toBe(false);
    expect(isQuotaFormatStyle("unknown")).toBe(false);
  });

  it("resolves aliases to canonical style ids", () => {
    expect(resolveQuotaFormatStyle("singleWindow")).toBe("singleWindow");
    expect(resolveQuotaFormatStyle("classic")).toBe("singleWindow");
    expect(resolveQuotaFormatStyle("allWindows")).toBe("allWindows");
    expect(resolveQuotaFormatStyle("grouped")).toBe("allWindows");
  });

  it("falls back to the canonical single-window default for invalid values", () => {
    expect(resolveQuotaFormatStyle(undefined)).toBe("singleWindow");
    expect(resolveQuotaFormatStyle("mystery")).toBe("singleWindow");
    expect(resolveQuotaFormatStyle("single_window_per_provider")).toBe("singleWindow");
    expect(resolveQuotaFormatStyle("all_windows")).toBe("singleWindow");
  });

  it("exposes labels and behavior mapping from the shared registry", () => {
    expect(getQuotaFormatStyleLabel("classic")).toBe("Single window");
    expect(getQuotaFormatStyleLabel("allWindows")).toBe("All windows");
    expect(getQuotaFormatStyleDefinition("grouped")).toMatchObject({
      id: "allWindows",
      projection: "allWindows",
      renderer: "grouped",
      sessionTokens: "detailed",
    });
  });
});
