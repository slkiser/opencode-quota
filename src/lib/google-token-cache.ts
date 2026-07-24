/**
 * Persistent access-token cache for Google Antigravity accounts.
 *
 * Why:
 * - Antigravity quota is multi-account; each account needs its own access token.
 * - Refreshing on every toast is noisy and increases timeout risk.
 * - We persist access tokens so restarts don't force immediate refresh.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

import { writeTextAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export interface GoogleAccessTokenCacheEntry {
  accessToken: string;
  expiresAt: number; // epoch ms
  projectId: string;
  email?: string;
}

interface GoogleAccessTokenCacheFile {
  version: 1;
  updatedAt: number;
  tokens: Record<string, GoogleAccessTokenCacheEntry>;
}

const CACHE_VERSION = 1 as const;

let memCache: GoogleAccessTokenCacheFile | null = null;
let loadPromise: Promise<GoogleAccessTokenCacheFile> | null = null;
let operationQueue: Promise<void> = Promise.resolve();

function getCacheBaseDir(): string {
  // Match OpenCode runtime cache semantics (xdg-basedir).
  // This avoids mismatches on Windows where OpenCode cache is not under LOCALAPPDATA.
  return getOpencodeRuntimeDirs().cacheDir;
}

export function getGoogleTokenCachePath(): string {
  return join(getCacheBaseDir(), "opencode-quota", "google-access-tokens.json");
}

export function makeAccountCacheKey(params: {
  refreshToken: string;
  projectId: string;
  email?: string;
}): string {
  const emailPart = (params.email ?? "").trim().toLowerCase();
  const hash = createHash("sha256")
    .update(params.refreshToken)
    .update("\n")
    .update(params.projectId)
    .digest("hex")
    .slice(0, 16);
  // Keep a human hint without making it sensitive.
  return `${emailPart}::${params.projectId}::${hash}`;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function cloneCache(cache: GoogleAccessTokenCacheFile): GoogleAccessTokenCacheFile {
  return {
    version: CACHE_VERSION,
    updatedAt: cache.updatedAt,
    tokens: Object.fromEntries(
      Object.entries(cache.tokens).map(([key, entry]) => [key, { ...entry }]),
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCacheEntry(value: unknown): GoogleAccessTokenCacheEntry | null {
  const entry = asRecord(value);
  if (!entry) return null;
  if (typeof entry.accessToken !== "string" || !entry.accessToken.trim()) return null;
  if (typeof entry.projectId !== "string" || !entry.projectId.trim()) return null;
  if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)) return null;
  if (entry.email !== undefined && typeof entry.email !== "string") return null;

  return {
    accessToken: entry.accessToken,
    expiresAt: entry.expiresAt,
    projectId: entry.projectId,
    ...(entry.email === undefined ? {} : { email: entry.email }),
  };
}

async function loadFromDisk(path: string): Promise<GoogleAccessTokenCacheFile> {
  try {
    const raw = await readFile(path, "utf-8");
    const file = asRecord(JSON.parse(raw) as unknown);
    const tokenValues = asRecord(file?.tokens);
    if (file?.version !== CACHE_VERSION || !tokenValues) {
      throw new Error("invalid");
    }

    const tokens: Record<string, GoogleAccessTokenCacheEntry> = {};
    for (const [key, value] of Object.entries(tokenValues)) {
      const entry = parseCacheEntry(value);
      if (entry) tokens[key] = entry;
    }

    return {
      version: CACHE_VERSION,
      updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : Date.now(),
      tokens,
    };
  } catch {
    return { version: CACHE_VERSION, updatedAt: Date.now(), tokens: {} };
  }
}

async function ensureLoaded(): Promise<GoogleAccessTokenCacheFile> {
  if (memCache) return memCache;
  if (loadPromise) return loadPromise;

  const path = getGoogleTokenCachePath();
  loadPromise = loadFromDisk(path).then((file) => {
    memCache = file;
    loadPromise = null;
    return file;
  });
  return loadPromise;
}

async function persist(cache: GoogleAccessTokenCacheFile): Promise<void> {
  await writeTextAtomic(getGoogleTokenCachePath(), JSON.stringify(cache, null, 2), {
    directoryMode: 0o700,
    fileMode: 0o600,
  });
}

export async function getCachedAccessToken(params: {
  key: string;
  skewMs: number;
}): Promise<GoogleAccessTokenCacheEntry | null> {
  return enqueue(async () => {
    const cache = await ensureLoaded();
    const entry = cache.tokens[params.key];
    if (!entry) return null;
    if (typeof entry.expiresAt !== "number") return null;
    if (entry.expiresAt <= Date.now() + params.skewMs) return null;
    return entry;
  });
}

export async function setCachedAccessToken(params: {
  key: string;
  entry: GoogleAccessTokenCacheEntry;
}): Promise<void> {
  return enqueue(async () => {
    const current = await ensureLoaded();
    const next = cloneCache(current);
    next.tokens[params.key] = { ...params.entry };
    next.updatedAt = Date.now();
    await persist(next);
    memCache = next;
  });
}

export async function clearGoogleTokenCache(): Promise<void> {
  return enqueue(async () => {
    await ensureLoaded();
    const next: GoogleAccessTokenCacheFile = {
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      tokens: {},
    };
    await persist(next);
    memCache = next;
  });
}
