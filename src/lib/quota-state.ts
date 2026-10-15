import { createHash, randomUUID } from "crypto";
import { readFile, readdir, rm, stat } from "fs/promises";
import { join } from "path";

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "./entries.js";

import { writeJsonAtomic } from "./atomic-json.js";
import { isAccountingDocument } from "./accounting.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { isLiveLocalUsageProviderId } from "./provider-metadata.js";
import { isResolvedAuthIdentity, type ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import { getPackageVersion } from "./version.js";

const QUOTA_PROVIDER_CACHE_VERSION = 3 as const;
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
    ...(result.accounting ? { accounting: structuredClone(result.accounting) } : {}),
    ...(result.observation ? { observation: { ...result.observation } } : {}),
    attempted: result.attempted,
    entries: result.entries.map((entry) => ({ ...entry })),
    errors: result.errors.map((error) => ({ ...error })),
    ...(result.presentation ? { presentation: { ...result.presentation } } : {}),
  };
}

export function buildQuotaProviderStateCacheKey(
  providerId: string,
  ctx: QuotaProviderContext,
  identity?: ResolvedAuthIdentity,
): string {
  const googleModels = ctx.config.googleModels.join(",");
  const alibabaCodingPlanTier = ctx.config.alibabaCodingPlanTier;
  const cursorPlan = ctx.config.cursorPlan;
  const cursorIncludedApiUsd = ctx.config.cursorIncludedApiUsd ?? "";
  const cursorBillingCycleStartDay = ctx.config.cursorBillingCycleStartDay ?? "";
  const opencodeGoWindows = ctx.config.opencodeGoWindows?.join(",") ?? "";
  const onlyCurrentModel = ctx.config.onlyCurrentModel ? "yes" : "no";
  const currentModel = ctx.config.currentModel ?? "";
  const currentProviderID = ctx.config.currentProviderID ?? "";
  const anthropicBinaryPath = ctx.config.anthropicBinaryPath ?? "";

  return `${providerId}|anthropicBinaryPath=${anthropicBinaryPath}|googleModels=${googleModels}|alibabaTier=${alibabaCodingPlanTier}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|opencodeGoWindows=${opencodeGoWindows}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}${identity ? `|resolvedAuthIdentity=${identity}` : ""}`;
}

function getQuotaProviderCacheDir(): string {
  return join(getOpencodeRuntimeDirs().cacheDir, QUOTA_PROVIDER_CACHE_DIRNAME);
}

export function getQuotaProviderCacheLocator(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function prepareCacheScope(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
): Promise<{
  identity?: ResolvedAuthIdentity;
  fetch: () => Promise<QuotaProviderResult>;
} | null> {
  if (provider.cachePolicy?.kind === "account-neutral") return { fetch: () => provider.fetch(ctx) };
  if (provider.cachePolicy?.kind !== "resolved-auth") return null;
  try {
    const scope = await provider.cachePolicy.prepare(ctx);
    return scope && isResolvedAuthIdentity(scope.identity) && typeof scope.fetch === "function"
      ? scope
      : null;
  } catch {
    // Identity/storage failure must never authorize reuse of an ambiguous snapshot.
    return null;
  }
}

function cachePathForLocator(providerId: string, locator: string): string {
  const stem = /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(providerId)
    ? providerId
    : `provider-${getQuotaProviderCacheLocator(providerId)}`;
  return join(getQuotaProviderCacheDir(), `${stem}-${locator}.json`);
}

export function getQuotaProviderStateCacheFilePath(providerId: string, key: string): string {
  const digest = getQuotaProviderCacheLocator(key);
  return cachePathForLocator(providerId, digest);
}

function isQuotaProviderPresentation(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const presentation = value as Record<string, unknown>;
  const hasKnownField =
    "singleWindowDisplayName" in presentation ||
    "singleWindowShowRight" in presentation ||
    "classicDisplayName" in presentation ||
    "classicShowRight" in presentation ||
    "classicStrategy" in presentation;

  if (!hasKnownField) {
    return false;
  }

  return (
    (presentation.singleWindowDisplayName === undefined ||
      typeof presentation.singleWindowDisplayName === "string") &&
    (presentation.singleWindowShowRight === undefined ||
      typeof presentation.singleWindowShowRight === "boolean") &&
    (presentation.classicDisplayName === undefined ||
      typeof presentation.classicDisplayName === "string") &&
    (presentation.classicShowRight === undefined ||
      typeof presentation.classicShowRight === "boolean") &&
    (presentation.classicStrategy === undefined ||
      presentation.classicStrategy === "preserve" ||
      presentation.classicStrategy === "collapse_worst" ||
      presentation.classicStrategy === "first")
  );
}

function isQuotaProviderResult(value: unknown): value is QuotaProviderResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  if (result.accounting !== undefined && !isAccountingDocument(result.accounting)) return false;
  if (typeof result.attempted !== "boolean") {
    return false;
  }

  if (!Array.isArray(result.entries) || !Array.isArray(result.errors)) {
    return false;
  }

  if (result.observation !== undefined) {
    const observation = result.observation as Record<string, unknown>;
    if (
      !observation ||
      typeof observation !== "object" ||
      typeof observation.id !== "string" ||
      !/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(observation.id) ||
      typeof observation.observedAt !== "number" ||
      !Number.isFinite(observation.observedAt) ||
      observation.observedAt < 0
    )
      return false;
  }
  if (result.presentation !== undefined && !isQuotaProviderPresentation(result.presentation)) {
    return false;
  }

  return true;
}

