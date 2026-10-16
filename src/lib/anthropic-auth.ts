/**
 * OpenCode-managed Anthropic OAuth credentials.
 *
 * Reads the `anthropic` OAuth logins from OpenCode's own opencode.db. These are the
 * credentials OpenCode refreshes for Anthropic subscription models, so they stay
 * usable even when a separately installed Claude Code has stale credentials.
 */

import { type CredentialRow, credentialRowAuthData, readCredentialRows } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

type ResolvedAnthropicOAuth =
  | { state: "none" }
  | { state: "failed"; error: string }
  | { state: "expired"; expiresAt: number }
  | { state: "configured"; accessToken: string; expiresAt?: number };

export function resolveAnthropicOAuth(
  auth: AuthData | null | undefined,
  options: { nowMs?: number } = {},
): ResolvedAnthropicOAuth {
  const entry = auth?.anthropic;
  if (!entry || entry.type !== "oauth") return { state: "none" };
  if (entry.resolveError !== undefined) return { state: "failed", error: entry.resolveError };

  const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
  if (!accessToken) return { state: "none" };

  const expiresAt = typeof entry.expires === "number" ? entry.expires : undefined;
  if (expiresAt !== undefined && expiresAt <= (options.nowMs ?? Date.now())) {
    return { state: "expired", expiresAt };
  }

  return expiresAt === undefined
    ? { state: "configured", accessToken }
    : { state: "configured", accessToken, expiresAt };
}

export type AnthropicLogin = {
  row: CredentialRow;
  auth: Extract<ResolvedAnthropicOAuth, { state: "configured" | "failed" }>;
};

/**
 * Every OpenCode Claude sign-in with a usable token, in OpenCode's order (the one it uses
 * first). A sign-in OpenCode could not return stays, so it shows as its own error.
 */
export async function readAnthropicLogins(): Promise<AnthropicLogin[]> {
  return (await readCredentialRows(["anthropic"], { methods: ["oauth"] })).flatMap((row) => {
    if (row.integrationId !== "anthropic") return [];
    const auth = resolveAnthropicOAuth(credentialRowAuthData(row));
    return auth.state === "configured" || auth.state === "failed" ? [{ row, auth }] : [];
  });
}
