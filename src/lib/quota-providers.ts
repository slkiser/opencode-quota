import { isIP } from "node:net";

import type { AccountingResultType } from "./entries.js";

import { getQuotaProviderShape } from "./provider-metadata.js";
import { lookupCost } from "./modelsdev-pricing.js";
import { resolvePricingKey } from "./quota-stats.js";

export const QUOTA_PROVIDER_REMOTE_FORMATS = ["quota-v1", "openrouter-key-v1", "json-v1"] as const;
export const QUOTA_PROVIDER_MODES = ["remote-api", "local-estimate"] as const;
export const QUOTA_PROVIDER_WINDOW_TYPES = ["utc-day", "rolling"] as const;
export const QUOTA_PROVIDERS_AGGREGATE_ID = "quota-providers";
export const MAINTAINED_LOCAL_ESTIMATE_IDS = ["qwen-code", "alibaba-coding-plan"] as const;

export function isMaintainedQuotaProviderTuning(definition: QuotaProviderDefinition): boolean {
  return (MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(definition.id);
}

export function customQuotaProviderDefinitions(
  definitions: readonly QuotaProviderDefinition[],
): QuotaProviderDefinition[] {
  return definitions.filter((definition) => !isMaintainedQuotaProviderTuning(definition));
}

export function resolveQuotaProviderSessionModelIdentity(params: {
  currentModel: string;
  currentProviderID?: string;
}): { providerId: string; modelId: string } | null {
  if (params.currentProviderID) {
    return params.currentModel.length > 0
      ? { providerId: params.currentProviderID, modelId: params.currentModel }
      : null;
  }

  const slashIndex = params.currentModel.indexOf("/");
  if (slashIndex <= 0 || slashIndex === params.currentModel.length - 1) return null;
  return {
    providerId: params.currentModel.slice(0, slashIndex),
    modelId: params.currentModel.slice(slashIndex + 1),
  };
}

export function selectEligibleQuotaProviderDefinitions(params: {
  definitions: readonly QuotaProviderDefinition[];
  availableProviderIds: ReadonlySet<string>;
  onlyCurrentModel?: boolean;
  currentModel?: string;
  currentProviderID?: string;
}): QuotaProviderDefinition[] {
  const runtimeEligible = customQuotaProviderDefinitions(params.definitions).filter((definition) =>
    params.availableProviderIds.has(definition.providerId),
  );
  if (!params.onlyCurrentModel) return runtimeEligible;

  if (!params.currentModel) {
    if (!params.currentProviderID) return [];
    return runtimeEligible.filter(
      (definition) =>
        definition.providerId === params.currentProviderID && definition.modelIds === undefined,
    );
  }

  const identity = resolveQuotaProviderSessionModelIdentity({
    currentModel: params.currentModel,
    currentProviderID: params.currentProviderID,
  });
  if (!identity) return [];

  return runtimeEligible.filter(
    (definition) =>
      definition.providerId === identity.providerId &&
      (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)),
  );
}

export type QuotaProviderRemoteFormat = (typeof QUOTA_PROVIDER_REMOTE_FORMATS)[number];
export type QuotaProviderMode = (typeof QUOTA_PROVIDER_MODES)[number];
export type QuotaProviderWindowType = (typeof QUOTA_PROVIDER_WINDOW_TYPES)[number];

export type JsonV1Path = string[];

export type JsonV1NumberSource =
  | { path: JsonV1Path; divideBy?: 100 | 1_000 | 1_000_000 }
  | { literal: number };

export type JsonV1TextSource = { path: JsonV1Path } | { literal: string };

export type JsonV1TimestampEncoding = "iso-8601" | "unix-seconds" | "unix-milliseconds";

export type JsonV1TimestampSource =
  | { path: JsonV1Path; encoding: JsonV1TimestampEncoding }
  | { literal: string | number; encoding: JsonV1TimestampEncoding };

export type JsonV1Metric =
  | {
      type: "percentage";
      percentage: JsonV1NumberSource;
      meaning: "remaining" | "used";
    }
  | { type: "used-limit"; used: JsonV1NumberSource; limit: JsonV1NumberSource }
  | {
      type: "remaining-limit";
      remaining: JsonV1NumberSource;
      limit: JsonV1NumberSource;
    }
  | { type: "spend-budget"; spend: JsonV1NumberSource; budget: JsonV1NumberSource }
  | {
      type: "remaining-budget";
      remaining: JsonV1NumberSource;
      budget: JsonV1NumberSource;
    }
  | {
      type: "value";
      valueType: "used" | "limit" | "remaining" | "balance" | "spend" | "budget";
      value: JsonV1NumberSource;
    }
  | { type: "status"; value: JsonV1TextSource };

export interface JsonV1Mapping {
  resultType: AccountingResultType;
  name: string;
  label?: string;
  unit?: string;
  unitPosition?: "prefix" | "suffix";
  resetTime?: JsonV1TimestampSource;
  observedTime?: JsonV1TimestampSource;
  metric: JsonV1Metric;
}

export interface JsonV1Adapter {
  rowsPath?: JsonV1Path;
  mappings: JsonV1Mapping[];
}

interface QuotaProviderDefinitionBase {
  id: string;
  /** Effective OpenCode provider id. Input omits this when it is the same as id. */
  providerId: string;
  /** Normalized display label; omitted input defaults to id. */
  label: string;
  mode: QuotaProviderMode;
  /** Exact OpenCode model ids, without a provider prefix. Omission covers the provider. */
  modelIds?: string[];
}

interface RemoteApiQuotaProviderDefinitionBase extends QuotaProviderDefinitionBase {
  mode: "remote-api";
  /** Canonical absolute HTTPS URL, or loopback HTTP URL. */
  url: string;
  apiKeyEnv?: string;
}

export type RemoteApiQuotaProviderDefinition =
  | (RemoteApiQuotaProviderDefinitionBase & {
      format: "quota-v1" | "openrouter-key-v1";
      adapter?: never;
    })
  | (RemoteApiQuotaProviderDefinitionBase & {
      format: "json-v1";
      adapter: JsonV1Adapter;
    });

export interface LocalEstimateWindow {
  id: string;
  label: string;
  type: QuotaProviderWindowType;
  /** Present only for rolling windows. */
  durationMinutes?: number;
  requestLimit: number;
  usdBudget?: number;
}

