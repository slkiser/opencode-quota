/**
 * The gate every row passes before it reaches the store, the disk or a client: known fields
 * only, valid values, display text scrubbed of control characters. A bad row is dropped and
 * noted in the provider's debug details; the provider's other rows stay.
 */
import { isCanonicalAccountingDecimal } from "../lib/accounting-format.js";
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import { isRecord } from "../lib/json-guards.js";
import type {
  Amount,
  AmountUnit,
  DebugDetail,
  QuotaRow,
  RowAuthority,
  RowMethod,
  RowType,
} from "./types.js";
import { isQuotaWindow } from "./windows.js";

const ROW_TYPES: readonly RowType[] = ["quota", "budget", "usage", "balance", "status"];
const ROW_METHODS: readonly RowMethod[] = [
  "remote_api",
  "dashboard_scrape",
  "local_cli",
  "local_estimation",
];
const ROW_AUTHORITIES: readonly RowAuthority[] = ["provider_reported", "locally_derived"];
const PROMINENCES = ["primary", "supplementary"] as const;

/** Row key after the provider id: lower-case first segment, then dotted segments. */
const ROW_KEY_RE = /^[a-z0-9_]+(?:\.[A-Za-z0-9_-]+)*$/u;
const ROW_ID_MAX_LENGTH = 160;
/** Longest label or account, in code points. Custom provider names and labels use it too. */
export const LABEL_MAX_CODE_POINTS = 80;
const TEXT_MAX_CODE_POINTS = 200;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const COUNT_UNIT_RE = /^[a-z_]{1,32}$/u;
const CUSTOM_SYMBOL_RE = /^[\p{L}\p{N}._-]{1,16}$/u;

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}

export function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** A text's length in Unicode code points, the way every row text limit counts. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Scrubbed single-line text, or undefined when it is empty or longer than `maxCodePoints`. */
function cleanText(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = sanitizeSingleLineDisplayText(value);
  return text && codePointLength(text) <= maxCodePoints ? text : undefined;
}

function cleanUnit(value: unknown): AmountUnit | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === "currency" &&
    typeof value.code === "string" &&
    /^[A-Z]{3}$/u.test(value.code)
  ) {
    return { kind: "currency", code: value.code };
  }
  if (value.kind === "count" && typeof value.unit === "string" && COUNT_UNIT_RE.test(value.unit)) {
    return { kind: "count", unit: value.unit };
  }
  if (value.kind === "custom" && typeof value.symbol === "string") {
    const symbol = sanitizeSingleLineDisplayText(value.symbol);
    return CUSTOM_SYMBOL_RE.test(symbol) ? { kind: "custom", symbol } : undefined;
  }
  return undefined;
}

function cleanAmount(value: unknown): Amount | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.decimal !== "string" || !isCanonicalAccountingDecimal(value.decimal)) {
    return undefined;
  }
  const unit = cleanUnit(value.unit);
  return unit ? { decimal: value.decimal, unit } : undefined;
}

/** The clean row, or the reason it is dropped. */
function checkRow(providerId: string, value: unknown): QuotaRow | string {
  if (!isRecord(value)) return "not an object";
  const { id } = value;
  if (
    typeof id !== "string" ||
    id.length > ROW_ID_MAX_LENGTH ||
    !id.startsWith(`${providerId}.`) ||
    !ROW_KEY_RE.test(id.slice(providerId.length + 1))
  ) {
    return "invalid id";
  }
  if (value.providerId !== providerId) return "wrong provider";
  const label = cleanText(value.label, LABEL_MAX_CODE_POINTS);
  if (!label) return "invalid label";
  if (!isOneOf(value.type, ROW_TYPES)) return "invalid type";
  if (!isOneOf(value.method, ROW_METHODS)) return "invalid method";
  if (!isOneOf(value.authority, ROW_AUTHORITIES)) return "invalid authority";
  if (!isOneOf(value.prominence, PROMINENCES)) return "invalid prominence";

  const row: QuotaRow = {
    id,
    providerId,
    label,
    type: value.type,
    method: value.method,
    authority: value.authority,
    prominence: value.prominence,
  };
  if (value.account !== undefined) {
    const account = cleanText(value.account, LABEL_MAX_CODE_POINTS);
    if (!account) return "invalid account";
    row.account = account;
  }
  if (value.window !== undefined) {
    if (!isQuotaWindow(value.window)) return "invalid window";
    row.window = value.window;
  }
  if (value.percentRemaining !== undefined) {
    if (typeof value.percentRemaining !== "number" || !Number.isFinite(value.percentRemaining)) {
      return "invalid percentRemaining";
    }
    row.percentRemaining = value.percentRemaining;
  }
  for (const field of ["used", "limit", "remaining", "amount"] as const) {
    if (value[field] === undefined) continue;
    const amount = cleanAmount(value[field]);
    if (!amount) return `invalid ${field}`;
    row[field] = amount;
  }
  if (value.flag !== undefined) {
    if (typeof value.flag !== "boolean") return "invalid flag";
    row.flag = value.flag;
  }
  if (value.text !== undefined) {
    const text = cleanText(value.text, TEXT_MAX_CODE_POINTS);
    if (!text) return "invalid text";
    row.text = text;
  }
  for (const field of ["resetsAt", "windowStartedAt"] as const) {
    if (value[field] === undefined) continue;
    if (!isIsoTime(value[field])) return `invalid ${field}`;
    row[field] = value[field];
  }
  if (
    row.percentRemaining === undefined &&
    row.amount === undefined &&
    row.flag === undefined &&
    row.text === undefined
  ) {
    return "no value";
  }
  return row;
}

/** Keeps every valid row (as a clean copy) and notes each dropped one. */
export function validateRows(
  providerId: string,
  candidates: readonly unknown[],
): { rows: QuotaRow[]; dropped: DebugDetail[] } {
  const rows: QuotaRow[] = [];
  const dropped: DebugDetail[] = [];
  candidates.forEach((candidate, index) => {
    const checked = checkRow(providerId, candidate);
    if (typeof checked === "string") {
      const id = isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : "";
      const name = cleanText(id, ROW_ID_MAX_LENGTH) ?? `row ${index + 1}`;
      dropped.push({ key: "dropped_row", value: `${name}: ${checked}` });
    } else {
      rows.push(checked);
    }
  });
  return { rows, dropped };
}
