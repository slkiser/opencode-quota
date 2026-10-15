import { describe, expect, it } from "vitest";
import {
  accountingQuantityFromNumber,
  formatAccountingQuantity,
  isAccountingDocument,
  projectAccountingToLegacy,
  type AccountingDocument,
  type AccountingRow,
} from "../src/lib/accounting.js";
import { cloneQuotaProviderResult } from "../src/lib/quota-state.js";

function row(id: string, value: AccountingRow["value"]): AccountingRow {
  return {
    id,
    name: id,
    resultType: "balance",
    prominence: "primary",
    source: {
      id: "fixture",
      acquisitionMethod: "remote_api",
      authority: "provider_reported",
      ownership: "maintained",
    },
    account: { kind: "unknown" },
    freshness: { kind: "unknown" },
    window: { kind: "unknown" },
    value,
  };
}
const doc = (...rows: AccountingRow[]): AccountingDocument => ({ version: 1, rows });
describe("structured accounting compatibility", () => {
  it("preserves mixed currencies and decimal precision without converting quantities to percents", () => {
    const output = projectAccountingToLegacy(
      doc(
        row("usd", {
          kind: "quantity",
          quantity: { decimal: "9007199254740993.001", unit: { kind: "currency", code: "USD" } },
        }),
        row("eur", {
          kind: "quantity",
          quantity: { decimal: "0.00", unit: { kind: "currency", code: "EUR" } },
        }),
        row("credit", {
          kind: "quantity",
          quantity: { decimal: "1.0", unit: { kind: "count", unit: "credit" } },
        }),
        row("custom", {
          kind: "quantity",
          quantity: { decimal: "3.5", unit: { kind: "custom", symbol: "GPU-h" } },
        }),
      ),
    );
    expect(output).toEqual([
      { name: "usd", kind: "value", value: "USD 9007199254740993.001" },
      { name: "eur", kind: "value", value: "EUR 0.00" },
      { name: "credit", kind: "value", value: "1.0 credit" },
      { name: "custom", kind: "value", value: "3.5 GPU-h" },
    ]);
  });
  it("distinguishes zero, unknown, unlimited and over-limit; basis never supplies a missing percentage", () => {
    const rows = doc(
      row("zero", { kind: "percent", remaining: 0 }),
      row("over", { kind: "percent", remaining: -12.5 }),
      row("missing", {
        kind: "percent",
        remaining: null,
        basis: {
          used: {
            authority: "provider_reported",
            quantity: { decimal: "0", unit: { kind: "count", unit: "token" } },
          },
        },
      }),
      row("unlimited", { kind: "status", status: "unlimited" }),
      row("no-balance", { kind: "quantity", quantity: null }),
      row("disabled", { kind: "boolean", value: false }),
    );
    expect(projectAccountingToLegacy(rows)).toEqual([
      { name: "zero", percentRemaining: 0 },
      { name: "over", percentRemaining: -12.5 },
      { name: "missing", kind: "value", value: "Unknown" },
      { name: "unlimited", kind: "value", value: "Unlimited" },
      { name: "no-balance", kind: "value", value: "Unknown" },
      { name: "disabled", kind: "value", value: "No" },
    ]);
  });
  it("keeps account, source authority, freshness and window evidence independent of labels", () => {
    const a = row("a", { kind: "percent", remaining: 20 });
    a.account = { kind: "opaque", digest: "a".repeat(64) };
    a.source.authority = "locally_derived";
    a.freshness = { kind: "observed", observedAtIso: "2026-10-01T12:00:00.000Z" };
    a.window = {
      kind: "fixed",
      id: "monthly",
      startedAtIso: "2026-10-01T00:00:00.000Z",
      endsAtIso: "2026-11-01T00:00:00.000Z",
      fullReset: false,
    };
    const b = structuredClone(a);
    b.id = "b";
    b.account = { kind: "opaque", digest: "b".repeat(64) };
    const input = doc(a, b);
    expect(isAccountingDocument(input)).toBe(true);
    expect(projectAccountingToLegacy(input)).toHaveLength(2);
    const clone = cloneQuotaProviderResult({
      attempted: true,
      entries: [],
      errors: [],
      accounting: input,
    });
    clone.accounting!.rows[0].source.authority = "unknown";
    clone.accounting!.rows[0].window = { kind: "unknown" };
    expect(input.rows[0].source.authority).toBe("locally_derived");
    expect(input.rows[0].window.kind).toBe("fixed");
  });
  it.each(["01", "1e3", "NaN", "Infinity", "-0", "-0.00", ".1"])(
    "rejects invalid decimal %s",
    (decimal) => {
      expect(
        isAccountingDocument(
          doc(
            row("bad", {
              kind: "quantity",
              quantity: { decimal, unit: { kind: "currency", code: "USD" } },
            }),
          ),
        ),
      ).toBe(false);
    },
  );
  it("validates documents, duplicate identities and unsafe account identifiers", () => {
    const valid = row("a", { kind: "percent", remaining: 50 });
    expect(isAccountingDocument({ version: 2, rows: [] })).toBe(false);
    expect(isAccountingDocument(doc(valid, valid))).toBe(false);
    expect(
      isAccountingDocument(
        doc({ ...valid, account: { kind: "opaque", digest: "alice@example.com" } }),
      ),
    ).toBe(false);
    expect(
      isAccountingDocument(doc({ ...valid, value: { kind: "percent", remaining: NaN } })),
    ).toBe(false);
    expect(() =>
      projectAccountingToLegacy({ version: 9, rows: [] } as unknown as AccountingDocument),
    ).toThrow(TypeError);
  });
  it("expands provider number notation without float-based display arithmetic", () => {
    expect(accountingQuantityFromNumber(1e-7, { kind: "count", unit: "token" })?.decimal).toBe(
      "0.0000001",
    );
    expect(accountingQuantityFromNumber(-1e21, { kind: "count", unit: "token" })?.decimal).toBe(
      "-1000000000000000000000",
    );
    expect(accountingQuantityFromNumber(Infinity, { kind: "currency", code: "USD" })).toBeNull();
    expect(() =>
      formatAccountingQuantity({ decimal: "1e2", unit: { kind: "currency", code: "USD" } }),
    ).toThrow(TypeError);
  });
});
