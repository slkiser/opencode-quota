import { describe, expect, it } from "vitest";

import {
  groupQuotaEntries,
  normalizeGroupedQuotaEntries,
} from "../src/lib/grouped-entry-normalization.js";

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

  it("sorts OpenCode Go windows as rolling, weekly, monthly", () => {
    const entries = [
      {
        name: "OpenCode Go Weekly",
        group: "OpenCode Go",
        label: "Weekly:",
        percentRemaining: 98,
      },
      {
        name: "OpenCode Go Monthly",
        group: "OpenCode Go",
        label: "Monthly:",
        percentRemaining: 84,
      },
      {
        name: "OpenCode Go Rolling",
        group: "OpenCode Go",
        label: "Rolling:",
        percentRemaining: 93,
      },
    ];

    expect(normalizeGroupedQuotaEntries(entries, "toast").map((entry) => entry.label)).toEqual([
      "Rolling:",
      "Weekly:",
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

  it("returns grouped quota entries in stable group and in-group order", () => {
    const groups = groupQuotaEntries(
      [
        {
          name: "Qwen Free Daily",
          group: "Qwen (free)",
          label: "Daily:",
          percentRemaining: 90,
        },
        {
          name: "Qwen Free RPM",
          group: "Qwen (free)",
          label: "RPM:",
          percentRemaining: 60,
        },
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
        },
      ],
      "quota",
    );

    expect(groups).toEqual([
      {
        group: "Qwen (free)",
        entries: [
          expect.objectContaining({ label: "RPM:" }),
          expect.objectContaining({ label: "Daily:" }),
        ],
      },
      {
        group: "OpenAI (Pro)",
        entries: [expect.objectContaining({ label: "Weekly:" })],
      },
    ]);
  });
});
