import { describe, expect, it } from "vitest";
import {
  compareAccountingSemanticEntries,
  formatAccountingBasisDetails,
  formatAccountingBasisSummary,
  formatAccountingBoolean,
  formatAccountingQuantity,
  formatAccountingSemanticLabel,
  formatAccountingWindowLabel,
  getAccountingEntryLabel,
  interpretAccountingRow,
  isCanonicalAccountingDecimal,
} from "../src/lib/accounting-format.js";
import type {
  AccountingMetadata,
  AccountingQuantity,
  QuotaToastEntry,
} from "../src/lib/entries.js";

const ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

const usd = (decimal: string): AccountingQuantity => ({
  decimal,
  unit: { kind: "currency", code: "USD" },
});

function semanticEntry(params: {
  resultType: AccountingMetadata["resultType"];
  metric: NonNullable<QuotaToastEntry["semantic"]>["metric"];
  kind?: "percent" | "quantity";
}): QuotaToastEntry {
  const common = {
    accounting: { ...ACCOUNTING, resultType: params.resultType },
    name: "fixture",
    semantic: { metric: params.metric, prominence: "primary" as const },
  };
  return params.kind === "quantity"
    ? { ...common, kind: "quantity", quantity: usd("1") }
    : { ...common, kind: "percent", percentRemaining: 50 };
}

