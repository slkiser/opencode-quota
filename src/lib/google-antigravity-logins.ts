import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord } from "./json-guards.js";
import type { CredentialRow } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

/**
 * Which logins under the shared `google` integration id belong to opencode-antigravity-auth.
 * opencode-gemini-auth stores its logins there too. The rule is the companion's own
 * (`isAntigravityCredential` in its `dist/src/v2.js`, 2.1.2): its OpenCode 2 sign-ins have
 * `methodID: "antigravity"`; an OpenCode 1 login imported into OpenCode 2 has
 * `methodID: "oauth"` and is the companion's when its refresh token is in the companion's
 * account pool (`antigravity-accounts.json`).
 */

const POOL_FILE_NAME = "antigravity-accounts.json";
/** Pool file versions the companion reads; it ignores a file of any other version. */
const POOL_VERSIONS = [1, 2, 3, 4];
/** A larger pool file is not the companion's; it counts as no pool. */
const MAX_POOL_FILE_BYTES = 1024 * 1024;

type PoolAccount = { refreshToken: string; id?: unknown; refreshTokenHashes?: unknown };

/**
 * Connection ids of `google` logins seen as Antigravity logins, kept while the connection exists.
 * A login OpenCode could not return has neither its method id nor its refresh token, so this is
 * the only evidence for it.
 */
const antigravityLoginIds = new Set<string>();

/** The last pool file read, so both Google providers in one refresh read it once. */
let poolCache:
  | { path: string; mtimeMs: number; size: number; accounts: Promise<PoolAccount[]> }
  | undefined;

/**
 * The companion's pool file: in OpenCode's config folder, or on Windows in the older
 * `%APPDATA%\opencode` folder when only that one has it.
 */
function poolFilePath(): string {
  const path = join(getOpencodeRuntimeDirs().configDir, POOL_FILE_NAME);
  if (process.platform !== "win32" || existsSync(path)) return path;
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const legacyPath = join(appData, "opencode", POOL_FILE_NAME);
  return existsSync(legacyPath) ? legacyPath : path;
}

/**
 * The pool's accounts that have a refresh token; none when the file is missing, unreadable or
 * over 1 MiB. The file is read again only when its path, modification time or size changes.
 */
async function readPoolAccounts(): Promise<PoolAccount[]> {
  const path = poolFilePath();
  let info: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    info = await stat(path);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_POOL_FILE_BYTES) return [];
  if (
    poolCache?.path !== path ||
    poolCache.mtimeMs !== info.mtimeMs ||
    poolCache.size !== info.size
  ) {
    poolCache = { path, mtimeMs: info.mtimeMs, size: info.size, accounts: parsePoolFile(path) };
  }
  return poolCache.accounts;
}

/** The accounts with a refresh token in the pool file at `path`; none when unreadable. */
async function parsePoolFile(path: string): Promise<PoolAccount[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data.accounts)) return [];
  if (typeof data.version !== "number" || !POOL_VERSIONS.includes(data.version)) return [];
  return data.accounts.filter(
    (account): account is PoolAccount =>
      isRecord(account) && typeof account.refreshToken === "string",
  );
}

/** The companion's `matchesAccountToken`: the token itself, its hash as the id, or an old hash. */
function poolHasToken(accounts: readonly PoolAccount[], token: string): boolean {
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
  return accounts.some(
    (account) =>
      account.refreshToken === token ||
      account.id === hash ||
      (Array.isArray(account.refreshTokenHashes) && account.refreshTokenHashes.includes(hash)),
  );
}

/** The companion's `isAntigravityCredential` for a login OpenCode returned. */
function isAntigravityCredential(
  row: CredentialRow,
  poolAccounts: readonly PoolAccount[],
): boolean {
  const { type, methodID, refresh } = row.value;
  if (type !== "oauth" || typeof refresh !== "string" || refresh === "") return false;
  if (methodID === "antigravity") return true;
  // The refresh value may be packed as `refreshToken|projectId|managedProjectId`.
  return methodID === "oauth" && poolHasToken(poolAccounts, refresh.split("|")[0] ?? "");
}

/**
 * The Antigravity logins among the `google` rows of `rows`. A login OpenCode returned is judged
 * by the companion's rule; once it is an Antigravity login, its connection id stays one for as
 * long as the connection exists in this process, even when OpenCode can no longer return it or
 * its account later leaves the pool.
 *
 * Limit: the companion also counts an `oauth` login as its own when the login has a saved
 * per-connection account binding. That binding is in the companion's private storage, which this
 * plugin does not read; keeping a login once seen in the pool covers the case where the companion
 * binds a login and later drops the account from the pool, but not a login that was bound
 * without ever being in the pool while this process ran.
 */
export async function findAntigravityGoogleLogins(
  rows: readonly CredentialRow[],
): Promise<Set<CredentialRow>> {
  const googleRows = rows.filter((row) => row.integrationId === "google");
  const needsPool = googleRows.some(
    (row) => row.resolveError === undefined && row.value.methodID === "oauth",
  );
  const poolAccounts = needsPool ? await readPoolAccounts() : [];

  const currentIds = new Set(googleRows.map((row) => row.id));
  for (const id of antigravityLoginIds) {
    if (!currentIds.has(id)) antigravityLoginIds.delete(id);
  }

  const found = new Set<CredentialRow>();
  for (const row of googleRows) {
    if (row.resolveError !== undefined) {
      if (antigravityLoginIds.has(row.id)) found.add(row);
      continue;
    }
    if (antigravityLoginIds.has(row.id) || isAntigravityCredential(row, poolAccounts)) {
      antigravityLoginIds.add(row.id);
      found.add(row);
    }
  }
  return found;
}

/** Test helper: forgets which connections were Antigravity logins, and the pool file read. */
export function clearAntigravityLoginMemoryForTests(): void {
  antigravityLoginIds.clear();
  poolCache = undefined;
}
