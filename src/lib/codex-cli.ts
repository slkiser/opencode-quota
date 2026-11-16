/**
 * Codex CLI quota: the ChatGPT quota of the account the Codex CLI is signed in to.
 *
 * OpenCode 2's "Sign in with ChatGPT" gets a token that only works for api.openai.com, and
 * ChatGPT's usage endpoint rejects it with 401 `no_matching_rule` (#316). The Codex CLI signs in
 * with another OAuth client whose token that endpoint accepts, so it is a second source of the
 * same numbers. It is opt-in, and the CLI's credentials stay its own: this reads them, never
 * refreshes them and never writes them.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { sanitizeDisplayText } from "./display-sanitize.js";
import { failureFacts, requestJson } from "./http.js";
import { isRecord, nonEmptyString } from "./json-guards.js";
import { openAIErrorCode, parseJwtPayload, parseUsageResponse } from "./openai.js";
import type { OpenAIResult, OpenAIUsageResponse } from "./openai.js";
import type { QuotaError } from "./types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

/** The Codex CLI's own sign-in: the token it holds and the ChatGPT account it belongs to. */
export type CodexCliLogin =
  | { state: "missing" }
  | { state: "expired"; accountId?: string; planType?: string }
  | { state: "configured"; accessToken: string; accountId?: string; planType?: string };

/** Where the Codex CLI keeps its credentials: `$CODEX_HOME`, else `~/.codex`. */
export function codexCliHome(): string {
  const home = nonEmptyString(process.env.CODEX_HOME);
  return home ? home : join(homedir(), ".codex");
}

/** The Codex CLI's credential file. */
export function codexCliAuthPath(): string {
  return join(codexCliHome(), "auth.json");
}

/**
 * The Codex CLI's sign-in, read from its credential file.
 *
 * A missing file, an unreadable one and a sign-in that uses an API key are all "missing": none
 * of them carries a token ChatGPT's usage endpoint accepts. An expired token is its own state,
 * because the fix is to sign in with the CLI again and not something this plugin can do: the
 * credentials belong to the CLI, so they are never refreshed or rewritten here.
 */
export async function readCodexCliLogin(): Promise<CodexCliLogin> {
  let raw: string;
  try {
    raw = await readFile(codexCliAuthPath(), "utf8");
  } catch {
    return { state: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "missing" };
  }

  if (!isRecord(parsed)) return { state: "missing" };
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  if (!tokens) return { state: "missing" };
  const accessToken = nonEmptyString(tokens.access_token);
  if (!accessToken) return { state: "missing" };

  const idClaims = parseJwtPayload(nonEmptyString(tokens.id_token) ?? "");
  const idAuth = idClaims?.["https://api.openai.com/auth"];
  const accountId = nonEmptyString(tokens.account_id) ?? nonEmptyString(idAuth?.chatgpt_account_id);
  const planType = nonEmptyString(idAuth?.chatgpt_plan_type);
  const claims = parseJwtPayload(accessToken);
  const expiresAt = claims?.exp;

  if (expiresAt !== undefined && expiresAt * 1000 <= Date.now()) {
    return {
      state: "expired",
      ...(accountId ? { accountId } : {}),
      ...(planType ? { planType } : {}),
    };
  }

  return {
    state: "configured",
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(planType ? { planType } : {}),
  };
}

/** The Codex CLI's quota, read from the same endpoint OpenCode's own logins use. */
export async function queryCodexCliQuota(options: {
  login: { accessToken: string; accountId?: string };
  requestTimeoutMs?: number;
}): Promise<OpenAIResult> {
  const { login } = options;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${login.accessToken}`,
    "User-Agent": USER_AGENT,
    ...(login.accountId ? { "ChatGPT-Account-Id": login.accountId } : {}),
  };
  const reply = await requestJson(CODEX_USAGE_URL, {
    headers,
    secrets: [login.accessToken, login.accountId],
    timeoutMs: options.requestTimeoutMs,
  });
  if (!reply.ok) {
    const { failure } = reply;
    const facts = failureFacts(failure);
    if (failure.kind !== "http") return { success: false, error: failure.detail, facts };
    const code = openAIErrorCode(failure.detail);
    return {
      success: false,
      error: `OpenAI API error ${failure.status}${code ? ` (${code})` : ""}`,
      facts,
    };
  }
  try {
    return parseUsageResponse(reply.json as OpenAIUsageResponse);
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** The Codex CLI's sign-in as a quota source: ready, expired, or nothing to read. */
export type CodexCliSource =
  | { state: "ready"; login: { accessToken: string; accountId?: string } }
  | { state: "expired"; error: string }
  | { state: "missing"; error: string };

/** The Codex CLI's sign-in as a quota source, with the guidance a missing one needs. */
export async function readCodexCliSource(): Promise<CodexCliSource> {
  const login = await readCodexCliLogin();
  if (login.state === "configured") {
    return {
      state: "ready",
      login: {
        accessToken: login.accessToken,
        ...(login.accountId ? { accountId: login.accountId } : {}),
      },
    };
  }
  if (login.state === "expired") {
    return {
      state: "expired",
      error: "The Codex CLI sign-in has expired; sign in with the Codex CLI again",
    };
  }
  return {
    state: "missing",
    error:
      "No Codex CLI sign-in found; sign in with the Codex CLI or turn providers.openai.codexCliSource off",
  };
}

export type CodexCliQuotaReply = OpenAIResult | QuotaError;
