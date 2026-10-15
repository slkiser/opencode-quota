/** Private IPC worker launched using system Node. No provider requests. */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getOpenCodeDbPath } from "../lib/opencode-storage.js";
import { DashboardApi } from "../dashboard/api.js";
import { openNativeDashboardDatabase } from "../dashboard/native-database.js";
import {
  recordQuotaObservations,
  type ProviderResultForSnapshot,
} from "../dashboard/quota-snapshot-bridge.js";
import { syncTodayUsageHistory } from "../dashboard/usage-history-bridge.js";
import { aggregateUsage } from "../lib/quota-stats.js";
import { preloadUserPricing } from "../lib/user-pricing.js";
import {
  setPricingSnapshotSelection,
  setPricingSnapshotAutoRefresh,
} from "../lib/modelsdev-pricing.js";
import { budgetSince, type WindowAggregation } from "./budget-evaluation.js";
import type { BudgetTimeWindow } from "../lib/budget-alerts.js";
import type { QuotaToastConfig } from "../lib/types.js";
import {
  claimResetEvents,
  settleResetEvent,
  getResetEvents,
  advertiseResetDesktop,
  retryUncertainReset,
} from "../dashboard/reset-events.js";

export type HistoryRequest =
  | ({ operation: "reset-desktop" } & Parameters<typeof advertiseResetDesktop>[1])
  | { operation: "reset-retry"; id: string }
  | ({ operation: "reset-claim" } & Parameters<typeof claimResetEvents>[1])
  | ({ operation: "reset-settle" } & Parameters<typeof settleResetEvent>[1])
  | { operation: "reset-events"; providerId?: string }
  | {
      operation: "record";
      providerResults: ProviderResultForSnapshot[];
      now: number;
      pricing: QuotaToastConfig["pricingSnapshot"];
    }
  | {
      operation: "aggregate";
      windows: BudgetTimeWindow[];
      now: number;
      pricing: QuotaToastConfig["pricingSnapshot"];
    };

let queue = Promise.resolve();
async function execute(request: HistoryRequest) {
  if ("pricing" in request) {
    setPricingSnapshotSelection(request.pricing.source);
    setPricingSnapshotAutoRefresh(request.pricing.autoRefresh);
    await preloadUserPricing();
  }
  if (request.operation === "aggregate") {
    const windows: WindowAggregation[] = [];
    for (const window of new Set(request.windows)) {
      try {
        windows.push({
          window,
          aggregate: await aggregateUsage({
            sinceMs: budgetSince(window, request.now),
            untilMs: request.now,
            strictReads: true,
          }),
        });
      } catch {
        windows.push({ window, error: "Usage unavailable" });
      }
    }
    return windows;
  }
  const dbPath = join(dirname(getOpenCodeDbPath()), "quota-dashboard.db");
  await mkdir(dirname(dbPath), { recursive: true });
  const db = await openNativeDashboardDatabase(dbPath);
  try {
    const api = new DashboardApi(db);
    if (request.operation === "reset-desktop") return advertiseResetDesktop(db, request);
    if (request.operation === "reset-retry") return retryUncertainReset(db, request.id);
    if (request.operation === "reset-claim") return claimResetEvents(db, request);
    if (request.operation === "reset-settle") return settleResetEvent(db, request);
    if (request.operation === "reset-events") return getResetEvents(db, request.providerId);
    const diagnostics = recordQuotaObservations(api, request.providerResults);
    try {
      await syncTodayUsageHistory(
        api,
        (params) => aggregateUsage({ ...params, strictReads: true }),
        request.now,
      );
    } catch {
      diagnostics.push("Usage history sync failed");
    }
    return { diagnostics };
  } finally {
    db.close();
  }
}

process.on("message", (message: { id: number; request: HistoryRequest }) => {
  queue = queue.then(async () => {
    try {
      const result = await execute(message.request);
      process.send?.({ id: message.id, result });
    } catch {
      // Never send raw DB rows, paths or exception payloads into the renderer.
      process.send?.({ id: message.id, error: "Local history helper unavailable" });
    }
  });
});
process.on("disconnect", () => process.exit(0));
