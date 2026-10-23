import type { ErrorFacts } from "../core/errors.js";
import { codePointLength, isIsoTime, LABEL_MAX_CODE_POINTS } from "../core/validate.js";
import { accountingDecimalFromNumber } from "../providers/accounting-decimal.js";
import type { ProviderRow } from "../providers/contract.js";
import { amountText } from "../view/format.js";
import { type ApiKeySpec, getApiKeyCheckedPaths, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fmtUsdAmount } from "./format-utils.js";
import { failureFacts, type RequestFailure, requestJson } from "./http.js";
import { hasOnlyKeys, isRecord } from "./json-guards.js";
import { getCredentialDatabasePaths } from "./opencode-auth.js";
import type {
  CustomResultType,
  JsonV1Mapping,
  JsonV1NumberSource,
  JsonV1Path,
  JsonV1TextSource,
  JsonV1TimestampSource,
  RemoteApiQuotaProviderDefinition,
} from "./quota-providers.js";
import {
  CUSTOM_RESULT_TYPES,
  customRow,
  customRowKey,
  JSON_V1_MAX_DISPLAY_CODE_POINTS,
  JSON_V1_MAX_ITEMS,
  JSON_V1_MAX_NUMBER_MAGNITUDE,
  normalizeJsonV1Timestamp,
} from "./quota-providers.js";

export const QUOTA_PROVIDER_MAX_BODY_BYTES = 256 * 1024;
const MAX_REMOTE_ROWS = 100;
const JSON_V1_MAX_RESPONSE_DEPTH = 32;
const JSON_V1_MAX_CANDIDATES = 1_600;
const JSON_V1_MAX_DETAILED_ERRORS = 16;

const PERCENT_RESULT_TYPES = new Set<CustomResultType>(["quota", "rate_limit", "budget"]);
/** `right` and `observedAtIso` are checked but not shown. */
const QUOTA_V1_ROW_KEYS = [
  "kind",
  "name",
  "resultType",
  "percentRemaining",
  "value",
  "label",
  "right",
  "resetTimeIso",
  "observedAtIso",
];
const JSON_V1_DECIMAL_TEXT_RE = /^-?\d+(?:\.\d+)?$/;
/** Units that mark a json-v1 value as US dollars, in lower case: the match ignores case. */
const JSON_V1_USD_UNITS = new Set(["$", "usd"]);
/**
 * Every decimal of up to 15 significant digits survives a trip through a float, so a value
 * shown to 15 digits loses float noise such as 0.7 / 100 = 0.006999999999999999.
 */
const JSON_V1_SHOWN_SIGNIFICANT_DIGITS = 15;

export type QuotaProviderAuthSource = "env" | "opencode.json" | "opencode.jsonc" | "opencode.db";

export interface QuotaProviderAuthResolution {
  key?: string;
  source: QuotaProviderAuthSource | null;
  checkedPaths: string[];
  credentialDatabasePaths: string[];
}

/** Why a check got no rows, as its /quota_status check names it. */
export type RemoteFailureOutcome =
  | "switched_off"
  | "http_error"
  | "redirect_error"
  | "timeout"
  | "body_too_large"
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_response"
  | "network_error";

type ParsedReply =
  | { success: true; rows: ProviderRow[]; rowErrors?: string[] }
  | { success: false; error: string };

/**
 * The rows of one reply (each key is the part of the row id after `custom.<definition id>.`),
 * or why there are none: the words, the outcome, and the request's facts when it gave them.
 */
export type RemoteQuotaProviderResult =
  | { success: true; rows: ProviderRow[]; rowErrors?: string[] }
  | { success: false; error: string; outcome: RemoteFailureOutcome; facts?: ErrorFacts };

function boundedDisplayText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeSingleLineDisplayText(value);
  const length = codePointLength(normalized);
  return length >= 1 && length <= maxCodePoints ? normalized : null;
}

