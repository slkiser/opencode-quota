import { describe, it, expect, vi } from "vitest";
import { parseOpenRouterAccounting, queryOpenRouterQuota } from "../src/lib/openrouter.js";
import { isAccountingDocument, projectAccountingToLegacy } from "../src/lib/accounting.js";
const body = (data: unknown) => ({ data });
describe("OpenRouter quota contract", () => {
  it("keeps lifetime spend separate from resetting key caps and ignores key-like labels", () => {
    const { accounting, warnings } = parseOpenRouterAccounting(
      body({
        label: "sk-or-private",
        limit: 100,
        limit_remaining: 20,
        limit_reset: "monthly",
        usage: 10000,
        usage_monthly: 80,
      }),
    );
    expect(isAccountingDocument(accounting)).toBe(true);
    expect(warnings).toEqual([]);
    expect(accounting.rows[0].value).toMatchObject({ kind: "percent", remaining: 20 });
    expect(accounting.rows[0].window).toEqual({ kind: "identified", id: "key-monthly" });
    expect(accounting.rows.find((row) => row.id === "usage")?.value).toMatchObject({
      kind: "quantity",
      quantity: { decimal: "10000" },
    });
    expect(JSON.stringify(accounting)).not.toContain("sk-or-private");
    expect(
      accounting.rows.every(
        (row) => row.account.kind === "unknown" && row.freshness.kind === "unknown",
      ),
    ).toBe(true);
  });
  it.each([
    [null, null, "status"],
    [0, 0, "quantity"],
    [100, -25, "percent"],
    [undefined, undefined, "status"],
    ["100", 10, "quantity"],
  ])("distinguishes cap %s, remaining %s and unknown limits", (limit, remaining, kind) => {
    const { accounting } = parseOpenRouterAccounting(body({ limit, limit_remaining: remaining }));
    expect(accounting.rows[0].value.kind).toBe(kind);
    if (limit === null)
      expect(accounting.rows[0].value).toEqual({ kind: "status", status: "unlimited" });
    if (limit === 100)
      expect(projectAccountingToLegacy(accounting)[0]).toMatchObject({ percentRemaining: -25 });
    if (limit === undefined)
      expect(accounting.rows[0].value).toEqual({ kind: "status", status: "unknown" });
  });
  it("retains valid budget/request rows while rejecting malformed data independently", () => {
    const { accounting, warnings } = parseOpenRouterAccounting(
      body({
        limit: null,
        usage: "bad",
        budgets: [
          {
            scope: "workspace",
            budget_id: "private-id",
            limit_usd: 50,
            remaining_usd: -5,
            spend_usd: 55,
            resets_at: "2026-11-01T00:00:00Z",
            reset_interval: "monthly",
          },
          { scope: "invalid", limit_usd: 10 },
        ],
        free_model_daily_requests: { limit: 50, used: 12, remaining: 38 },
      }),
    );
    expect(isAccountingDocument(accounting)).toBe(true);
    expect(accounting.rows[1].value).toMatchObject({
      kind: "percent",
      remaining: -10,
      basis: { used: { quantity: { decimal: "55" } } },
    });
    expect(accounting.rows[2].value).toMatchObject({ kind: "percent", remaining: 76 });
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(accounting)).not.toContain("private-id");
    expect(accounting.rows[1].window.kind).toBe("identified");
  });
  it.each([null, [], { data: null }, { data: [] }, {}])(
    "rejects missing response envelopes",
    (payload) => {
      expect(() => parseOpenRouterAccounting(payload)).toThrow("Invalid OpenRouter quota response");
    },
  );
  it("bounds budget rows and does not promote malformed unlimited or numeric strings", () => {
    const { accounting, warnings } = parseOpenRouterAccounting(
      body({
        limit: "unlimited",
        budgets: Array.from({ length: 100 }, () => ({
          scope: "member",
          limit_usd: 10,
          remaining_usd: 5,
          spend_usd: 5,
        })),
      }),
    );
    expect(accounting.rows).toHaveLength(65);
    expect(warnings).toContain("OpenRouter budget list truncated");
    expect(accounting.rows[0].value).toMatchObject({ status: "unknown" });
  });
  it("uses a bounded read-only request, refuses redirects and sanitizes failure diagnostics", async () => {
    const remote = vi.fn(
      async () =>
        new Response(JSON.stringify(body({ limit: 100, limit_remaining: 75 })), { status: 200 }),
    );
    vi.stubGlobal("fetch", remote);
    expect((await queryOpenRouterQuota("fixture-key", 100)).success).toBe(true);
    expect(remote).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
      }),
    );
    remote.mockResolvedValueOnce(
      new Response("fixture-key private server diagnostic", { status: 401 }),
    );
    expect(await queryOpenRouterQuota("fixture-key")).toEqual({
      success: false,
      error: "OpenRouter quota HTTP 401",
    });
    remote.mockRejectedValueOnce(new Error("fixture-key"));
    expect(JSON.stringify(await queryOpenRouterQuota("fixture-key"))).not.toContain("fixture-key");
  });
});
