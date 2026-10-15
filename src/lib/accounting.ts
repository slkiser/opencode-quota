import type { QuotaToastEntry } from "./entries.js";

// Adapted from upstream 4.x entries.ts/accounting-format.ts at 2733b5b.
// Keep rich facts separate from the legacy display/export contract.
export type AccountingResultType =
  | "quota"
  | "rate_limit"
  | "usage"
  | "spend"
  | "budget"
  | "balance"
  | "status";
export type AccountingAuthority = "provider_reported" | "locally_derived" | "unknown";
export type AccountingUnit =
  | { kind: "currency"; code: string }
  | { kind: "count"; unit: "request" | "token" | "credit" | "message" | "interaction" | "unit" }
  | { kind: "custom"; symbol: string };
export interface AccountingQuantity {
  decimal: string;
  unit: AccountingUnit;
}
export interface AccountingBasisFact {
  quantity: AccountingQuantity;
  authority: AccountingAuthority | "user_configured";
}
export interface AccountingRow {
  /** Stable within one provider result, independent of display text. */
  id: string;
  name: string;
  group?: string;
  label?: string;
  resultType: AccountingResultType;
  prominence: "primary" | "supplementary";
  source: {
    id: string;
    acquisitionMethod:
      | "remote_api"
      | "dashboard_scrape"
      | "local_cli"
      | "local_runtime_accounting"
      | "local_estimation";
    ownership: "maintained" | "user_configured";
    authority: AccountingAuthority;
  };
  /** An opaque digest only; never a token, email, username or display label. */
  account: { kind: "unknown" } | { kind: "opaque"; digest: string };
  /** Source observation time, never fabricated from application fetch time. */
  freshness: { kind: "unknown" } | { kind: "observed"; observedAtIso: string };
  window:
    | { kind: "unknown" }
    | { kind: "identified"; id: string; resetTimeIso?: string }
    | { kind: "fixed"; id: string; startedAtIso: string; endsAtIso: string; fullReset: boolean }
    | { kind: "rolling"; id: string; durationMs: number; resetTimeIso?: string };
  value:
    | {
        kind: "percent";
        remaining: number | null;
        basis?: {
          used?: AccountingBasisFact;
          limit?: AccountingBasisFact;
          remaining?: AccountingBasisFact;
        };
      }
    | { kind: "quantity"; quantity: AccountingQuantity | null }
    | { kind: "boolean"; value: boolean | null }
    | {
        kind: "status";
        status: "unlimited" | "unknown" | "available" | "unavailable";
        detail?: string;
      };
}
export interface AccountingDocument {
  version: 1;
  rows: AccountingRow[];
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
export function isCanonicalAccountingDecimal(value: string): boolean {
  return DECIMAL.test(value) && !/^-0(?:\.0+)?$/u.test(value);
}
/** Preserve the provider number's precision while removing exponent notation. */
export function accountingQuantityFromNumber(
  value: number,
  unit: AccountingUnit,
): AccountingQuantity | null {
  if (!Number.isFinite(value)) return null;
  const raw = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/u.exec(raw);
  if (!match) return { decimal: raw, unit: { ...unit } };
  const [, sign, integer, fraction = "", exponent] = match;
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  const decimal =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return { decimal: sign + decimal, unit: { ...unit } };
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d\d-\d\dT/u.test(v) && Number.isFinite(Date.parse(v));
const optionalText = (v: unknown) => v === undefined || typeof v === "string";
const authority = (v: unknown) => oneOf(v, ["provider_reported", "locally_derived", "unknown"]);
function quantity(v: unknown): v is AccountingQuantity {
  if (
    !record(v) ||
    typeof v.decimal !== "string" ||
    !isCanonicalAccountingDecimal(v.decimal) ||
    !record(v.unit)
  )
    return false;
  const u = v.unit;
  return (
    (u.kind === "currency" && typeof u.code === "string" && /^[A-Z]{3}$/u.test(u.code)) ||
    (u.kind === "count" &&
      oneOf(u.unit, ["request", "token", "credit", "message", "interaction", "unit"])) ||
    (u.kind === "custom" && text(u.symbol))
  );
}
function validWindow(v: unknown): boolean {
  if (!record(v)) return false;
  if (v.kind === "unknown") return true;
  if (!text(v.id)) return false;
  if (v.kind === "fixed")
    return (
      timestamp(v.startedAtIso) &&
      timestamp(v.endsAtIso) &&
      Date.parse(v.endsAtIso) > Date.parse(v.startedAtIso) &&
      typeof v.fullReset === "boolean"
    );
  if (v.resetTimeIso !== undefined && !timestamp(v.resetTimeIso)) return false;
  return (
    v.kind === "identified" ||
    (v.kind === "rolling" &&
      typeof v.durationMs === "number" &&
      Number.isFinite(v.durationMs) &&
      v.durationMs > 0)
  );
}
function validValue(v: unknown): boolean {
  if (!record(v)) return false;
  if (v.kind === "quantity") return v.quantity === null || quantity(v.quantity);
  if (v.kind === "boolean") return v.value === null || typeof v.value === "boolean";
  if (v.kind === "status")
    return (
      oneOf(v.status, ["unlimited", "unknown", "available", "unavailable"]) &&
      optionalText(v.detail)
    );
  if (
    v.kind !== "percent" ||
    !(v.remaining === null || (typeof v.remaining === "number" && Number.isFinite(v.remaining)))
  )
    return false;
  if (v.basis === undefined) return true;
  if (!record(v.basis)) return false;
  const basis = v.basis;
  return ["used", "limit", "remaining"].every((key) => {
    const fact = basis[key];
    return (
      fact === undefined ||
      (record(fact) &&
        quantity(fact.quantity) &&
        (authority(fact.authority) || fact.authority === "user_configured"))
    );
  });
}
export function isAccountingDocument(v: unknown): v is AccountingDocument {
  if (!record(v) || v.version !== 1 || !Array.isArray(v.rows)) return false;
  const ids = new Set<string>();
  return v.rows.every((r: unknown) => {
    if (
      !record(r) ||
      !text(r.id) ||
      ids.has(r.id) ||
      !text(r.name) ||
      !optionalText(r.group) ||
      !optionalText(r.label) ||
      !oneOf(r.resultType, [
        "quota",
        "rate_limit",
        "usage",
        "spend",
        "budget",
        "balance",
        "status",
      ]) ||
      !oneOf(r.prominence, ["primary", "supplementary"]) ||
      !record(r.source) ||
      !text(r.source.id) ||
      !oneOf(r.source.acquisitionMethod, [
        "remote_api",
        "dashboard_scrape",
        "local_cli",
        "local_runtime_accounting",
        "local_estimation",
      ]) ||
      !oneOf(r.source.ownership, ["maintained", "user_configured"]) ||
      !authority(r.source.authority) ||
      !record(r.account) ||
      !(
        r.account.kind === "unknown" ||
        (r.account.kind === "opaque" &&
          typeof r.account.digest === "string" &&
          /^[a-f0-9]{64}$/u.test(r.account.digest))
      ) ||
      !record(r.freshness) ||
      !(
        r.freshness.kind === "unknown" ||
        (r.freshness.kind === "observed" && timestamp(r.freshness.observedAtIso))
      ) ||
      !validWindow(r.window) ||
      !validValue(r.value)
    )
      return false;
    ids.add(r.id);
    return true;
  });
}

/** Exact decimal display: no Number conversion, cross-currency sum, or percent inference. */
export function formatAccountingQuantity(q: AccountingQuantity): string {
  if (!quantity(q)) throw new TypeError("Invalid accounting quantity");
  if (q.unit.kind === "currency") return `${q.unit.code} ${q.decimal}`;
  if (q.unit.kind === "custom") return `${q.decimal} ${q.unit.symbol}`;
  const singular = /^1(?:\.0+)?$/u.test(q.decimal);
  return `${q.decimal} ${q.unit.unit}${singular ? "" : "s"}`;
}

/** Opt-in adapter. Existing provider entries/JSON remain untouched during ACC-01. */
export function projectAccountingToLegacy(doc: AccountingDocument): QuotaToastEntry[] {
  if (!isAccountingDocument(doc)) throw new TypeError("Invalid accounting document");
  return doc.rows.map((row) => {
    const resetTimeIso =
      row.window.kind === "unknown"
        ? undefined
        : row.window.kind === "fixed"
          ? row.window.endsAtIso
          : row.window.resetTimeIso;
    const meta = {
      name: row.name,
      ...(row.group !== undefined ? { group: row.group } : {}),
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(resetTimeIso ? { resetTimeIso } : {}),
    };
    if (row.value.kind === "percent" && row.value.remaining !== null)
      return { ...meta, percentRemaining: row.value.remaining };
    const value =
      row.value.kind === "quantity"
        ? row.value.quantity
          ? formatAccountingQuantity(row.value.quantity)
          : "Unknown"
        : row.value.kind === "boolean"
          ? row.value.value === null
            ? "Unknown"
            : row.value.value
              ? "Yes"
              : "No"
          : row.value.kind === "status"
            ? {
                unlimited: "Unlimited",
                unknown: "Unknown",
                available: "Available",
                unavailable: "Unavailable",
              }[row.value.status]
            : "Unknown";
    return { ...meta, kind: "value" as const, value };
  });
}
