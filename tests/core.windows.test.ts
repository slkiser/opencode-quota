import { describe, expect, it } from "vite-plus/test";

import { classifyWindow, isQuotaWindow, WINDOWS } from "../src/core/windows.js";

describe("quota windows", () => {
  it.each([
    ["5h:", "five_hour"],
    ["5h limit", "five_hour"],
    ["Rolling", "five_hour"],
    ["Five-hour", "five_hour"],
    ["Hourly", "hour"],
    ["Per minute", "rpm"],
    ["Session:", "session"],
    ["Weekly:", "week"],
    ["Weekly limit", "week"],
    ["7d", "week"],
    ["Daily", "day"],
    ["Monthly:", "month"],
    ["Yearly", "year"],
    ["MCP:", "mcp"],
    ["Code Review:", "code_review"],
  ] as const)("reads %s as %s", (label, window) => {
    expect(classifyWindow(label)).toBe(window);
  });

  it("reads nothing from labels that name no window", () => {
    for (const label of ["", ":", "Budget:", "Gemini Pro", "Limit #2", "Period"]) {
      expect(classifyWindow(label)).toBeUndefined();
    }
  });

  it("knows only its own windows", () => {
    for (const window of Object.keys(WINDOWS)) expect(isQuotaWindow(window)).toBe(true);
    for (const value of ["weekly", "toString", "__proto__", 5, undefined]) {
      expect(isQuotaWindow(value)).toBe(false);
    }
  });

  it("gives reset notices only to windows that refill on a schedule", () => {
    const resetting = Object.entries(WINDOWS)
      .filter(([, info]) => info.resets)
      .map(([window]) => window);
    expect(resetting).toEqual(["hour", "five_hour", "day", "week", "month", "year"]);
  });
});
