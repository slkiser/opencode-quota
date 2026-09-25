import { openOpenCodeSqliteReadOnly } from "./opencode-sqlite.js";
import { getOpenCodeDbPath } from "./opencode-storage.js";

export interface OpenCodeZenConsoleAccount {
  email: string;
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
  | { state: "configured"; account: OpenCodeZenConsoleAccount };

type AccountRow = {
  id?: unknown;
  email?: unknown;
  url?: unknown;
  access_token?: unknown;
  token_expiry?: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBaseUrl(value: unknown): string | null {
  const url = asString(value);
  if (!url || !/^https:\/\//i.test(url)) return null;
  return url.replace(/\/+$/, "");
}

/**
 * Reads the active OpenCode Console CLI session (`opencode console login`)
 * from OpenCode's local state database, strictly read-only. Tokens are never
 * refreshed or written here.
 */
export async function resolveOpenCodeZenAccount(): Promise<ResolvedOpenCodeZenAccount> {
  const dbPath = getOpenCodeDbPath();
  if (!dbPath) return { state: "none" };

  let conn: Awaited<ReturnType<typeof openOpenCodeSqliteReadOnly>>;
  try {
    conn = await openOpenCodeSqliteReadOnly(dbPath);
  } catch {
    return { state: "none" };
  }

  try {
    const stateRow = conn.get<{ active_account_id?: unknown; active_org_id?: unknown }>(
      `SELECT active_account_id, active_org_id FROM "account_state" LIMIT 1`,
    );
    const activeAccountId = asString(stateRow?.active_account_id);
    if (!activeAccountId) return { state: "no_active_account" };

    const rows = conn.all<AccountRow>(`SELECT * FROM "account"`);
    const active = rows.find((row) => row.id === stateRow?.active_account_id);
    if (!active) return { state: "inactive_account" };

    const activeOrgId = asString(stateRow?.active_org_id);
    if (!activeOrgId) return { state: "missing_org" };

    const accessToken = asString(active.access_token);
    if (!accessToken) return { state: "expired", expiryMs: 0 };

    const expiryMs =
      typeof active.token_expiry === "number" && Number.isFinite(active.token_expiry)
        ? active.token_expiry
        : null;
    if (expiryMs !== null && expiryMs <= Date.now()) {
      return { state: "expired", expiryMs };
    }

    const baseUrl = normalizeBaseUrl(active.url);
    if (!baseUrl) return { state: "none" };

    return {
      state: "configured",
      account: {
        email: asString(active.email) ?? "",
        baseUrl,
        accessToken,
        activeOrgId,
      },
    };
  } finally {
    conn.close();
  }
}

let cachedAccount: ResolvedOpenCodeZenAccount | null = null;
let cachedAt = 0;

export const DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS = 30_000;

export async function resolveOpenCodeZenAccountCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeZenAccount> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedAccount && now - cachedAt < maxAgeMs) {
    return cachedAccount;
  }

  cachedAccount = await resolveOpenCodeZenAccount();
  cachedAt = now;
  return cachedAccount;
}
