import { isIP } from "node:net";

import { getQuotaProviderShape } from "./provider-metadata.js";
import { lookupCost } from "./modelsdev-pricing.js";
import { resolvePricingKey } from "./quota-stats.js";

export const QUOTA_PROVIDER_REMOTE_FORMATS = ["accounting-v1", "openrouter-key-v1"] as const;
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

export interface RemoteApiQuotaProviderDefinition extends QuotaProviderDefinitionBase {
  mode: "remote-api";
  /** Canonical absolute HTTPS URL, or loopback HTTP URL. */
  url: string;
  format: QuotaProviderRemoteFormat;
  apiKeyEnv?: string;
}

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
const REMOTE_FIELDS = [...BASE_FIELDS, "url", "format", "apiKeyEnv"] as const;
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
    return {
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
      const format = raw.format;
      if (
        hasOwnKey(raw, "format") &&
        (typeof format !== "string" ||
          !(QUOTA_PROVIDER_REMOTE_FORMATS as readonly string[]).includes(format))
      ) {
        issues.push({
          key: `${providerKey}.format`,
          message: 'expected "accounting-v1" or "openrouter-key-v1"',
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

      if (providerId && normalizedUrl.value && typeof format === "string") {
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
        typeof format === "string" &&
        (QUOTA_PROVIDER_REMOTE_FORMATS as readonly string[]).includes(format)
      ) {
        definitions.push({
          index,
          config: {
            id,
            providerId,
            label,
            mode,
            url: normalizedUrl.value,
            format: format as QuotaProviderRemoteFormat,
            ...(apiKeyEnv !== undefined ? { apiKeyEnv: apiKeyEnv as string } : {}),
            ...(modelIds ? { modelIds } : {}),
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
