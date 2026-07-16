import { createHash } from "crypto";
import { readFile, readdir, rm, stat } from "fs/promises";
import { join } from "path";

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "./entries.js";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderDisplayLabel, isLiveLocalUsageProviderId } from "./provider-metadata.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  selectEligibleQuotaProviderDefinitions,
} from "./quota-providers.js";
import { getPackageVersion } from "./version.js";

const QUOTA_PROVIDER_CACHE_VERSION = 2 as const;
const QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK = "unknown";
const QUOTA_PROVIDER_CACHE_DIRNAME = "quota-provider-state";
const QUOTA_PROVIDER_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type PersistedQuotaProviderCacheEntry = {
  version: typeof QUOTA_PROVIDER_CACHE_VERSION;
  packageVersion: string;
  key: string;
  providerId: string;
  timestamp: number;
  result: QuotaProviderResult;
};

const inMemoryCache = new Map<string, PersistedQuotaProviderCacheEntry>();
const inFlightByKey = new Map<string, Promise<QuotaProviderResult>>();
let lastPruneAtMs = 0;

export function cloneQuotaProviderResult(result: QuotaProviderResult): QuotaProviderResult {
  return {
    attempted: result.attempted,
    entries: result.entries.map((entry) => ({
      ...entry,
      accounting: { ...entry.accounting },
    })),
    errors: result.errors.map((error) => ({ ...error })),
    ...(result.diagnostics
      ? {
          diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            modelIds: diagnostic.modelIds ? [...diagnostic.modelIds] : null,
            checkedPaths: [...diagnostic.checkedPaths],
            authPaths: [...diagnostic.authPaths],
          })),
        }
      : {}),
    ...(result.presentation ? { presentation: { ...result.presentation } } : {}),
  };
}

export function buildQuotaProviderStateCacheKey(
  providerId: string,
  ctx: QuotaProviderContext,
  options: { runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[] } = {},
): string {
  const googleModels = ctx.config.googleModels.join(",");
  const cursorPlan = ctx.config.cursorPlan;
  const cursorIncludedApiUsd = ctx.config.cursorIncludedApiUsd ?? "";
  const cursorBillingCycleStartDay = ctx.config.cursorBillingCycleStartDay ?? "";
  const opencodeGoWindows = ctx.config.opencodeGoWindows?.join(",") ?? "";
  const onlyCurrentModel = ctx.config.onlyCurrentModel ? "yes" : "no";
  const currentModel = ctx.config.currentModel ?? "";
  const currentProviderID = ctx.config.currentProviderID ?? "";
  const anthropicBinaryPath = ctx.config.anthropicBinaryPath ?? "";
  const isAggregateCache =
    providerId === QUOTA_PROVIDERS_AGGREGATE_ID ||
    providerId.startsWith(`${QUOTA_PROVIDERS_AGGREGATE_ID}:`);
  const relevantQuotaProviders = isAggregateCache
    ? (ctx.config.quotaProviders ?? [])
    : (ctx.config.quotaProviders ?? []).filter((definition) => definition.id === providerId);
  const quotaProvidersIdentity =
    relevantQuotaProviders.length > 0
      ? `|quotaProviders=${JSON.stringify(["quota-providers-cache-v1", relevantQuotaProviders])}`
      : "";
  const runtimeEligibleIdentity = isAggregateCache
    ? `|runtimeEligibleQuotaProviders=${JSON.stringify([
        "quota-providers-runtime-eligible-v1",
        options.runtimeEligibleQuotaProviders ?? [],
      ])}`
    : "";

  return `${providerId}${quotaProvidersIdentity}${runtimeEligibleIdentity}|anthropicBinaryPath=${anthropicBinaryPath}|googleModels=${googleModels}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|opencodeGoWindows=${opencodeGoWindows}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}`;
}

function getQuotaProviderCacheDir(): string {
  return join(getOpencodeRuntimeDirs().cacheDir, QUOTA_PROVIDER_CACHE_DIRNAME);
}

export function getQuotaProviderStateCacheFilePath(providerId: string, key: string): string {
  const digest = createHash("sha1").update(key).digest("hex");
  return join(getQuotaProviderCacheDir(), `${providerId}-${digest}.json`);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isOptionalIsoTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      ISO_TIMESTAMP_RE.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}

function isAccountingMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const accounting = value as Record<string, unknown>;
  return (
    hasOnlyKeys(accounting, [
      "resultType",
      "acquisitionMethod",
      "ownership",
      "authority",
      "sourceId",
      "observedAtIso",
    ]) &&
    ["quota", "rate_limit", "usage", "spend", "budget", "balance", "status"].includes(
      String(accounting.resultType),
    ) &&
    [
      "remote_api",
      "dashboard_scrape",
      "local_cli",
      "local_runtime_accounting",
      "local_estimation",
    ].includes(String(accounting.acquisitionMethod)) &&
    ["maintained", "user_configured"].includes(String(accounting.ownership)) &&
    ["provider_reported", "locally_derived"].includes(String(accounting.authority)) &&
    (accounting.sourceId === undefined || typeof accounting.sourceId === "string") &&
    isOptionalIsoTimestamp(accounting.observedAtIso)
  );
}

function isQuotaToastEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const entry = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(entry, [
      "accounting",
      "kind",
      "name",
      "percentRemaining",
      "value",
      "resetTimeIso",
      "group",
      "label",
      "right",
    ]) ||
    !isAccountingMetadata(entry.accounting) ||
    typeof entry.name !== "string" ||
    !isOptionalIsoTimestamp(entry.resetTimeIso) ||
    !["group", "label", "right"].every(
      (key) => entry[key] === undefined || typeof entry[key] === "string",
    )
  ) {
    return false;
  }

  if (entry.kind === "value") {
    return typeof entry.value === "string" && entry.percentRemaining === undefined;
  }

  return (
    (entry.kind === undefined || entry.kind === "percent") &&
    typeof entry.percentRemaining === "number" &&
    Number.isFinite(entry.percentRemaining) &&
    entry.value === undefined
  );
}

function isQuotaToastError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const error = value as Record<string, unknown>;
  return (
    hasOnlyKeys(error, ["label", "message"]) &&
    typeof error.label === "string" &&
    typeof error.message === "string"
  );
}

function isQuotaProviderDiagnostic(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  return (
    hasOnlyKeys(diagnostic, [
      "sourceId",
      "providerId",
      "mode",
      "format",
      "modelIds",
      "apiKeyEnv",
      "selected",
      "attempted",
      "credentialSource",
      "outcome",
      "httpStatus",
      "entryCount",
      "checkedPaths",
      "authPaths",
      "statePath",
      "stateHealth",
      "stateVersion",
      "stateLastUpdatedAt",
    ]) &&
    typeof diagnostic.sourceId === "string" &&
    typeof diagnostic.providerId === "string" &&
    ["remote-api", "local-estimate"].includes(String(diagnostic.mode)) &&
    (diagnostic.format === undefined ||
      ["accounting-v1", "openrouter-key-v1"].includes(String(diagnostic.format))) &&
    (diagnostic.mode === "remote-api"
      ? diagnostic.format !== undefined
      : diagnostic.format === undefined) &&
    (diagnostic.modelIds === null ||
      (Array.isArray(diagnostic.modelIds) &&
        diagnostic.modelIds.every((modelId) => typeof modelId === "string"))) &&
    (diagnostic.apiKeyEnv === null || typeof diagnostic.apiKeyEnv === "string") &&
    diagnostic.selected === true &&
    typeof diagnostic.attempted === "boolean" &&
    (diagnostic.credentialSource === null ||
      ["explicit_env", "global_opencode_json", "global_opencode_jsonc", "auth_json"].includes(
        String(diagnostic.credentialSource),
      )) &&
    [
      "missing_credential",
      "success",
      "http_error",
      "redirect_error",
      "timeout",
      "body_too_large",
      "invalid_content_type",
      "invalid_json",
      "invalid_response",
      "network_error",
      "local_state_error",
    ].includes(String(diagnostic.outcome)) &&
    (diagnostic.httpStatus === undefined ||
      (typeof diagnostic.httpStatus === "number" &&
        Number.isInteger(diagnostic.httpStatus) &&
        diagnostic.httpStatus >= 100 &&
        diagnostic.httpStatus <= 599)) &&
    typeof diagnostic.entryCount === "number" &&
    Number.isInteger(diagnostic.entryCount) &&
    diagnostic.entryCount >= 0 &&
    Array.isArray(diagnostic.checkedPaths) &&
    diagnostic.checkedPaths.every((path) => typeof path === "string") &&
    Array.isArray(diagnostic.authPaths) &&
    diagnostic.authPaths.every((path) => typeof path === "string") &&
    (diagnostic.statePath === undefined || typeof diagnostic.statePath === "string") &&
    (diagnostic.stateHealth === undefined ||
      ["missing", "healthy", "malformed", "version_mismatch"].includes(
        String(diagnostic.stateHealth),
      )) &&
    (diagnostic.stateVersion === undefined ||
      diagnostic.stateVersion === null ||
      (typeof diagnostic.stateVersion === "number" &&
        Number.isInteger(diagnostic.stateVersion) &&
        diagnostic.stateVersion >= 0)) &&
    (diagnostic.stateLastUpdatedAt === undefined ||
      diagnostic.stateLastUpdatedAt === null ||
      (typeof diagnostic.stateLastUpdatedAt === "number" &&
        Number.isFinite(diagnostic.stateLastUpdatedAt)))
  );
}

