import { describe, expect, it } from "vitest";

import { normalizeGroupedQuotaEntries } from "../src/lib/grouped-entry-normalization.js";

describe("normalizeGroupedQuotaEntries", () => {
  it("applies the Google fallback to grouped toast and /quota rendering", () => {
    const entry = {
      name: "Claude (acct)",
      percentRemaining: 67,
      resetTimeIso: "2026-01-15T15:00:00.000Z",
    } as const;

    expect(normalizeGroupedQuotaEntries([entry], "quota")).toEqual([
      {
        ...entry,
        group: "Google Antigravity (acct)",
        label: "Claude:",
      },
    ]);

    expect(normalizeGroupedQuotaEntries([entry], "toast")).toEqual([
      {
        ...entry,
        group: "Google Antigravity (acct)",
        label: "Claude:",
      },
    ]);
  });

  it("sorts recognized grouped duration rows from shortest to longest for toast output", () => {
    const entries = [
      {
        name: "Example Daily",
        group: "Example",
        label: "Daily:",
        percentRemaining: 80,
      },
      {
        name: "Example RPM",
        group: "Example",
        label: "RPM:",
        percentRemaining: 90,
      },
      {
        name: "Example Monthly",
        group: "Example",
        label: "Monthly:",
        percentRemaining: 70,
      },
    ];

    expect(normalizeGroupedQuotaEntries(entries, "toast").map((entry) => entry.label)).toEqual([
      "RPM:",
      "Daily:",
      "Monthly:",
    ]);
  });

  it("keeps unknown grouped rows after duration rows while preserving unknown-row order for /quota", () => {
    const entries = [
      {
        name: "Example Balance",
        group: "Example",
        label: "Balance:",
        kind: "value" as const,
        value: "$42",
      },
      {
        name: "Example Monthly",
        group: "Example",
        label: "Monthly:",
        percentRemaining: 75,
      },
      {
        name: "Example Daily",
        group: "Example",
        label: "Daily:",
        percentRemaining: 85,
      },
      {
        name: "Example MCP",
        group: "Example",
        label: "MCP:",
        kind: "value" as const,
        value: "Connected",
      },
    ];

    expect(normalizeGroupedQuotaEntries(entries, "quota").map((entry) => entry.label)).toEqual([
      "Daily:",
      "Monthly:",
      "Balance:",
      "MCP:",
    ]);
  });
});
