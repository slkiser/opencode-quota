import { describe, expect, it } from "vite-plus/test";
import type { QuotaToastEntry } from "../src/lib/entries.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const balanceAccounting = { ...quotaAccounting, resultType: "balance" } as const;
const group = "Xiaomi MiMo: Standard [standard_monthly]";

const monthlyQuota: QuotaToastEntry = {
  accounting: quotaAccounting,
  name: `${group} Monthly`,
  group,
  percentRemaining: 75,
  semantic: {
    metric: { kind: "window", window: "month" },
    prominence: "primary",
  },
  basis: {
    used: {
      quantity: { decimal: "25", unit: { kind: "count", unit: "token" } },
      authority: "provider_reported",
    },
    limit: {
      quantity: { decimal: "100", unit: { kind: "count", unit: "token" } },
      authority: "provider_reported",
    },
  },
};

function balanceEntry(
  component: "total_balance" | "cash_balance" | "gift_balance",
  prominence: "primary" | "supplementary",
  decimal: string,
  currency: string | null = "USD",
): QuotaToastEntry {
  return {
    kind: "quantity",
    accounting: balanceAccounting,
    name: `xiaomi-mimo-${component}`,
    group,
    semantic: { metric: { kind: "component", component }, prominence },
    quantity: {
      decimal,
      unit: currency ? { kind: "currency", code: currency } : { kind: "count", unit: "credit" },
    },
  };
}

describe("Xiaomi MiMo structured four-surface formatting", () => {
  it("shows plan identity, monthly token quota, and separate balance components", () => {
    const outputs = renderAccountingFourSurfaces({
      data: {
        entries: [
          monthlyQuota,
          balanceEntry("total_balance", "primary", "50"),
          balanceEntry("cash_balance", "supplementary", "30"),
          balanceEntry("gift_balance", "supplementary", "20"),
        ],
        errors: [],
      },
      accountingDetail: "detailed",
      toastMaxWidth: 72,
      toastNarrowAt: 48,
      compactMaxWidth: 240,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Xiaomi MiMo");
      expect(output).toContain("Standard");
      expect(output).toContain("Monthly quota");
      expect(output).toContain("75%");
      expect(output).toContain("Total balance");
      expect(output).toContain("USD 50.00");
      expect(output).toContain("Cash balance");
      expect(output).not.toContain("$");
    }
    for (const output of [outputs.command, outputs.toast, outputs.sidebar]) {
      expect(output).toContain("Gift balance");
    }
    expect(outputs.command).toContain(group);
    expect(outputs.command).toContain("Used: 25 tokens");
    expect(outputs.command).toContain("Limit: 100 tokens");
    expect(outputs.toast.split("\n").every((line) => line.length <= 72)).toBe(true);
    expect(outputs.sidebar.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it("renders missing-currency balances as credit counts", () => {
    const outputs = renderAccountingFourSurfaces({
      data: {
        entries: [balanceEntry("total_balance", "primary", "12.5", null)],
        errors: [],
      },
      accountingDetail: "detailed",
      toastMaxWidth: 72,
      toastNarrowAt: 48,
      compactMaxWidth: 240,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Total balance");
      expect(output).toContain("12.5 credits");
      expect(output).not.toContain("USD");
      expect(output).not.toContain("$");
    }
  });
});
