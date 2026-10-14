import { describe, expect, it, vi } from "vitest";
import { evaluateDesktopBudgets, budgetSince } from "../src/gui/budget-evaluation.js";
import { HistoryBudgetRuntime } from "../src/gui/history-budget-runtime.js";
import { emptyTokenBuckets } from "../src/lib/token-buckets.js";
import type { AggregateResult } from "../src/lib/quota-stats.js";
import type { BudgetAlertRule, BudgetTimeWindow } from "../src/lib/budget-alerts.js";

function rule(window: BudgetTimeWindow, extra: Partial<BudgetAlertRule> = {}): BudgetAlertRule {
  return {
    id: window,
    name: window,
    enabled: true,
    scope: { type: "global" },
    window,
    metric: "cost_usd",
    threshold: 5,
    direction: "above",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}
function aggregate(cost: number): AggregateResult {
  const tokens = { ...emptyTokenBuckets(), input: 123 };
  return {
    window: {},
    totals: {
      priced: tokens,
      unknown: emptyTokenBuckets(),
      unpriced: emptyTokenBuckets(),
      costUsd: cost,
      messageCount: 1,
      sessionCount: 1,
    },
    bySourceProvider: [{ providerID: "connector", tokens, costUsd: cost, messageCount: 1 }],
    bySourceModel: [
      {
        sourceProviderID: "connector",
        sourceModelID: "source-model",
        tokens,
        costUsd: cost,
        messageCount: 1,
      },
    ],
    byModel: [
      {
        key: { provider: "pricing-provider", model: "priced-model" },
        tokens,
        costUsd: cost,
        messageCount: 1,
      },
    ],
    bySession: [],
    unknown: [],
    unpriced: [],
  };
}
describe("desktop budget windows and source scopes", () => {
  it("evaluates different windows independently using one captured upper timestamp", () => {
    const now = 2_000_000_000_000;
    const windows = ["day", "week", "month", "all"] as const;
    const results = evaluateDesktopBudgets(
      windows.map((w) => rule(w)),
      windows.map((window, i) => ({ window, aggregate: aggregate([2, 8, 20, 50][i]!) })),
      now,
    );
    expect(results.map((r) => r.triggered)).toEqual([false, true, true, true]);
    expect(results.map((r) => r.currentValue)).toEqual([2, 8, 20, 50]);
    expect(results.every((r) => r.evaluatedAt === now && r.window.untilMs === now)).toBe(true);
    expect(results.map((r) => r.window.sinceMs)).toEqual([
      now - 86_400_000,
      now - 7 * 86_400_000,
      now - 30 * 86_400_000,
      undefined,
    ]);
    expect(budgetSince("all", now)).toBeUndefined();
  });
  it("keeps connector/provider and source-model scopes separate from pricing aliases", () => {
    const rules = [
      rule("day", { scope: { type: "provider", providerId: "connector" } }),
      rule("day", { scope: { type: "model", providerId: "connector", modelId: "source-model" } }),
      rule("day", { scope: { type: "provider", providerId: "pricing-provider" } }),
    ];
    expect(
      evaluateDesktopBudgets(rules, [{ window: "day", aggregate: aggregate(9) }], 1).map(
        (r) => r.currentValue,
      ),
    ).toEqual([9, 9, 0]);
  });
  it("does not trigger below thresholds on failed reads or unpriced costs; still counts unpriced tokens", () => {
    const data = aggregate(2);
    data.unpriced.push({
      key: {
        sourceProviderID: "connector",
        sourceModelID: "source-model",
        mappedProvider: "pricing-provider",
        mappedModel: "priced-model",
        reason: "missing",
      },
      tokens: { ...emptyTokenBuckets(), input: 10 },
      messageCount: 1,
    });
    const costRule = rule("day", { direction: "below" });
    expect(
      evaluateDesktopBudgets([costRule], [{ window: "day", error: "db locked" }], 1)[0],
    ).toMatchObject({ status: "unknown", triggered: false, currentValue: null });
    expect(
      evaluateDesktopBudgets([costRule], [{ window: "day", aggregate: data }], 1)[0],
    ).toMatchObject({ status: "unknown", triggered: false });
    const tokenRule = rule("day", {
      metric: "tokens_input",
      scope: { type: "provider", providerId: "connector" },
      threshold: 130,
    });
    expect(
      evaluateDesktopBudgets([tokenRule], [{ window: "day", aggregate: data }], 1)[0],
    ).toMatchObject({ status: "ok", currentValue: 133, triggered: true });
  });
  it("uses one request per distinct window and re-evaluates changed rules without provider work", async () => {
    let rules = [rule("day"), rule("day", { id: "second" }), rule("week")];
    const request = vi.fn(async (message: any) =>
      message.windows.map((window: BudgetTimeWindow) => ({ window, aggregate: aggregate(8) })),
    );
    const onBudgets = vi.fn();
    const runtime = new HistoryBudgetRuntime({
      helper: { request: request as any, dispose: vi.fn() },
      rules: async () => rules,
      pricing: () => ({ source: "bundled", autoRefresh: 0 }),
      onBudgets,
    });
    expect((await runtime.evaluate()).triggeredCount).toBe(3);
    expect(request.mock.calls[0]![0].windows).toEqual(["day", "week"]);
    rules = [rule("month", { threshold: 10 })];
    expect((await runtime.evaluate()).triggeredCount).toBe(0);
    expect(onBudgets).toHaveBeenCalledTimes(2);
    runtime.dispose();
    await runtime.evaluate();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps persistence failures visible while publishing unknown budgets", async () => {
    const runtime = new HistoryBudgetRuntime({
      helper: {
        request: vi.fn().mockRejectedValue(new Error("binding missing")),
        dispose: vi.fn(),
      },
      rules: async () => [rule("day", { direction: "below" })],
      pricing: () => ({ source: "bundled", autoRefresh: 0 }),
    });
    expect(await runtime.postFetch([])).toEqual([expect.stringContaining("History unavailable")]);
    expect(runtime.getState().results[0]).toMatchObject({ status: "unknown", triggered: false });
    runtime.dispose();
  });
  it("marks previous evaluations unknown when budget rules cannot be read", async () => {
    const rules = vi
      .fn()
      .mockResolvedValueOnce([rule("day")])
      .mockRejectedValueOnce(new Error("unreadable rules"));
    const runtime = new HistoryBudgetRuntime({
      helper: {
        request: vi.fn(async () => [{ window: "day", aggregate: aggregate(8) }]) as any,
        dispose: vi.fn(),
      },
      rules,
      pricing: () => ({ source: "bundled", autoRefresh: 0 }),
    });
    expect((await runtime.evaluate()).triggeredCount).toBe(1);
    const failed = await runtime.evaluate();
    expect(failed.diagnostic).toContain("Budget rules unavailable");
    expect(failed.results[0]).toMatchObject({
      status: "unknown",
      triggered: false,
      currentValue: null,
    });
    runtime.dispose();
  });
});
