import { getBudgetAlertRules, type BudgetAlertRule } from "../lib/budget-alerts.js";
import type { QuotaToastConfig } from "../lib/types.js";
import type { ProviderResultForSnapshot } from "../dashboard/quota-snapshot-bridge.js";
import { HistoryHelperClient } from "./history-client.js";
import {
  evaluateDesktopBudgets,
  type BudgetEvaluationState,
  type WindowAggregation,
} from "./budget-evaluation.js";

/** One post-fetch flow, no timers or provider requests of its own. */
export class HistoryBudgetRuntime {
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private state: BudgetEvaluationState = {
    revision: 0,
    evaluatedAt: null,
    results: [],
    rules: [],
    triggeredCount: 0,
  };
  constructor(
    private readonly options: {
      helper?: Pick<HistoryHelperClient, "request" | "dispose">;
      rules?: () => Promise<BudgetAlertRule[]>;
      pricing: () => QuotaToastConfig["pricingSnapshot"];
      onBudgets?: (state: BudgetEvaluationState) => void;
      onHistory?: () => void;
    },
  ) {
    this.helper = options.helper ?? new HistoryHelperClient();
  }
  private helper: Pick<HistoryHelperClient, "request" | "dispose">;
  getState(): BudgetEvaluationState {
    return structuredClone(this.state);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  postFetch(results: ProviderResultForSnapshot[]): Promise<string[]> {
    return this.serialize(async () => {
      if (this.disposed) return [];
      const now = Date.now();
      let diagnostics: string[] = [];
      try {
        const recorded = await this.helper.request<{ diagnostics: string[] }>({
          operation: "record",
          providerResults: results,
          now,
          pricing: this.options.pricing(),
        });
        diagnostics = recorded.diagnostics;
        if (!this.disposed) {
          try {
            this.options.onHistory?.();
          } catch {
            /* Closed renderer. */
          }
        }
      } catch {
        diagnostics = [
          "History unavailable: system Node with SQLite support is required, or the database is busy",
        ];
      }
      if (!this.disposed) {
        try {
          await this.evaluateNow();
        } catch {
          diagnostics.push("Budget evaluation unavailable");
        }
      }
      return diagnostics;
    });
  }
  evaluate(): Promise<BudgetEvaluationState> {
    return this.serialize(() => this.evaluateNow());
  }
  private async evaluateNow(): Promise<BudgetEvaluationState> {
    if (this.disposed) return this.getState();
    let rules = this.state.rules;
    let diagnostic: string | undefined;
    try {
      rules = await (
        this.options.rules ?? (() => getBudgetAlertRules({ strictReads: true, forceReload: true }))
      )();
    } catch {
      diagnostic = "Budget rules unavailable; saved evaluations are not current";
    }
    const now = Date.now();
    let windows: WindowAggregation[] = [];
    const requested = [...new Set(rules.filter((rule) => rule.enabled).map((rule) => rule.window))];
    if (requested.length && !diagnostic) {
      try {
        windows = await this.helper.request<WindowAggregation[]>({
          operation: "aggregate",
          windows: requested,
          now,
          pricing: this.options.pricing(),
        });
      } catch {
        /* All requested windows evaluate as unknown, never zero. */
      }
    }
    if (this.disposed) return this.getState();
    const results = evaluateDesktopBudgets(rules, windows, now);
    this.state = {
      revision: this.state.revision + 1,
      evaluatedAt: now,
      results,
      rules,
      triggeredCount: results.filter((item) => item.triggered).length,
      ...(diagnostic ? { diagnostic } : {}),
    };
    try {
      this.options.onBudgets?.(this.getState());
    } catch {
      /* Closed renderer. */
    }
    return this.getState();
  }
  dispose(): void {
    this.disposed = true;
    this.helper.dispose();
  }
}
