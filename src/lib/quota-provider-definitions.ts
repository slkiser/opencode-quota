import { sanitizeSingleLineDisplaySnippet as clean } from "./display-sanitize.js";
// Adapted from upstream declarative quota-providers.ts at 2733b5b.
export type JsonPath = string[];
export type NumberSource =
  | { path: JsonPath; divideBy?: 100 | 1000 | 1000000 }
  | { literal: number };
export type TextSource = { path: JsonPath } | { literal: string };
export type TimeSource = ({ path: JsonPath } | { literal: string | number }) & {
  encoding: "iso-8601" | "unix-seconds" | "unix-milliseconds";
};
export type CustomMetric =
  | { type: "percentage"; percentage: NumberSource; meaning: "used" | "remaining" }
  | { type: "used-limit"; used: NumberSource; limit: NumberSource }
  | { type: "remaining-limit"; remaining: NumberSource; limit: NumberSource }
  | { type: "spend-budget"; spend: NumberSource; budget: NumberSource }
  | { type: "remaining-budget"; remaining: NumberSource; budget: NumberSource }
  | {
      type: "value";
      valueType: "used" | "limit" | "remaining" | "balance" | "spend" | "budget";
      value: NumberSource;
    }
  | { type: "status"; value: TextSource };
export interface CustomMapping {
  resultType: "quota" | "rate_limit" | "usage" | "spend" | "budget" | "balance" | "status";
  name: string;
  label?: string;
  unit?: string;
  unitPosition?: "prefix" | "suffix";
  resetTime?: TimeSource;
  observedTime?: TimeSource;
  metric: CustomMetric;
}
export interface RemoteQuotaDefinition {
  id: `custom-${string}`;
  providerId: string;
  label: string;
  mode: "remote-api";
  url: string;
  apiKeyEnv?: string;
  modelIds?: string[];
  format: "quota-v1" | "json-v1";
  adapter?: { rowsPath?: JsonPath; mappings: CustomMapping[] };
}
export const isRecord = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((key) => keys.includes(key));
export const boundedText = (v: unknown, max = 80): v is string =>
  typeof v === "string" && v.trim().length > 0 && Array.from(v).length <= max;
