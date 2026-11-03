/**
 * Keyed cache and throttling system for rendered quota toasts.
 *
 * This is presentation-only throttling:
 * - Each cache key stores the last rendered toast string for that surface/session context
 * - Only fetch if minIntervalMs has passed since the last fetch for that key
 * - Deduplicate concurrent fetches per key
 */

import type { CachedToast } from "./types.js";

type CacheEntry = {
  cachedToast: CachedToast | null;
  inFlightPromise: Promise<string | null> | null;
  lastFetchTime: number;
};

const MAX_CACHE_ENTRIES = 100;

const cacheEntries = new Map<string, CacheEntry>();

/**
 * Keep at most MAX_CACHE_ENTRIES entries by dropping the least recently used ones. Entries that
 * are still fetching, and the entry about to be used, are never dropped.
 */
function trimToMaxEntries(keepKey?: string): void {
  for (const [cacheKey, cacheEntry] of cacheEntries) {
    if (cacheEntries.size <= MAX_CACHE_ENTRIES) {
      return;
    }
    if (cacheKey !== keepKey && !cacheEntry.inFlightPromise) {
      cacheEntries.delete(cacheKey);
    }
  }
}

function getCacheEntry(cacheKey: string): CacheEntry {
  const existing = cacheEntries.get(cacheKey);
  if (existing) {
    // Map order is insertion order; moving the key to the end makes it the most recently used.
    cacheEntries.delete(cacheKey);
    cacheEntries.set(cacheKey, existing);
    return existing;
  }

  const created: CacheEntry = {
    cachedToast: null,
    inFlightPromise: null,
    lastFetchTime: 0,
  };
  cacheEntries.set(cacheKey, created);
  trimToMaxEntries(cacheKey);
  return created;
}

/**
 * Get the cached toast message for a key if still valid.
 */
export function getCachedToast(cacheKey: string, minIntervalMs: number): string | null {
  const cacheEntry = cacheEntries.get(cacheKey);
  if (!cacheEntry?.cachedToast) {
    return null;
  }

  const now = Date.now();
  const age = now - cacheEntry.cachedToast.timestamp;

  if (age < minIntervalMs) {
    return cacheEntry.cachedToast.message;
  }

  return null;
}

/**
 * Check if a new fetch should be initiated for a key.
 */
export function shouldFetch(cacheKey: string, minIntervalMs: number): boolean {
  const cacheEntry = getCacheEntry(cacheKey);
  const now = Date.now();
  return now - cacheEntry.lastFetchTime >= minIntervalMs;
}

/**
 * Get or start a fetch operation with keyed deduplication.
 */
export async function getOrFetch(
  cacheKey: string,
  fetchFn: () => Promise<string | null>,
  minIntervalMs: number,
): Promise<string | null> {
  const wrapped = async () => {
    const message = await fetchFn();
    return { message, cache: true };
  };
  return getOrFetchWithCacheControl(cacheKey, wrapped, minIntervalMs);
}

/**
 * Get or start a fetch operation with keyed deduplication and cache control.
 *
 * This is useful when some results should be displayed but not cached
 * (e.g. transient "all providers failed" cases).
 */
export async function getOrFetchWithCacheControl(
  cacheKey: string,
  fetchFn: () => Promise<{ message: string | null; cache?: boolean }>,
  minIntervalMs: number,
): Promise<string | null> {
  const cacheEntry = getCacheEntry(cacheKey);

  const cached = getCachedToast(cacheKey, minIntervalMs);
  if (cached !== null) {
    return cached;
  }

  if (cacheEntry.inFlightPromise) {
    return cacheEntry.inFlightPromise;
  }

  if (!shouldFetch(cacheKey, minIntervalMs)) {
    return cacheEntry.cachedToast?.message ?? null;
  }

  cacheEntry.lastFetchTime = Date.now();
  cacheEntry.inFlightPromise = (async () => {
    try {
      const out = await fetchFn();
      const result = out.message;
      const cache = out.cache ?? true;

      if (result === null) {
        cacheEntry.lastFetchTime = 0;
        return null;
      }

      if (!cache) {
        cacheEntry.lastFetchTime = 0;
        return result;
      }

      cacheEntry.cachedToast = {
        message: result,
        timestamp: Date.now(),
      };

      return result;
    } finally {
      cacheEntry.inFlightPromise = null;
      if (!cacheEntry.cachedToast && cacheEntry.lastFetchTime === 0) {
        cacheEntries.delete(cacheKey);
      }
      // Fetches running at the same time can each add an entry while none can be dropped.
      trimToMaxEntries();
    }
  })();

  return cacheEntry.inFlightPromise;
}

/**
 * Clear one keyed entry, or the whole keyed cache if no key is provided.
 */
export function clearCache(cacheKey?: string): void {
  if (cacheKey) {
    cacheEntries.delete(cacheKey);
    return;
  }

  cacheEntries.clear();
}

/**
 * Number of keyed entries currently held (for tests and diagnostics).
 */
export function getCacheEntryCount(): number {
  return cacheEntries.size;
}

/**
 * Force update a keyed cache entry with a new message.
 */
export function updateCache(cacheKey: string, message: string): void {
  const cacheEntry = getCacheEntry(cacheKey);
  cacheEntry.cachedToast = {
    message,
    timestamp: Date.now(),
  };
  cacheEntry.lastFetchTime = Date.now();
}