export interface LocalEstimateQuotaProviderDefinition extends QuotaProviderDefinitionBase {
  mode: "local-estimate";
  windows: LocalEstimateWindow[];
  /**
   * Exact source model id -> models.dev provider/model fallback.
   * Automatic models.dev matching always wins.
   */
  pricingModelMap?: Record<string, string>;
}

export type QuotaProviderDefinition =
  | RemoteApiQuotaProviderDefinition
  | LocalEstimateQuotaProviderDefinition;

export interface QuotaProviderValidationIssue {
  key: string;
  message: string;
}

export type QuotaProvidersValidationResult =
  | { value: QuotaProviderDefinition[]; issues: [] }
  | { value?: undefined; issues: QuotaProviderValidationIssue[] };

const BASE_FIELDS = ["id", "providerId", "label", "mode", "modelIds"] as const;
const REMOTE_FIELDS = [...BASE_FIELDS, "url", "format", "apiKeyEnv", "adapter"] as const;
const LOCAL_FIELDS = [...BASE_FIELDS, "windows", "pricingModelMap"] as const;
const WINDOW_FIELDS = [
  "id",
  "label",
  "type",
  "durationMinutes",
  "requestLimit",
  "usdBudget",
] as const;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ASCII_OR_UNICODE_CONTROL_PATTERN = /\p{Cc}/u;
const JSON_V1_STATIC_DISPLAY_FORBIDDEN_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const URL_WHITESPACE_OR_CONTROL_PATTERN = /[\s\p{Cc}]/u;
const MODEL_FORBIDDEN_PATTERN = /[\s\p{Cc}#?]/u;
const MAX_ID_LENGTH = 64;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_LABEL_CODE_POINTS = 80;
const MAX_ENV_NAME_LENGTH = 128;
const MAX_WINDOWS = 16;
const MAX_ROLLING_MINUTES = 366 * 24 * 60;
const MAX_SAFE_REQUEST_LIMIT = 1_000_000_000;
const MAX_USD_BUDGET = 1_000_000_000;
export const JSON_V1_MAX_MAPPINGS = 16;
export const JSON_V1_MAX_ADAPTER_DEPTH = 8;
export const JSON_V1_MAX_ADAPTER_OBJECTS = 128;
export const JSON_V1_MAX_ADAPTER_PROPERTIES = 384;
export const JSON_V1_MAX_ADAPTER_ARRAY_ELEMENTS = 640;
export const JSON_V1_MAX_PATH_SEGMENTS = 8;
export const JSON_V1_MAX_PATH_SEGMENT_CODE_POINTS = 64;
export const JSON_V1_MAX_STATIC_NAME_CODE_POINTS = 80;
export const JSON_V1_MAX_STATIC_UNIT_CODE_POINTS = 32;
export const JSON_V1_MAX_DISPLAY_CODE_POINTS = 160;
export const JSON_V1_MAX_NUMBER_MAGNITUDE = 1e15;

const JSON_V1_FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const JSON_V1_DIVISORS = new Set([100, 1_000, 1_000_000]);
const JSON_V1_TIMESTAMP_ENCODINGS = new Set<JsonV1TimestampEncoding>([
  "iso-8601",
  "unix-seconds",
  "unix-milliseconds",
]);
const JSON_V1_RESULT_TYPES = new Set<AccountingResultType>([
  "quota",
  "rate_limit",
  "usage",
  "spend",
  "budget",
  "balance",
  "status",
]);
const JSON_V1_MIN_TIMESTAMP_MS = 0;
const JSON_V1_MAX_TIMESTAMP_MS = 253_402_300_799_999;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value)
  );
}

function isValidProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

function isPositiveInteger(value: unknown, max: number): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= max;
}

function isPositiveFinite(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function normalizeLabel(value: unknown, fallback: string | undefined): string | null {
  if (value === undefined) return fallback ?? null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > MAX_LABEL_CODE_POINTS ||
    ASCII_OR_UNICODE_CONTROL_PATTERN.test(value)
  ) {
    return null;
  }
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "[::1]") return true;
  if (isIP(normalized) === 4) {
    const first = Number(normalized.split(".", 1)[0]);
    return first === 127;
  }
  return false;
}

function normalizeRemoteUrl(value: unknown): { value?: string; message?: string } {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    URL_WHITESPACE_OR_CONTROL_PATTERN.test(value)
  ) {
    return {
      message: "expected an absolute HTTPS URL without whitespace or control characters",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { message: "expected an absolute HTTPS URL" };
  }

  if (!parsed.hostname) return { message: "URL must contain a host" };
  if (parsed.username || parsed.password) return { message: "URL must not contain credentials" };
  if (parsed.search) return { message: "URL must not contain a query string" };
  if (parsed.hash) return { message: "URL must not contain a fragment" };
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    return { message: "HTTPS is required except for loopback HTTP endpoints" };
  }

  return { value: parsed.toString() };
}

function cloneDefinition(definition: QuotaProviderDefinition): QuotaProviderDefinition {
  if (definition.mode === "remote-api") {
    return definition.format === "json-v1"
      ? {
          ...definition,
          ...(definition.modelIds ? { modelIds: [...definition.modelIds] } : {}),
          adapter: structuredClone(definition.adapter),
        }
      : {
          ...definition,
          ...(definition.modelIds ? { modelIds: [...definition.modelIds] } : {}),
        };
  }
  return {
    ...definition,
    ...(definition.modelIds ? { modelIds: [...definition.modelIds] } : {}),
    windows: definition.windows.map((window) => ({ ...window })),
    ...(definition.pricingModelMap ? { pricingModelMap: { ...definition.pricingModelMap } } : {}),
  };
}

function adapterIssue(issues: QuotaProviderValidationIssue[], key: string, message: string): void {
  issues.push({ key, message });
}

function validateKnownAdapterFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  key: string,
  issues: QuotaProviderValidationIssue[],
): void {
  if (Object.keys(value).some((field) => !allowed.includes(field))) {
    adapterIssue(issues, `${key}.*`, `unknown field; allowed fields are ${allowed.join(", ")}`);
  }
}