export async function resolveQuotaProviderApiKey(
  source: RemoteApiQuotaProviderDefinition,
  directory: string,
): Promise<QuotaProviderAuthResolution> {
  // A switched-off provider's key is never read, whoever asks.
  if (source.enabled === false) {
    return { source: null, checkedPaths: [], credentialDatabasePaths: [] };
  }
  const spec: ApiKeySpec = {
    envVars: source.apiKeyEnv ? [source.apiKeyEnv] : [],
    providerKeys: [source.providerId],
    // Key logins only: `providerId` can name an integration with OAuth sign-ins
    // (for example `opencode`), and resolving one could refresh its token for nothing.
    keyLoginsOnly: true,
  };
  const resolved = await resolveApiKey(spec, directory);
  return {
    ...(resolved ? { key: resolved.key } : {}),
    // Custom providers report every environment variable source as plain "env".
    source: !resolved
      ? null
      : resolved.source.startsWith("env:")
        ? "env"
        : (resolved.source as QuotaProviderAuthSource),
    checkedPaths: getApiKeyCheckedPaths(spec, directory),
    credentialDatabasePaths: getCredentialDatabasePaths(),
  };
}

function isJsonContentType(headers: Headers): boolean {
  const type = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!type) return false;
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

/** A quota-v1 row keyed by its name. */
function parseQuotaV1Row(raw: unknown): ProviderRow | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, QUOTA_V1_ROW_KEYS)) return null;

  const name = boundedDisplayText(raw.name, LABEL_MAX_CODE_POINTS);
  const resultType =
    typeof raw.resultType === "string" &&
    CUSTOM_RESULT_TYPES.has(raw.resultType as CustomResultType)
      ? (raw.resultType as CustomResultType)
      : null;
  // Optional fields are undefined when absent and null when present but invalid.
  const label =
    raw.label === undefined ? undefined : boundedDisplayText(raw.label, LABEL_MAX_CODE_POINTS);
  const right = raw.right === undefined ? undefined : boundedDisplayText(raw.right, 160);
  const resetTimeIso =
    raw.resetTimeIso === undefined
      ? undefined
      : isIsoTime(raw.resetTimeIso)
        ? raw.resetTimeIso
        : null;
  const observedAtIso =
    raw.observedAtIso === undefined
      ? undefined
      : isIsoTime(raw.observedAtIso)
        ? raw.observedAtIso
        : null;
  if (
    !name ||
    !resultType ||
    label === null ||
    right === null ||
    resetTimeIso === null ||
    observedAtIso === null
  ) {
    return null;
  }

  const row = (value: { percentRemaining: number } | { text: string }): ProviderRow =>
    customRow({
      key: customRowKey(name),
      name,
      label,
      resultType,
      method: "remote_api",
      value,
      resetsAt: resetTimeIso,
    });

  if (
    raw.kind === "percent" &&
    typeof raw.percentRemaining === "number" &&
    Number.isFinite(raw.percentRemaining) &&
    raw.percentRemaining <= 100 &&
    PERCENT_RESULT_TYPES.has(resultType) &&
    raw.value === undefined
  ) {
    return row({ percentRemaining: raw.percentRemaining });
  }

  const value = boundedDisplayText(raw.value, 160);
  if (raw.kind === "value" && value !== null && raw.percentRemaining === undefined) {
    return row({ text: value });
  }
  return null;
}

function parseQuotaV1(body: unknown): ParsedReply {
  const invalid = { success: false, error: "Invalid quota-v1 response" } as const;
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, ["version", "entries"]) ||
    body.version !== "quota-v1" ||
    !Array.isArray(body.entries) ||
    body.entries.length < 1 ||
    body.entries.length > MAX_REMOTE_ROWS
  ) {
    return invalid;
  }

  const rows: ProviderRow[] = [];
  for (const raw of body.entries) {
    const row = parseQuotaV1Row(raw);
    if (!row) return invalid;
    rows.push(row);
  }
  return { success: true, rows };
}

type JsonV1Resolved<T> = { ok: true; value: T } | { ok: false; issue: string };

type JsonV1Candidate = { row: ProviderRow } | { error: string };

