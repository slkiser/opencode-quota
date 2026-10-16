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
 */

import { readCredentialRows } from "./opencode-auth.js";

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

type OpenCodeConsoleAuthState =
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

  const value = row.value;
  // An API key under `opencode` (service account or workspace key) is not a sign-in.
  if (value.type !== "oauth") return { state: "none", reason: "not_oauth" };

  const accessToken = typeof value.access === "string" ? value.access.trim() : "";
  if (!accessToken) {
    return { state: "invalid", error: "OpenCode Console credential has no access token" };
  }

  const metadata = (value.metadata ?? null) as Record<string, unknown> | null;
  const credential: OpenCodeConsoleCredential = {
    accessToken,
    refreshToken:
      typeof value.refresh === "string" && value.refresh.trim() ? value.refresh : undefined,
    expiresAt: typeof value.expires === "number" ? value.expires : undefined,
    accountId: typeof metadata?.accountID === "string" ? metadata.accountID : undefined,
    orgId: typeof metadata?.orgID === "string" ? metadata.orgID : undefined,
    orgName: typeof metadata?.orgName === "string" ? metadata.orgName : undefined,
    email: typeof metadata?.email === "string" ? metadata.email : undefined,
    server: typeof metadata?.server === "string" ? metadata.server : undefined,
  };

  const nowMs = params?.nowMs ?? Date.now();
  if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
    return { state: "expired", credential };
  }

  return { state: "configured", credential };
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
