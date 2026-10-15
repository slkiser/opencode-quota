import { randomUUID } from "node:crypto";
import type { AccountingRow } from "../lib/accounting.js";
import {
  detectQuotaReset,
  isQuotaResetEvent,
  type QuotaResetEvent,
  type StoredResetEvent,
  type ResetDeliveryChannel,
} from "../lib/quota-reset-transition.js";

export interface ResetDatabase {
  prepare(sql: string): {
    get(...params: any[]): any;
    all(...params: any[]): any[];
    run(...params: any[]): any;
  };
  exec(sql: string): any;
}

/** Called inside the same native transaction as the current accounting row. */
export function recordResetTransition(
  db: ResetDatabase,
  providerId: string,
  observation: { id: string; observedAt: number },
  row: AccountingRow,
  now = Date.now(),
): void {
  if (
    row.account.kind !== "opaque" ||
    row.window.kind === "unknown" ||
    row.value.kind !== "percent"
  )
    return;
  const account = row.account.digest;
  if (
    db
      .prepare(
        `SELECT 1 FROM accounting_observations WHERE provider=? AND account_identity=? AND observation_id=? AND row_id=?`,
      )
      .get(providerId, account, observation.id, row.id)
  )
    return;
  const previous = db
    .prepare(
      `SELECT observation_id, observed_at, row_data FROM accounting_observations
    WHERE provider=? AND account_identity=? AND window_id=? AND row_id=?
    ORDER BY observed_at DESC LIMIT 1`,
    )
    .get(providerId, account, row.window.id, row.id);
  if (!previous) return;
  let previousRow: AccountingRow;
  try {
    previousRow = JSON.parse(previous.row_data);
  } catch {
    return;
  } // Corruption cannot establish a transition; current data establishes a new baseline.
  const event = detectQuotaReset(
    providerId,
    { observationId: previous.observation_id, observedAt: previous.observed_at, row: previousRow },
    { observationId: observation.id, observedAt: observation.observedAt, row },
    now,
  );
  if (!event) return;
  db.prepare(
    `INSERT OR IGNORE INTO reset_events
    (id,provider,account_identity,window_id,observed_at,reset_at,event_data,state)
    VALUES(?,?,?,?,?,?,?,'pending')`,
  ).run(
    event.id,
    providerId,
    account,
    event.windowId,
    event.observedAt,
    event.resetAt,
    JSON.stringify(event),
  );
}

function parseEvent(row: any): StoredResetEvent {
  const event: unknown = JSON.parse(row.event_data);
  if (
    !isQuotaResetEvent(event) ||
    event.id !== row.id ||
    event.providerId !== row.provider ||
    event.accountIdentity !== row.account_identity ||
    event.windowId !== row.window_id ||
    event.resetAt !== row.reset_at ||
    event.observedAt !== row.observed_at ||
    !["pending", "delivering", "delivered", "uncertain"].includes(row.state)
  )
    throw new Error("Reset history unavailable");
  return {
    ...event,
    state: row.state,
    ...(row.delivered_at !== null && row.delivered_at !== undefined
      ? { deliveredAt: row.delivered_at, deliveredChannel: row.delivered_channel }
      : {}),
  };
}
export function getResetEvents(db: ResetDatabase, providerId?: string): StoredResetEvent[] {
  if (db.prepare("SELECT max(version) AS version FROM schema_version").get()?.version < 3)
    return [];
  return db
    .prepare(
      `SELECT * FROM reset_events WHERE (? IS NULL OR provider=?) ORDER BY observed_at DESC LIMIT 100`,
    )
    .all(providerId ?? null, providerId ?? null)
    .map(parseEvent);
}
export interface ResetClaim {
  event: QuotaResetEvent;
  leaseToken: string;
}
export function claimResetEvents(
  db: ResetDatabase,
  params: {
    enabled: boolean;
    watched: readonly { providerId: string; windowId: string }[];
    channel: ResetDeliveryChannel;
    consumerId: string;
    now?: number;
    leaseMs?: number;
  },
): ResetClaim[] {
  if (!params.enabled || params.watched.length === 0) return [];
  if (params.watched.length > 64) throw new Error("Too many watched reset windows");
  const now = params.now ?? Date.now();
  if (!Number.isFinite(now)) return [];
  const requestedLease = params.leaseMs ?? 30000;
  const leaseMs = Number.isFinite(requestedLease)
    ? Math.max(5000, Math.min(60000, requestedLease))
    : 30000;
  db.exec("BEGIN IMMEDIATE");
  try {
    // After a crash, an OS notice may have shown before acknowledgment. Expose
    // uncertainty rather than silently consuming it or automatically duplicating it.
    db.prepare(
      "UPDATE reset_events SET state='uncertain' WHERE state='delivering' AND lease_until <= ?",
    ).run(now);
    const selectedWindows = params.watched.map(() => "(provider=? AND window_id=?)").join(" OR ");
    const candidates = db
      .prepare(
        `SELECT * FROM reset_events WHERE state='pending'
      AND observed_at >= ? AND observed_at <= ? AND reset_at > ? AND (${selectedWindows}) ORDER BY observed_at ASC LIMIT 100`,
      )
      .all(
        now - 15 * 60000,
        now,
        now,
        ...params.watched.flatMap((watch) => [watch.providerId, watch.windowId]),
      );
    const claims: ResetClaim[] = [];
    for (const candidate of candidates) {
      const event = parseEvent(candidate);
      if (
        !params.watched.some(
          (watch) => watch.providerId === event.providerId && watch.windowId === event.windowId,
        )
      )
        continue;
      const leaseToken = `${params.consumerId}/${randomUUID()}`;
      db.prepare(
        "UPDATE reset_events SET state='delivering', lease_owner=?, lease_until=?, lease_channel=? WHERE id=? AND state='pending'",
      ).run(leaseToken, now + leaseMs, params.channel, event.id);
      claims.push({ event, leaseToken });
      if (claims.length === 10) break;
    }
    db.exec("COMMIT");
    return claims;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function settleResetEvent(
  db: ResetDatabase,
  params: {
    id: string;
    leaseToken: string;
    channel: ResetDeliveryChannel;
    delivered: boolean;
    now?: number;
  },
): boolean {
  const now = params.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE reset_events SET state=?, delivered_at=?, delivered_channel=?, lease_owner=NULL, lease_until=NULL
    WHERE id=? AND state='delivering' AND lease_owner=? AND lease_channel=? AND lease_until>=?`,
    )
    .run(
      params.delivered ? "delivered" : "pending",
      params.delivered ? now : null,
      params.delivered ? params.channel : null,
      params.id,
      params.leaseToken,
      params.channel,
      now,
    );
  return Number(result.changes) > 0;
}