export const boundedNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e15;
export function validPath(v: unknown): v is JsonPath {
  return (
    Array.isArray(v) &&
    v.length <= 8 &&
    v.every(
      (item) => boundedText(item, 64) && !["__proto__", "constructor", "prototype"].includes(item),
    )
  );
}
function numberSource(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return "literal" in v
    ? onlyKeys(v, ["literal"]) && boundedNumber(v.literal)
    : onlyKeys(v, ["path", "divideBy"]) &&
        validPath(v.path) &&
        (v.divideBy === undefined || [100, 1000, 1000000].includes(v.divideBy));
}
function textSource(v: unknown): boolean {
  return (
    isRecord(v) &&
    ("literal" in v
      ? onlyKeys(v, ["literal"]) && boundedText(v.literal, 160)
      : onlyKeys(v, ["path"]) && validPath(v.path))
  );
}
function timeSource(v: unknown): boolean {
  if (!isRecord(v) || !["iso-8601", "unix-seconds", "unix-milliseconds"].includes(v.encoding))
    return false;
  return "literal" in v
    ? onlyKeys(v, ["literal", "encoding"]) &&
        (boundedText(v.literal, 160) || boundedNumber(v.literal))
    : onlyKeys(v, ["path", "encoding"]) && validPath(v.path);
}
function metric(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (v.type === "percentage")
    return (
      onlyKeys(v, ["type", "percentage", "meaning"]) &&
      ["remaining", "used"].includes(v.meaning) &&
      numberSource(v.percentage)
    );
  if (v.type === "status") return onlyKeys(v, ["type", "value"]) && textSource(v.value);
  if (v.type === "value")
    return (
      onlyKeys(v, ["type", "valueType", "value"]) &&
      ["used", "limit", "remaining", "balance", "spend", "budget"].includes(v.valueType) &&
      numberSource(v.value)
    );
  const pairs: Record<string, string[]> = {
    "used-limit": ["used", "limit"],
    "remaining-limit": ["remaining", "limit"],
    "spend-budget": ["spend", "budget"],
    "remaining-budget": ["remaining", "budget"],
  };
  const keys = pairs[v.type];
  return !!keys && onlyKeys(v, ["type", ...keys]) && keys.every((key) => numberSource(v[key]));
}
function compatibleMetric(v: Record<string, any>): boolean {
  const type = v.metric?.type;
  if (["percentage", "used-limit", "remaining-limit"].includes(type))
    return ["quota", "rate_limit", "budget"].includes(v.resultType);
  if (["spend-budget", "remaining-budget"].includes(type)) return v.resultType === "budget";
  if (type === "value" && ["spend", "balance", "budget"].includes(v.metric.valueType))
    return v.resultType === v.metric.valueType;
  return true;
}
function mapping(v: unknown): boolean {
  return (
    isRecord(v) &&
    onlyKeys(v, [
      "resultType",
      "name",
      "label",
      "unit",
      "unitPosition",
      "resetTime",
      "observedTime",
      "metric",
    ]) &&
    ["quota", "rate_limit", "usage", "spend", "budget", "balance", "status"].includes(
      v.resultType,
    ) &&
    boundedText(v.name) &&
    (v.label === undefined || boundedText(v.label)) &&
    (v.unit === undefined || boundedText(v.unit, 32)) &&
    (v.unitPosition === undefined || ["prefix", "suffix"].includes(v.unitPosition)) &&
    (v.resetTime === undefined || timeSource(v.resetTime)) &&
    (v.observedTime === undefined || timeSource(v.observedTime)) &&
    metric(v.metric) &&
    compatibleMetric(v)
  );
}
export function validQuotaUrl(value: unknown): value is string {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      ![...url.searchParams.keys()].some((key) =>
        /token|secret|password|api.?key|authorization/iu.test(key),
      )
    );
  } catch {
    return false;
  }
}
export function validateRemoteDefinitions(value: unknown): RemoteQuotaDefinition[] {
  if (!Array.isArray(value) || value.length > 16)
    throw new Error("Expected at most 16 custom definitions");
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      !onlyKeys(item, [
        "id",
        "providerId",
        "label",
        "mode",
        "url",
        "apiKeyEnv",
        "modelIds",
        "format",
        "adapter",
      ]) ||
      typeof item.id !== "string" ||
      !/^custom-[a-z0-9][a-z0-9-]{0,55}$/u.test(item.id) ||
      ids.has(item.id) ||
      item.mode !== "remote-api" ||
      (item.providerId !== undefined &&
        (typeof item.providerId !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(item.providerId))) ||
      (item.modelIds !== undefined &&
        (!Array.isArray(item.modelIds) ||
          item.modelIds.length < 1 ||
          item.modelIds.length > 32 ||
          !item.modelIds.every(
            (model: unknown) => typeof model === "string" && /^[^\s]{1,200}$/u.test(model),
          ))) ||
      (item.label !== undefined && !boundedText(item.label)) ||
      !validQuotaUrl(item.url) ||
      (item.apiKeyEnv !== undefined &&
        (typeof item.apiKeyEnv !== "string" ||
          !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(item.apiKeyEnv))) ||
      !["quota-v1", "json-v1"].includes(item.format)
    )
      throw new Error(`Invalid custom definition at index ${index}`);
    if (item.format === "quota-v1" && item.adapter !== undefined)
      throw new Error(`Unexpected adapter at index ${index}`);
    if (
      item.format === "json-v1" &&
      (!isRecord(item.adapter) ||
        !onlyKeys(item.adapter, ["rowsPath", "mappings"]) ||
        (item.adapter.rowsPath !== undefined && !validPath(item.adapter.rowsPath)) ||
        !Array.isArray(item.adapter.mappings) ||
        item.adapter.mappings.length < 1 ||
        item.adapter.mappings.length > 16 ||
        !item.adapter.mappings.every(mapping))
    )
      throw new Error(`Invalid mappings at index ${index}`);
    if (!clean(item.label ?? item.id, 80)) throw new Error(`Invalid label at index ${index}`);
    ids.add(item.id);
    return structuredClone({
      ...item,
      providerId: item.providerId ?? item.id,
      label: clean(item.label ?? item.id, 80),
    }) as RemoteQuotaDefinition;
  });
}