function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  if (!value || typeof value !== "object") return false;
  const stack: Array<{ value: object; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) return true;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) {
      if (child && typeof child === "object") {
        stack.push({ value: child as object, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function resolveJsonV1Path(root: unknown, path: JsonV1Path): JsonV1Resolved<unknown> {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) return { ok: false, issue: "had wrong type" };
    if (!Object.hasOwn(current, segment)) return { ok: false, issue: "was missing" };
    current = current[segment];
    if (current === null) return { ok: false, issue: "was null" };
  }
  return { ok: true, value: current };
}

function resolveJsonV1Source(
  row: Record<string, unknown>,
  source: { path: JsonV1Path } | { literal: unknown },
): JsonV1Resolved<unknown> {
  return "literal" in source
    ? { ok: true, value: source.literal }
    : resolveJsonV1Path(row, source.path);
}

function resolveJsonV1Number(
  row: Record<string, unknown>,
  source: JsonV1NumberSource,
): JsonV1Resolved<number> {
  const resolved = resolveJsonV1Source(row, source);
  if (!resolved.ok) return resolved;
  // Some APIs write numbers as text (`"95.50"`); only a plain decimal is read as a number.
  const raw =
    typeof resolved.value === "string" && JSON_V1_DECIMAL_TEXT_RE.test(resolved.value.trim())
      ? Number(resolved.value.trim())
      : resolved.value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, issue: "had wrong type" };
  }
  if (Math.abs(raw) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
    return { ok: false, issue: "exceeded the numeric magnitude limit" };
  }
  const divideBy = "path" in source ? source.divideBy : undefined;
  return { ok: true, value: divideBy === undefined ? raw : raw / divideBy };
}

function resolveJsonV1Text(
  row: Record<string, unknown>,
  source: JsonV1TextSource,
): JsonV1Resolved<string> {
  const resolved = resolveJsonV1Source(row, source);
  if (!resolved.ok) return resolved;
  if (typeof resolved.value !== "string") return { ok: false, issue: "had wrong type" };
  const text = boundedDisplayText(resolved.value, JSON_V1_MAX_DISPLAY_CODE_POINTS);
  return text
    ? { ok: true, value: text }
    : { ok: false, issue: "did not resolve to bounded display text" };
}

function resolveJsonV1Timestamp(
  row: Record<string, unknown>,
  source: JsonV1TimestampSource,
): JsonV1Resolved<string> {
  const resolved = resolveJsonV1Source(row, source);
  if (!resolved.ok) return resolved;
  const timestamp = normalizeJsonV1Timestamp(resolved.value, source.encoding);
  return timestamp
    ? { ok: true, value: timestamp }
    : { ok: false, issue: "did not resolve to a valid timestamp" };
}

function jsonV1CandidateError(
  mappingIndex: number,
  field: string,
  issue: string,
  rowIndex: number,
): string {
  return `adapter.mappings[${mappingIndex}].${field} ${issue} at row ${rowIndex}`;
}

/**
 * A value row's text. A value in US dollars (unit `$` or `USD` in any case, either position) is
 * written like built-in money ("$1,234.57", "-$3.50"); any other value as its number without float
 * noise ("0.007", not "0.006999999999999999"), with its unit where the mapping puts it.
 */
function formatJsonV1Value(value: number, mapping: JsonV1Mapping): string {
  const decimal = accountingDecimalFromNumber(
    Number(value.toPrecision(JSON_V1_SHOWN_SIGNIFICANT_DIGITS)),
  );
  if (mapping.unit !== undefined && JSON_V1_USD_UNITS.has(mapping.unit.toLowerCase())) {
    return amountText({ decimal, unit: { kind: "currency", code: "USD" } });
  }
  if (!mapping.unit) return decimal;
  return mapping.unitPosition === "prefix"
    ? `${mapping.unit}${decimal}`
    : `${decimal} ${mapping.unit}`;
}

/**
 * One mapping applied to one reply item: a row keyed by the mapping's name, or why not. In a
 * list of more than one item, item n's label ends in " n" and, from item 2 on, its key in ".n";
 * item 1 keeps the key a single item has. The label is clipped so the longest number in the list
 * still fits the row gate.
 */
