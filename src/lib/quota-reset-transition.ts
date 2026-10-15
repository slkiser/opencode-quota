// Adapted from upstream c2dca3c14904fef36712b682b28b54d9d7c149d0 and
// cedee73770bb11fb9fa860c2545899dd46782650; identity/storage are fork-specific.
import { createHash } from "node:crypto";
import { isAccountingDocument, type AccountingRow } from "./accounting.js";

export interface ResetEvidence {
  observationId: string;
  observedAt: number;
  row: AccountingRow;
}
export interface QuotaResetEvent {
  id: string;
  providerId: string;
  accountIdentity: string;
  rowId: string;
  windowId: string;
  label: string;
  previousResetAt: number;
  resetAt: number;
  observedAt: number;
  previousRemaining: number;
  percentRemaining: number;
}
export type ResetDeliveryState = "pending" | "delivering" | "delivered" | "uncertain";
export type ResetDeliveryChannel = "desktop" | "plugin";
export interface StoredResetEvent extends QuotaResetEvent {
  state: ResetDeliveryState;
  deliveredAt?: number;
  deliveredChannel?: ResetDeliveryChannel;
}

function boundary(row: AccountingRow): number | null {
  const window = row.window;
  if (window.kind === "unknown" || window.kind === "rolling") return null;
  if (window.kind === "fixed" && !window.fullReset) return null;
  const iso = window.kind === "fixed" ? window.endsAtIso : window.resetTimeIso;
  return iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null;
}

/** Requires a fresh, newer observation across a confirmed boundary. Display
 * text, account switches, clocks alone and percentage jumps cannot prove reset. */
export function detectQuotaReset(
  providerId: string,
  previous: ResetEvidence,
  current: ResetEvidence,
  now = Date.now(),
): QuotaResetEvent | null {
  const p = previous.row,
    c = current.row;
  if (
    !isAccountingDocument({ version: 1, rows: [p] }) ||
    !isAccountingDocument({ version: 1, rows: [c] })
  )
    return null;
  if (
    p.account.kind !== "opaque" ||
    c.account.kind !== "opaque" ||
    p.account.digest !== c.account.digest ||
    p.id !== c.id ||
    p.source.id !== c.source.id ||
    p.resultType !== c.resultType ||
    c.source.authority !== "provider_reported" ||
    p.source.authority !== "provider_reported" ||
    !(c.resultType === "quota" || c.resultType === "rate_limit") ||
    p.window.kind === "unknown" ||
    c.window.kind === "unknown" ||
    p.window.id !== c.window.id ||
    p.value.kind !== "percent" ||
    c.value.kind !== "percent" ||
    p.value.remaining === null ||
    c.value.remaining === null
  )
    return null;
  const oldReset = boundary(p),
    newReset = boundary(c);
  if (
    oldReset === null ||
    newReset === null ||
    !Number.isFinite(now) ||
    !Number.isFinite(previous.observedAt) ||
    !Number.isFinite(current.observedAt) ||
    previous.observationId === current.observationId ||
    current.observedAt <= previous.observedAt ||
    now - previous.observedAt > 30 * 86400000 ||
    previous.observedAt > oldReset ||
    current.observedAt < oldReset ||
    now < oldReset ||
    now - oldReset > 86400000 ||
    newReset <= oldReset ||
    newReset <= now ||
    current.observedAt > now ||
    now - current.observedAt > 5 * 60000 ||
    p.value.remaining >= 100 ||
    c.value.remaining <= p.value.remaining
  )
    return null;
  // When provider source time exists it must independently confirm the new
  // period; a newly fetched stale provider snapshot is not a new observation.
  if (
    p.freshness.kind === "observed" &&
    Date.parse(p.freshness.observedAtIso) > previous.observedAt
  )
    return null;
  if (
    c.freshness.kind === "observed" &&
    (Date.parse(c.freshness.observedAtIso) > current.observedAt ||
      Date.parse(c.freshness.observedAtIso) < oldReset ||
      (p.freshness.kind === "observed" &&
        Date.parse(c.freshness.observedAtIso) <= Date.parse(p.freshness.observedAtIso)))
  )
    return null;
  const key = [
    "quota-reset-v1",
    providerId,
    c.account.digest,
    c.source.id,
    c.id,
    c.window.id,
    oldReset,
    newReset,
  ];
  return {
    id: createHash("sha256").update(JSON.stringify(key)).digest("hex"),
    providerId,
    accountIdentity: c.account.digest,
    rowId: c.id,
    windowId: c.window.id,
    label: c.name,
    previousResetAt: oldReset,
    resetAt: newReset,
    observedAt: current.observedAt,
    previousRemaining: p.value.remaining,
    percentRemaining: c.value.remaining,
  };
}

export function isQuotaResetEvent(value: unknown): value is QuotaResetEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as QuotaResetEvent;
  return (
    typeof e.id === "string" &&
    /^[a-f0-9]{64}$/u.test(e.id) &&
    typeof e.accountIdentity === "string" &&
    /^[a-f0-9]{64}$/u.test(e.accountIdentity) &&
    [e.providerId, e.rowId, e.windowId, e.label].every(
      (v) => typeof v === "string" && v.length > 0,
    ) &&
    [e.previousResetAt, e.resetAt, e.observedAt, e.previousRemaining, e.percentRemaining].every(
      Number.isFinite,
    ) &&
    e.resetAt > e.previousResetAt &&
    e.percentRemaining > e.previousRemaining
  );
}
