/**
 * IPC handlers for the menubar's History tab (quota burn-down, model cost
 * breakdown, weekly reset history).
 *
 * Reads the same `quota-dashboard.db` the plugin process writes to, directly
 * via DashboardApi - no HTTP server involved. Electron can't load
 * better-sqlite3 (native module, wrong V8 ABI - see dashboard/sqljs-database.ts),
 * so this uses the same read-only sql.js/WASM adapter the (now-removed)
 * in-process Express server used, re-reading the file whenever its mtime
 * changes so it reflects the plugin's latest writes.
 */

import path from "path";

import type {
  DashboardApi as DashboardApiType,
  ModelUsage,
  QuotaSnapshot,
  WeeklyReset,
} from "../../dashboard/api.js";
import { getOpenCodeDbPath } from "../../lib/opencode-storage.js";

let dashboardApi: Promise<DashboardApiType | null> | null = null;

function loadDashboardApi(): Promise<DashboardApiType | null> {
  if (!dashboardApi) {
    dashboardApi = (async () => {
      const openCodeDbPath = getOpenCodeDbPath();
      if (!openCodeDbPath) return null;

      const dashboardDbPath = path.join(path.dirname(openCodeDbPath), "quota-dashboard.db");
      const [{ SqlJsDatabaseAdapter }, { DashboardApi }] = await Promise.all([
        import("../../dashboard/sqljs-database.js"),
        import("../../dashboard/api.js"),
      ]);

      const adapter = await SqlJsDatabaseAdapter.open(dashboardDbPath);
      return new DashboardApi(adapter as any);
    })().catch((err) => {
      dashboardApi = null; // allow retry on next call
      console.error(
        "[gui] Dashboard history unavailable:",
        err instanceof Error ? err.message : err,
      );
      throw new Error("Local history unavailable");
    });
  }
  return dashboardApi;
}

export async function listProviders(): Promise<string[]> {
  const api = await loadDashboardApi();
  return api ? api.listProviders() : [];
}

export async function getQuotaHistory(params: {
  provider: string;
  days?: number;
}): Promise<QuotaSnapshot[]> {
  const api = await loadDashboardApi();
  return api ? api.getQuotaHistory(params.provider, params.days) : [];
}

export async function getModelBreakdown(params: {
  provider: string;
  days?: number;
}): Promise<ModelUsage[]> {
  const api = await loadDashboardApi();
  return api ? api.getModelBreakdown(params.provider, params.days) : [];
}

export async function getWeeklyResets(params: {
  provider: string;
  weeks?: number;
}): Promise<WeeklyReset[]> {
  const api = await loadDashboardApi();
  return api ? api.getWeeklyResets(params.provider, params.weeks) : [];
}