function mapJsonV1Candidate(
  row: Record<string, unknown>,
  rowIndex: number,
  itemCount: number,
  mapping: JsonV1Mapping,
  mappingIndex: number,
): JsonV1Candidate {
  const fail = (field: string, issue: string): JsonV1Candidate => ({
    error: jsonV1CandidateError(mappingIndex, field, issue, rowIndex),
  });

  let resetTimeIso: string | undefined;
  if (mapping.resetTime) {
    const resolved = resolveJsonV1Timestamp(row, mapping.resetTime);
    if (!resolved.ok) return fail("resetTime", resolved.issue);
    resetTimeIso = resolved.value;
  }

  // The observed time is checked but not shown.
  if (mapping.observedTime) {
    const resolved = resolveJsonV1Timestamp(row, mapping.observedTime);
    if (!resolved.ok) return fail("observedTime", resolved.issue);
  }

  const itemNumber = rowIndex + 1;
  const mapped = (value: { percentRemaining: number } | { text: string }): JsonV1Candidate => {
    const row = customRow({
      key: customRowKey(mapping.name),
      name: mapping.name,
      label: mapping.label,
      resultType: mapping.resultType,
      method: "remote_api",
      value,
      resetsAt: resetTimeIso,
    });
    if (itemCount === 1) return { row };
    const labelRoom = LABEL_MAX_CODE_POINTS - ` ${itemCount}`.length;
    const clippedLabel = Array.from(row.label).slice(0, labelRoom).join("").trimEnd();
    return {
      row: {
        ...row,
        key: itemNumber === 1 ? row.key : `${row.key}.${itemNumber}`,
        label: `${clippedLabel} ${itemNumber}`,
      },
    };
  };

  // Shared by used-limit, remaining-limit, spend-budget and remaining-budget:
  // an amount (used, spent, or remaining) out of a positive total.
  const share = (
    amountKey: "used" | "spend" | "remaining",
    amountSource: JsonV1NumberSource,
    totalKey: "limit" | "budget",
    totalSource: JsonV1NumberSource,
  ): JsonV1Candidate => {
    const amountField = `metric.${amountKey}`;
    const totalField = `metric.${totalKey}`;
    const amountIsRemaining = amountKey === "remaining";
    const amount = resolveJsonV1Number(row, amountSource);
    if (!amount.ok) return fail(amountField, amount.issue);
    const total = resolveJsonV1Number(row, totalSource);
    if (!total.ok) return fail(totalField, total.issue);
    if (!amountIsRemaining && amount.value < 0) return fail(amountField, "must be non-negative");
    if (total.value <= 0) return fail(totalField, "must be greater than zero");
    if (amountIsRemaining && amount.value > total.value) {
      return fail(amountField, `must not exceed ${totalKey}`);
    }
    const percentRemaining = amountIsRemaining
      ? (amount.value / total.value) * 100
      : ((total.value - amount.value) / total.value) * 100;
    // Finite operands can still overflow, for example a tiny literal total.
    if (!Number.isFinite(percentRemaining)) {
      return fail(totalField, "produced a non-finite percentage");
    }
    if (Math.abs(percentRemaining) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
      return fail(totalField, "produced a percentage beyond the numeric magnitude limit");
    }
    return mapped({ percentRemaining });
  };

  const { metric } = mapping;
  switch (metric.type) {
    case "percentage": {
      const percentage = resolveJsonV1Number(row, metric.percentage);
      if (!percentage.ok) return fail("metric.percentage", percentage.issue);
      if (metric.meaning === "remaining" && percentage.value > 100) {
        return fail("metric.percentage", "must not exceed 100 for remaining meaning");
      }
      if (metric.meaning === "used" && percentage.value < 0) {
        return fail("metric.percentage", "must be non-negative for used meaning");
      }
      const percentRemaining =
        metric.meaning === "remaining" ? percentage.value : 100 - percentage.value;
      return mapped({ percentRemaining });
    }
    case "used-limit":
      return share("used", metric.used, "limit", metric.limit);
    case "remaining-limit":
      return share("remaining", metric.remaining, "limit", metric.limit);
    case "spend-budget":
      return share("spend", metric.spend, "budget", metric.budget);
    case "remaining-budget":
      return share("remaining", metric.remaining, "budget", metric.budget);
    case "value": {
      const value = resolveJsonV1Number(row, metric.value);
      if (!value.ok) return fail("metric.value", value.issue);
      // Remaining and balance values may legitimately be negative (overdrawn).
      const mayBeNegative = metric.valueType === "remaining" || metric.valueType === "balance";
      if (!mayBeNegative && value.value < 0) return fail("metric.value", "must be non-negative");
      return mapped({ text: formatJsonV1Value(value.value, mapping) });
    }
    case "status": {
      const value = resolveJsonV1Text(row, metric.value);
      if (!value.ok) return fail("metric.value", value.issue);
      return mapped({ text: value.value });
    }
  }
}

