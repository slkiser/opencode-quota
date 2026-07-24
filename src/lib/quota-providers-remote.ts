import type { AccountingResultType, QuotaToastEntry } from "./entries.js";
import type {
  JsonV1Mapping,
  JsonV1NumberSource,
  JsonV1Path,
  JsonV1TextSource,
  JsonV1TimestampSource,
  RemoteApiQuotaProviderDefinition,
} from "./quota-providers.js";

import {
  createProviderApiKeyResolver,
  getApiKeyCheckedPaths,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import {
  JSON_V1_MAX_DISPLAY_CODE_POINTS,
  JSON_V1_MAX_NUMBER_MAGNITUDE,
  normalizeJsonV1Timestamp,
} from "./quota-providers.js";
import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import { REQUEST_TIMEOUT_MS } from "./types.js";

export const QUOTA_PROVIDER_MAX_BODY_BYTES = 256 * 1024;
export const QUOTA_PROVIDER_MAX_REMOTE_ROWS = 100;
export const JSON_V1_MAX_RESPONSE_DEPTH = 32;
export const JSON_V1_MAX_CANDIDATES = 1_600;
export const JSON_V1_MAX_ENTRIES = 100;
export const JSON_V1_MAX_DETAILED_ERRORS = 16;
export const QUOTA_PROVIDER_CONCURRENCY = 4;

const RESULT_TYPES = new Set<AccountingResultType>([
  "quota",
  "rate_limit",
  "usage",
  "spend",
  "budget",
  "balance",
  "status",
]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type QuotaProviderAuthSource = "env" | "opencode.json" | "opencode.jsonc" | "auth.json";

export interface QuotaProviderAuthResolution {
  key?: string;
  source: QuotaProviderAuthSource | null;
  checkedPaths: string[];
  authPaths: string[];
}

export type RemoteQuotaProviderResult =
  | { success: true; entries: QuotaToastEntry[]; rowErrors?: string[] }
  | { success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value))
  );
}

function boundedDisplayText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeSingleLineDisplayText(value);
  const length = Array.from(normalized).length;
  return length >= 1 && length <= maxCodePoints ? normalized : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function accountingMetadata(
  resultType: AccountingResultType,
  observedAtIso?: string,
): QuotaToastEntry["accounting"] {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "user_configured",
    authority: "provider_reported",
    ...(observedAtIso ? { observedAtIso } : {}),
  };
}

export async function resolveQuotaProviderApiKey(
  source: RemoteApiQuotaProviderDefinition,
): Promise<QuotaProviderAuthResolution> {
  const resolver = createProviderApiKeyResolver<QuotaProviderAuthSource>({
    envVars: source.apiKeyEnv ? [{ name: source.apiKeyEnv, source: "env" }] : [],
    providerKeys: [source.providerId],
    allowedEnvVars: source.apiKeyEnv ? [source.apiKeyEnv] : [],
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      readAuth: readAuthFile,
      authKeys: [source.providerId],
      authSource: "auth.json",
    },
  });

  const resolved = await resolver.resolve();
  return {
    ...(resolved ? { key: resolved.key } : {}),
    source: resolved?.source ?? null,
    checkedPaths: getApiKeyCheckedPaths({
      envVarNames: source.apiKeyEnv ? [source.apiKeyEnv] : [],
      getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    }),
    authPaths: getAuthPaths(),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !contentType ||
    (contentType !== "application/json" &&
      !(contentType.startsWith("application/") && contentType.endsWith("+json")))
  ) {
    throw new Error("Expected a JSON response");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > QUOTA_PROVIDER_MAX_BODY_BYTES) {
      throw new Error("Response exceeded 262144 bytes");
    }
  }

  let bytes: Uint8Array;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > QUOTA_PROVIDER_MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error("Response exceeded 262144 bytes");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > QUOTA_PROVIDER_MAX_BODY_BYTES) {
      throw new Error("Response exceeded 262144 bytes");
    }
    bytes = buffer;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Invalid JSON response");
  }
}

