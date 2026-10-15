import { describe, it, expect, vi } from "vitest";
import { parseKiloBalance, parseKiloPass, queryKiloQuota } from "../src/lib/kilo.js";
import { isAccountingDocument } from "../src/lib/accounting.js";
const pass = (subscription: unknown) => [{ result: { data: { json: { subscription } } } }];
const subscription = {
  currentPeriodBaseCreditsUsd: 50,
  currentPeriodUsageUsd: 20,
  currentPeriodHostingCostUsd: 5,
  currentPeriodBonusCreditsUsd: 50,
  currentPeriodBonus: { status: "available", actualAmountUsd: null, projectedAmountUsd: 50 },
  nextBillingAt: "2026-11-15T00:00:00Z",
};
describe("Kilo current quota contracts", () => {
  it.each([0, 12.345678, -1.25])("preserves the authoritative personal balance %s", (balance) => {
    const row = parseKiloBalance({ balance, isDepleted: balance <= 0 });
    expect(row.value).toMatchObject({
      kind: "quantity",
      quantity: { decimal: String(balance), unit: { code: "USD" } },
    });
    expect(row.window).toEqual({ kind: "unknown" });
    expect(row.account).toEqual({ kind: "unknown" });
  });
  it("keeps potential bonus separate, does not add included hosting twice and does not label billing as reset", () => {
    const rows = parseKiloPass(pass(subscription));
    expect(isAccountingDocument({ version: 1, rows })).toBe(true);
    expect(rows.find((row) => row.id === "pass-spend")?.value).toMatchObject({
      quantity: { decimal: "20" },
    });
    expect(rows.find((row) => row.id === "pass-hosting")?.name).toContain("included");
    expect(rows.find((row) => row.id === "pass-bonus-potential")?.name).toContain("not issued");
    expect(rows.some((row) => row.value.kind === "percent")).toBe(false);
    expect(rows.every((row) => !("resetTimeIso" in row.window))).toBe(true);
    expect(rows.find((row) => row.id === "pass-billing")?.name).toContain("not a quota reset");
  });
  it("uses actual issued bonus instead of projected values and leaves legacy ambiguous bonuses unknown", () => {
    const issued = parseKiloPass(
      pass({
        ...subscription,
        currentPeriodBonus: { status: "issued", actualAmountUsd: 12, projectedAmountUsd: 50 },
      }),
    );
    expect(issued.find((row) => row.id === "pass-bonus-issued")?.value).toMatchObject({
      quantity: { decimal: "12" },
    });
    expect(issued.some((row) => row.id === "pass-bonus-potential")).toBe(false);
    const legacy = parseKiloPass(pass({ ...subscription, currentPeriodBonus: undefined }));
    expect(legacy.find((row) => row.id === "pass-bonus-unknown")?.value).toEqual({
      kind: "status",
      status: "unknown",
    });
    expect(parseKiloPass(pass(null))).toEqual([]);
  });
  it.each([
    {},
    [],
    { result: { data: { json: {} } } },
    pass({}),
    pass({ ...subscription, currentPeriodUsageUsd: -1 }),
    pass({ ...subscription, currentPeriodHostingCostUsd: "5" }),
  ])("rejects malformed Pass state without inventing an absent subscription", (payload) => {
    expect(() => parseKiloPass(payload)).toThrow();
  });
  it("retains balance when optional Pass permission fails and sanitizes all failures", async () => {
    const remote = vi.fn(async (url: unknown, init: any) => {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.headers.Authorization).toBe("Bearer fixture-key");
      return String(url).includes("profile/balance")
        ? new Response(JSON.stringify({ balance: 12.5 }))
        : new Response("fixture-key private error", { status: 403 });
    });
    vi.stubGlobal("fetch", remote);
    const result = await queryKiloQuota("fixture-key", 100);
    expect(result.accounting.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-key");
    expect(remote).toHaveBeenCalledTimes(2);
  });
  it("retains valid Pass facts when balance is unavailable and rejects oversized optional bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).includes("profile/balance")
          ? new Response("denied", { status: 401 })
          : new Response(JSON.stringify(pass(subscription))),
      ),
    );
    const partial = await queryKiloQuota("fixture", 100);
    expect(partial.accounting.rows.some((row) => row.id === "pass-spend")).toBe(true);
    expect(partial.accounting.rows.some((row) => row.id === "balance")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(65537))),
    );
    expect((await queryKiloQuota("fixture", 100)).errors).toHaveLength(2);
  });
  it("bounds both parallel quota requests with the shared response deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const result = queryKiloQuota("fixture-key", 10);
    await vi.advanceTimersByTimeAsync(11);
    expect((await result).errors).toHaveLength(2);
    vi.useRealTimers();
  });
});
