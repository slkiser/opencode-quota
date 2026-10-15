import { describe, expect, it } from "vitest";
import { copilotAccounting, openAIAccounting } from "../src/providers/accounting-adapters.js";
import { isAccountingDocument, projectAccountingToLegacy } from "../src/lib/accounting.js";

describe("provider accounting facts", () => {
  it("preserves exact OpenAI windows without inferring an account, source timestamp or full reset", () => {
    const doc = openAIAccounting({
      success: true,
      label: "OpenAI",
      email: "private@example.com",
      windows: {
        weekly: { percentRemaining: 0, resetTimeIso: "2026-10-20T00:00:00Z" },
        monthly: { percentRemaining: 42 },
      },
    });
    expect(isAccountingDocument(doc)).toBe(true);
    expect(doc.rows.map((r) => [r.id, r.account, r.freshness, r.window, r.value])).toEqual([
      [
        "weekly",
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "identified", id: "weekly", resetTimeIso: "2026-10-20T00:00:00Z" },
        { kind: "percent", remaining: 0 },
      ],
      [
        "monthly",
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "identified", id: "monthly" },
        { kind: "percent", remaining: 42 },
      ],
    ]);
    expect(JSON.stringify(doc)).not.toContain("private@example.com");
    expect(openAIAccounting({ success: true, label: "OpenAI", windows: {} }).rows).toEqual([]);
  });
  it("does not assign USD to an OpenAI credit balance without a declared unit", () => {
    const doc = openAIAccounting({
      success: true,
      label: "OpenAI",
      windows: {},
      credits: { hasCredits: true, unlimited: true, balance: "9.50" },
    });
    expect(doc.rows.map((r) => r.value)).toEqual([
      { kind: "boolean", value: true },
      { kind: "status", status: "unknown", detail: "9.50" },
      { kind: "status", status: "unlimited" },
    ]);
    expect(doc.rows.every((r) => r.prominence === "supplementary")).toBe(true);
  });
  it("keeps Copilot over-limit operands, credits, spend and supplementary usage typed", () => {
    const doc = copilotAccounting({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      authority: "provider_reported",
      used: 125,
      total: 100,
      percentRemaining: -25,
      includedUsed: 100,
      billedUsed: 25,
      billedAmountUsd: 0.25,
      budget: {
        amountUsd: 10,
        spentUsd: 12,
        percentRemaining: -20,
        authority: "locally_derived",
        scope: "user",
      },
    });
    expect(isAccountingDocument(doc)).toBe(true);
    expect(doc.rows[0].value).toEqual({
      kind: "percent",
      remaining: -25,
      basis: {
        used: {
          quantity: { decimal: "125", unit: { kind: "count", unit: "credit" } },
          authority: "provider_reported",
        },
        limit: {
          quantity: { decimal: "100", unit: { kind: "count", unit: "credit" } },
          authority: "provider_reported",
        },
      },
    });
    expect(doc.rows.find((r) => r.id === "billed-usd")?.value).toEqual({
      kind: "quantity",
      quantity: { decimal: "0.25", unit: { kind: "currency", code: "USD" } },
    });
    expect(doc.rows.find((r) => r.id === "budget")?.source.authority).toBe("locally_derived");
    expect(projectAccountingToLegacy(doc)[0]).toEqual({
      name: "Copilot usage",
      percentRemaining: -25,
    });
  });
  it("preserves zero/missing limits without manufacturing percentages, and keeps unlimited separate", () => {
    for (const total of [0, undefined]) {
      const doc = copilotAccounting({
        success: true,
        mode: "user_quota",
        unit: "premium_requests",
        authority: "provider_reported",
        used: 0,
        total,
      });
      expect(doc.rows[0].value).toEqual({
        kind: "quantity",
        quantity: { decimal: "0", unit: { kind: "count", unit: "request" } },
      });
    }
    expect(
      copilotAccounting({
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        authority: "provider_reported",
        used: 0,
        unlimited: true,
      }).rows[0].value,
    ).toEqual({ kind: "status", status: "unlimited" });
  });
  it("keeps managed usage and unreadable spend distinct from the known budget limit", () => {
    const doc = copilotAccounting({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      username: "alice",
      unit: "ai_credits",
      authority: "provider_reported",
      period: { year: 2026, month: 10 },
      used: 0,
      budget: { amountUsd: 10, authority: "provider_reported", scope: "org" },
    });
    expect(doc.rows.map((r) => [r.resultType, r.value])).toEqual([
      [
        "usage",
        { kind: "quantity", quantity: { decimal: "0", unit: { kind: "count", unit: "credit" } } },
      ],
      [
        "budget",
        { kind: "quantity", quantity: { decimal: "10", unit: { kind: "currency", code: "USD" } } },
      ],
    ]);
    expect(JSON.stringify(doc)).not.toContain("alice");
    expect(doc.rows.every((r) => r.account.kind === "unknown")).toBe(true);
  });
});
