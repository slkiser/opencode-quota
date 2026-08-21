import { createHash } from "crypto";
import { readdir, readFile, rm, stat } from "fs/promises";
import { join } from "path";
import { writeJsonAtomic } from "./atomic-json.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderDisplayLabel, isLiveLocalUsageProviderId } from "./provider-metadata.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  selectEligibleQuotaProviderDefinitions,
} from "./quota-providers.js";
import type { PersistedQuotaProviderCacheEntry } from "./quota-state-codec.js";
import {
  cloneQuotaProviderResult,
  decodePersistedQuotaProviderCacheEntry,
  encodePersistedQuotaProviderCacheEntry,
  normalizeQuotaProviderResult,
} from "./quota-state-codec.js";
import { updateQuotaTelemetrySnapshot } from "./quota-telemetry.js";
import { getPackageVersion } from "./version.js";

const QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK = "unknown";
const QUOTA_PROVIDER_CACHE_DIRNAME = "quota-provider-state";
const QUOTA_PROVIDER_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const inMemoryCache = new Map<string, PersistedQuotaProviderCacheEntry>();
const inFlightByKey = new Map<string, Promise<QuotaProviderResult>>();
let lastPruneAtMs = 0;

export function buildQuotaProviderStateCacheKey(
  providerId: string,
  ctx: QuotaProviderContext,
  options: { runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[] } = {},
): string {
  const providerSchemaIdentity = providerId === "openai" ? "|labelSchema=plan-v1" : "";
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

  return `${providerId}${providerSchemaIdentity}${quotaProvidersIdentity}${runtimeEligibleIdentity}|anthropicBinaryPath=${anthropicBinaryPath}|googleModels=${googleModels}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|opencodeGoWindows=${opencodeGoWindows}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}`;
}

function getQuotaProviderCacheDir(): string {
  return join(getOpencodeRuntimeDirs().cacheDir, QUOTA_PROVIDER_CACHE_DIRNAME);
}

export function getQuotaProviderStateCacheFilePath(providerId: string, key: string): string {
  const digest = createHash("sha1").update(key).digest("hex");
  return join(getQuotaProviderCacheDir(), `${providerId}-${digest}.json`);
}

async function getQuotaProviderCachePackageVersion(): Promise<string> {
  return (await getPackageVersion()) ?? QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK;
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
    const decoded = decodePersistedQuotaProviderCacheEntry(parsed, {
      key: params.key,
      providerId: params.providerId,
      packageVersion: params.packageVersion,
    });
    if (!decoded) {
      await safeRm(path);
      return null;
    }
    if (!params.ignoreExpiry && params.now - decoded.timestamp >= params.ttlMs) {
      return null;
    }

    return decoded;
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
  const normalized = normalizeQuotaProviderResult(fetched);
  if (normalized) return normalized;

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

function publishQuotaTelemetry(params: {
  ctx: QuotaProviderContext;
  providerId: string;
  snapshotId: string;
  result: QuotaProviderResult;
  cacheTimestamp?: number;
}): void {
  if (!params.ctx.config.telemetryToken) return;
  const uncachedSnapshotId = `uncached:${params.providerId}`;
  updateQuotaTelemetrySnapshot({
    token: params.ctx.config.telemetryToken,
    snapshotId: params.snapshotId,
    ...(params.snapshotId !== uncachedSnapshotId
      ? { supersededSnapshotIds: [uncachedSnapshotId] }
      : {}),
    providerId: params.providerId,
    result: params.result,
    ...(params.cacheTimestamp !== undefined ? { cacheTimestamp: params.cacheTimestamp } : {}),
  });
}

export async function fetchQuotaProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs, bypassCache = false } = params;

  if (bypassCache) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
  }

  if (isLiveLocalUsageProviderId(provider.id)) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
  }

  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    provider.id,
    ctx,
  );
  if (runtimeEligibleQuotaProviders === null) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
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
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: inMemory.result,
      cacheTimestamp: inMemory.timestamp,
    });
    return cloneQuotaProviderResult(inMemory.result);
  }

  const inFlight = inFlightByKey.get(key);
  if (inFlight) {
    const snapshot = await inFlight;
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: inMemoryCache.get(key)?.timestamp,
    });
    return cloneQuotaProviderResult(snapshot);
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
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: persisted.result,
      cacheTimestamp: persisted.timestamp,
    });
    return cloneQuotaProviderResult(persisted.result);
  }

  // Another caller may have installed the shared promise while this caller awaited disk I/O.
  const inFlightAfterDiskRead = inFlightByKey.get(key);
  if (inFlightAfterDiskRead) {
    const snapshot = await inFlightAfterDiskRead;
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: inMemoryCache.get(key)?.timestamp,
    });
    return cloneQuotaProviderResult(snapshot);
  }

  const fetchPromise = (async () => {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);

    if (!snapshot.attempted || snapshot.entries.length === 0) {
      inMemoryCache.delete(key);
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    const entry = encodePersistedQuotaProviderCacheEntry({
      packageVersion,
      key,
      providerId: provider.id,
      timestamp: Date.now(),
      result: snapshot,
    });

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
  const snapshot = await fetchPromise;
  publishQuotaTelemetry({
    ctx,
    providerId: provider.id,
    snapshotId: key,
    result: snapshot,
    cacheTimestamp: inMemoryCache.get(key)?.timestamp,
  });
  return cloneQuotaProviderResult(snapshot);
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
    publishQuotaTelemetry({
      ctx: params.ctx,
      providerId: params.provider.id,
      snapshotId: key,
      result: inMemory.result,
      cacheTimestamp: inMemory.timestamp,
    });
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
    publishQuotaTelemetry({
      ctx: params.ctx,
      providerId: params.provider.id,
      snapshotId: key,
      result: persisted.result,
      cacheTimestamp: persisted.timestamp,
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
