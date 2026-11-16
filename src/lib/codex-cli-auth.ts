/**
 * Codex CLI sign-in, read-only.
 *
 * OpenCode 2's "Sign in with ChatGPT" token is scoped to api.openai.com, so ChatGPT's usage
 * endpoint rejects it (#316). The token the Codex CLI stores in `$CODEX_HOME/auth.json` (default
 * `~/.codex/auth.json`) is accepted by that endpoint, so the OpenAI provider falls back to it.
 *
 * This module only reads: it never refreshes, never writes, and a stale file reports its own
 * error. Refreshing stays the Codex CLI's job, which owns that credential.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { sanitizeDisplayText } from "./display-sanitize.js";
import { isRecord } from "./json-guards.js";

export type CodexCliAuth =
  | { state: "not-found"; location: string }
  | { state: "unavailable"; detail: string; location: string }
  | {
      state: "configured";
      location: string;
      accessToken: string;
      accountId?: string;
      /** From the token's `exp`, so an expired file can say so instead of failing the request. */
      expiresAt?: number;
    };

/** The file the Codex CLI keeps its sign-in in: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function codexCliAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim();
  return join(codexHome || join(homedir(), ".codex"), "auth.json");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `exp` of a JWT access token in epoch milliseconds, when the token carries one. */
function jwtExpiresAt(accessToken: string): number | undefined {
  const parts = accessToken.split(".");
  const payloadPart = parts[1];
  if (parts.length !== 3 || !payloadPart) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    const exp = isRecord(payload) ? payload.exp : undefined;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Codex CLI's sign-in: `not-found` when the file is missing (the normal case for a machine
 * without the CLI), `unavailable` when it exists but cannot be used.
 */
export async function readCodexCliAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexCliAuth> {
  const path = codexCliAuthPath(env);
  const location = sanitizeDisplayText(path);

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      return { state: "not-found", location };
    }
    return {
      state: "unavailable",
      location,
      detail: `Could not read the Codex CLI sign-in: ${sanitizeDisplayText(errorText(error))}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      state: "unavailable",
      location,
      detail: `The Codex CLI sign-in at ${location} is not valid JSON.`,
    };
  }

  const tokens = isRecord(parsed) && isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : undefined;
  if (!accessToken) {
    return {
      state: "unavailable",
      location,
      detail: `The Codex CLI sign-in at ${location} carries no access token.`,
    };
  }

  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
  const expiresAt = jwtExpiresAt(accessToken);
  return {
    state: "configured",
    location,
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}
