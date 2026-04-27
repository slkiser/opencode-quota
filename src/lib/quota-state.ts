import { createHash } from "crypto";
import { readFile, readdir, rm, stat } from "fs/promises";
import { join } from "path";

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "./entries.js";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { isLiveLocalUsageProviderId } from "./provider-metadata.js";

const QUOTA_PROVIDER_CACHE_VERSION = 1 as const;
const QUOTA_PROVIDER_CACHE_DIRNAME = "quota-provider-state";
const QUOTA_PROVIDER_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type PersistedQuotaProviderCacheEntry = {
  version: typeof QUOTA_PROVIDER_CACHE_VERSION;
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
    entries: result.entries.map((entry) => ({ ...entry })),
    errors: result.errors.map((error) => ({ ...error })),
    ...(result.presentation ? { presentation: { ...result.presentation } } : {}),
  };
}

export function buildQuotaProviderStateCacheKey(
  providerId: string,
  ctx: QuotaProviderContext,
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

  return `${providerId}|anthropicBinaryPath=${anthropicBinaryPath}|googleModels=${googleModels}|alibabaTier=${alibabaCodingPlanTier}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|opencodeGoWindows=${opencodeGoWindows}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}`;
}

function getQuotaProviderCacheDir(): string {
  return join(getOpencodeRuntimeDirs().cacheDir, QUOTA_PROVIDER_CACHE_DIRNAME);
}

export function getQuotaProviderStateCacheFilePath(providerId: string, key: string): string {
  const digest = createHash("sha1").update(key).digest("hex");
  return join(getQuotaProviderCacheDir(), `${providerId}-${digest}.json`);
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
  if (typeof result.attempted !== "boolean") {
    return false;
  }

  if (!Array.isArray(result.entries) || !Array.isArray(result.errors)) {
    return false;
  }

  if (result.presentation !== undefined && !isQuotaProviderPresentation(result.presentation)) {
    return false;
  }

  return true;
}

function isPersistedQuotaProviderCacheEntry(
  value: unknown,
  key: string,
  providerId: string,
): value is PersistedQuotaProviderCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    entry.version === QUOTA_PROVIDER_CACHE_VERSION &&
    entry.key === key &&
    entry.providerId === providerId &&
    typeof entry.timestamp === "number" &&
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
  ttlMs: number;
  now: number;
}): Promise<PersistedQuotaProviderCacheEntry | null> {
  if (params.ttlMs <= 0) {
    return null;
  }

  const path = getQuotaProviderStateCacheFilePath(params.providerId, params.key);

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedQuotaProviderCacheEntry(parsed, params.key, params.providerId)) {
      await safeRm(path);
      return null;
    }

    if (params.now - parsed.timestamp >= params.ttlMs) {
      return null;
    }

    return {
      version: parsed.version,
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

export async function fetchQuotaProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs, bypassCache = false } = params;

  if (bypassCache || isLiveLocalUsageProviderId(provider.id)) {
    return cloneQuotaProviderResult(await provider.fetch(ctx));
  }

  const key = buildQuotaProviderStateCacheKey(provider.id, ctx);
  const now = Date.now();
  await maybePrunePersistedQuotaProviderCache(now);

  const inMemory = inMemoryCache.get(key);
  if (inMemory && ttlMs > 0 && now - inMemory.timestamp < ttlMs) {
    return cloneQuotaProviderResult(inMemory.result);
  }

  const inFlight = inFlightByKey.get(key);
  if (inFlight) {
    return cloneQuotaProviderResult(await inFlight);
  }

  const persisted = await readPersistedQuotaProviderCacheEntry({
    key,
    providerId: provider.id,
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
    const fetched = await provider.fetch(ctx);
    const snapshot = cloneQuotaProviderResult(fetched);

    if (!snapshot.attempted) {
      inMemoryCache.delete(key);
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    const entry: PersistedQuotaProviderCacheEntry = {
      version: QUOTA_PROVIDER_CACHE_VERSION,
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

export function __resetQuotaStateForTests(): void {
  inMemoryCache.clear();
  inFlightByKey.clear();
  lastPruneAtMs = 0;
}
