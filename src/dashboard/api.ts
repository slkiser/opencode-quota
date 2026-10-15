/**
 * Dashboard API - SQLite-backed historical quota tracking
 */

import { migrateSchema } from "./db-migrate.js";
import { isAccountingDocument, type AccountingRow } from "../lib/accounting.js";
import { recordResetTransition } from "./reset-events.js";

export interface QuotaSnapshot {
  timestamp: number;
  provider: string;
  limits: QuotaLimit[];
  percentUsed: number | null;
  percentRemaining: number | null;
  error?: string;
  accountIdentity: string;
}

export interface AccountingObservation {
  provider: string;
  observationId: string;
  timestamp: number;
  row: AccountingRow;
}

export interface QuotaLimit {
  kind: string; // 'session', 'weekly_all', 'monthly'
  group: string; // 'session', 'weekly', 'monthly'
  percent: number; // 0-100
  severity: string; // 'normal', 'warning', 'critical'
  resets_at: string; // ISO timestamp
  scope?: { model?: string }; // Optional model-specific limit
}

export interface UsageData {
  tokensInput: number;
  tokensOutput: number;
  tokensCache: number;
  costUsd: number;
  requestCount: number;
}

export interface ModelUsage {
  model: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCache: number;
  costUsd: number;
  requestCount: number;
}

export interface WeeklyReset {
  reset_at: number;
  quota_used: number;
  quota_remaining: number;
  quota_limit: number;
  reset_type: string;
}

interface DatabaseLike {
  prepare(sql: string): {
    get(...params: any[]): any;
    run(...params: any[]): any;
    all(...params: any[]): any[];
  };
  exec(sql: string): any;
  close(): void;
}

export class DashboardApi {
  private db: DatabaseLike;

  constructor(db: DatabaseLike) {
    this.db = db;
    migrateSchema(this.db);
  }

