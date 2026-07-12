import { getQuotaProviderShape } from "./provider-metadata.js";

export const CUSTOM_SOURCE_PRESETS = ["accounting-v1", "openrouter-key-v1"] as const;

export type CustomSourcePreset = (typeof CUSTOM_SOURCE_PRESETS)[number];

export interface CustomSourceConfig {
  id: string;
  providerId: string;
  /** Normalized display label; omitted input defaults to id. */
  label: string;
  /** Canonical absolute HTTP(S) URL. */
  url: string;
  preset: CustomSourcePreset;
  apiKeyEnv?: string;
  /**
   * Exact full model ids used only for onlyCurrentModel source inclusion.
   * Omission covers every model under the exact providerId.
   */
  modelIds?: string[];
}

export interface CustomSourceValidationIssue {
  key: string;
  message: string;
}

export type CustomSourcesValidationResult =
  | { value: CustomSourceConfig[]; issues: [] }
  | { value?: undefined; issues: CustomSourceValidationIssue[] };

const SOURCE_FIELDS = [
  "id",
  "providerId",
  "label",
  "url",
  "preset",
  "apiKeyEnv",
  "modelIds",
] as const;

const REQUIRED_SOURCE_FIELDS = ["id", "providerId", "url", "preset"] as const;
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ASCII_OR_UNICODE_CONTROL_PATTERN = /\p{Cc}/u;
const URL_WHITESPACE_OR_CONTROL_PATTERN = /[\s\p{Cc}]/u;
const MODEL_FORBIDDEN_PATTERN = /[\s\p{Cc}#?]/u;
const RESERVED_AGGREGATE_ID = "custom-sources";
const MAX_ID_LENGTH = 64;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_LABEL_CODE_POINTS = 80;
const MAX_ENV_NAME_LENGTH = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidSourceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    SOURCE_ID_PATTERN.test(value)
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

function normalizeUrl(value: unknown): { value?: string; message?: string } {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    URL_WHITESPACE_OR_CONTROL_PATTERN.test(value)
  ) {
    return {
      message: "expected an absolute HTTP(S) URL without whitespace or control characters",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { message: "expected an absolute HTTP(S) URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { message: "expected an absolute HTTP(S) URL" };
  }
  if (!parsed.hostname) {
    return { message: "URL must contain a host" };
  }
  if (parsed.username || parsed.password) {
    return { message: "URL must not contain credentials" };
  }
  if (parsed.search) {
    return { message: "URL must not contain a query string" };
  }
  if (parsed.hash) {
    return { message: "URL must not contain a fragment" };
  }

  return { value: parsed.toString() };
}

function cloneSource(source: CustomSourceConfig): CustomSourceConfig {
  return {
    ...source,
    ...(source.modelIds ? { modelIds: [...source.modelIds] } : {}),
  };
}

/**
 * Validate and normalize the complete customSources array.
 *
 * Validation is atomic: any issue rejects the entire array. Successful values
 * are newly allocated and retain source and model declaration order.
 */
export function validateCustomSources(value: unknown): CustomSourcesValidationResult {
  if (!Array.isArray(value)) {
    return {
      issues: [{ key: "customSources", message: "expected an array" }],
    };
  }

  const issues: CustomSourceValidationIssue[] = [];
  const sources: Array<{ index: number; config: CustomSourceConfig }> = [];
  const sourceIds: Array<{ index: number; id: string }> = [];
  const requestIdentities: Array<{ index: number; identity: string }> = [];
  const coverage: Array<{
    index: number;
    providerId: string;
    modelIds?: string[];
  }> = [];

  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    const sourceKey = `customSources[${index}]`;

    if (!isPlainObject(raw)) {
      issues.push({ key: sourceKey, message: "expected an object" });
      continue;
    }

    const issueStart = issues.length;
    const unknownFields = Object.keys(raw)
      .filter((key) => !(SOURCE_FIELDS as readonly string[]).includes(key))
      .sort();
    for (const field of unknownFields) {
      issues.push({
        key: `${sourceKey}.${field}`,
        message:
          "unknown field; allowed fields are id, providerId, label, url, preset, apiKeyEnv, modelIds",
      });
    }

    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (!hasOwnKey(raw, field)) {
        issues.push({
          key: `${sourceKey}.${field}`,
          message: "field is required",
        });
      }
    }

    const id = raw.id;
    if (hasOwnKey(raw, "id") && !isValidSourceId(id)) {
      issues.push({
        key: `${sourceKey}.id`,
        message: "expected 1-64 ASCII characters matching ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      });
    } else if (isValidSourceId(id)) {
      if (id === RESERVED_AGGREGATE_ID) {
        issues.push({
          key: `${sourceKey}.id`,
          message: `"${RESERVED_AGGREGATE_ID}" is reserved for the aggregate provider`,
        });
      } else if (getQuotaProviderShape(id)) {
        issues.push({
          key: `${sourceKey}.id`,
          message: `collides with built-in quota provider id "${id}"`,
        });
      }
    }

    const providerId = raw.providerId;
    if (hasOwnKey(raw, "providerId") && !isValidProviderId(providerId)) {
      issues.push({
        key: `${sourceKey}.providerId`,
        message: "expected 1-64 lowercase characters matching ^[a-z0-9][a-z0-9._-]*$",
      });
    }

    let label: string | undefined;
    if (!hasOwnKey(raw, "label")) {
      if (isValidSourceId(id)) label = id;
    } else if (typeof raw.label !== "string") {
      issues.push({
        key: `${sourceKey}.label`,
        message: "expected a string",
      });
    } else {
      const normalizedLabel = raw.label.trim();
      const labelLength = Array.from(normalizedLabel).length;
      if (
        labelLength < 1 ||
        labelLength > MAX_LABEL_CODE_POINTS ||
        ASCII_OR_UNICODE_CONTROL_PATTERN.test(raw.label)
      ) {
        issues.push({
          key: `${sourceKey}.label`,
          message: "expected 1-80 printable Unicode code points after trimming",
        });
      } else {
        label = normalizedLabel;
      }
    }

    const normalizedUrl = hasOwnKey(raw, "url") ? normalizeUrl(raw.url) : { value: undefined };
    if (normalizedUrl.message) {
      issues.push({
        key: `${sourceKey}.url`,
        message: normalizedUrl.message,
      });
    }

    const preset = raw.preset;
    if (
      hasOwnKey(raw, "preset") &&
      (typeof preset !== "string" || !(CUSTOM_SOURCE_PRESETS as readonly string[]).includes(preset))
    ) {
      issues.push({
        key: `${sourceKey}.preset`,
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
        key: `${sourceKey}.apiKeyEnv`,
        message: "expected at most 128 characters matching ^[A-Z_][A-Z0-9_]*$",
      });
    }

    let modelIds: string[] | undefined;
    if (hasOwnKey(raw, "modelIds")) {
      if (!Array.isArray(raw.modelIds) || raw.modelIds.length === 0) {
        issues.push({
          key: `${sourceKey}.modelIds`,
          message: "expected a non-empty array of exact full model ids",
        });
      } else {
        modelIds = [];
        const seenModelIds = new Map<string, number>();
        for (let modelIndex = 0; modelIndex < raw.modelIds.length; modelIndex += 1) {
          const modelId = raw.modelIds[modelIndex];
          const modelKey = `${sourceKey}.modelIds[${modelIndex}]`;
          const slashIndex = typeof modelId === "string" ? modelId.indexOf("/") : -1;
          const validModelId =
            typeof modelId === "string" &&
            slashIndex > 0 &&
            slashIndex < modelId.length - 1 &&
            !MODEL_FORBIDDEN_PATTERN.test(modelId) &&
            isValidProviderId(modelId.slice(0, slashIndex)) &&
            modelId.slice(0, slashIndex) === providerId;

          if (!validModelId) {
            issues.push({
              key: modelKey,
              message:
                "expected an exact <providerId>/<modelId> selector without whitespace, control characters, #, or ?",
            });
            continue;
          }

          const firstIndex = seenModelIds.get(modelId);
          if (firstIndex !== undefined) {
            issues.push({
              key: modelKey,
              message: `duplicates ${sourceKey}.modelIds[${firstIndex}]`,
            });
            continue;
          }
          seenModelIds.set(modelId, modelIndex);
          modelIds.push(modelId);
        }
      }
    }

    const sourceIdValid =
      isValidSourceId(id) && id !== RESERVED_AGGREGATE_ID && !getQuotaProviderShape(id);
    const providerIdValid = isValidProviderId(providerId);
    const presetValid =
      typeof preset === "string" && (CUSTOM_SOURCE_PRESETS as readonly string[]).includes(preset);
    const apiKeyEnvValid =
      !hasOwnKey(raw, "apiKeyEnv") ||
      (typeof apiKeyEnv === "string" &&
        apiKeyEnv.length <= MAX_ENV_NAME_LENGTH &&
        ENV_NAME_PATTERN.test(apiKeyEnv));
    const modelIdsValid =
      !hasOwnKey(raw, "modelIds") ||
      (Array.isArray(raw.modelIds) &&
        raw.modelIds.length > 0 &&
        modelIds?.length === raw.modelIds.length);

    if (sourceIdValid) sourceIds.push({ index, id });
    if (providerIdValid && normalizedUrl.value !== undefined && presetValid && apiKeyEnvValid) {
      requestIdentities.push({
        index,
        identity: JSON.stringify([providerId, normalizedUrl.value, preset, apiKeyEnv ?? ""]),
      });
    }
    if (providerIdValid && modelIdsValid) {
      coverage.push({ index, providerId, ...(modelIds ? { modelIds } : {}) });
    }

    if (
      issueStart === issues.length &&
      sourceIdValid &&
      providerIdValid &&
      label !== undefined &&
      normalizedUrl.value !== undefined &&
      presetValid
    ) {
      sources.push({
        index,
        config: {
          id,
          providerId,
          label,
          url: normalizedUrl.value,
          preset: preset as CustomSourcePreset,
          ...(apiKeyEnv !== undefined ? { apiKeyEnv: apiKeyEnv as string } : {}),
          ...(modelIds ? { modelIds } : {}),
        },
      });
    }
  }

  const firstIdIndex = new Map<string, number>();
  for (const source of sourceIds) {
    const firstId = firstIdIndex.get(source.id);
    if (firstId !== undefined) {
      issues.push({
        key: `customSources[${source.index}].id`,
        message: `duplicates customSources[${firstId}].id`,
      });
    } else {
      firstIdIndex.set(source.id, source.index);
    }
  }

  const firstRequestIndex = new Map<string, number>();
  for (const request of requestIdentities) {
    const firstRequest = firstRequestIndex.get(request.identity);
    if (firstRequest !== undefined) {
      issues.push({
        key: `customSources[${request.index}].url`,
        message: `duplicates request identity from customSources[${firstRequest}]`,
      });
    } else {
      firstRequestIndex.set(request.identity, request.index);
    }
  }

  for (let index = 0; index < coverage.length; index += 1) {
    const source = coverage[index];
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
      const earlier = coverage[earlierIndex];
      if (source.providerId !== earlier.providerId) continue;

      const overlap =
        source.modelIds === undefined ||
        earlier.modelIds === undefined ||
        source.modelIds.some((modelId) => earlier.modelIds!.includes(modelId));
      if (!overlap) continue;

      const key = source.modelIds
        ? `customSources[${source.index}].modelIds`
        : `customSources[${source.index}].providerId`;
      issues.push({
        key,
        message: `source coverage overlaps customSources[${earlier.index}] for providerId "${source.providerId}"`,
      });
    }
  }

  if (issues.length > 0) return { issues };
  return {
    value: sources.map((source) => cloneSource(source.config)),
    issues: [],
  };
}

export function cloneCustomSources(sources: readonly CustomSourceConfig[]): CustomSourceConfig[] {
  return sources.map(cloneSource);
}