function preflightJsonV1Adapter(
  value: unknown,
  key: string,
  issues: QuotaProviderValidationIssue[],
): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  const seen = new WeakSet<object>();
  let objects = 0;
  let properties = 0;
  let arrayElements = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      adapterIssue(issues, key, "expected a bounded JSON object tree");
      return false;
    }
    seen.add(current.value);

    if (current.depth > JSON_V1_MAX_ADAPTER_DEPTH) {
      adapterIssue(issues, key, `must not exceed nesting depth ${JSON_V1_MAX_ADAPTER_DEPTH}`);
      return false;
    }

    if (Array.isArray(current.value)) {
      arrayElements += current.value.length;
      if (arrayElements > JSON_V1_MAX_ADAPTER_ARRAY_ELEMENTS) {
        adapterIssue(
          issues,
          key,
          `must not exceed ${JSON_V1_MAX_ADAPTER_ARRAY_ELEMENTS} total array elements`,
        );
        return false;
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }

    objects += 1;
    const keys = Object.keys(current.value);
    properties += keys.length;
    if (objects > JSON_V1_MAX_ADAPTER_OBJECTS) {
      adapterIssue(issues, key, `must not exceed ${JSON_V1_MAX_ADAPTER_OBJECTS} objects`);
      return false;
    }
    if (properties > JSON_V1_MAX_ADAPTER_PROPERTIES) {
      adapterIssue(
        issues,
        key,
        `must not exceed ${JSON_V1_MAX_ADAPTER_PROPERTIES} object properties`,
      );
      return false;
    }
    const record = current.value as Record<string, unknown>;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      stack.push({ value: record[keys[index]!], depth: current.depth + 1 });
    }
  }

  return true;
}

function normalizeJsonV1StaticText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== "string" || JSON_V1_STATIC_DISPLAY_FORBIDDEN_PATTERN.test(value))
    return null;
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  return length >= 1 && length <= maxCodePoints ? normalized : null;
}

function validateJsonV1Path(
  value: unknown,
  key: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1Path | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > JSON_V1_MAX_PATH_SEGMENTS) {
    adapterIssue(
      issues,
      key,
      `expected an array containing 1-${JSON_V1_MAX_PATH_SEGMENTS} path segments`,
    );
    return undefined;
  }

  const path: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const segment = value[index];
    if (
      typeof segment !== "string" ||
      Array.from(segment).length < 1 ||
      Array.from(segment).length > JSON_V1_MAX_PATH_SEGMENT_CODE_POINTS ||
      ASCII_OR_UNICODE_CONTROL_PATTERN.test(segment) ||
      JSON_V1_FORBIDDEN_PATH_SEGMENTS.has(segment)
    ) {
      adapterIssue(issues, `${key}[${index}]`, "expected a safe 1-64 code point property segment");
      continue;
    }
    path.push(segment);
  }
  return path.length === value.length ? path : undefined;
}

