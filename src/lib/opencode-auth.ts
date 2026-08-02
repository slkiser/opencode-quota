/**
 * OpenCode auth.json reader
 *
 * Shared helper to read auth from ~/.local/share/opencode/auth.json
 * (or platform equivalent). Providers should prefer this to duplicating
 * file/path parsing.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createRequire } from "module";
import { isAbsolute, join, resolve } from "path";

import { getOpencodeRuntimeDirCandidates, getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

import type { AuthData } from "./types.js";

const DEFAULT_AUTH_CACHE_MAX_AGE_MS = 5_000;
const runtimeRequire = createRequire(import.meta.url);

type CredentialDatabase = {
  close(): void;
  prepare(sql: string): { all(...params: string[]): unknown[] };
};

type CredentialDatabaseConstructor = new (path: string, options?: Record<string, unknown>) => CredentialDatabase;

type AuthCacheEntry = {
  timestamp: number;
  value: AuthData | null;
  inFlight?: Promise<AuthData | null>;
};

let authCache: AuthCacheEntry | null = null;

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
  const { dataDirs } = getOpencodeRuntimeDirCandidates();
  const fileAuth = await readAuthFiles(dataDirs.map((dataDir) => join(dataDir, "auth.json")));
  const databaseAuth = readCredentialDatabases(dataDirs);

  if (!fileAuth && !databaseAuth) return null;
  // auth.json is a user-managed compatibility source, so it wins over the current database.
  return { ...databaseAuth, ...fileAuth };
}

async function readAuthFiles(paths: string[]): Promise<AuthData | null> {
  for (const path of paths) {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as AuthData;
    } catch {
      // Try next path
    }
  }

  return null;
}

function readCredentialDatabases(dataDirs: string[]): AuthData | null {
  for (const path of getCredentialDbPaths(dataDirs)) {
    const auth = readCredentialDatabase(path);
    if (auth) return auth;
  }

  return null;
}

function getCredentialDbPaths(dataDirs: string[]): string[] {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) {
    if (override === ":memory:") return [];
    return [isAbsolute(override) ? override : resolve(dataDirs[0] ?? getOpencodeRuntimeDirs().dataDir, override)];
  }
  return dataDirs.map((dataDir) => join(dataDir, "opencode-next.db"));
}

function readCredentialDatabase(path: string): AuthData | null {
  if (!existsSync(path)) return null;

  let database: CredentialDatabase | undefined;
  try {
    database = openCredentialDatabase(path);
    const rows = database
      .prepare("SELECT integration_id, value FROM credential WHERE integration_id IS NOT NULL ORDER BY time_updated DESC, id DESC")
      .all() as Array<{ integration_id?: unknown; value?: unknown }>;
    const auth: Record<string, unknown> = {};

    for (const row of rows) {
      if (typeof row.integration_id !== "string" || typeof row.value !== "string" || row.integration_id in auth) continue;
      const value = parseCredentialValue(row.value);
      if (value) auth[row.integration_id] = value;
    }

    return Object.keys(auth).length > 0 ? (auth as AuthData) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function openCredentialDatabase(path: string): CredentialDatabase {
  if ("Bun" in globalThis) {
    const { Database } = runtimeRequire("bun:sqlite") as { Database: CredentialDatabaseConstructor };
    return new Database(path, { readonly: true });
  }

  const { DatabaseSync } = runtimeRequire("node:sqlite") as { DatabaseSync: CredentialDatabaseConstructor };
  return new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
}

function parseCredentialValue(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const credential = parsed as Record<string, unknown>;
    const metadata = credential.metadata;
    const authEntry = {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      ...credential,
    };
    if (authEntry.type === "key" && typeof authEntry.key === "string") {
      authEntry.type = "api";
    }
    return authEntry;
  } catch {
    return null;
  }
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