  /**
   * Capture current quota snapshot
   */
  captureSnapshot(provider: string, quotaData: any): void {
    const observation = quotaData.observation;
    const { accounting: _accounting, accountingOnly: _accountingOnly, ...legacyData } = quotaData;
    if (quotaData.accounting !== undefined && !isAccountingDocument(quotaData.accounting))
      throw new TypeError("Invalid accounting observation");
    if (observation) {
      // Serialize with all native writers. Keep the v1 schema and unique key
      // readable by older packages; the real time lives in the JSON metadata.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (quotaData.accounting)
          for (const row of quotaData.accounting.rows as AccountingRow[]) {
            recordResetTransition(this.db, provider, observation, row);
            this.db
              .prepare(
                `INSERT OR IGNORE INTO accounting_observations
            (provider, observation_id, observed_at, row_id, account_identity, window_id, row_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                provider,
                observation.id,
                observation.observedAt,
                row.id,
                row.account.kind === "opaque" ? row.account.digest : "unknown",
                row.window.kind === "unknown" ? null : row.window.id,
                JSON.stringify(row),
              );
          }
        if (quotaData.accountingOnly) {
          this.db.exec("COMMIT");
          return;
        }
        const duplicate = this.db
          .prepare(
            "SELECT id FROM quota_snapshots WHERE provider = ? AND json_extract(quota_data, '$.observation.id') = ? LIMIT 1",
          )
          .get(provider, observation.id);
        if (!duplicate) {
          let capturedAt = observation.observedAt;
          while (
            this.db
              .prepare("SELECT id FROM quota_snapshots WHERE provider = ? AND captured_at = ?")
              .get(provider, capturedAt)
          )
            capturedAt++;
          this.db
            .prepare(
              "INSERT INTO quota_snapshots (provider, captured_at, quota_data) VALUES (?, ?, ?)",
            )
            .run(provider, capturedAt, JSON.stringify(legacyData));
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO quota_snapshots (provider, captured_at, quota_data)
         VALUES (?, ?, ?)
         ON CONFLICT(provider, captured_at) 
         DO UPDATE SET quota_data = excluded.quota_data`,
      )
      .run(provider, now, JSON.stringify(legacyData));
  }

  /**
   * Get current quota (latest snapshot)
   */
  getCurrentQuota(provider: string, accountIdentity?: string): any {
    const row = this.db
      .prepare(
        `SELECT quota_data
         FROM quota_snapshots
         WHERE provider = ? AND (? IS NULL OR COALESCE(json_extract(quota_data, '$.accountIdentity'), 'unknown') = ?)
         ORDER BY COALESCE(json_extract(quota_data, '$.observation.observedAt'), captured_at) DESC, captured_at DESC
         LIMIT 1`,
      )
      .get(provider, accountIdentity ?? null, accountIdentity ?? null);

    return row ? JSON.parse(row.quota_data) : null;
  }

  /**
   * Get quota history for chart
   */
  getQuotaHistory(provider: string, days: number = 7, accountIdentity?: string): QuotaSnapshot[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const rows = this.db
      .prepare(
        `SELECT captured_at, quota_data
         FROM quota_snapshots
         WHERE provider = ? AND COALESCE(json_extract(quota_data, '$.observation.observedAt'), captured_at) >= ?
           AND (? IS NULL OR COALESCE(json_extract(quota_data, '$.accountIdentity'), 'unknown') = ?)
         ORDER BY COALESCE(json_extract(quota_data, '$.observation.observedAt'), captured_at) ASC, captured_at ASC`,
      )
      .all(provider, since, accountIdentity ?? null, accountIdentity ?? null);

    return rows.map((row: any) => {
      const data = JSON.parse(row.quota_data);
      return {
        timestamp: data.observation?.observedAt ?? row.captured_at,
        provider,
        limits: data.limits || [],
        percentUsed: typeof data.percentRemaining === "number" ? 100 - data.percentRemaining : null,
        percentRemaining: typeof data.percentRemaining === "number" ? data.percentRemaining : null,
        ...(data.error ? { error: data.error } : {}),
        accountIdentity:
          typeof data.accountIdentity === "string" && /^[a-f0-9]{64}$/u.test(data.accountIdentity)
            ? data.accountIdentity
            : "unknown",
      };
    });
  }

  /** Rich history is separate from legacy percentage tables/exports. Unknown
   * legacy observations are never relabelled as the currently selected account. */
  getAccountingHistory(
    provider: string,
    days: number = 7,
    filter: { accountIdentity?: string; windowId?: string } = {},
  ): AccountingObservation[] {
    // A read-only WASM adapter may reload a v1 file after an old writer updates
    // it. Such a file genuinely has no rich rows; do not imply a failed upgrade.
    const version = this.db
      .prepare("SELECT max(version) AS version FROM schema_version")
      .get()?.version;
    if (version < 2) return [];
    const since = Date.now() - days * 86400000;
    return this.db
      .prepare(
        `SELECT observation_id, observed_at, row_data FROM accounting_observations
      WHERE provider = ? AND observed_at >= ?
      AND (? IS NULL OR account_identity = ?)
      AND (? IS NULL OR window_id = ?)
      ORDER BY observed_at ASC, observation_id ASC, row_id ASC`,
      )
      .all(
        provider,
        since,
        filter.accountIdentity ?? null,
        filter.accountIdentity ?? null,
        filter.windowId ?? null,
        filter.windowId ?? null,
      )
      .map((data: any) => {
        const row: unknown = JSON.parse(data.row_data);
        if (!isAccountingDocument({ version: 1, rows: [row] }))
          throw new Error("Invalid stored accounting row");
        return {
          provider,
          observationId: data.observation_id,
          timestamp: data.observed_at,
          row: row as AccountingRow,
        };
      });
  }

  /**
   * Record usage for a session
   */
  recordUsage(provider: string, date: string, model: string, usage: UsageData): void {
    this.db
      .prepare(
        `INSERT INTO usage_history 
         (provider, date, model, tokens_input, tokens_output, tokens_cache, cost_usd, request_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, date, model) DO UPDATE SET
           tokens_input = tokens_input + excluded.tokens_input,
           tokens_output = tokens_output + excluded.tokens_output,
           tokens_cache = tokens_cache + excluded.tokens_cache,
           cost_usd = cost_usd + excluded.cost_usd,
           request_count = request_count + excluded.request_count`,
      )
      .run(
        provider,
        date,
        model,
        usage.tokensInput,
        usage.tokensOutput,
        usage.tokensCache,
        usage.costUsd,
        usage.requestCount,
      );
  }

  /**
   * Set (replace) the usage row for a given day/provider/model, instead of
   * incrementing like recordUsage(). Used by the history sync bridge, which
   * recomputes each day's full totals from the source pricing pipeline
   * every time rather than tracking incremental deltas — so writes must
   * replace, not add.
   */
  setUsageForDate(provider: string, date: string, model: string, usage: UsageData): void {
    this.db
      .prepare(
        `INSERT INTO usage_history
         (provider, date, model, tokens_input, tokens_output, tokens_cache, cost_usd, request_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, date, model) DO UPDATE SET
           tokens_input = excluded.tokens_input,
           tokens_output = excluded.tokens_output,
           tokens_cache = excluded.tokens_cache,
           cost_usd = excluded.cost_usd,
           request_count = excluded.request_count`,
      )
      .run(
        provider,
        date,
        model,
        usage.tokensInput,
        usage.tokensOutput,
        usage.tokensCache,
        usage.costUsd,
        usage.requestCount,
      );
  }

  /**
   * Get per-model breakdown
   */
  getModelBreakdown(provider: string, days: number = 7): ModelUsage[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const rows = this.db
      .prepare(
        `SELECT model,
                SUM(tokens_input) as tokens_input,
                SUM(tokens_output) as tokens_output,
                SUM(tokens_cache) as tokens_cache,
                SUM(cost_usd) as cost_usd,
                SUM(request_count) as request_count
         FROM usage_history
         WHERE provider = ? AND date >= ?
         GROUP BY model
         ORDER BY cost_usd DESC`,
      )
      .all(provider, since);

    return rows.map((row: any) => ({
      model: row.model,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      tokensCache: row.tokens_cache || 0,
      costUsd: row.cost_usd,
      requestCount: row.request_count,
    }));
  }

  /**
   * Get weekly reset history
   */
  getWeeklyResets(provider: string, weeks: number = 4): WeeklyReset[] {
    const since = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;

    return this.db
      .prepare(
        `SELECT reset_at, quota_used, quota_remaining, quota_limit, reset_type
         FROM weekly_resets
         WHERE provider = ? AND reset_at >= ?
         ORDER BY reset_at DESC`,
      )
      .all(provider, since);
  }

  /**
   * Record weekly reset
   */
  recordWeeklyReset(
    provider: string,
    resetType: string,
    quotaData: {
      used: number;
      remaining: number;
      limit: number;
    },
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO weekly_resets 
         (provider, reset_at, quota_used, quota_remaining, quota_limit, reset_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(provider, Date.now(), quotaData.used, quotaData.remaining, quotaData.limit, resetType);
  }

  /**
   * List every provider that has ever recorded a quota snapshot or usage
   * row — i.e. the real, current set of providers with data, rather than a
   * hardcoded guess. Used to populate the dashboard UI's provider picker so
   * it can't silently omit a provider the user actually has data for.
   */
  listProviders(): string[] {
    const rich =
      this.db.prepare("SELECT max(version) AS version FROM schema_version").get()?.version >= 2;
    const rows = this.db
      .prepare(
        `SELECT provider FROM quota_snapshots
         UNION
         SELECT provider FROM usage_history
         ${rich ? "UNION SELECT provider FROM accounting_observations" : ""}
         ORDER BY provider`,
      )
      .all();
    return rows.map((row: any) => row.provider);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
