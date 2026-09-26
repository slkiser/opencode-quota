import { describe, expect, it } from "vitest";
import type { QuotaToastEntry } from "../src/lib/entries.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const budgetAccounting = {
  resultType: "budget",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
} as const;

const providerAccounting = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const budget: QuotaToastEntry = {
  accounting: budgetAccounting,
  name: "zen-monthly-budget",
  group: "OpenCode Zen",
  percentRemaining: 94.25,
  semantic: {
    metric: { kind: "window", window: "month" },
    prominence: "primary",
  },
  basis: {
    used: {
      quantity: { decimal: "5.75", unit: { kind: "currency", code: "USD" } },
      authority: "provider_reported",
    },
    limit: {
      quantity: { decimal: "100", unit: { kind: "currency", code: "USD" } },
      authority: "user_configured",
    },
    remaining: {
      quantity: { decimal: "94.25", unit: { kind: "currency", code: "USD" } },
      authority: "locally_derived",
    },
  },
};

const balance: QuotaToastEntry = {
  kind: "quantity",
  accounting: providerAccounting,
  name: "zen-current-balance",
  group: "OpenCode Zen",
  semantic: {
    metric: { kind: "component", component: "current_balance" },
    prominence: "supplementary",
  },
  quantity: { decimal: "42.5", unit: { kind: "currency", code: "USD" } },
};

const primaryBalance: QuotaToastEntry = {
  ...balance,
  semantic: {
    metric: { kind: "component", component: "current_balance" },
    prominence: "primary",
  },
};

const autoReload: QuotaToastEntry = {
  kind: "boolean",
  accounting: { ...providerAccounting, resultType: "status" },
  name: "zen-auto-reload",
  group: "OpenCode Zen",
  semantic: {
    metric: { kind: "component", component: "auto_reload" },
    prominence: "supplementary",
  },
  value: true,
};

describe("OpenCode Zen structured four-surface formatting", () => {
  it("renders summary budget semantics without supplementary accounting rows", () => {
    const outputs = renderAccountingFourSurfaces({
      data: { entries: [budget], errors: [] },
      accountingDetail: "summary",
      toastMaxWidth: 50,
      toastNarrowAt: 42,
      compactMaxWidth: 200,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("OpenCode Zen");
      expect(output).toContain("94%");
      expect(output).not.toContain("Current balance");
      expect(output).not.toContain("Auto-reload");
    }
    expect(outputs.command).toContain("Remaining: USD 94.25");
    expect(outputs.toast).toContain("Remaining: USD 94.25");
  });

  it("renders a primary structured balance fallback without financial legacy fields", () => {
    const outputs = renderAccountingFourSurfaces({
      data: { entries: [primaryBalance], errors: [] },
      accountingDetail: "summary",
      toastMaxWidth: 50,
      toastNarrowAt: 42,
      compactMaxWidth: 200,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("OpenCode Zen");
      expect(output).toContain("Current balance");
      expect(output).toContain("USD 42.50");
      expect(output).not.toContain("$");
    }
    expect(primaryBalance).not.toHaveProperty("right");
    expect(primaryBalance).not.toHaveProperty("barValue");
    expect(primaryBalance).not.toHaveProperty("value");
  });

  it("renders detailed basis and supplementary values within each surface width", () => {
    const outputs = renderAccountingFourSurfaces({
      data: { entries: [budget, balance, autoReload], errors: [] },
      accountingDetail: "detailed",
      toastMaxWidth: 50,
      toastNarrowAt: 42,
      compactMaxWidth: 200,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Monthly budget");
      expect(output).toContain("Current balance");
      expect(output).toContain("USD 42.50");
      expect(output).toContain("Auto-reload");
      expect(output).toContain("Enabled");
    }
    expect(outputs.command).toContain("Used: USD 5.75");
    expect(outputs.command).toContain("Limit: USD 100.00");
    expect(outputs.command).toContain("Remaining: USD 94.25");
    expect(outputs.toast.split("\n").every((line) => line.length <= 50)).toBe(true);
    expect(outputs.sidebar.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it("omits an incomplete financial basis phrase at tiny popup width", () => {
    const tiny = formatQuotaRows({
      version: "test",
      style: "allWindows",
      layout: { maxWidth: 28, narrowAt: 28, tinyAt: 28 },
      entries: [budget, balance],
      errors: [],
      accountingDetail: "detailed",
      percentDisplayMode: "remaining",
    });

    expect(tiny.split("\n").every((line) => line.length <= 28)).toBe(true);
    expect(tiny).not.toContain("Remaining: USD 9");
    expect(tiny).toContain("USD 42.50");
  });
});