function isErrorOnlyResult(result: QuotaProviderResult): boolean {
  return result.entries.length === 0 && result.errors.length > 0;
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
    (entry.version === QUOTA_PROVIDER_CACHE_VERSION || entry.version === 2) &&
    entry.packageVersion === packageVersion &&
    entry.key === getQuotaProviderCacheLocator(key) &&
    entry.providerId === providerId &&
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    isQuotaProviderResult(entry.result) &&
    (entry.version === 2 || Boolean((entry.result as QuotaProviderResult).observation)) &&
    !isErrorOnlyResult(entry.result)
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
      version: QUOTA_PROVIDER_CACHE_VERSION,
      packageVersion: parsed.packageVersion,
      key: parsed.key,
      providerId: parsed.providerId,
      timestamp: parsed.timestamp,
      result: {
        ...cloneQuotaProviderResult(parsed.result),
        observation: parsed.result.observation ?? {
          id: createHash("sha256").update(`legacy:${parsed.key}:${parsed.timestamp}`).digest("hex"),
          observedAt: parsed.timestamp,
        },
      },
    };
  } catch {
    return null;
  }
}

async function writePersistedQuotaProviderCacheEntry(
  entry: PersistedQuotaProviderCacheEntry,
): Promise<void> {
  try {
    await writeJsonAtomic(cachePathForLocator(entry.providerId, entry.key), entry, {
      trailingNewline: true,
    });
  } catch {
    // persistence failures should not break quota fetches
  }
}

function observe(result: QuotaProviderResult): QuotaProviderResult {
  return {
    ...cloneQuotaProviderResult(result),
    observation: { id: randomUUID(), observedAt: Date.now() },
  };
}

export async function fetchQuotaProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs, bypassCache = false } = params;

  if (bypassCache || isLiveLocalUsageProviderId(provider.id)) {
    return observe(await provider.fetch(ctx));
  }

  const scope = await prepareCacheScope(provider, ctx);
  if (!scope) return observe(await provider.fetch(ctx));
  const key = buildQuotaProviderStateCacheKey(provider.id, ctx, scope.identity);
  const now = Date.now();
  const packageVersion = await getQuotaProviderCachePackageVersion();
  await maybePrunePersistedQuotaProviderCache(now);

  const inMemory = inMemoryCache.get(key);
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

  const persisted = await readPersistedQuotaProviderCacheEntry({
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

  // Another caller may have published pending work while disk I/O was awaited.
  const pendingAfterDiskRead = inFlightByKey.get(key);
  if (pendingAfterDiskRead) return cloneQuotaProviderResult(await pendingAfterDiskRead);

  const fetchPromise = (async () => {
    const fetched = await scope.fetch();
    const snapshot = observe(fetched);

    if (!snapshot.attempted) {
      inMemoryCache.delete(key);
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    // Display the current failure, but do not replace or refresh a previous
    // observation. Cached-only surfaces may still read its original timestamp.
    if (isErrorOnlyResult(snapshot)) return snapshot;

    const entry: PersistedQuotaProviderCacheEntry = {
      version: QUOTA_PROVIDER_CACHE_VERSION,
      packageVersion,
      key: getQuotaProviderCacheLocator(key),
      providerId: provider.id,
      timestamp: snapshot.observation!.observedAt,
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
  const scope = await prepareCacheScope(params.provider, params.ctx);
  if (!scope) return { hit: false };
  const key = buildQuotaProviderStateCacheKey(params.provider.id, params.ctx, scope.identity);
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
