import {
  evaluateBudgetAlert,
  type BudgetAlertRule,
  type BudgetAlertResult,
  type BudgetAlertUsage,
  type BudgetTimeWindow,
} from "../lib/budget-alerts.js";
import { addTokenBuckets, emptyTokenBuckets } from "../lib/token-buckets.js";
import type { AggregateResult } from "../lib/quota-stats.js";

export interface DesktopBudgetResult extends Omit<
  BudgetAlertResult,
  "currentValue" | "percentUsed"
> {
  currentValue: number | null;
  percentUsed: number | null;
  status: "ok" | "unknown";
  window: { sinceMs?: number; untilMs: number };
}
export interface BudgetEvaluationState {
  revision: number;
  evaluatedAt: number | null;
  results: DesktopBudgetResult[];
  rules: BudgetAlertRule[];
  triggeredCount: number;
  diagnostic?: string;
}
export type WindowAggregation = {
  window: BudgetTimeWindow;
  aggregate?: AggregateResult;
  error?: string;
};

export function budgetSince(window: BudgetTimeWindow, now: number): number | undefined {
  const days = { day: 1, week: 7, month: 30 };
  return window === "all" ? undefined : now - days[window] * 86_400_000;
}

/** Use connector/source buckets, not the provider to which pricing resolved. */
function scopeUsage(rule: BudgetAlertRule, aggregate: AggregateResult) {
  const usage: BudgetAlertUsage = { tokens: emptyTokenBuckets(), costUsd: 0, messageCount: 0 };
  const matches = (provider: string, model?: string) =>
    rule.scope.type === "global" ||
    (rule.scope.providerId === provider &&
      (rule.scope.type === "provider" || rule.scope.modelId === model));
  const rows = aggregate.bySourceModel.filter((row) =>
    matches(row.sourceProviderID, row.sourceModelID),
  );
  for (const row of rows) {
    usage.tokens = addTokenBuckets(usage.tokens, row.tokens);
    usage.costUsd += row.costUsd;
    usage.messageCount += row.messageCount;
  }
  let unknownCost = false;
  let unknownScope = false;
  for (const row of [...aggregate.unknown, ...aggregate.unpriced]) {
    const provider = row.key.sourceProviderID;
    const model = row.key.sourceModelID;
    if (matches(provider, model)) {
      usage.tokens = addTokenBuckets(usage.tokens, row.tokens);
      usage.messageCount += row.messageCount;
      unknownCost = true;
    } else if (
      provider === "unknown" ||
      (rule.scope.type === "model" && provider === rule.scope.providerId && model === "unknown")
    ) {
      unknownScope = true;
    }
  }
  if (rule.scope.type === "global") {
    usage.tokens = addTokenBuckets(
      addTokenBuckets(aggregate.totals.priced, aggregate.totals.unknown),
      aggregate.totals.unpriced,
    );
    usage.costUsd = aggregate.totals.costUsd;
    usage.messageCount = aggregate.totals.messageCount;
    unknownCost = aggregate.unknown.length > 0 || aggregate.unpriced.length > 0;
  }
  return { usage, unknownCost, unknownScope };
}

export function evaluateDesktopBudgets(
  rules: BudgetAlertRule[],
  windows: WindowAggregation[],
  now: number,
): DesktopBudgetResult[] {
  return rules
    .filter((rule) => rule.enabled)
    .map((rule) => {
      const window = { sinceMs: budgetSince(rule.window, now), untilMs: now };
      const data = windows.find((item) => item.window === rule.window);
      const scoped = data?.aggregate ? scopeUsage(rule, data.aggregate) : null;
      const message = !scoped
        ? "Usage unavailable: local history could not be read"
        : scoped.unknownScope
          ? "Usage unknown: source attribution is incomplete"
          : rule.metric === "cost_usd" && scoped.unknownCost
            ? "Cost unknown: some usage has no price"
            : null;
      if (message)
        return {
          rule,
          triggered: false,
          currentValue: null,
          percentUsed: null,
          message,
          evaluatedAt: now,
          status: "unknown",
          window,
        };
      return {
        ...evaluateBudgetAlert(rule, scoped!.usage),
        evaluatedAt: now,
        status: "ok",
        window,
      };
    });
}
