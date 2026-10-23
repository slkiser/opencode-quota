/**
 * OpenCode Console credential reader
 *
 * OpenCode 2 keeps its OpenCode Console sign-in (`opencode auth login opencode`)
 * under the `opencode` integration as an OAuth connection created by the device
 * flow (`client_id: opencode-cli`, default server `https://opencode.ai/console`,
 * stored as `metadata.server`). Consumers call the console APIs with
 * `consoleBaseUrl` and `consoleHeaders`: the access token as
 * `Authorization: Bearer`, plus `metadata.orgID` as `x-org-id` when present.
 *
 * The login is read through OpenCode's plugin API, which refreshes a token that
 * is about to expire (and saves the new one) before returning it. A failed
 * refresh is reported as `invalid`.
 *
 * OpenCode Zen and OpenCode Go share this one login: the same identity rule and
 * the same words for a login that can't be used.
 */

import { safeErrorText } from "../core/redact.js";
import { isRecord } from "./json-guards.js";
import { readCredentialRows, readOAuthLogin } from "./opencode-auth.js";
import { deriveResolvedAuthIdentity, type ResolvedAuthIdentity } from "./resolved-auth-identity.js";

const OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai/console";
const OPENCODE_CONSOLE_INTEGRATION_ID = "opencode";

export interface OpenCodeConsoleCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  email?: string;
  server?: string;
}

export type OpenCodeConsoleAuthState =
  | { state: "none"; reason?: "not_oauth" }
  | { state: "configured"; credential: OpenCodeConsoleCredential }
  | { state: "expired"; credential: OpenCodeConsoleCredential }
  | { state: "invalid"; error: string };

export async function resolveOpenCodeConsoleAuth(params?: {
  nowMs?: number;
}): Promise<OpenCodeConsoleAuthState> {
  // Only the active Console login counts, the way OpenCode itself picks it.
  const rows = await readCredentialRows([OPENCODE_CONSOLE_INTEGRATION_ID], { firstOnly: true });
  const row = rows[0];
  if (!row) return { state: "none" };
  if (row.resolveError !== undefined) return { state: "invalid", error: row.resolveError };

  // An API key under `opencode` (service account or workspace key) is not a sign-in.
  const login = readOAuthLogin(row);
  if (login?.state !== "signed-in") return { state: "none", reason: "not_oauth" };

  const { accessToken } = login;
  if (!accessToken) {
    return { state: "invalid", error: "OpenCode Console credential has no access token" };
  }

  const metadata = login.fields.metadata;
  const text = (key: string) =>
    isRecord(metadata) && typeof metadata[key] === "string" ? metadata[key] : undefined;
  const credential: OpenCodeConsoleCredential = {
    accessToken,
    refreshToken: login.refreshToken,
    expiresAt: login.expiresAt,
    accountId: text("accountID"),
    orgId: text("orgID"),
    orgName: text("orgName"),
    email: text("email"),
    server: text("server"),
  };

  const nowMs = params?.nowMs ?? Date.now();
  if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
    return { state: "expired", credential };
  }

  return { state: "configured", credential };
}

const CONSOLE_LOGIN_HINT = "Run `opencode auth login opencode`.";

/**
 * Why an expired or failed Console login can't be used (`detail`), and the error both Zen and Go
 * show for it, which reads as "Sign in again".
 */
export function consoleSignInFailure(
  auth: Extract<OpenCodeConsoleAuthState, { state: "expired" | "invalid" }>,
): { detail: string; message: string } {
  const detail = auth.state === "expired" ? "the sign-in expired" : safeErrorText(auth.error);
  return { detail, message: `OpenCode Console sign-in failed: ${detail}. ${CONSOLE_LOGIN_HINT}` };
}

/**
 * Who the Console login is, for `providerId`'s cache: org + account (member budgets are per
 * account), else the account, else the token. The Console URL qualifies it because org ids can
 * collide across self-hosted Console URLs.
 */
export async function consoleLoginIdentity(
  providerId: string,
  credential: OpenCodeConsoleCredential,
): Promise<ResolvedAuthIdentity | null> {
  const { orgId, accountId } = credential;
  return await deriveResolvedAuthIdentity({
    providerId,
    principal:
      orgId || accountId
        ? {
            kind: "stable-id",
            value:
              orgId && accountId ? JSON.stringify([orgId, accountId]) : (orgId ?? accountId ?? ""),
          }
        : { kind: "credential", value: credential.accessToken },
    qualifiers: [consoleBaseUrl(credential)],
  });
}

/** The Console server the login belongs to. */
export function consoleBaseUrl(credential: OpenCodeConsoleCredential): string {
  return credential.server ?? OPENCODE_CONSOLE_BASE_URL;
}

/** Console API request headers; `x-org-id` only when the login has an org. */
export function consoleHeaders(credential: OpenCodeConsoleCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    ...(typeof credential.orgId === "string" ? { "x-org-id": credential.orgId } : {}),
  };
}
