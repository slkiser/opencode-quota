/**
 * Process-local access-token caches for the Google quota providers, one per provider.
 *
 * Access tokens and account correlation material are intentionally never
 * persisted. The legacy v1 disk cache contained account PII and an unkeyed
 * refresh-token verifier, so it is never read and is removed before every get and set.
 */

import { createHmac, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

type GoogleAccessTokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

export type GoogleTokenCache = {
  /** The entry of `key`, unless it expires within `skewMs`. */
  get(params: { key: string; skewMs: number }): Promise<GoogleAccessTokenCacheEntry | null>;
  set(params: { key: string; entry: GoogleAccessTokenCacheEntry }): Promise<void>;
};

const PROCESS_CACHE_KEY = randomBytes(32);

export function makeAccountCacheKey(params: { refreshToken: string; projectId: string }): string {
  return `gat1_${createHmac("sha256", PROCESS_CACHE_KEY)
    .update("google-access-token-cache-v2\0")
    .update(params.refreshToken)
    .update("\0")
    .update(params.projectId)
    .digest("base64url")}`;
}

async function removeLegacyCache(): Promise<void> {
  const legacyPath = join(
    getOpencodeRuntimeDirs().cacheDir,
    "opencode-quota",
    "google-access-tokens.json",
  );
  await rm(legacyPath, { force: true }).catch(() => undefined);
}

/** An empty cache; its operations run one at a time, each after removing the legacy file. */
export function createGoogleTokenCache(): GoogleTokenCache {
  const memoryTokens = new Map<string, GoogleAccessTokenCacheEntry>();
  let operationQueue: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    get: (params) =>
      enqueue(async () => {
        await removeLegacyCache();
        const entry = memoryTokens.get(params.key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now() + params.skewMs) {
          memoryTokens.delete(params.key);
          return null;
        }
        return { ...entry };
      }),
    set: (params) =>
      enqueue(async () => {
        await removeLegacyCache();
        memoryTokens.set(params.key, { ...params.entry });
      }),
  };
}
