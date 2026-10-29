import { describe, expect, it } from "vite-plus/test";
import {
  groupQuotaEntries,
  normalizeGroupedQuotaEntries,
} from "../src/lib/grouped-entry-normalization.js";
import { accountingContractResult } from "./fixtures/accounting-contract.js";

describe("normalizeGroupedQuotaEntries", () => {
  it("preserves and owns accounting metadata while grouping and sorting", () => {
    const entries = accountingContractResult.entries.slice(0, 2);
    const normalized = normalizeGroupedQuotaEntries(entries, "toast");

    for (const entry of entries) {
      const matching = normalized.find((candidate) => candidate.name === entry.name)!;
      expect(matching.accounting).toEqual(entry.accounting);
      expect(matching.accounting).not.toBe(entry.accounting);
    }
  });

  it("preserves and owns nested quantity, semantic, and basis data", () => {
    const entries = [
      {
        accounting: accountingContractResult.entries[0]!.accounting,
        kind: "percent" as const,
        name: "Monthly",
        group: "Example",
        percentRemaining: 75,
        semantic: {
          metric: { kind: "window" as const, window: "month" as const },
          prominence: "primary" as const,
        },
        basis: {
          remaining: {
            quantity: { decimal: "75", unit: { kind: "count" as const, unit: "credit" as const } },
            authority: "provider_reported" as const,
          },
        },
      },
      {
        accounting: {
          ...accountingContractResult.entries[0]!.accounting,
          resultType: "balance" as const,
        },
        kind: "quantity" as const,
        name: "Balance",
        group: "Example",
        semantic: {
          metric: { kind: "component" as const, component: "current_balance" as const },
          prominence: "primary" as const,
        },
        quantity: { decimal: "12.50", unit: { kind: "currency" as const, code: "USD" } },
      },
    ];

    const normalized = normalizeGroupedQuotaEntries(entries, "toast");
    expect(normalized).toEqual(entries);
    expect(normalized[0]!.semantic).not.toBe(entries[0]!.semantic);
    expect((normalized[0] as any).basis.remaining.quantity).not.toBe(
      entries[0]!.basis.remaining.quantity,
    );
    expect((normalized[1] as any).quantity).not.toBe(entries[1]!.quantity);
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

  it("uses an explicit row priority before generic duration ordering", () => {
    const entries = [
      {
        name: "Example 5h",
        group: "Example",
        label: "5h:",
        sortPriority: 1,
        percentRemaining: 80,
      },
      {
        name: "Example Weekly",
        group: "Example",
        label: "Weekly:",
        sortPriority: 0,
        percentRemaining: 90,
      },
    ];

    expect(normalizeGroupedQuotaEntries(entries, "toast").map((entry) => entry.label)).toEqual([
      "Weekly:",
      "5h:",
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

  it("sorts semantic runs without moving rows across legacy anchors", () => {
    const accounting = accountingContractResult.entries[0]!.accounting;
    const semantic = (resultType: "quota" | "budget", metric: "day" | "month" | "aggregate") => ({
      accounting: { ...accounting, resultType },
      name: `${resultType}-${metric}`,
      group: "Example",
      percentRemaining: 50,
      semantic: {
        metric:
          metric === "aggregate"
            ? ({ kind: "aggregate" } as const)
            : ({ kind: "window", window: metric } as const),
        prominence: "primary" as const,
      },
    });
    const legacy = {
      accounting,
      name: "Legacy",
      group: "Example",
      label: "RPM:",
      percentRemaining: 50,
    };
    const entries = [
      semantic("quota", "day"),
      legacy,
      semantic("budget", "aggregate"),
      semantic("quota", "month"),
    ];

    expect(normalizeGroupedQuotaEntries(entries, "toast").map((entry) => entry.name)).toEqual([
      "quota-day",
      "Legacy",
      "quota-month",
      "budget-aggregate",
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