function parseJsonV1(
  source: Extract<RemoteApiQuotaProviderDefinition, { format: "json-v1" }>,
  body: unknown,
): ParsedReply {
  const invalid = (message: string): ParsedReply => ({
    success: false,
    error: `Invalid json-v1 response: ${message}`,
  });

  if (exceedsJsonDepth(body, JSON_V1_MAX_RESPONSE_DEPTH)) {
    return invalid(`nesting depth exceeded ${JSON_V1_MAX_RESPONSE_DEPTH}`);
  }

  let rows: unknown[];
  if (source.adapter.rowsPath) {
    if (!isRecord(body)) return invalid("adapter.rowsPath requires an object root");
    const resolved = resolveJsonV1Path(body, source.adapter.rowsPath);
    if (!resolved.ok) return invalid(`adapter.rowsPath ${resolved.issue}`);
    if (!Array.isArray(resolved.value)) {
      return invalid("adapter.rowsPath did not resolve to an array");
    }
    rows = resolved.value;
  } else if (Array.isArray(body)) {
    rows = body;
  } else if (isRecord(body)) {
    rows = [body];
  } else {
    return invalid("expected an object or array root");
  }

  if (rows.length < 1 || rows.length > JSON_V1_MAX_ITEMS) {
    return invalid(`selected rows must contain 1-${JSON_V1_MAX_ITEMS} elements`);
  }
  const { mappings } = source.adapter;
  if (rows.length * mappings.length > JSON_V1_MAX_CANDIDATES) {
    return invalid(`candidate count exceeded ${JSON_V1_MAX_CANDIDATES}`);
  }

  const mappedRows: ProviderRow[] = [];
  const rowErrors: string[] = [];
  let errorCount = 0;
  const recordError = (error: string): void => {
    errorCount += 1;
    if (rowErrors.length < JSON_V1_MAX_DETAILED_ERRORS) rowErrors.push(error);
  };

  for (const [rowIndex, row] of rows.entries()) {
    for (const [mappingIndex, mapping] of mappings.entries()) {
      if (!isRecord(row)) {
        recordError(
          jsonV1CandidateError(mappingIndex, "metric", "requires an object row", rowIndex),
        );
        continue;
      }
      const mapped = mapJsonV1Candidate(row, rowIndex, rows.length, mapping, mappingIndex);
      if ("error" in mapped) {
        recordError(mapped.error);
        continue;
      }
      mappedRows.push(mapped.row);
    }
  }

  if (mappedRows.length === 0) {
    return invalid(rowErrors[0] ?? "no mappings produced entries");
  }
  if (errorCount > rowErrors.length) {
    rowErrors.push("Additional json-v1 mapping errors omitted");
  }
  return {
    success: true,
    rows: mappedRows,
    ...(rowErrors.length > 0 ? { rowErrors } : {}),
  };
}

/**
 * The key's budget (percent left), or its spend when the key has no limit: this month's
 * (`usage_monthly`, the current UTC month) when the reply has it, else all time.
 */
