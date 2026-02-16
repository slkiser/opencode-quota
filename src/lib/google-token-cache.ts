/**
 * Persistent access-token cache for Google Antigravity accounts.
 *
 * Why:
 * - Antigravity quota is multi-account; each account needs its own access token.
 * - Refreshing on every toast is noisy and increases timeout risk.
 * - We persist access tokens so restarts don't force immediate refresh.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { createHash } from "crypto";

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

async function loadFromDisk(path: string): Promise<GoogleAccessTokenCacheFile> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const file = parsed as any;
    if (file.version !== CACHE_VERSION || typeof file.tokens !== "object" || !file.tokens) {
      throw new Error("invalid");
    }
    return {
      version: CACHE_VERSION,
      updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : Date.now(),
      tokens: file.tokens as Record<string, GoogleAccessTokenCacheEntry>,
    };
  } catch {
    return { version: CACHE_VERSION, updatedAt: Date.now(), tokens: {} };
  }
}

async function ensureLoaded(): Promise<GoogleAccessTokenCacheFile> {
  if (memCache) return memCache;
  if (loadPromise) return loadPromise;

  const path = getGoogleTokenCachePath();
  loadPromise = (async () => {
    const file = await loadFromDisk(path);
    memCache = file;
    loadPromise = null;
    return file;
  })();

  return loadPromise;
}

async function persist(): Promise<void> {
  if (!memCache) return;
  const path = getGoogleTokenCachePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(memCache, null, 2), "utf-8");
}

export async function getCachedAccessToken(params: {
  key: string;
  skewMs: number;
}): Promise<GoogleAccessTokenCacheEntry | null> {
  const cache = await ensureLoaded();
  const entry = cache.tokens[params.key];
  if (!entry) return null;
  if (typeof entry.expiresAt !== "number") return null;
  if (entry.expiresAt <= Date.now() + params.skewMs) return null;
  return entry;
}

export async function setCachedAccessToken(params: {
  key: string;
  entry: GoogleAccessTokenCacheEntry;
}): Promise<void> {
  const cache = await ensureLoaded();
  cache.tokens[params.key] = params.entry;
  cache.updatedAt = Date.now();
  await persist();
}

export async function clearGoogleTokenCache(): Promise<void> {
  memCache = { version: CACHE_VERSION, updatedAt: Date.now(), tokens: {} };
  await persist();
}
