/**
 * Process-local access-token cache shared by the Google quota providers.
 *
 * Access tokens and account correlation material are intentionally never
 * persisted. The legacy v1 disk cache contained account PII and an unkeyed
 * refresh-token verifier, so it is ignored and removed on first use.
 */

import { createHmac, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export interface GoogleAccessTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const PROCESS_CACHE_KEY = randomBytes(32);
const memoryTokens = new Map<string, GoogleAccessTokenCacheEntry>();
let operationQueue: Promise<void> = Promise.resolve();

export function getGoogleTokenCachePath(): string {
  return join(getOpencodeRuntimeDirs().cacheDir, "opencode-quota", "google-access-tokens.json");
}

export function makeAccountCacheKey(params: { refreshToken: string; projectId: string }): string {
  return `gat1_${createHmac("sha256", PROCESS_CACHE_KEY)
    .update("google-access-token-cache-v2\0")
    .update(params.refreshToken)
    .update("\0")
    .update(params.projectId)
    .digest("base64url")}`;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function removeLegacyCache(): Promise<void> {
  await rm(getGoogleTokenCachePath(), { force: true }).catch(() => undefined);
}

export async function getCachedAccessToken(params: {
  key: string;
  skewMs: number;
}): Promise<GoogleAccessTokenCacheEntry | null> {
  return enqueue(async () => {
    await removeLegacyCache();
    const entry = memoryTokens.get(params.key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now() + params.skewMs) {
      memoryTokens.delete(params.key);
      return null;
    }
    return { ...entry };
  });
}

export async function setCachedAccessToken(params: {
  key: string;
  entry: GoogleAccessTokenCacheEntry;
}): Promise<void> {
  return enqueue(async () => {
    await removeLegacyCache();
    memoryTokens.set(params.key, { ...params.entry });
  });
}

export async function clearGoogleTokenCache(): Promise<void> {
  return enqueue(async () => {
    memoryTokens.clear();
    await removeLegacyCache();
  });
}

export function __resetGoogleTokenCacheForTests(): void {
  memoryTokens.clear();
  operationQueue = Promise.resolve();
}
