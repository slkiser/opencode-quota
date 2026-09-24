/**
 * OpenCode Console credential reader
 *
 * OpenCode 2 stores its OpenCode Console account in the credential database
 * under the `opencode` integration as an OAuth entry created by the device
 * flow (`client_id: opencode-cli`, base `https://opencode.ai/console`).
 * Consumers use the access token as `Authorization: Bearer` against console
 * APIs and `metadata.orgID` for org-scoped routes.
 *
 * The reader is intentionally read-only: the CLI refreshes the token via
 * `/console/auth/device/token` on its own; an expired token is reported as
 * `expired` so callers can tell the user to re-run `opencode auth login`.
 */

import { readCredentialRows } from "./opencode-auth.js";

export const OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai/console";
export const OPENCODE_CONSOLE_INTEGRATION_ID = "opencode";

export interface OpenCodeConsoleCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  orgId?: string;
  orgName?: string;
  email?: string;
  server?: string;
}

export type OpenCodeConsoleAuthState =
  | { state: "none" }
  | { state: "configured"; credential: OpenCodeConsoleCredential }
  | { state: "expired"; credential: OpenCodeConsoleCredential }
  | { state: "invalid"; error: string };

export async function resolveOpenCodeConsoleAuth(params?: {
  nowMs?: number;
}): Promise<OpenCodeConsoleAuthState> {
  const rows = await readCredentialRows();
  const candidates = rows
    .filter((row) => row.integrationId === OPENCODE_CONSOLE_INTEGRATION_ID)
    .filter((row) => (row.value as Record<string, unknown> | null)?.type === "oauth");

  if (candidates.length === 0) return { state: "none" };

  const row = candidates[0]!;
  const value = row.value as Record<string, unknown>;
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