function parseQuotaV1(
  source: RemoteApiQuotaProviderDefinition,
  body: unknown,
): RemoteQuotaProviderResult {
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, ["version", "entries"]) ||
    body.version !== "quota-v1" ||
    !Array.isArray(body.entries)
  ) {
    return { success: false, error: "Invalid quota-v1 response" };
  }
  if (body.entries.length < 1 || body.entries.length > QUOTA_PROVIDER_MAX_REMOTE_ROWS) {
    return { success: false, error: "Invalid quota-v1 response" };
  }

  const entries: QuotaToastEntry[] = [];
  for (const raw of body.entries) {
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, [
        "kind",
        "name",
        "resultType",
        "percentRemaining",
        "value",
        "label",
        "right",
        "resetTimeIso",
        "observedAtIso",
      ])
    ) {
      return { success: false, error: "Invalid quota-v1 response" };
    }

    const name = boundedDisplayText(raw.name, 80);
    const resultType =
      typeof raw.resultType === "string" && RESULT_TYPES.has(raw.resultType as AccountingResultType)
        ? (raw.resultType as AccountingResultType)
        : null;
    const label = raw.label === undefined ? undefined : boundedDisplayText(raw.label, 80);
    const right = raw.right === undefined ? undefined : boundedDisplayText(raw.right, 160);
    const resetTimeIso =
      raw.resetTimeIso === undefined
        ? undefined
        : isIsoTimestamp(raw.resetTimeIso)
          ? raw.resetTimeIso
          : null;
    const observedAtIso =
      raw.observedAtIso === undefined
        ? undefined
        : isIsoTimestamp(raw.observedAtIso)
          ? raw.observedAtIso
          : null;

    if (
      !name ||
      !resultType ||
      (raw.label !== undefined && label === null) ||
      (raw.right !== undefined && right === null) ||
      resetTimeIso === null ||
      observedAtIso === null
    ) {
      return { success: false, error: "Invalid quota-v1 response" };
    }

    const common = {
      accounting: accountingMetadata(resultType, observedAtIso),
      name: `${source.label} ${name}`,
      group: source.label,
      ...(label ? { label } : {}),
      ...(right ? { right } : {}),
      ...(resetTimeIso ? { resetTimeIso } : {}),
    };

    if (
      raw.kind === "percent" &&
      typeof raw.percentRemaining === "number" &&
      Number.isFinite(raw.percentRemaining) &&
      raw.percentRemaining <= 100 &&
      ["quota", "rate_limit", "budget"].includes(resultType) &&
      raw.value === undefined
    ) {
      entries.push({ ...common, kind: "percent", percentRemaining: raw.percentRemaining });
      continue;
    }

    const value = boundedDisplayText(raw.value, 160);
    if (raw.kind === "value" && value !== null && raw.percentRemaining === undefined) {
      entries.push({ ...common, kind: "value", value });
      continue;
    }

    return { success: false, error: "Invalid quota-v1 response" };
  }

  return { success: true, entries };
}

type JsonV1PathResolution =
  | { state: "value"; value: unknown }
  | { state: "missing" | "null" | "wrong-type" };

type JsonV1Resolved<T> = { ok: true; value: T } | { ok: false; issue: string };

