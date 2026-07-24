import { describe, expect, it } from "vitest";

import {
  buildSingleWindowPercentEntryDisplayName,
  classifyQuotaWindowText,
  extractSingleWindowWindowLabel,
} from "../src/lib/quota-entry-display.js";

const CASES = [
  ["RPM", "rpm", "RPM"],
  ["rolling 5 hour", "five_hour", "5h"],
  ["Hourly", "hour", "Hourly"],
  ["7d", "week", "Weekly"],
  ["Daily", "day", "Daily"],
  ["Monthly", "month", "Monthly"],
  ["Annual", "year", "Yearly"],
  ["MCP", "mcp", "MCP"],
  ["Code Review", "code_review", null],
] as const;

describe("quota window classification", () => {
  it.each(CASES)("classifies %s without changing single-window vocabulary", (text, kind, label) => {
    expect(classifyQuotaWindowText(text)).toBe(kind);
    expect(extractSingleWindowWindowLabel(text)).toBe(label);
  });

  it("keeps code review classified without adding it to single-window projection", () => {
    expect(
      buildSingleWindowPercentEntryDisplayName({
        name: "Copilot",
        group: "Copilot",
        label: "Code Review",
        percentRemaining: 75,
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
      }),
    ).toBe("[Copilot]");
  });

  it("leaves non-window labels unclassified", () => {
    expect(classifyQuotaWindowText("API requests")).toBeNull();
  });
});
