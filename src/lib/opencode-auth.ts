/**
 * OpenCode auth.json reader
 *
 * Shared helper to read auth from ~/.local/share/opencode/auth.json
 * (or platform equivalent). Providers should prefer this to duplicating
 * file/path parsing.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "./opencode-runtime-paths.js";

import type { AuthData } from "./types.js";

const DEFAULT_AUTH_CACHE_MAX_AGE_MS = 5_000;

type AuthCacheEntry = {
  timestamp: number;
  value: AuthData | null;
  inFlight?: Promise<AuthData | null>;
};

let authCache: AuthCacheEntry | null = null;

type AuthFileSnapshot = {
  path: string;
  data: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getAuthContentOverride(): Record<string, unknown> | null {
  const content = process.env.OPENCODE_AUTH_CONTENT;
  if (!content) return null;

  try {
    const data = JSON.parse(content);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

export function hasOpenCodeAuthContentOverride(): boolean {
  return getAuthContentOverride() !== null;
}

async function readAuthFileSnapshot(): Promise<AuthFileSnapshot | null> {
  for (const path of getAuthPaths()) {
    try {
      const data = JSON.parse(await readFile(path, "utf-8"));
      if (isRecord(data)) return { path, data };
    } catch {
      // Try next path.
    }
  }

  return null;
}

/**
 * Get candidate auth.json paths in priority order.
 * Some OpenCode installations use Linux-style paths even on macOS,
 * so we check multiple locations.
 */
export function getAuthPaths(): string[] {
  // OpenCode stores auth at `${Global.Path.data}/auth.json`.
  // We generate candidates based on OpenCode runtime dir semantics (xdg-basedir)
  // plus platform fallbacks for alternate/legacy installs.
  const { dataDirs } = getOpencodeRuntimeDirCandidates();
  return dataDirs.map((d) => join(d, "auth.json"));
}

/** Returns OpenCode's primary auth.json path (for display/logging) */
export function getAuthPath(): string {
  return join(getOpencodeRuntimeDirs().dataDir, "auth.json");
}

export async function readAuthFile(): Promise<AuthData | null> {
  const overridden = getAuthContentOverride();
  if (overridden) return overridden as AuthData;

  const snapshot = await readAuthFileSnapshot();
  return snapshot ? (snapshot.data as AuthData) : null;
}

/**
 * Checks that the on-disk xAI OAuth entry still matches the token used for a
 * refresh. OPENCODE_AUTH_CONTENT is immutable from the plugin's perspective.
 */
export async function isCurrentXaiOAuth(params: {
  access: string;
  refresh: string;
}): Promise<boolean> {
  if (hasOpenCodeAuthContentOverride()) return false;

  const snapshot = await readAuthFileSnapshot();
  const xai = snapshot?.data.xai;
  return (
    isRecord(xai) &&
    xai.type === "oauth" &&
    xai.access === params.access &&
    xai.refresh === params.refresh
  );
}

/**
 * Atomically replaces only the xAI OAuth entry while retaining every other
 * auth.json record, including credentials unknown to OpenCode itself.
 */
export async function updateCurrentXaiOAuth(params: {
  expectedAccess: string;
  expectedRefresh: string;
  access: string;
  refresh: string;
  expires: number;
}): Promise<boolean> {
  if (hasOpenCodeAuthContentOverride()) return false;

  const snapshot = await readAuthFileSnapshot();
  const current = snapshot?.data.xai;
  if (
    !snapshot ||
    !isRecord(current) ||
    current.type !== "oauth" ||
    current.access !== params.expectedAccess ||
    current.refresh !== params.expectedRefresh
  ) {
    return false;
  }

  await writeJsonAtomic(
    snapshot.path,
    {
      ...snapshot.data,
      xai: {
        ...current,
        type: "oauth",
        access: params.access,
        refresh: params.refresh,
        expires: params.expires,
      },
    },
    { trailingNewline: true, mode: 0o600, replaceOnRenameError: false },
  );
  authCache = null;
  return true;
}

/**
 * Cached auth reader for frequently triggered code paths (e.g. per-question hooks).
 * This avoids repeated filesystem reads while keeping auth updates visible quickly.
 */
export async function readAuthFileCached(params?: { maxAgeMs?: number }): Promise<AuthData | null> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_AUTH_CACHE_MAX_AGE_MS);
  const now = Date.now();

  if (authCache && now - authCache.timestamp <= maxAgeMs) {
    return authCache.value;
  }

  if (authCache?.inFlight) {
    return authCache.inFlight;
  }

  const inFlight = (async () => {
    const value = await readAuthFile();
    authCache = { timestamp: Date.now(), value };
    return value;
  })();

  authCache = {
    timestamp: authCache?.timestamp ?? 0,
    value: authCache?.value ?? null,
    inFlight,
  };

  try {
    return await inFlight;
  } finally {
    if (authCache?.inFlight === inFlight) {
      authCache.inFlight = undefined;
    }
  }
}

/** Test helper to clear cached auth state between test cases. */
export function clearReadAuthFileCacheForTests(): void {
  authCache = null;
}
