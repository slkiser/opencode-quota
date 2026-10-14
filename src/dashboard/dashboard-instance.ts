/**
 * Lazy, best-effort singleton for the dashboard's SQLite-backed DashboardApi.
 *
 * Used from the plugin's live quota-fetch path to persist snapshots as a
 * side effect of work already being done. Must never throw into callers:
 * if no SQLite backend is available, or the OpenCode data directory can't
 * be found, dashboard snapshotting is silently unavailable and the
 * toast/status-report path continues unaffected.
 *
 * Backend selection mirrors lib/opencode-sqlite.ts's Bun-detection pattern:
 * opencode's actual plugin runtime is Bun, where bun:sqlite (built directly
 * into the runtime, no native-module ABI concerns) is used; better-sqlite3
 * is a fallback for Node-based contexts (the standalone CLI, tests).
 */

import { dirname, join } from "path";
import { getOpenCodeDbPath } from "../lib/opencode-storage.js";
import type { DashboardApi as DashboardApiType } from "./api.js";

let cached: DashboardApiType | null | undefined;

async function openDatabase(dbPath: string): Promise<unknown> {
  if (typeof globalThis === "object" && "Bun" in globalThis) {
    const { BunSqliteDatabaseAdapter } = await import("./bun-sqlite-database.js");
    return BunSqliteDatabaseAdapter.open(dbPath);
  }

  const Database = await import("better-sqlite3").then((mod) => mod.default);
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 1500");
  return db;
}

export async function getDashboardApi(): Promise<DashboardApiType | null> {
  if (cached !== undefined) return cached;

  try {
    const openCodeDbPath = getOpenCodeDbPath();
    if (!openCodeDbPath) {
      cached = null;
      return cached;
    }

    const dashboardDbPath = join(dirname(openCodeDbPath), "quota-dashboard.db");
    const [{ DashboardApi }, db] = await Promise.all([
      import("./api.js"),
      openDatabase(dashboardDbPath),
    ]);

    cached = new DashboardApi(db as any);
  } catch (err) {
    console.error(
      "[dashboard] Snapshot capture unavailable:",
      err instanceof Error ? err.message : err,
    );
    cached = null;
  }

  return cached;
}
