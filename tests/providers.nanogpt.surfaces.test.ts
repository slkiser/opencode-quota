import { describe, expect, it } from "vite-plus/test";
import type { QuotaToastEntry } from "../src/lib/entries.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const balanceAccounting = {
  ...quotaAccounting,
  resultType: "balance",
} as const;

function quotaEntry(
  window: "day" | "month",
  used: string,
  limit: string,
  remaining: string,
  percentRemaining: number,
): QuotaToastEntry {
  return {
    accounting: quotaAccounting,
    name: `nanogpt-${window}-quota`,
    group: "NanoGPT",
    percentRemaining,
    resetTimeIso: window === "day" ? "2030-01-02T00:00:00.000Z" : "2030-02-01T00:00:00.000Z",
    semantic: {
      metric: { kind: "window", window },
      prominence: "primary",
    },
    basis: {
      used: {
        quantity: { decimal: used, unit: { kind: "count", unit: "request" } },
        authority: "provider_reported",
      },
      limit: {
        quantity: { decimal: limit, unit: { kind: "count", unit: "request" } },
        authority: "provider_reported",
      },
      remaining: {
        quantity: { decimal: remaining, unit: { kind: "count", unit: "request" } },
        authority: "provider_reported",
      },
    },
  };
}

const daily = quotaEntry("day", "25", "100", "75", 75);
const monthly = quotaEntry("month", "500", "1000", "500", 50);
const usdBalance: QuotaToastEntry = {
  kind: "quantity",
  accounting: balanceAccounting,
  name: "nanogpt-current-balance",
  group: "NanoGPT",
  semantic: {
    metric: { kind: "component", component: "current_balance" },
    prominence: "primary",
  },
  quantity: { decimal: "12.3400", unit: { kind: "currency", code: "USD" } },
};
const nanoBalance: QuotaToastEntry = {
  ...usdBalance,
  quantity: { decimal: "26.71801147", unit: { kind: "custom", symbol: "NANO" } },
};

describe("NanoGPT structured four-surface formatting", () => {
  it("renders both quota windows, provider-reported basis, resets, and USD balance", () => {
    const outputs = renderAccountingFourSurfaces({
      data: { entries: [daily, monthly, usdBalance], errors: [] },
      accountingDetail: "detailed",
      toastMaxWidth: 56,
      toastNarrowAt: 42,
      compactMaxWidth: 220,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("NanoGPT");
      expect(output).toContain("Daily quota");
      expect(output).toContain("Monthly quota");
      expect(output).toContain("Current balance");
      expect(output).toContain("USD 12.34");
      expect(output).not.toContain("$");
    }
    expect(outputs.command).toContain("Used: 25 requests");
    expect(outputs.command).toContain("Limit: 100 requests");
    expect(outputs.command).toContain("Remaining: 75 requests");
    expect(outputs.toast.split("\n").every((line) => line.length <= 56)).toBe(true);
    expect(outputs.sidebar.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it("renders the valid NANO fallback while retaining a bounded partial error", () => {
    const outputs = renderAccountingFourSurfaces({
      data: {
        entries: [nanoBalance],
        errors: [
          {
            label: "NanoGPT Balance",
            message: "NanoGPT balance response returned an invalid usd_balance decimal",
          },
        ],
      },
      accountingDetail: "summary",
      toastMaxWidth: 56,
      toastNarrowAt: 42,
      compactMaxWidth: 220,
    });

    for (const output of [outputs.command, outputs.toast, outputs.sidebar]) {
      expect(output).toContain("26.71801147 NANO");
      expect(output).toContain("invalid usd_balance decimal");
    }
    expect(outputs.compact).toContain("26.71801147 NANO");
    expect(outputs.compact).toContain("1 issue");
  });
});