function parseOpenRouterKeyV1(body: unknown): ParsedReply {
  const invalid = { success: false, error: "Invalid openrouter-key-v1 response" } as const;
  if (!isRecord(body) || !isRecord(body.data)) return invalid;

  const { usage, usage_monthly: usageMonthly, limit, limit_remaining: remaining } = body.data;
  const isValidUsage = typeof usage === "number" && Number.isFinite(usage) && usage >= 0;
  const isValidLimit =
    limit === null ||
    limit === undefined ||
    (typeof limit === "number" && Number.isFinite(limit) && limit >= 0);
  // A null remaining is valid only for a key without a limit (free tier).
  const isValidRemaining =
    remaining === undefined ||
    (remaining === null
      ? limit === null
      : typeof remaining === "number" && Number.isFinite(remaining));
  if (!isValidUsage || !isValidLimit || !isValidRemaining) return invalid;

  if (typeof limit === "number" && limit > 0) {
    // `limit_remaining` covers the current limit window, while `usage` is the key's lifetime total.
    const remainingUsd = typeof remaining === "number" ? remaining : limit - usage;
    if (remainingUsd > limit) return invalid;
    const percentRemaining = (remainingUsd / limit) * 100;
    return {
      success: true,
      rows: [
        customRow({
          key: "budget",
          name: "budget",
          label: "Budget",
          resultType: "budget",
          method: "remote_api",
          value: { percentRemaining },
        }),
      ],
    };
  }

  // A reply without a usable monthly figure (an older or compatible endpoint) keeps the
  // all-time spend.
  const hasMonthly =
    typeof usageMonthly === "number" && Number.isFinite(usageMonthly) && usageMonthly >= 0;
  return {
    success: true,
    rows: [
      customRow({
        key: "spend",
        name: "spend",
        label: hasMonthly ? "This month" : "Spend",
        resultType: "spend",
        method: "remote_api",
        value: { text: fmtUsdAmount(hasMonthly ? usageMonthly : usage) },
      }),
    ],
  };
}

function parseReply(source: RemoteApiQuotaProviderDefinition, body: unknown): ParsedReply {
  switch (source.format) {
    case "quota-v1":
      return parseQuotaV1(body);
    case "openrouter-key-v1":
      return parseOpenRouterKeyV1(body);
    case "json-v1":
      return parseJsonV1(source, body);
  }
}

/**
 * A failed request as fixed words: an endpoint's reply body and a thrown error's text are never
 * echoed, since they can hold the endpoint or account data.
 */
function requestFailure(failure: RequestFailure): RemoteQuotaProviderResult {
  const fail = (error: string, outcome: RemoteFailureOutcome, facts: ErrorFacts) =>
    ({ success: false, error, outcome, facts }) as const;
  switch (failure.kind) {
    case "http": {
      const status = failure.status ?? 0;
      return status >= 300 && status < 400
        ? fail("Redirect rejected", "redirect_error", failureFacts(failure, "bad_response"))
        : fail(`HTTP ${status}`, "http_error", failureFacts(failure));
    }
    case "timeout":
      return fail(failure.detail, "timeout", failureFacts(failure));
    case "network":
      return fail("Failed to read accounting data", "network_error", failureFacts(failure));
    case "too_large":
      return fail(
        `Response exceeded ${QUOTA_PROVIDER_MAX_BODY_BYTES} bytes`,
        "body_too_large",
        failureFacts(failure),
      );
    case "invalid_json":
      return failure.headers && !isJsonContentType(failure.headers)
        ? fail("Expected a JSON response", "invalid_content_type", failureFacts(failure))
        : fail("Invalid JSON response", "invalid_json", failureFacts(failure));
  }
}

export async function fetchRemoteQuotaProvider(
  source: RemoteApiQuotaProviderDefinition,
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<RemoteQuotaProviderResult> {
  // A switched-off provider is never sent a request or its key, whoever asks.
  if (source.enabled === false) {
    return { success: false, error: "Provider is switched off", outcome: "switched_off" };
  }
  const reply = await requestJson(source.url, {
    method: "GET",
    redirect: "manual",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    secrets: [apiKey],
    timeoutMs: requestTimeoutMs,
    maxBytes: QUOTA_PROVIDER_MAX_BODY_BYTES,
  });
  if (!reply.ok) return requestFailure(reply.failure);
  if (!isJsonContentType(reply.headers)) {
    return { success: false, error: "Expected a JSON response", outcome: "invalid_content_type" };
  }
  const parsed = parseReply(source, reply.json);
  return parsed.success ? parsed : { ...parsed, outcome: "invalid_response" };
}
