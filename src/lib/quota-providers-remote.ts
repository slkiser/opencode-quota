import type { AccountingRow, AccountingUnit, AccountingDocument } from "./accounting.js";
import {
  accountingQuantityFromNumber,
  projectAccountingToLegacy,
  isAccountingDocument,
} from "./accounting.js";
import type { QuotaProviderResult } from "./entries.js";
import { sanitizeSingleLineDisplaySnippet as clean } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import {
  isRecord,
  onlyKeys,
  boundedNumber,
  boundedText,
  type RemoteQuotaDefinition,
  type JsonPath,
  type NumberSource,
  type TextSource,
  type TimeSource,
  type CustomMapping,
} from "./quota-provider-definitions.js";
function pathValue(root: unknown, path: JsonPath): unknown {
  let value = root;
  for (const segment of path) {
    if ((!isRecord(value) && !Array.isArray(value)) || !Object.hasOwn(value, segment))
      return undefined;
    value = (value as any)[segment];
  }
  return value;
}
function sourceValue(root: unknown, source: NumberSource | TextSource | TimeSource): unknown {
  return "literal" in source ? source.literal : pathValue(root, source.path);
}
function number(root: unknown, source: NumberSource): number {
  const value = sourceValue(root, source);
  if (!boundedNumber(value)) throw new Error("Numeric mapping unavailable");
  const result = value / ("divideBy" in source ? (source.divideBy ?? 1) : 1);
  if (!boundedNumber(result)) throw new Error("Numeric mapping unavailable");
  return result;
}
function time(root: unknown, source: TimeSource): string {
  const value = sourceValue(root, source);
  const at =
    source.encoding === "iso-8601" &&
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      ? Date.parse(value)
      : boundedNumber(value) && source.encoding !== "iso-8601"
        ? value * (source.encoding === "unix-seconds" ? 1000 : 1)
        : NaN;
  if (!Number.isFinite(at) || Math.abs(at) > 8640000000000000)
    throw new Error("Timestamp mapping unavailable");
  return new Date(at).toISOString();
}
function unit(value?: string): AccountingUnit {
  if (value && /^[A-Z]{3}$/u.test(value)) return { kind: "currency", code: value };
  const known: Record<string, "request" | "token" | "credit" | "message" | "interaction" | "unit"> =
    {
      request: "request",
      requests: "request",
      token: "token",
      tokens: "token",
      credit: "credit",
      credits: "credit",
      message: "message",
      messages: "message",
      interaction: "interaction",
      unit: "unit",
    };
  return value
    ? known[value]
      ? { kind: "count", unit: known[value] }
      : { kind: "custom", symbol: clean(value, 32) }
    : { kind: "count", unit: "unit" };
}
function base(
  def: RemoteQuotaDefinition,
  id: string,
  name: string,
  resultType: AccountingRow["resultType"],
): AccountingRow {
  return {
    id,
    name: clean(`${def.label} ${name}`, 200),
    group: clean(def.label, 80),
    resultType,
    prominence: "primary",
    source: {
      id: def.id,
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
    account: { kind: "unknown" },
    freshness: { kind: "unknown" },
    window: { kind: "unknown" },
    value: { kind: "status", status: "unknown" },
  };
}
function mappedRow(
  def: RemoteQuotaDefinition,
  root: unknown,
  mapping: CustomMapping,
  id: string,
): AccountingRow {
  const row = base(def, id, mapping.name, mapping.resultType),
    metric = mapping.metric;
  if (mapping.label) row.label = clean(mapping.label, 80);
  if (mapping.observedTime)
    row.freshness = { kind: "observed", observedAtIso: time(root, mapping.observedTime) };
  if (mapping.resetTime)
    row.window = { kind: "identified", id, resetTimeIso: time(root, mapping.resetTime) };
  if (
    (mapping.observedTime && "literal" in mapping.observedTime) ||
    ("value" in metric && "literal" in metric.value) ||
    (metric.type === "percentage" && "literal" in metric.percentage)
  )
    row.source.authority = "locally_derived";
  const units = unit(mapping.unit),
    quantity = (value: number) => accountingQuantityFromNumber(value, units)!;
  const fact = (value: number, source: NumberSource) => ({
    quantity: quantity(value),
    authority: "literal" in source ? ("user_configured" as const) : ("provider_reported" as const),
  });
  if (metric.type === "status") {
    const value = sourceValue(root, metric.value);
    if (!boundedText(value, 160)) throw new Error("Status mapping unavailable");
    row.value = ["unlimited", "available", "unavailable", "unknown"].includes(value)
      ? { kind: "status", status: value as "unlimited" | "available" | "unavailable" | "unknown" }
      : { kind: "status", status: "unknown", detail: clean(value, 160) };
  } else if (metric.type === "value")
    row.value = { kind: "quantity", quantity: quantity(number(root, metric.value)) };
  else if (metric.type === "percentage") {
    const value = number(root, metric.percentage),
      remaining = metric.meaning === "used" ? 100 - value : value;
    if (!boundedNumber(remaining)) throw new Error("Percentage unavailable");
    row.value = { kind: "percent", remaining };
  } else {
    const isUsed = metric.type === "used-limit" || metric.type === "spend-budget";
    const firstSource =
      metric.type === "used-limit"
        ? metric.used
        : metric.type === "spend-budget"
          ? metric.spend
          : metric.remaining;
    const totalSource = "limit" in metric ? metric.limit : metric.budget;
    const first = number(root, firstSource),
      total = number(root, totalSource);
    if (total < 0 || (isUsed && first < 0)) throw new Error("Invalid quota operands");
    const remaining = isUsed ? total - first : first,
      percent = total > 0 ? (remaining / total) * 100 : null;
    if (percent !== null && !boundedNumber(percent)) throw new Error("Percentage unavailable");
    row.source.authority = "locally_derived";
    row.value = {
      kind: "percent",
      remaining: percent,
      basis: {
        limit: fact(total, totalSource),
        [isUsed ? "used" : "remaining"]: fact(first, firstSource),
      },
    };
  }
  return row;
}
export function mapRemoteQuotaResponse(
  def: RemoteQuotaDefinition,
  payload: unknown,
): QuotaProviderResult {
  const rows: AccountingRow[] = [],
    errors: Array<{ label: string; message: string }> = [];
  const valueOverrides = new Map<string, string>();
  const rightOverrides = new Map<string, string>();
  if (def.format === "quota-v1") {
    if (
      !isRecord(payload) ||
      !onlyKeys(payload, ["version", "entries"]) ||
      payload.version !== "quota-v1" ||
      !Array.isArray(payload.entries) ||
      payload.entries.length < 1 ||
      payload.entries.length > 64
    )
      throw new Error("Invalid quota-v1 response");
    payload.entries.forEach((item, index) => {
      if (
        !isRecord(item) ||
        !onlyKeys(item, [
          "kind",
          "name",
          "resultType",
          "percentRemaining",
          "value",
          "label",
          "right",
          "resetTimeIso",
          "observedAtIso",
        ]) ||
        !boundedText(item.name) ||
        !["quota", "rate_limit", "usage", "spend", "budget", "balance", "status"].includes(
          item.resultType,
        )
      )
        throw new Error("Invalid quota-v1 row");
      const row = base(def, `row-${index}`, item.name, item.resultType);
      if (
        item.kind === "percent" &&
        boundedNumber(item.percentRemaining) &&
        item.percentRemaining <= 100 &&
        ["quota", "rate_limit", "budget"].includes(item.resultType) &&
        item.value === undefined
      )
        row.value = { kind: "percent", remaining: item.percentRemaining };
      else if (
        item.kind === "value" &&
        boundedText(item.value, 160) &&
        item.percentRemaining === undefined
      ) {
        row.value = { kind: "status", status: "unknown", detail: clean(item.value, 160) };
        valueOverrides.set(row.id, clean(item.value, 160));
      } else throw new Error("Invalid quota-v1 value");
      if (item.label !== undefined) {
        if (!boundedText(item.label)) throw new Error("Invalid label");
        row.label = clean(item.label, 80);
      }
      if (item.right !== undefined) {
        if (!boundedText(item.right, 160)) throw new Error("Invalid supplementary text");
        rightOverrides.set(row.id, clean(item.right, 160));
      }
      if (item.observedAtIso !== undefined)
        row.freshness = {
          kind: "observed",
          observedAtIso: time(item, { path: ["observedAtIso"], encoding: "iso-8601" }),
        };
      if (item.resetTimeIso !== undefined)
        row.window = {
          kind: "identified",
          id: row.id,
          resetTimeIso: time(item, { path: ["resetTimeIso"], encoding: "iso-8601" }),
        };
      rows.push(row);
    });
  } else {
    const adapter = def.adapter!;
    const input = adapter.rowsPath ? pathValue(payload, adapter.rowsPath) : payload;
    const inputs = adapter.rowsPath ? input : [input];
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length * adapter.mappings.length > 64)
      throw new Error("Invalid or excessive mapped rows");
    inputs.forEach((item, index) =>
      adapter.mappings.forEach((mapping, mappingIndex) => {
        try {
          rows.push(mappedRow(def, item, mapping, `row-${index}-${mappingIndex}`));
        } catch {
          rows.push(base(def, `row-${index}-${mappingIndex}`, mapping.name, mapping.resultType));
          errors.push({
            label: clean(def.label, 80),
            message: `Custom quota mapping ${mappingIndex + 1} unavailable at row ${index + 1}`,
          });
        }
      }),
    );
  }
  const accounting: AccountingDocument = { version: 1, rows };
  if (!isAccountingDocument(accounting)) throw new Error("Invalid accounting mapping");
  const entries = projectAccountingToLegacy(accounting).map((entry, index) => {
    const id = rows[index].id;
    const right = rightOverrides.has(id) ? { right: rightOverrides.get(id)! } : {};
    if (valueOverrides.has(id))
      return { ...entry, kind: "value" as const, value: valueOverrides.get(id)!, ...right };
    return { ...entry, ...right };
  });
  return { attempted: true, accounting, entries, errors };
}
export async function fetchRemoteQuota(
  def: RemoteQuotaDefinition,
  key: string,
  timeoutMs?: number,
): Promise<QuotaProviderResult> {
  if (!key) return { attempted: false, entries: [], errors: [] };
  try {
    const response = await fetchWithTimeout(
      def.url,
      {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      },
      timeoutMs,
      1024 * 1024,
    );
    if (!response.ok) throw new Error("HTTP quota failure");
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Quota response too large");
    const result = mapRemoteQuotaResponse(def, JSON.parse(text));
    if (JSON.stringify(result).includes(key))
      throw new Error("Credential reflected by quota source");
    return result;
  } catch {
    return {
      attempted: true,
      entries: [],
      errors: [
        {
          label: clean(def.label, 80).split(key).join("[redacted]"),
          message: "Custom quota unavailable (transport, permission or invalid response)",
        },
      ],
    };
  }
}
