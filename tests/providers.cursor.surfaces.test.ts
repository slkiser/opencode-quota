import { afterEach, describe, expect, it, vi } from "vitest";

import type { QuotaToastEntry } from "../src/lib/entries.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const budgetAccounting = {
  resultType: "budget",
  acquisitionMethod: "local_runtime_accounting",
  ownership: "maintained",
  authority: "locally_derived",
} as const;
const spendAccounting = { ...budgetAccounting, resultType: "spend" } as const;
const resetTimeIso = "2099-02-01T00:00:00.000Z";

const apiBudget: QuotaToastEntry = {
  accounting: budgetAccounting,
  name: "Cursor API (Pro)",
  group: "Cursor (Pro)",
  percentRemaining: 75,
  resetTimeIso,
  semantic: {
    metric: { kind: "named", name: "API" },
    prominence: "primary",
  },
  basis: {
    used: {
      quantity: { decimal: "5", unit: { kind: "currency", code: "USD" } },
      authority: "locally_derived",
    },
    limit: {
      quantity: { decimal: "20", unit: { kind: "currency", code: "USD" } },
      authority: "locally_derived",
    },
    remaining: {
      quantity: { decimal: "15", unit: { kind: "currency", code: "USD" } },
      authority: "locally_derived",
    },
  },
};

function spendEntry(name: "API" | "Known API" | "Auto+Composer", decimal: string): QuotaToastEntry {
  return {
    kind: "quantity",
    accounting: spendAccounting,
    name: `cursor-${name.toLowerCase().replaceAll("+", "-").replaceAll(" ", "-")}-spend`,
    group: "Cursor (Pro)",
    resetTimeIso,
    semantic: {
      metric: { kind: "named", name },
      prominence: name === "Auto+Composer" ? "supplementary" : "primary",
    },
    quantity: { decimal, unit: { kind: "currency", code: "USD" } },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Cursor structured four-surface formatting", () => {
  it("renders complete API budget basis and supplementary Auto+Composer spend", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    const outputs = renderAccountingFourSurfaces({
      data: { entries: [apiBudget, spendEntry("Auto+Composer", "1.25")], errors: [] },
      accountingDetail: "detailed",
      toastMaxWidth: 68,
      toastNarrowAt: 46,
      compactMaxWidth: 240,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Cursor");
      expect(output).toContain("Pro");
      expect(output).toContain("API budget");
      expect(output).toContain("75%");
      expect(output).toContain("USD");
      expect(output).not.toContain("$");
    }
    for (const output of [outputs.command, outputs.toast, outputs.sidebar]) {
      expect(output).toContain("Auto+Composer spend");
      expect(output).toContain("USD 1.25");
      expect(output).toMatch(/\b\d+d\d+h\d+m\b/u);
    }
    expect(outputs.command).toContain("Used: USD 5.00");
    expect(outputs.command).toContain("Limit: USD 20.00");
    expect(outputs.command).toContain("Remaining: USD 15.00");
    expect(outputs.toast.split("\n").every((line) => line.length <= 68)).toBe(true);
    expect(outputs.sidebar.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it("renders partial coverage only as Known API spend plus the existing error", () => {
    const outputs = renderAccountingFourSurfaces({
      data: {
        entries: [spendEntry("Known API", "2")],
        errors: [
          {
            label: "Cursor",
            message: "Unknown Cursor model ids present in local history (see /quota_status)",
          },
        ],
      },
      accountingDetail: "summary",
      toastMaxWidth: 68,
      toastNarrowAt: 46,
      compactMaxWidth: 240,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Known API spend");
      expect(output).toContain("USD 2.00");
      expect(output).not.toContain("%");
      expect(output).not.toContain("USD 20.00");
    }
    for (const output of [outputs.command, outputs.toast, outputs.sidebar]) {
      expect(output).toContain("Unknown Cursor model ids");
    }
    expect(outputs.compact).toContain("1 issue");
  });

  it("renders no-allowance complete coverage as API cycle spend and hides supplementary spend in summary", () => {
    const outputs = renderAccountingFourSurfaces({
      data: {
        entries: [spendEntry("API", "0.5")],
        errors: [],
      },
      accountingDetail: "summary",
      toastMaxWidth: 68,
      toastNarrowAt: 46,
      compactMaxWidth: 240,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("API spend");
      expect(output).toContain("USD 0.50");
      expect(output).not.toContain("Auto+Composer");
      expect(output).not.toContain("%");
    }
  });
});
