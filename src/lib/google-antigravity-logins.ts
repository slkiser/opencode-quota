import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

type PoolAccount = { refreshToken: string; id?: unknown; refreshTokenHashes?: unknown };

/**
 * Connection ids of `google` logins last seen as Antigravity logins. A login OpenCode could not
 * return has neither its method id nor its refresh token, so this is the only evidence for it.
 */
const antigravityLoginIds = new Set<string>();

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

/** The pool's accounts that have a refresh token; none when the file is missing or unreadable. */
async function readPoolAccounts(): Promise<PoolAccount[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(poolFilePath(), "utf-8"));
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
 * by the companion's rule, and remembered by connection id; a login OpenCode could not return is
 * an Antigravity login when it was one at its last successful read in this process.
 */
export async function findAntigravityGoogleLogins(
  rows: readonly CredentialRow[],
): Promise<Set<CredentialRow>> {
  const googleRows = rows.filter((row) => row.integrationId === "google");
  const needsPool = googleRows.some(
    (row) => row.resolveError === undefined && row.value.methodID === "oauth",
  );
  const poolAccounts = needsPool ? await readPoolAccounts() : [];

  const found = new Set<CredentialRow>();
  for (const row of googleRows) {
    if (row.resolveError !== undefined) {
      if (antigravityLoginIds.has(row.id)) found.add(row);
      continue;
    }
    if (isAntigravityCredential(row, poolAccounts)) {
      antigravityLoginIds.add(row.id);
      found.add(row);
    } else {
      antigravityLoginIds.delete(row.id);
    }
  }
  return found;
}

/** Test helper: forgets which connections were Antigravity logins. */
export function clearAntigravityLoginMemoryForTests(): void {
  antigravityLoginIds.clear();
}