function isQuotaProviderPresentation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const presentation = value as Record<string, unknown>;
  return (
    hasOnlyKeys(presentation, [
      "singleWindowDisplayName",
      "singleWindowShowRight",
      "classicStrategy",
    ]) &&
    (presentation.singleWindowDisplayName === undefined ||
      typeof presentation.singleWindowDisplayName === "string") &&
    (presentation.singleWindowShowRight === undefined ||
      typeof presentation.singleWindowShowRight === "boolean") &&
    (presentation.classicStrategy === undefined || presentation.classicStrategy === "preserve")
  );
}

function isQuotaProviderResult(value: unknown): value is QuotaProviderResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const result = value as Record<string, unknown>;
  return (
    hasOnlyKeys(result, ["attempted", "entries", "errors", "diagnostics", "presentation"]) &&
    typeof result.attempted === "boolean" &&
    Array.isArray(result.entries) &&
    result.entries.every(isQuotaToastEntry) &&
    Array.isArray(result.errors) &&
    result.errors.every(isQuotaToastError) &&
    (result.diagnostics === undefined ||
      (Array.isArray(result.diagnostics) && result.diagnostics.every(isQuotaProviderDiagnostic))) &&
    (result.presentation === undefined || isQuotaProviderPresentation(result.presentation))
  );
}

async function getQuotaProviderCachePackageVersion(): Promise<string> {
  return (await getPackageVersion()) ?? QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK;
}

function isPersistedQuotaProviderCacheEntry(
  value: unknown,
  key: string,
  providerId: string,
  packageVersion: string,
): value is PersistedQuotaProviderCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    entry.version === QUOTA_PROVIDER_CACHE_VERSION &&
    entry.packageVersion === packageVersion &&
    entry.key === key &&
    entry.providerId === providerId &&
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    isQuotaProviderResult(entry.result)
  );
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // best-effort cleanup
  }
}

async function maybePrunePersistedQuotaProviderCache(now: number): Promise<void> {
  if (now - lastPruneAtMs < QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastPruneAtMs = now;
  const cacheDir = getQuotaProviderCacheDir();

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }

        const path = join(cacheDir, entry.name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > QUOTA_PROVIDER_CACHE_RETENTION_MS) {
            await safeRm(path);
          }
        } catch {
          // ignore unreadable files during best-effort pruning
        }
      }),
    );
  } catch {
    // missing/unreadable cache dir is non-fatal
  }
}

async function readPersistedQuotaProviderCacheEntry(params: {
  key: string;
  providerId: string;
  packageVersion: string;
  ttlMs: number;
  now: number;
  ignoreExpiry?: boolean;
}): Promise<PersistedQuotaProviderCacheEntry | null> {
  if (params.ttlMs <= 0 && !params.ignoreExpiry) {
    return null;
  }

  const path = getQuotaProviderStateCacheFilePath(params.providerId, params.key);

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isPersistedQuotaProviderCacheEntry(
        parsed,
        params.key,
        params.providerId,
        params.packageVersion,
      )
    ) {
      await safeRm(path);
      return null;
    }

    if (!params.ignoreExpiry && params.now - parsed.timestamp >= params.ttlMs) {
      return null;
    }

    return {
      version: parsed.version,
      packageVersion: parsed.packageVersion,
      key: parsed.key,
      providerId: parsed.providerId,
      timestamp: parsed.timestamp,
      result: cloneQuotaProviderResult(parsed.result),
    };
  } catch {
    return null;
  }
}

async function writePersistedQuotaProviderCacheEntry(
  entry: PersistedQuotaProviderCacheEntry,
): Promise<void> {
  try {
    await writeJsonAtomic(getQuotaProviderStateCacheFilePath(entry.providerId, entry.key), entry, {
      trailingNewline: true,
    });
  } catch {
    // persistence failures should not break quota fetches
  }
}