describe("accounting-format", () => {
  it("accepts only canonical decimals", () => {
    for (const value of ["0", "0.00", "1", "1.2300", "-0.1", "-12.50", "999999999999999999999"]) {
      expect(isCanonicalAccountingDecimal(value), value).toBe(true);
    }
    for (const value of [
      "",
      "+1",
      "01",
      "-0",
      "-0.0",
      ".1",
      "1.",
      "1e3",
      "NaN",
      "Infinity",
      "1,000",
    ]) {
      expect(isCanonicalAccountingDecimal(value), value).toBe(false);
    }
  });

  it("formats currencies without losing codes or displaying a false zero", () => {
    expect(formatAccountingQuantity(usd("12.5"))).toBe("USD 12.50");
    expect(
      formatAccountingQuantity({ decimal: "8.25", unit: { kind: "currency", code: "CNY" } }),
    ).toBe("CNY 8.25");
    expect(formatAccountingQuantity(usd("12.345"))).toBe("USD 12.35");
    expect(formatAccountingQuantity(usd("0.009"))).toBe("USD <0.01");
    expect(formatAccountingQuantity(usd("0.05"))).toBe("USD 0.05");
    expect(formatAccountingQuantity(usd("-0.004"))).toBe("USD -0.004");
    expect(formatAccountingQuantity(usd("12345678901234567890.1"))).toBe(
      "USD 12,345,678,901,234,567,890.10",
    );
  });

  it("formats count and custom units with stable precision and pluralization", () => {
    expect(formatAccountingQuantity({ decimal: "1", unit: { kind: "count", unit: "token" } })).toBe(
      "1 token",
    );
    expect(
      formatAccountingQuantity({ decimal: "1.0", unit: { kind: "count", unit: "request" } }),
    ).toBe("1.0 request");
    expect(
      formatAccountingQuantity({ decimal: "12500", unit: { kind: "count", unit: "token" } }),
    ).toBe("12,500 tokens");
    expect(
      formatAccountingQuantity({ decimal: "25.5", unit: { kind: "custom", symbol: "NANO" } }),
    ).toBe("25.5 NANO");
    expect(formatAccountingBoolean(true)).toBe("Enabled");
    expect(formatAccountingBoolean(false)).toBe("Disabled");
    const availability = {
      metric: { kind: "named", name: "Availability" },
      prominence: "primary",
    } as const;
    expect(formatAccountingBoolean(true, availability)).toBe("Available");
    expect(formatAccountingBoolean(false, availability)).toBe("Low balance");
  });

  it("formats summary and detailed basis facts without relabeling them", () => {
    const basis = {
      used: { quantity: usd("5.75"), authority: "provider_reported" as const },
      limit: { quantity: usd("100"), authority: "user_configured" as const },
      remaining: { quantity: usd("94.25"), authority: "locally_derived" as const },
    };
    expect(formatAccountingBasisSummary(basis, "remaining")).toBe("Remaining: USD 94.25");
    expect(formatAccountingBasisSummary(basis, "used")).toBe("Used: USD 5.75");
    expect(formatAccountingBasisDetails(basis)).toEqual([
      "Used: USD 5.75",
      "Limit: USD 100.00",
      "Remaining: USD 94.25",
    ]);
    expect(
      formatAccountingBasisSummary({ used: basis.used, limit: basis.limit }, "remaining"),
    ).toBe("Used: USD 5.75 / Limit: USD 100.00");
  });

  it("owns provider-neutral labels including typed windows and components", () => {
    expect(formatAccountingWindowLabel("rpm")).toBe("RPM");
    expect(formatAccountingWindowLabel("five_hour")).toBe("5h");
    expect(formatAccountingWindowLabel("code_review")).toBe("Code Review");
    expect(
      formatAccountingSemanticLabel(
        "quota",
        { metric: { kind: "window", window: "month" }, prominence: "primary" },
        "percent",
      ),
    ).toBe("Monthly quota");
    expect(
      formatAccountingSemanticLabel(
        "quota",
        { metric: { kind: "component", component: "remaining_credits" }, prominence: "primary" },
        "percent",
      ),
    ).toBe("Credits");
    expect(
      getAccountingEntryLabel(
        semanticEntry({
          resultType: "quota",
          metric: { kind: "component", component: "remaining_credits" },
          kind: "quantity",
        }),
      ),
    ).toBe("Remaining credits");
    expect(
      formatAccountingSemanticLabel(
        "status",
        { metric: { kind: "named", name: "Availability" }, prominence: "primary" },
        "boolean",
      ),
    ).toBe("Availability");
  });

  it("interprets every row kind with explicit boolean wording and raw percentages", () => {
    const percent = interpretAccountingRow(
      {
        accounting: ACCOUNTING,
        name: "raw percent",
        percentRemaining: Number.POSITIVE_INFINITY,
        semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
      },
      { booleanWording: "semantic" },
    );
    expect(percent).toEqual({
      label: "Weekly quota",
      display: { kind: "percent", percentRemaining: Number.POSITIVE_INFINITY },
    });

    expect(
      interpretAccountingRow(
        { accounting: ACCOUNTING, kind: "value", name: "legacy", value: " exact " },
        { booleanWording: "semantic" },
      ),
    ).toEqual({
      label: "legacy",
      display: { kind: "value", entryKind: "value", text: " exact " },
    });
    expect(
      interpretAccountingRow(
        {
          accounting: { ...ACCOUNTING, resultType: "balance" },
          kind: "quantity",
          name: "balance",
          quantity: usd("12.5"),
          semantic: {
            metric: { kind: "component", component: "total_balance" },
            prominence: "primary",
          },
        },
        { booleanWording: "semantic" },
      ),
    ).toEqual({
      label: "Total balance",
      display: { kind: "value", entryKind: "quantity", text: "USD 12.50" },
    });

    const availability = {
      accounting: { ...ACCOUNTING, resultType: "status" as const },
      kind: "boolean" as const,
      name: "availability",
      value: false,
      semantic: {
        metric: { kind: "named" as const, name: "Availability" },
        prominence: "primary" as const,
      },
    };
    expect(interpretAccountingRow(availability, { booleanWording: "semantic" }).display).toEqual({
      kind: "value",
      entryKind: "boolean",
      text: "Low balance",
    });
    expect(interpretAccountingRow(availability, { booleanWording: "generic" }).display).toEqual({
      kind: "value",
      entryKind: "boolean",
      text: "Disabled",
    });
  });

  it("interprets basis only when requested and preserves typed fact order", () => {
    const entry = {
      accounting: ACCOUNTING,
      name: "quota",
      percentRemaining: 25,
      basis: {
        used: { quantity: usd("75"), authority: "provider_reported" as const },
        limit: { quantity: usd("100"), authority: "provider_reported" as const },
        remaining: { quantity: usd("25"), authority: "provider_reported" as const },
      },
    } satisfies QuotaToastEntry;

    expect(
      interpretAccountingRow(entry, {
        booleanWording: "semantic",
        basis: { kind: "summary", mode: "remaining" },
      }).basis,
    ).toEqual({ kind: "summary", text: "Remaining: USD 25.00" });
    expect(
      interpretAccountingRow(entry, {
        booleanWording: "semantic",
        basis: { kind: "summary", mode: "used" },
      }).basis,
    ).toEqual({ kind: "summary", text: "Used: USD 75.00" });
    expect(
      interpretAccountingRow(entry, {
        booleanWording: "semantic",
        basis: { kind: "detailed" },
      }).basis,
    ).toEqual({
      kind: "detailed",
      facts: [
        { role: "used", text: "Used: USD 75.00" },
        { role: "limit", text: "Limit: USD 100.00" },
        { role: "remaining", text: "Remaining: USD 25.00" },
      ],
    });

    const invalidBasis = {
      ...entry,
      basis: {
        remaining: {
          quantity: usd("01"),
          authority: "provider_reported" as const,
        },
      },
    };
    expect(interpretAccountingRow(invalidBasis, { booleanWording: "semantic" })).not.toHaveProperty(
      "basis",
    );
    expect(() =>
      interpretAccountingRow(invalidBasis, {
        booleanWording: "semantic",
        basis: { kind: "detailed" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      interpretAccountingRow(
        { accounting: ACCOUNTING, kind: "quantity", name: "bad", quantity: usd("01") },
        { booleanWording: "semantic" },
      ),
    ).toThrow(TypeError);
  });

  it("orders result meanings, typed windows, and components while preserving named ties", () => {
    const quotaMonth = semanticEntry({
      resultType: "quota",
      metric: { kind: "window", window: "month" },
    });
    const quotaDay = semanticEntry({
      resultType: "quota",
      metric: { kind: "window", window: "day" },
    });
    const budget = semanticEntry({ resultType: "budget", metric: { kind: "aggregate" } });
    const balanceTotal = semanticEntry({
      resultType: "balance",
      metric: { kind: "component", component: "total_balance" },
      kind: "quantity",
    });
    const balanceCurrent = semanticEntry({
      resultType: "balance",
      metric: { kind: "component", component: "current_balance" },
      kind: "quantity",
    });
    const namedA = semanticEntry({ resultType: "spend", metric: { kind: "named", name: "B" } });
    const namedB = semanticEntry({ resultType: "spend", metric: { kind: "named", name: "A" } });

    expect(
      [balanceTotal, budget, quotaMonth, balanceCurrent, quotaDay].sort(
        compareAccountingSemanticEntries,
      ),
    ).toEqual([quotaDay, quotaMonth, budget, balanceCurrent, balanceTotal]);
    expect(compareAccountingSemanticEntries(namedA, namedB)).toBe(0);
  });
});