function isJsonV1ResponseDepthValid(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const stack: Array<{ value: object; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > JSON_V1_MAX_RESPONSE_DEPTH) return false;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) {
      if (child && typeof child === "object") {
        stack.push({ value: child as object, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function resolveJsonV1Path(root: unknown, path: JsonV1Path): JsonV1PathResolution {
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    if (!isRecord(current)) return { state: "wrong-type" };
    const segment = path[index]!;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { state: "missing" };
    current = current[segment];
    if (current === null) return { state: "null" };
    if (index < path.length - 1 && !isRecord(current)) return { state: "wrong-type" };
  }
  return { state: "value", value: current };
}

function jsonV1SourceValue(
  row: Record<string, unknown>,
  source: { path: JsonV1Path } | { literal: unknown },
): JsonV1PathResolution {
  if ("literal" in source) {
    return source.literal === null ? { state: "null" } : { state: "value", value: source.literal };
  }
  return resolveJsonV1Path(row, source.path);
}

function jsonV1ResolutionIssue(
  resolution: Exclude<JsonV1PathResolution, { state: "value" }>,
): string {
  switch (resolution.state) {
    case "missing":
      return "was missing";
    case "null":
      return "was null";
    case "wrong-type":
      return "had wrong type";
  }
}

function resolveJsonV1Number(
  row: Record<string, unknown>,
  source: JsonV1NumberSource,
): JsonV1Resolved<number> {
  const resolution = jsonV1SourceValue(row, source);
  if (resolution.state !== "value") {
    return { ok: false, issue: jsonV1ResolutionIssue(resolution) };
  }
  if (typeof resolution.value !== "number" || !Number.isFinite(resolution.value)) {
    return { ok: false, issue: "had wrong type" };
  }
  if (Math.abs(resolution.value) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
    return { ok: false, issue: "exceeded the numeric magnitude limit" };
  }
  const value =
    "path" in source && source.divideBy !== undefined
      ? resolution.value / source.divideBy
      : resolution.value;
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, issue: "did not resolve to a finite number" };
}

function resolveJsonV1Text(
  row: Record<string, unknown>,
  source: JsonV1TextSource,
): JsonV1Resolved<string> {
  const resolution = jsonV1SourceValue(row, source);
  if (resolution.state !== "value") {
    return { ok: false, issue: jsonV1ResolutionIssue(resolution) };
  }
  if (typeof resolution.value !== "string") {
    return { ok: false, issue: "had wrong type" };
  }
  const normalized = boundedDisplayText(resolution.value, JSON_V1_MAX_DISPLAY_CODE_POINTS);
  return normalized
    ? { ok: true, value: normalized }
    : { ok: false, issue: "did not resolve to bounded display text" };
}

function resolveJsonV1TimestampSource(
  row: Record<string, unknown>,
  source: JsonV1TimestampSource,
): JsonV1Resolved<string> {
  const resolution = jsonV1SourceValue(row, source);
  if (resolution.state !== "value") {
    return { ok: false, issue: jsonV1ResolutionIssue(resolution) };
  }
  const normalized = normalizeJsonV1Timestamp(resolution.value, source.encoding);
  return normalized
    ? { ok: true, value: normalized }
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

function formatJsonV1Value(value: number, mapping: JsonV1Mapping): string {
  const text = String(value);
  if (!mapping.unit) return text;
  return mapping.unitPosition === "prefix" ? `${mapping.unit}${text}` : `${text} ${mapping.unit}`;
}

function formatJsonV1Pair(left: number, right: number, mapping: JsonV1Mapping): string {
  const pair = `${String(left)}/${String(right)}`;
  if (!mapping.unit) return pair;
  return mapping.unitPosition === "prefix"
    ? `${mapping.unit}${String(left)}/${mapping.unit}${String(right)}`
    : `${pair} ${mapping.unit}`;
}

function jsonV1DerivedPercentageIssue(value: number): string | null {
  if (!Number.isFinite(value)) return "produced a non-finite percentage";
  if (Math.abs(value) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
    return "produced a percentage beyond the numeric magnitude limit";
  }
  return null;
}

function mapJsonV1Candidate(
  source: Extract<RemoteApiQuotaProviderDefinition, { format: "json-v1" }>,
  row: Record<string, unknown>,
  rowIndex: number,
  mapping: JsonV1Mapping,
  mappingIndex: number,
): { entry: QuotaToastEntry } | { error: string } {
  const fail = (field: string, issue: string): { error: string } => ({
    error: jsonV1CandidateError(mappingIndex, field, issue, rowIndex),
  });

  let resetTimeIso: string | undefined;
  if (mapping.resetTime) {
    const resolved = resolveJsonV1TimestampSource(row, mapping.resetTime);
    if (!resolved.ok) return fail("resetTime", resolved.issue);
    resetTimeIso = resolved.value;
  }

  let observedAtIso: string | undefined;
  if (mapping.observedTime) {
    const resolved = resolveJsonV1TimestampSource(row, mapping.observedTime);
    if (!resolved.ok) return fail("observedTime", resolved.issue);
    observedAtIso = resolved.value;
  }

  const common = {
    accounting: accountingMetadata(mapping.resultType, observedAtIso),
    name: `${source.label} ${mapping.name}`,
    group: source.label,
    ...(mapping.label ? { label: mapping.label } : {}),
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };

  switch (mapping.metric.type) {
    case "percentage": {
      const percentage = resolveJsonV1Number(row, mapping.metric.percentage);
      if (!percentage.ok) return fail("metric.percentage", percentage.issue);
      if (mapping.metric.meaning === "remaining" && percentage.value > 100) {
        return fail("metric.percentage", "must not exceed 100 for remaining meaning");
      }
      if (mapping.metric.meaning === "used" && percentage.value < 0) {
        return fail("metric.percentage", "must be non-negative for used meaning");
      }
      return {
        entry: {
          ...common,
          kind: "percent",
          percentRemaining:
            mapping.metric.meaning === "remaining" ? percentage.value : 100 - percentage.value,
        },
      };
    }
    case "used-limit": {
      const used = resolveJsonV1Number(row, mapping.metric.used);
      if (!used.ok) return fail("metric.used", used.issue);
      const limit = resolveJsonV1Number(row, mapping.metric.limit);
      if (!limit.ok) return fail("metric.limit", limit.issue);
      if (used.value < 0) return fail("metric.used", "must be non-negative");
      if (limit.value <= 0) return fail("metric.limit", "must be greater than zero");
      const percentRemaining = ((limit.value - used.value) / limit.value) * 100;
      const percentageIssue = jsonV1DerivedPercentageIssue(percentRemaining);
      if (percentageIssue) return fail("metric.limit", percentageIssue);
      return {
        entry: {
          ...common,
          kind: "percent",
          percentRemaining,
          right: formatJsonV1Pair(used.value, limit.value, mapping),
        },
      };
    }
    case "remaining-limit": {
      const remaining = resolveJsonV1Number(row, mapping.metric.remaining);
      if (!remaining.ok) return fail("metric.remaining", remaining.issue);
      const limit = resolveJsonV1Number(row, mapping.metric.limit);
      if (!limit.ok) return fail("metric.limit", limit.issue);
      if (limit.value <= 0) return fail("metric.limit", "must be greater than zero");
      if (remaining.value > limit.value) {
        return fail("metric.remaining", "must not exceed limit");
      }
      const percentRemaining = (remaining.value / limit.value) * 100;
      const percentageIssue = jsonV1DerivedPercentageIssue(percentRemaining);
      if (percentageIssue) return fail("metric.limit", percentageIssue);
      return {
        entry: {
          ...common,
          kind: "percent",
          percentRemaining,
          right: formatJsonV1Pair(remaining.value, limit.value, mapping),
        },
      };
    }
    case "spend-budget": {
      const spend = resolveJsonV1Number(row, mapping.metric.spend);
      if (!spend.ok) return fail("metric.spend", spend.issue);
      const budget = resolveJsonV1Number(row, mapping.metric.budget);
      if (!budget.ok) return fail("metric.budget", budget.issue);
      if (spend.value < 0) return fail("metric.spend", "must be non-negative");
      if (budget.value <= 0) return fail("metric.budget", "must be greater than zero");
      const percentRemaining = ((budget.value - spend.value) / budget.value) * 100;
      const percentageIssue = jsonV1DerivedPercentageIssue(percentRemaining);
      if (percentageIssue) return fail("metric.budget", percentageIssue);
      return {
        entry: {
          ...common,
          kind: "percent",
          percentRemaining,
          right: formatJsonV1Pair(spend.value, budget.value, mapping),
        },
      };
    }
    case "remaining-budget": {
      const remaining = resolveJsonV1Number(row, mapping.metric.remaining);
      if (!remaining.ok) return fail("metric.remaining", remaining.issue);
      const budget = resolveJsonV1Number(row, mapping.metric.budget);
      if (!budget.ok) return fail("metric.budget", budget.issue);
      if (budget.value <= 0) return fail("metric.budget", "must be greater than zero");
      if (remaining.value > budget.value) {
        return fail("metric.remaining", "must not exceed budget");
      }
      const percentRemaining = (remaining.value / budget.value) * 100;
      const percentageIssue = jsonV1DerivedPercentageIssue(percentRemaining);
      if (percentageIssue) return fail("metric.budget", percentageIssue);
      return {
        entry: {
          ...common,
          kind: "percent",
          percentRemaining,
          right: formatJsonV1Pair(remaining.value, budget.value, mapping),
        },
      };
    }
    case "value": {
      const value = resolveJsonV1Number(row, mapping.metric.value);
      if (!value.ok) return fail("metric.value", value.issue);
      if (!["remaining", "balance"].includes(mapping.metric.valueType) && value.value < 0) {
        return fail("metric.value", "must be non-negative");
      }
      return {
        entry: {
          ...common,
          kind: "value",
          value: formatJsonV1Value(value.value, mapping),
        },
      };
    }
    case "status": {
      const value = resolveJsonV1Text(row, mapping.metric.value);
      if (!value.ok) return fail("metric.value", value.issue);
      return { entry: { ...common, kind: "value", value: value.value } };
    }
  }
}

function parseJsonV1(
  source: Extract<RemoteApiQuotaProviderDefinition, { format: "json-v1" }>,
  body: unknown,
): RemoteQuotaProviderResult {
  const invalid = (message: string): RemoteQuotaProviderResult => ({
    success: false,
    error: `Invalid json-v1 response: ${message}`,
  });

  if (!isJsonV1ResponseDepthValid(body)) {
    return invalid(`nesting depth exceeded ${JSON_V1_MAX_RESPONSE_DEPTH}`);
  }

  let rows: unknown[];
  if (source.adapter.rowsPath) {
    if (!isRecord(body)) return invalid("adapter.rowsPath requires an object root");
    const resolved = resolveJsonV1Path(body, source.adapter.rowsPath);
    if (resolved.state !== "value") {
      return invalid(`adapter.rowsPath ${jsonV1ResolutionIssue(resolved)}`);
    }
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

  if (rows.length < 1 || rows.length > QUOTA_PROVIDER_MAX_REMOTE_ROWS) {
    return invalid(`selected rows must contain 1-${QUOTA_PROVIDER_MAX_REMOTE_ROWS} elements`);
  }
  if (rows.length * source.adapter.mappings.length > JSON_V1_MAX_CANDIDATES) {
    return invalid(`candidate count exceeded ${JSON_V1_MAX_CANDIDATES}`);
  }

  const entries: QuotaToastEntry[] = [];
  const rowErrors: string[] = [];
  let errorCount = 0;
  const recordError = (error: string): void => {
    errorCount += 1;
    if (rowErrors.length < JSON_V1_MAX_DETAILED_ERRORS) rowErrors.push(error);
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let mappingIndex = 0; mappingIndex < source.adapter.mappings.length; mappingIndex += 1) {
      if (!isRecord(row)) {
        recordError(
          jsonV1CandidateError(mappingIndex, "metric", "requires an object row", rowIndex),
        );
        continue;
      }
      const mapped = mapJsonV1Candidate(
        source,
        row,
        rowIndex,
        source.adapter.mappings[mappingIndex]!,
        mappingIndex,
      );
      if ("error" in mapped) {
        recordError(mapped.error);
        continue;
      }
      entries.push(mapped.entry);
      if (entries.length > JSON_V1_MAX_ENTRIES) {
        return invalid(`more than ${JSON_V1_MAX_ENTRIES} entries were produced`);
      }
    }
  }

  if (entries.length === 0) {
    return invalid(rowErrors[0] ?? "no mappings produced entries");
  }
  if (errorCount > rowErrors.length) {
    rowErrors.push("Additional json-v1 mapping errors omitted");
  }
  return {
    success: true,
    entries,
    ...(rowErrors.length > 0 ? { rowErrors } : {}),
  };
}

function parseOpenRouterKeyV1(
  source: RemoteApiQuotaProviderDefinition,
  body: unknown,
): RemoteQuotaProviderResult {
  if (!isRecord(body) || !isRecord(body.data)) {
    return { success: false, error: "Invalid openrouter-key-v1 response" };
  }

  const data = body.data;
  const usage = data.usage;
  const limit = data.limit;
  const remaining = data.limit_remaining;
  if (
    typeof usage !== "number" ||
    !Number.isFinite(usage) ||
    usage < 0 ||
    (limit !== null &&
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) ||
    (remaining !== undefined && (typeof remaining !== "number" || !Number.isFinite(remaining)))
  ) {
    return { success: false, error: "Invalid openrouter-key-v1 response" };
  }

  if (typeof limit === "number" && limit > 0) {
    const remainingValue = typeof remaining === "number" ? remaining : limit - usage;
    if (remainingValue > limit) {
      return {
        success: false,
        error: "Invalid openrouter-key-v1 response",
      };
    }
    const percentRemaining = (remainingValue / limit) * 100;
    return {
      success: true,
      entries: [
        {
          accounting: accountingMetadata("budget"),
          kind: "percent",
          name: `${source.label} budget`,
          group: source.label,
          label: "Budget:",
          right: `${formatUsd(usage)}/${formatUsd(limit)}`,
          percentRemaining,
        },
      ],
    };
  }

  return {
    success: true,
    entries: [
      {
        accounting: accountingMetadata("spend"),
        kind: "value",
        name: `${source.label} spend`,
        group: source.label,
        label: "Spend:",
        value: formatUsd(usage),
      },
    ],
  };
}

export async function fetchRemoteQuotaProvider(
  source: RemoteApiQuotaProviderDefinition,
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<RemoteQuotaProviderResult> {
  const timeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(source.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return { success: false, error: "Redirect rejected" };
    }
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const body = await readBoundedJson(response);
    switch (source.format) {
      case "quota-v1":
        return parseQuotaV1(source, body);
      case "openrouter-key-v1":
        return parseOpenRouterKeyV1(source, body);
      case "json-v1":
        return parseJsonV1(source, body);
    }
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return {
        success: false,
        error: `Request timeout after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    if (
      error instanceof Error &&
      [
        "Response exceeded 262144 bytes",
        "Expected a JSON response",
        "Invalid JSON response",
      ].includes(error.message)
    ) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to read accounting data" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
  return results;
}