async function fetchValidatedProviderResult(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderResult> {
  const fetched = await provider.fetch(ctx);
  if (isQuotaProviderResult(fetched)) {
    return cloneQuotaProviderResult(fetched);
  }

  return {
    attempted: true,
    entries: [],
    errors: [
      {
        label: getQuotaProviderDisplayLabel(provider.id),
        message: "Invalid normalized provider result",
      },
    ],
  };
}

async function resolveRuntimeEligibleQuotaProviders(
  providerId: string,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderDefinition[] | null | undefined> {
  if (providerId !== QUOTA_PROVIDERS_AGGREGATE_ID) {
    return undefined;
  }

  try {
    const response = await ctx.client.config.providers();
    const availableProviderIds = new Set(
      (response.data?.providers ?? []).map((provider) => provider.id),
    );
    return selectEligibleQuotaProviderDefinitions({
      definitions: ctx.config.quotaProviders ?? [],
      availableProviderIds,
      onlyCurrentModel: ctx.config.onlyCurrentModel,
      currentModel: ctx.config.currentModel,
      currentProviderID: ctx.config.currentProviderID,
    });
  } catch {
    return null;
  }
}

export async function fetchQuotaProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs, bypassCache = false } = params;

  if (bypassCache || isLiveLocalUsageProviderId(provider.id)) {
    return fetchValidatedProviderResult(provider, ctx);
  }

  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    provider.id,
    ctx,
  );
  if (runtimeEligibleQuotaProviders === null) {
    return fetchValidatedProviderResult(provider, ctx);
  }
  const forceAggregateRefresh =
    provider.id === QUOTA_PROVIDERS_AGGREGATE_ID &&
    runtimeEligibleQuotaProviders?.some((definition) => definition.mode === "local-estimate") ===
      true;
  const key = buildQuotaProviderStateCacheKey(provider.id, ctx, {
    runtimeEligibleQuotaProviders,
  });
  const now = Date.now();
  const packageVersion = await getQuotaProviderCachePackageVersion();
  await maybePrunePersistedQuotaProviderCache(now);

  const inMemory = forceAggregateRefresh ? undefined : inMemoryCache.get(key);
  if (
    inMemory &&
    inMemory.packageVersion === packageVersion &&
    ttlMs > 0 &&
    now - inMemory.timestamp < ttlMs
  ) {
    return cloneQuotaProviderResult(inMemory.result);
  }

  const inFlight = inFlightByKey.get(key);
  if (inFlight) {
    return cloneQuotaProviderResult(await inFlight);
  }

  const persisted = forceAggregateRefresh
    ? null
    : await readPersistedQuotaProviderCacheEntry({
        key,
        providerId: provider.id,
        packageVersion,
        ttlMs,
        now,
      });
  if (persisted) {
    inMemoryCache.set(key, {
      ...persisted,
      result: cloneQuotaProviderResult(persisted.result),
    });
    return cloneQuotaProviderResult(persisted.result);
  }

  const fetchPromise = (async () => {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);

    if (!snapshot.attempted || snapshot.entries.length === 0) {
      inMemoryCache.delete(key);
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    const entry: PersistedQuotaProviderCacheEntry = {
      version: QUOTA_PROVIDER_CACHE_VERSION,
      packageVersion,
      key,
      providerId: provider.id,
      timestamp: Date.now(),
      result: cloneQuotaProviderResult(snapshot),
    };

    inMemoryCache.set(key, {
      ...entry,
      result: cloneQuotaProviderResult(entry.result),
    });
    await writePersistedQuotaProviderCacheEntry(entry);
    return snapshot;
  })().finally(() => {
    inFlightByKey.delete(key);
  });

  inFlightByKey.set(key, fetchPromise);
  return cloneQuotaProviderResult(await fetchPromise);
}

export type CachedProviderRead =
  | { hit: true; result: QuotaProviderResult; timestamp: number }
  | { hit: false };

export async function readCachedProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
}): Promise<CachedProviderRead> {
  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    params.provider.id,
    params.ctx,
  );
  if (runtimeEligibleQuotaProviders === null) {
    return { hit: false };
  }
  const key = buildQuotaProviderStateCacheKey(params.provider.id, params.ctx, {
    runtimeEligibleQuotaProviders,
  });
  const now = Date.now();

  // Check in-memory cache first.
  const inMemory = inMemoryCache.get(key);
  if (inMemory) {
    return {
      hit: true,
      result: cloneQuotaProviderResult(inMemory.result),
      timestamp: inMemory.timestamp,
    };
  }

  // Fall back to disk cache with no expiry guard.
  const packageVersion = await getQuotaProviderCachePackageVersion();
  const persisted = await readPersistedQuotaProviderCacheEntry({
    key,
    providerId: params.provider.id,
    packageVersion,
    ttlMs: params.ttlMs,
    now,
    ignoreExpiry: true,
  });

  if (persisted) {
    // Populate in-memory cache for subsequent reads.
    inMemoryCache.set(key, {
      ...persisted,
      result: cloneQuotaProviderResult(persisted.result),
    });
    return {
      hit: true,
      result: cloneQuotaProviderResult(persisted.result),
      timestamp: persisted.timestamp,
    };
  }

  return { hit: false };
}

export function __resetQuotaStateForTests(): void {
  inMemoryCache.clear();
  inFlightByKey.clear();
  lastPruneAtMs = 0;
}