const JSON_V1_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function normalizeJsonV1Timestamp(
  value: unknown,
  encoding: JsonV1TimestampEncoding,
): string | null {
  let milliseconds: number;

  if (encoding === "iso-8601") {
    if (typeof value !== "string") return null;
    const match = JSON_V1_ISO_RE.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fraction = (match[7] ?? "").padEnd(3, "0");
    const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
    const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
    if (
      year < 1970 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth(year, month) ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
    const offset =
      match[8] === "Z"
        ? 0
        : (match[9] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000;
    milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction)) - offset;
  } else {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      return null;
    }
    milliseconds = encoding === "unix-seconds" ? value * 1_000 : value;
  }

  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < JSON_V1_MIN_TIMESTAMP_MS ||
    milliseconds > JSON_V1_MAX_TIMESTAMP_MS
  ) {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

function validateJsonV1NumberSource(
  value: unknown,
  key: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1NumberSource | undefined {
  if (!isPlainObject(value)) {
    adapterIssue(issues, key, "expected a path or literal number source object");
    return undefined;
  }
  const hasPath = hasOwnKey(value, "path");
  const hasLiteral = hasOwnKey(value, "literal");
  if (hasPath === hasLiteral) {
    adapterIssue(issues, key, "expected exactly one of path or literal");
    return undefined;
  }

  if (hasPath) {
    validateKnownAdapterFields(value, ["path", "divideBy"], key, issues);
    const path = validateJsonV1Path(value.path, `${key}.path`, issues);
    if (
      hasOwnKey(value, "divideBy") &&
      (typeof value.divideBy !== "number" || !JSON_V1_DIVISORS.has(value.divideBy))
    ) {
      adapterIssue(issues, `${key}.divideBy`, "expected 100, 1000, or 1000000");
    }
    if (
      path &&
      (!hasOwnKey(value, "divideBy") ||
        (typeof value.divideBy === "number" && JSON_V1_DIVISORS.has(value.divideBy)))
    ) {
      return {
        path,
        ...(value.divideBy !== undefined
          ? { divideBy: value.divideBy as 100 | 1_000 | 1_000_000 }
          : {}),
      };
    }
    return undefined;
  }

  validateKnownAdapterFields(value, ["literal"], key, issues);
  if (
    typeof value.literal !== "number" ||
    !Number.isFinite(value.literal) ||
    Math.abs(value.literal) > JSON_V1_MAX_NUMBER_MAGNITUDE
  ) {
    adapterIssue(
      issues,
      `${key}.literal`,
      `expected a finite number with absolute magnitude at most ${JSON_V1_MAX_NUMBER_MAGNITUDE}`,
    );
    return undefined;
  }
  return { literal: value.literal };
}

function validateJsonV1TextSource(
  value: unknown,
  key: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1TextSource | undefined {
  if (!isPlainObject(value)) {
    adapterIssue(issues, key, "expected a path or literal text source object");
    return undefined;
  }
  const hasPath = hasOwnKey(value, "path");
  const hasLiteral = hasOwnKey(value, "literal");
  if (hasPath === hasLiteral) {
    adapterIssue(issues, key, "expected exactly one of path or literal");
    return undefined;
  }
  validateKnownAdapterFields(value, hasPath ? ["path"] : ["literal"], key, issues);
  if (hasPath) {
    const path = validateJsonV1Path(value.path, `${key}.path`, issues);
    return path ? { path } : undefined;
  }
  const literal = normalizeJsonV1StaticText(value.literal, JSON_V1_MAX_DISPLAY_CODE_POINTS);
  if (!literal) {
    adapterIssue(
      issues,
      `${key}.literal`,
      `expected 1-${JSON_V1_MAX_DISPLAY_CODE_POINTS} printable Unicode code points after trimming`,
    );
    return undefined;
  }
  return { literal };
}

function validateJsonV1TimestampSource(
  value: unknown,
  key: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1TimestampSource | undefined {
  if (!isPlainObject(value)) {
    adapterIssue(issues, key, "expected a timestamp source object");
    return undefined;
  }
  const hasPath = hasOwnKey(value, "path");
  const hasLiteral = hasOwnKey(value, "literal");
  if (hasPath === hasLiteral) {
    adapterIssue(issues, key, "expected exactly one of path or literal");
    return undefined;
  }
  validateKnownAdapterFields(
    value,
    hasPath ? ["path", "encoding"] : ["literal", "encoding"],
    key,
    issues,
  );
  const encoding = value.encoding;
  if (
    typeof encoding !== "string" ||
    !JSON_V1_TIMESTAMP_ENCODINGS.has(encoding as JsonV1TimestampEncoding)
  ) {
    adapterIssue(
      issues,
      `${key}.encoding`,
      'expected "iso-8601", "unix-seconds", or "unix-milliseconds"',
    );
    return undefined;
  }
  const typedEncoding = encoding as JsonV1TimestampEncoding;
  if (hasPath) {
    const path = validateJsonV1Path(value.path, `${key}.path`, issues);
    return path ? { path, encoding: typedEncoding } : undefined;
  }
  if (normalizeJsonV1Timestamp(value.literal, typedEncoding) === null) {
    adapterIssue(issues, `${key}.literal`, "expected a valid timestamp for the selected encoding");
    return undefined;
  }
  return { literal: value.literal as string | number, encoding: typedEncoding };
}

function literalNumber(source: JsonV1NumberSource | undefined): number | undefined {
  return source && "literal" in source ? source.literal : undefined;
}

function requireLiteralNumber(
  source: JsonV1NumberSource | undefined,
  key: string,
  issues: QuotaProviderValidationIssue[],
  rule: "non-negative" | "positive",
): void {
  const value = literalNumber(source);
  if (value === undefined) return;
  if ((rule === "positive" && value <= 0) || (rule === "non-negative" && value < 0)) {
    adapterIssue(
      issues,
      `${key}.literal`,
      rule === "positive"
        ? "expected a number greater than zero"
        : "expected a non-negative number",
    );
  }
}

function validateJsonV1Metric(
  value: unknown,
  resultType: AccountingResultType | undefined,
  key: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1Metric | undefined {
  if (!isPlainObject(value)) {
    adapterIssue(issues, key, "expected a tagged metric object");
    return undefined;
  }
  if (typeof value.type !== "string") {
    adapterIssue(issues, `${key}.type`, "field is required");
    return undefined;
  }

  const issueStart = issues.length;
  switch (value.type) {
    case "percentage": {
      validateKnownAdapterFields(value, ["type", "percentage", "meaning"], key, issues);
      const percentage = validateJsonV1NumberSource(value.percentage, `${key}.percentage`, issues);
      if (value.meaning !== "remaining" && value.meaning !== "used") {
        adapterIssue(issues, `${key}.meaning`, 'expected "remaining" or "used"');
      }
      if (resultType && !["quota", "rate_limit", "budget"].includes(resultType)) {
        adapterIssue(issues, `${key}.type`, "percentage is incompatible with resultType");
      }
      const literal = literalNumber(percentage);
      if (
        literal !== undefined &&
        ((value.meaning === "remaining" && literal > 100) ||
          (value.meaning === "used" && literal < 0))
      ) {
        adapterIssue(
          issues,
          `${key}.percentage.literal`,
          value.meaning === "remaining"
            ? "remaining percentage must not exceed 100"
            : "used percentage must be non-negative",
        );
      }
      return issueStart === issues.length && percentage
        ? { type: "percentage", percentage, meaning: value.meaning as "remaining" | "used" }
        : undefined;
    }
    case "used-limit": {
      validateKnownAdapterFields(value, ["type", "used", "limit"], key, issues);
      const used = validateJsonV1NumberSource(value.used, `${key}.used`, issues);
      const limit = validateJsonV1NumberSource(value.limit, `${key}.limit`, issues);
      requireLiteralNumber(used, `${key}.used`, issues, "non-negative");
      requireLiteralNumber(limit, `${key}.limit`, issues, "positive");
      if (resultType && !["quota", "rate_limit"].includes(resultType)) {
        adapterIssue(issues, `${key}.type`, "used-limit is incompatible with resultType");
      }
      return issueStart === issues.length && used && limit
        ? { type: "used-limit", used, limit }
        : undefined;
    }
    case "remaining-limit": {
      validateKnownAdapterFields(value, ["type", "remaining", "limit"], key, issues);
      const remaining = validateJsonV1NumberSource(value.remaining, `${key}.remaining`, issues);
      const limit = validateJsonV1NumberSource(value.limit, `${key}.limit`, issues);
      requireLiteralNumber(limit, `${key}.limit`, issues, "positive");
      const remainingLiteral = literalNumber(remaining);
      const limitLiteral = literalNumber(limit);
      if (
        remainingLiteral !== undefined &&
        limitLiteral !== undefined &&
        remainingLiteral > limitLiteral
      ) {
        adapterIssue(issues, `${key}.remaining.literal`, "remaining must not exceed limit");
      }
      if (resultType && !["quota", "rate_limit"].includes(resultType)) {
        adapterIssue(issues, `${key}.type`, "remaining-limit is incompatible with resultType");
      }
      return issueStart === issues.length && remaining && limit
        ? { type: "remaining-limit", remaining, limit }
        : undefined;
    }
    case "spend-budget": {
      validateKnownAdapterFields(value, ["type", "spend", "budget"], key, issues);
      const spend = validateJsonV1NumberSource(value.spend, `${key}.spend`, issues);
      const budget = validateJsonV1NumberSource(value.budget, `${key}.budget`, issues);
      requireLiteralNumber(spend, `${key}.spend`, issues, "non-negative");
      requireLiteralNumber(budget, `${key}.budget`, issues, "positive");
      if (resultType && resultType !== "budget") {
        adapterIssue(issues, `${key}.type`, "spend-budget is incompatible with resultType");
      }
      return issueStart === issues.length && spend && budget
        ? { type: "spend-budget", spend, budget }
        : undefined;
    }
    case "remaining-budget": {
      validateKnownAdapterFields(value, ["type", "remaining", "budget"], key, issues);
      const remaining = validateJsonV1NumberSource(value.remaining, `${key}.remaining`, issues);
      const budget = validateJsonV1NumberSource(value.budget, `${key}.budget`, issues);
      requireLiteralNumber(budget, `${key}.budget`, issues, "positive");
      const remainingLiteral = literalNumber(remaining);
      const budgetLiteral = literalNumber(budget);
      if (
        remainingLiteral !== undefined &&
        budgetLiteral !== undefined &&
        remainingLiteral > budgetLiteral
      ) {
        adapterIssue(issues, `${key}.remaining.literal`, "remaining must not exceed budget");
      }
      if (resultType && resultType !== "budget") {
        adapterIssue(issues, `${key}.type`, "remaining-budget is incompatible with resultType");
      }
      return issueStart === issues.length && remaining && budget
        ? { type: "remaining-budget", remaining, budget }
        : undefined;
    }
    case "value": {
      validateKnownAdapterFields(value, ["type", "valueType", "value"], key, issues);
      const source = validateJsonV1NumberSource(value.value, `${key}.value`, issues);
      const allowed: Record<string, readonly AccountingResultType[]> = {
        used: ["quota", "rate_limit", "usage"],
        limit: ["quota", "rate_limit"],
        remaining: ["quota", "rate_limit"],
        balance: ["balance"],
        spend: ["spend"],
        budget: ["budget"],
      };
      if (typeof value.valueType !== "string" || !hasOwnKey(allowed, value.valueType)) {
        adapterIssue(
          issues,
          `${key}.valueType`,
          'expected "used", "limit", "remaining", "balance", "spend", or "budget"',
        );
      } else {
        if (!["remaining", "balance"].includes(value.valueType)) {
          requireLiteralNumber(source, `${key}.value`, issues, "non-negative");
        }
        if (resultType && !allowed[value.valueType]!.includes(resultType)) {
          adapterIssue(issues, `${key}.valueType`, "valueType is incompatible with resultType");
        }
      }
      return issueStart === issues.length && source
        ? {
            type: "value",
            valueType: value.valueType as
              | "used"
              | "limit"
              | "remaining"
              | "balance"
              | "spend"
              | "budget",
            value: source,
          }
        : undefined;
    }
    case "status": {
      validateKnownAdapterFields(value, ["type", "value"], key, issues);
      const source = validateJsonV1TextSource(value.value, `${key}.value`, issues);
      if (resultType && resultType !== "status") {
        adapterIssue(issues, `${key}.type`, "status is incompatible with resultType");
      }
      return issueStart === issues.length && source ? { type: "status", value: source } : undefined;
    }
    default:
      adapterIssue(issues, `${key}.type`, "expected a supported tagged metric type");
      return undefined;
  }
}

function validateJsonV1Mapping(
  value: unknown,
  key: string,
  providerLabel: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1Mapping | undefined {
  if (!isPlainObject(value)) {
    adapterIssue(issues, key, "expected an object");
    return undefined;
  }
  const issueStart = issues.length;
  validateKnownAdapterFields(
    value,
    ["resultType", "name", "label", "unit", "unitPosition", "resetTime", "observedTime", "metric"],
    key,
    issues,
  );
  for (const field of ["resultType", "name", "metric"] as const) {
    if (!hasOwnKey(value, field)) adapterIssue(issues, `${key}.${field}`, "field is required");
  }

  const resultType =
    typeof value.resultType === "string" &&
    JSON_V1_RESULT_TYPES.has(value.resultType as AccountingResultType)
      ? (value.resultType as AccountingResultType)
      : undefined;
  if (hasOwnKey(value, "resultType") && !resultType) {
    adapterIssue(issues, `${key}.resultType`, "expected a supported accounting result type");
  }

  const name = normalizeJsonV1StaticText(value.name, JSON_V1_MAX_STATIC_NAME_CODE_POINTS);
  if (hasOwnKey(value, "name") && !name) {
    adapterIssue(
      issues,
      `${key}.name`,
      `expected 1-${JSON_V1_MAX_STATIC_NAME_CODE_POINTS} printable Unicode code points after trimming`,
    );
  } else if (
    name &&
    Array.from(`${providerLabel} ${name}`).length > JSON_V1_MAX_DISPLAY_CODE_POINTS
  ) {
    adapterIssue(
      issues,
      `${key}.name`,
      `provider-prefixed name must not exceed ${JSON_V1_MAX_DISPLAY_CODE_POINTS} code points`,
    );
  }

  const label =
    value.label === undefined
      ? undefined
      : normalizeJsonV1StaticText(value.label, JSON_V1_MAX_STATIC_NAME_CODE_POINTS);
  if (value.label !== undefined && !label) {
    adapterIssue(
      issues,
      `${key}.label`,
      `expected 1-${JSON_V1_MAX_STATIC_NAME_CODE_POINTS} printable Unicode code points after trimming`,
    );
  }

  const unit =
    value.unit === undefined
      ? undefined
      : normalizeJsonV1StaticText(value.unit, JSON_V1_MAX_STATIC_UNIT_CODE_POINTS);
  if (value.unit !== undefined && !unit) {
    adapterIssue(
      issues,
      `${key}.unit`,
      `expected 1-${JSON_V1_MAX_STATIC_UNIT_CODE_POINTS} printable Unicode code points after trimming`,
    );
  }
  const unitPosition =
    value.unitPosition === "prefix" || value.unitPosition === "suffix"
      ? value.unitPosition
      : undefined;
  if (value.unitPosition !== undefined && !unitPosition) {
    adapterIssue(issues, `${key}.unitPosition`, 'expected "prefix" or "suffix"');
  }
  if ((unit === undefined) !== (unitPosition === undefined)) {
    adapterIssue(
      issues,
      `${key}.unitPosition`,
      "unit and unitPosition must be configured together",
    );
  }

  const resetTime =
    value.resetTime === undefined
      ? undefined
      : validateJsonV1TimestampSource(value.resetTime, `${key}.resetTime`, issues);
  const observedTime =
    value.observedTime === undefined
      ? undefined
      : validateJsonV1TimestampSource(value.observedTime, `${key}.observedTime`, issues);
  const metric = validateJsonV1Metric(value.metric, resultType, `${key}.metric`, issues);
  if (metric && (metric.type === "percentage" || metric.type === "status") && unit !== undefined) {
    adapterIssue(issues, `${key}.unit`, "units are not allowed for percentage or status metrics");
  }

  if (issueStart !== issues.length || !resultType || !name || !metric) return undefined;
  return {
    resultType,
    name,
    ...(label ? { label } : {}),
    ...(unit ? { unit, unitPosition: unitPosition! } : {}),
    ...(resetTime ? { resetTime } : {}),
    ...(observedTime ? { observedTime } : {}),
    metric,
  };
}

function validateJsonV1Adapter(
  value: unknown,
  key: string,
  providerLabel: string,
  issues: QuotaProviderValidationIssue[],
): JsonV1Adapter | undefined {
  if (!isPlainObject(value)) {
    adapterIssue(issues, key, "expected an object");
    return undefined;
  }
  if (!preflightJsonV1Adapter(value, key, issues)) return undefined;

  const issueStart = issues.length;
  validateKnownAdapterFields(value, ["rowsPath", "mappings"], key, issues);
  const rowsPath =
    value.rowsPath === undefined
      ? undefined
      : validateJsonV1Path(value.rowsPath, `${key}.rowsPath`, issues);
  if (!hasOwnKey(value, "mappings")) {
    adapterIssue(issues, `${key}.mappings`, "field is required");
  }
  if (
    !Array.isArray(value.mappings) ||
    value.mappings.length < 1 ||
    value.mappings.length > JSON_V1_MAX_MAPPINGS
  ) {
    adapterIssue(
      issues,
      `${key}.mappings`,
      `expected an array containing 1-${JSON_V1_MAX_MAPPINGS} mappings`,
    );
    return undefined;
  }

  const mappings: JsonV1Mapping[] = [];
  for (let index = 0; index < value.mappings.length; index += 1) {
    const mapping = validateJsonV1Mapping(
      value.mappings[index],
      `${key}.mappings[${index}]`,
      providerLabel,
      issues,
    );
    if (mapping) mappings.push(mapping);
  }

  return issueStart === issues.length && mappings.length === value.mappings.length
    ? { ...(rowsPath ? { rowsPath } : {}), mappings }
    : undefined;
}

function validateModelIds(params: {
  raw: Record<string, unknown>;
  providerKey: string;
  providerId: string | undefined;
  issues: QuotaProviderValidationIssue[];
}): string[] | undefined {
  if (!hasOwnKey(params.raw, "modelIds")) return undefined;
  const rawModelIds = params.raw.modelIds;
  if (!Array.isArray(rawModelIds) || rawModelIds.length === 0) {
    params.issues.push({
      key: `${params.providerKey}.modelIds`,
      message: "expected a non-empty array of exact OpenCode model ids",
    });
    return undefined;
  }

  const modelIds: string[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < rawModelIds.length; index += 1) {
    const modelId = rawModelIds[index];
    const key = `${params.providerKey}.modelIds[${index}]`;
    if (
      typeof modelId !== "string" ||
      modelId.length === 0 ||
      MODEL_FORBIDDEN_PATTERN.test(modelId)
    ) {
      params.issues.push({
        key,
        message: "expected an exact model id without whitespace, control characters, #, or ?",
      });
      continue;
    }
    const first = seen.get(modelId);
    if (first !== undefined) {
      params.issues.push({
        key,
        message: `duplicates ${params.providerKey}.modelIds[${first}]`,
      });
      continue;
    }
    seen.set(modelId, index);
    modelIds.push(modelId);
  }
  return modelIds;
}

function validateWindows(
  raw: unknown,
  providerKey: string,
  issues: QuotaProviderValidationIssue[],
): LocalEstimateWindow[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WINDOWS) {
    issues.push({
      key: `${providerKey}.windows`,
      message: `expected an array containing 1-${MAX_WINDOWS} windows`,
    });
    return undefined;
  }

  const windows: LocalEstimateWindow[] = [];
  const ids = new Map<string, number>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const windowKey = `${providerKey}.windows[${index}]`;
    if (!isPlainObject(item)) {
      issues.push({ key: windowKey, message: "expected an object" });
      continue;
    }

    for (const field of Object.keys(item).filter(
      (field) => !(WINDOW_FIELDS as readonly string[]).includes(field),
    )) {
      issues.push({
        key: `${windowKey}.${field}`,
        message:
          "unknown field; allowed fields are id, label, type, durationMinutes, requestLimit, usdBudget",
      });
    }
    for (const field of ["id", "type", "requestLimit"] as const) {
      if (!hasOwnKey(item, field)) {
        issues.push({ key: `${windowKey}.${field}`, message: "field is required" });
      }
    }

    const id = item.id;
    if (hasOwnKey(item, "id") && !isValidId(id)) {
      issues.push({
        key: `${windowKey}.id`,
        message: "expected 1-64 ASCII kebab-case characters",
      });
    } else if (isValidId(id)) {
      const first = ids.get(id);
      if (first !== undefined) {
        issues.push({
          key: `${windowKey}.id`,
          message: `duplicates ${providerKey}.windows[${first}].id`,
        });
      } else {
        ids.set(id, index);
      }
    }

    const label = normalizeLabel(item.label, isValidId(id) ? id : undefined);
    if (hasOwnKey(item, "label") && label === null) {
      issues.push({
        key: `${windowKey}.label`,
        message: "expected 1-80 printable Unicode code points after trimming",
      });
    }

    const type = item.type;
    if (
      hasOwnKey(item, "type") &&
      (typeof type !== "string" ||
        !(QUOTA_PROVIDER_WINDOW_TYPES as readonly string[]).includes(type))
    ) {
      issues.push({
        key: `${windowKey}.type`,
        message: 'expected "utc-day" or "rolling"',
      });
    }

    let durationMinutes: number | undefined;
    if (type === "rolling") {
      if (!isPositiveInteger(item.durationMinutes, MAX_ROLLING_MINUTES)) {
        issues.push({
          key: `${windowKey}.durationMinutes`,
          message: `expected an integer from 1 to ${MAX_ROLLING_MINUTES}`,
        });
      } else {
        durationMinutes = item.durationMinutes;
      }
    } else if (hasOwnKey(item, "durationMinutes")) {
      issues.push({
        key: `${windowKey}.durationMinutes`,
        message: "allowed only for rolling windows",
      });
    }

    if (!isPositiveInteger(item.requestLimit, MAX_SAFE_REQUEST_LIMIT)) {
      issues.push({
        key: `${windowKey}.requestLimit`,
        message: `expected an integer from 1 to ${MAX_SAFE_REQUEST_LIMIT}`,
      });
    }

    if (hasOwnKey(item, "usdBudget") && !isPositiveFinite(item.usdBudget, MAX_USD_BUDGET)) {
      issues.push({
        key: `${windowKey}.usdBudget`,
        message: `expected a number greater than 0 and at most ${MAX_USD_BUDGET}`,
      });
    }

    if (
      isValidId(id) &&
      label !== null &&
      (type === "utc-day" || type === "rolling") &&
      (type !== "rolling" || durationMinutes !== undefined) &&
      isPositiveInteger(item.requestLimit, MAX_SAFE_REQUEST_LIMIT) &&
      (!hasOwnKey(item, "usdBudget") || isPositiveFinite(item.usdBudget, MAX_USD_BUDGET))
    ) {
      windows.push({
        id,
        label,
        type,
        ...(durationMinutes !== undefined ? { durationMinutes } : {}),
        requestLimit: item.requestLimit,
        ...(item.usdBudget !== undefined ? { usdBudget: item.usdBudget as number } : {}),
      });
    }
  }

  return windows.length === raw.length ? windows : undefined;
}

function validateMaintainedWindows(
  id: string,
  windows: LocalEstimateWindow[] | undefined,
  providerKey: string,
  issues: QuotaProviderValidationIssue[],
): void {
  if (!windows || !(MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(id)) return;
  const expected =
    id === "qwen-code"
      ? [
          { id: "daily", type: "utc-day" as const },
          { id: "rpm", type: "rolling" as const, durationMinutes: 1 },
        ]
      : [
          { id: "five-hour", type: "rolling" as const, durationMinutes: 300 },
          { id: "weekly", type: "rolling" as const, durationMinutes: 10_080 },
          { id: "monthly", type: "rolling" as const, durationMinutes: 43_200 },
        ];

  if (
    windows.length !== expected.length ||
    expected.some((item, index) => {
      const window = windows[index];
      return (
        !window ||
        window.id !== item.id ||
        window.type !== item.type ||
        window.durationMinutes !== item.durationMinutes ||
        window.usdBudget !== undefined
      );
    })
  ) {
    issues.push({
      key: `${providerKey}.windows`,
      message:
        id === "qwen-code"
          ? "qwen-code tuning requires ordered daily (utc-day) and rpm (1-minute rolling) request windows"
          : "alibaba-coding-plan tuning requires ordered five-hour, weekly, and monthly rolling request windows",
    });
  }
}

function validatePricingModelMap(
  raw: unknown,
  providerKey: string,
  providerId: string,
  issues: QuotaProviderValidationIssue[],
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    issues.push({
      key: `${providerKey}.pricingModelMap`,
      message:
        "expected a non-empty object of exact source model ids to models.dev provider/model ids",
    });
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const sourceModelId of Object.keys(raw).sort()) {
    const key = `${providerKey}.pricingModelMap.${sourceModelId}`;
    const target = raw[sourceModelId];
    if (sourceModelId.length === 0 || MODEL_FORBIDDEN_PATTERN.test(sourceModelId)) {
      issues.push({
        key,
        message: "source key must be an exact model id without whitespace or control characters",
      });
      continue;
    }
    if (typeof target !== "string") {
      issues.push({ key, message: "expected a models.dev provider/model string" });
      continue;
    }

    const automatic = resolvePricingKey({ providerID: providerId, modelID: sourceModelId });
    if (automatic.ok) {
      issues.push({
        key,
        message: `automatic models.dev matching already resolves to ${automatic.key.provider}/${automatic.key.model}`,
      });
      continue;
    }

    const slash = target.indexOf("/");
    const targetProvider = slash > 0 ? target.slice(0, slash) : "";
    const targetModel = slash > 0 ? target.slice(slash + 1) : "";
    if (!targetProvider || !targetModel || !lookupCost(targetProvider, targetModel)) {
      issues.push({
        key,
        message: "target must be an exact priced models.dev provider/model id",
      });
      continue;
    }
    result[sourceModelId] = target;
  }

  return Object.keys(result).length === Object.keys(raw).length ? result : undefined;
}

/** Validate and normalize the complete global-only quotaProviders array atomically. */
export function validateQuotaProviders(value: unknown): QuotaProvidersValidationResult {
  if (!Array.isArray(value)) {
    return { issues: [{ key: "quotaProviders", message: "expected an array" }] };
  }

  const issues: QuotaProviderValidationIssue[] = [];
  const definitions: Array<{ index: number; config: QuotaProviderDefinition }> = [];
  const ids = new Map<string, number>();
  const requestIdentities = new Map<string, number>();
  const coverage: Array<{ index: number; providerId: string; modelIds?: string[] }> = [];

  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    const providerKey = `quotaProviders[${index}]`;
    if (!isPlainObject(raw)) {
      issues.push({ key: providerKey, message: "expected an object" });
      continue;
    }

    const issueStart = issues.length;
    const mode = raw.mode;
    const allowedFields =
      mode === "local-estimate"
        ? LOCAL_FIELDS
        : mode === "remote-api"
          ? REMOTE_FIELDS
          : [...new Set([...REMOTE_FIELDS, ...LOCAL_FIELDS])];
    for (const field of Object.keys(raw)
      .filter((field) => !(allowedFields as readonly string[]).includes(field))
      .sort()) {
      issues.push({
        key: `${providerKey}.${field}`,
        message: `unknown field for ${typeof mode === "string" ? mode : "quota provider"} mode`,
      });
    }

    for (const field of ["id", "mode"] as const) {
      if (!hasOwnKey(raw, field)) {
        issues.push({ key: `${providerKey}.${field}`, message: "field is required" });
      }
    }

    const id = raw.id;
    const idValid = isValidId(id);
    if (hasOwnKey(raw, "id") && !idValid) {
      issues.push({
        key: `${providerKey}.id`,
        message: "expected 1-64 ASCII kebab-case characters",
      });
    } else if (idValid) {
      if (id === QUOTA_PROVIDERS_AGGREGATE_ID) {
        issues.push({
          key: `${providerKey}.id`,
          message: `"${QUOTA_PROVIDERS_AGGREGATE_ID}" is reserved for the aggregate provider`,
        });
      }
      const builtIn = getQuotaProviderShape(id);
      if (builtIn && !(MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(id)) {
        issues.push({
          key: `${providerKey}.id`,
          message: `collides with built-in quota provider id "${id}"`,
        });
      }
      const first = ids.get(id);
      if (first !== undefined) {
        issues.push({
          key: `${providerKey}.id`,
          message: `duplicates quotaProviders[${first}].id`,
        });
      } else {
        ids.set(id, index);
      }
    }

    let providerId: string | undefined;
    if (!hasOwnKey(raw, "providerId")) {
      if (idValid) providerId = id;
    } else if (!isValidProviderId(raw.providerId)) {
      issues.push({
        key: `${providerKey}.providerId`,
        message: "expected 1-64 lowercase provider-id characters",
      });
    } else if (raw.providerId === id) {
      issues.push({
        key: `${providerKey}.providerId`,
        message: "omit providerId when it is the same as id",
      });
    } else {
      providerId = raw.providerId;
    }

    const label = normalizeLabel(raw.label, idValid ? id : undefined);
    if (hasOwnKey(raw, "label") && label === null) {
      issues.push({
        key: `${providerKey}.label`,
        message: "expected 1-80 printable Unicode code points after trimming",
      });
    }

    if (typeof mode !== "string" || !(QUOTA_PROVIDER_MODES as readonly string[]).includes(mode)) {
      issues.push({
        key: `${providerKey}.mode`,
        message: 'expected "remote-api" or "local-estimate"',
      });
    }

    const modelIds = validateModelIds({ raw, providerKey, providerId, issues });
    const modelIdsValid =
      !hasOwnKey(raw, "modelIds") ||
      (Array.isArray(raw.modelIds) && modelIds?.length === raw.modelIds.length);

    if (
      idValid &&
      (MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(id) &&
      mode !== "local-estimate"
    ) {
      issues.push({
        key: `${providerKey}.mode`,
        message: `${id} tuning must use local-estimate mode`,
      });
    }

    if (mode === "remote-api") {
      for (const field of ["url", "format"] as const) {
        if (!hasOwnKey(raw, field)) {
          issues.push({ key: `${providerKey}.${field}`, message: "field is required" });
        }
      }
      const normalizedUrl = hasOwnKey(raw, "url")
        ? normalizeRemoteUrl(raw.url)
        : { value: undefined };
      if (normalizedUrl.message) {
        issues.push({ key: `${providerKey}.url`, message: normalizedUrl.message });
      }
      const rawFormat = raw.format;
      const format = rawFormat === "accounting-v1" ? "quota-v1" : rawFormat;
      const formatValid =
        typeof format === "string" &&
        (QUOTA_PROVIDER_REMOTE_FORMATS as readonly string[]).includes(format);
      if (hasOwnKey(raw, "format") && !formatValid) {
        issues.push({
          key: `${providerKey}.format`,
          message: 'expected "quota-v1", "openrouter-key-v1", or "json-v1"',
        });
      }

      let adapter: JsonV1Adapter | undefined;
      if (format === "json-v1") {
        if (!hasOwnKey(raw, "adapter")) {
          issues.push({ key: `${providerKey}.adapter`, message: "field is required" });
        } else if (label) {
          adapter = validateJsonV1Adapter(raw.adapter, `${providerKey}.adapter`, label, issues);
        }
      } else if (hasOwnKey(raw, "adapter")) {
        issues.push({
          key: `${providerKey}.adapter`,
          message: "allowed only for json-v1 format",
        });
      }

      const apiKeyEnv = raw.apiKeyEnv;
      if (
        hasOwnKey(raw, "apiKeyEnv") &&
        (typeof apiKeyEnv !== "string" ||
          apiKeyEnv.length > MAX_ENV_NAME_LENGTH ||
          !ENV_NAME_PATTERN.test(apiKeyEnv))
      ) {
        issues.push({
          key: `${providerKey}.apiKeyEnv`,
          message: "expected at most 128 characters matching ^[A-Z_][A-Z0-9_]*$",
        });
      }

      if (providerId && normalizedUrl.value && formatValid) {
        const identity = JSON.stringify([providerId, normalizedUrl.value, format, apiKeyEnv ?? ""]);
        const first = requestIdentities.get(identity);
        if (first !== undefined) {
          issues.push({
            key: `${providerKey}.url`,
            message: `duplicates request identity from quotaProviders[${first}]`,
          });
        } else {
          requestIdentities.set(identity, index);
        }
      }

      if (
        issueStart === issues.length &&
        idValid &&
        providerId &&
        label &&
        normalizedUrl.value &&
        formatValid
      ) {
        const common = {
          id,
          providerId,
          label,
          mode: "remote-api" as const,
          url: normalizedUrl.value,
          ...(apiKeyEnv !== undefined ? { apiKeyEnv: apiKeyEnv as string } : {}),
          ...(modelIds ? { modelIds } : {}),
        };
        definitions.push({
          index,
          config:
            format === "json-v1"
              ? { ...common, format, adapter: adapter! }
              : {
                  ...common,
                  format: format as "quota-v1" | "openrouter-key-v1",
                },
        });
      }
    } else if (mode === "local-estimate") {
      if (!hasOwnKey(raw, "windows")) {
        issues.push({ key: `${providerKey}.windows`, message: "field is required" });
      }
      const windows = validateWindows(raw.windows, providerKey, issues);
      if (idValid) validateMaintainedWindows(id, windows, providerKey, issues);
      const pricingModelMap =
        providerId && hasOwnKey(raw, "pricingModelMap")
          ? validatePricingModelMap(raw.pricingModelMap, providerKey, providerId, issues)
          : undefined;

      if (issueStart === issues.length && idValid && providerId && label && windows) {
        definitions.push({
          index,
          config: {
            id,
            providerId,
            label,
            mode,
            windows,
            ...(modelIds ? { modelIds } : {}),
            ...(pricingModelMap ? { pricingModelMap } : {}),
          },
        });
      }
    }

    if (providerId && modelIdsValid) {
      coverage.push({ index, providerId, ...(modelIds ? { modelIds } : {}) });
    }
  }

  for (let index = 0; index < coverage.length; index += 1) {
    const current = coverage[index];
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
      const earlier = coverage[earlierIndex];
      if (current.providerId !== earlier.providerId) continue;
      const overlap =
        current.modelIds === undefined ||
        earlier.modelIds === undefined ||
        current.modelIds.some((modelId) => earlier.modelIds!.includes(modelId));
      if (!overlap) continue;
      issues.push({
        key: current.modelIds
          ? `quotaProviders[${current.index}].modelIds`
          : `quotaProviders[${current.index}].providerId`,
        message: `provider/model coverage overlaps quotaProviders[${earlier.index}] for providerId "${current.providerId}"`,
      });
    }
  }

  if (issues.length > 0) return { issues };
  return { value: definitions.map((item) => cloneDefinition(item.config)), issues: [] };
}

export function cloneQuotaProviders(
  definitions: readonly QuotaProviderDefinition[],
): QuotaProviderDefinition[] {
  return definitions.map(cloneDefinition);
}

export function findQuotaProviderDefinition(
  definitions: readonly QuotaProviderDefinition[],
  id: string,
): QuotaProviderDefinition | undefined {
  return definitions.find((definition) => definition.id === id);
}
