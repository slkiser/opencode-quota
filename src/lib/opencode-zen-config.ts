import { statSync } from "node:fs";

import { openOpenCodeSqliteReadOnly } from "./opencode-sqlite.js";
import { getOpenCodeDbPath } from "./opencode-storage.js";

export interface OpenCodeZenConsoleAccount {
  /** Console base URL from the account row, e.g. https://opencode.ai/console */
  baseUrl: string;
  accessToken: string;
  activeOrgId: string;
}

export type ResolvedOpenCodeZenAccount =
  | { state: "none" }
  | { state: "expired"; expiryMs: number }
  | { state: "no_active_account" }
  | { state: "missing_org" }
  | { state: "inactive_account" }
  | { state: "invalid_url" }
  | { state: "incompatible" }
  | { state: "read_error" }
  | { state: "configured"; account: OpenCodeZenConsoleAccount };

type AccountRow = {
  url?: unknown;
  access_token?: unknown;
  token_expiry?: unknown;
};

interface AccountRead {
  resolved: ResolvedOpenCodeZenAccount;
  /** Raw token_expiry column value; null when absent or the token is already invalid. */
  tokenExpiryMs: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Checks a thrown error (e.g. from statSync) for a stable errno code. */
function hasErrnoCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * node:sqlite reports missing files as SQLITE_CANTOPEN (ERR_SQLITE_ERROR), the
 * same errcode it uses for permission problems — so ask the filesystem for the
 * real errno. statSync (unlike existsSync) distinguishes ENOENT from EACCES.
 */
function isMissingStateDbFile(dbPath: string): boolean {
  try {
    statSync(dbPath);
    return false;
  } catch (statError) {
    return hasErrnoCode(statError, "ENOENT");
  }
}

function normalizeBaseUrl(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Bare "?" / "#" leave search/hash empty but are not a valid Console base.
  if (raw.includes("?") || raw.includes("#")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}

/**
 * Reads the active OpenCode Console CLI session (`opencode console login`)
 * from OpenCode's local state database, strictly read-only. Tokens are never
 * refreshed or written here.
 */
async function readAccount(): Promise<AccountRead> {
  const safe = (resolved: ResolvedOpenCodeZenAccount): AccountRead => ({
    resolved,
    tokenExpiryMs: null,
  });

  const dbPath = getOpenCodeDbPath();
  if (!dbPath) return safe({ state: "none" });

  let conn: Awaited<ReturnType<typeof openOpenCodeSqliteReadOnly>>;
  try {
    conn = await openOpenCodeSqliteReadOnly(dbPath);
  } catch {
    // Classify by the actual DB path, not the opener's error: node:sqlite
    // surfaces missing files as SQLITE_CANTOPEN (ERR_SQLITE_ERROR) — the same
    // errcode it uses for permission problems — and a wrapped unrelated ENOENT
    // must never hide an existing DB. statSync distinguishes ENOENT (absent)
    // from EACCES (unsearchable parent) without exception-text matching.
    if (isMissingStateDbFile(dbPath)) return safe({ state: "none" });
    return safe({ state: "read_error" });
  }

  try {
    const tables = conn.all<{ name?: unknown }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account', 'account_state')`,
    );
    const names = new Set(tables.map((row) => row?.name));
    if (!names.has("account") || !names.has("account_state")) {
      return safe({ state: "incompatible" });
    }

    // Column-level check: an older/newer schema that misses required columns is
    // incompatible, while a failing read (lock, I/O) is a transient read_error.
    const requiredColumns: Record<string, Set<string>> = {
      account_state: new Set(["active_account_id", "active_org_id"]),
      account: new Set(["id", "url", "access_token", "token_expiry"]),
    };
    for (const [table, required] of Object.entries(requiredColumns)) {
      const columns = conn.all<{ name?: unknown }>(`PRAGMA table_info(${table})`);
      const columnNames = new Set(columns.map((row) => row?.name));
      for (const column of required) {
        if (!columnNames.has(column)) return safe({ state: "incompatible" });
      }
    }

    const stateRow = conn.get<{ active_account_id?: unknown; active_org_id?: unknown }>(
      `SELECT active_account_id, active_org_id FROM "account_state" LIMIT 1`,
    );
    const activeAccountId = asString(stateRow?.active_account_id);
    if (!activeAccountId) return safe({ state: "no_active_account" });

    const active = conn.get<AccountRow>(
      `SELECT url, access_token, token_expiry FROM "account" WHERE id = ? LIMIT 1`,
      [activeAccountId],
    );
    if (!active) return safe({ state: "inactive_account" });

    const activeOrgId = asString(stateRow?.active_org_id);
    if (!activeOrgId) return safe({ state: "missing_org" });

    const accessToken = asString(active.access_token);
    if (!accessToken) return { resolved: { state: "expired", expiryMs: 0 }, tokenExpiryMs: 0 };

    const expiryMs =
      typeof active.token_expiry === "number" && Number.isFinite(active.token_expiry)
        ? active.token_expiry
        : null;
    if (expiryMs !== null && expiryMs <= Date.now()) {
      // Propagate the already-passed expiry so the cache TTL collapses to 0 and
      // the next read goes back to the DB (e.g. right after a fresh login).
      return { resolved: { state: "expired", expiryMs }, tokenExpiryMs: expiryMs };
    }

    const baseUrl = normalizeBaseUrl(active.url);
    if (!baseUrl) return safe({ state: "invalid_url" });

    return {
      resolved: {
        state: "configured",
        account: { baseUrl, accessToken, activeOrgId },
      },
      tokenExpiryMs: expiryMs,
    };
  } catch {
    // The schema is fine but the read failed (lock, disk I/O, ...): report a
    // transient read error instead of throwing.
    return safe({ state: "read_error" });
  } finally {
    conn.close();
  }
}

export async function resolveOpenCodeZenAccount(): Promise<ResolvedOpenCodeZenAccount> {
  return (await readAccount()).resolved;
}

let cachedAccount: ResolvedOpenCodeZenAccount | null = null;
let cachedExpiresAt = 0;

export const DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS = 30_000;

export async function resolveOpenCodeZenAccountCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeZenAccount> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS);
  // A zero maxAgeMs explicitly bypasses an unexpired prior cache entry.
  if (maxAgeMs > 0 && cachedAccount && Date.now() < cachedExpiresAt) return cachedAccount;

  const { resolved, tokenExpiryMs } = await readAccount();
  // The cache must never outlive the token: cap the TTL at the token's expiry
  // so an expired session triggers a fresh DB read (and a login prompt).
  const ttl =
    tokenExpiryMs === null ? maxAgeMs : Math.min(maxAgeMs, Math.max(0, tokenExpiryMs - Date.now()));
  cachedAccount = resolved;
  cachedExpiresAt = Date.now() + ttl;
  return resolved;
}
