/**
 * OpenAI (ChatGPT) quota fetcher
 *
 * Reads OpenCode's OpenAI OAuth logins and queries
 * https://chatgpt.com/backend-api/wham/usage
 */

import { sanitizeDisplayText } from "./display-sanitize.js";
import type { FixedWindowProjectionEvidence } from "./entries.js";
import { clampPercent } from "./format-utils.js";
import { failureFacts, requestJson } from "./http.js";
import { finiteNumber, isRecord } from "./json-guards.js";
import {
  type CredentialRow,
  credentialRowAuthData,
  readAuthFileCached,
  readCredentialRows,
} from "./opencode-auth.js";
import {
  deriveResolvedAuthIdentity,
  loginListIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";
import type { AuthData, QuotaError } from "./types.js";

interface OpenAIUsageResponse {
  plan_type: string;
  rate_limit: { primary_window?: unknown; secondary_window?: unknown } | null;
  code_review_rate_limit?: { primary_window?: unknown } | null;
  spend_control?: { individual_limit?: unknown } | null;
}

interface JwtPayload {
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

function parseJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
}

type OpenAIWindowKind = "hourly" | "weekly" | "monthly";

type OpenAIWindowValue = {
  percentRemaining: number;
  resetTimeIso?: string;
  fixedWindow?: FixedWindowProjectionEvidence;
};

type OpenAIWindows = Partial<Record<OpenAIWindowKind | "codeReview", OpenAIWindowValue>>;

const WINDOW_KIND_BY_DURATION: Readonly<Record<number, OpenAIWindowKind>> = {
  18000: "hourly",
  604800: "weekly",
  2628000: "monthly",
};

function isoFromMilliseconds(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function positiveSeconds(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
}

/** `reset_at` (epoch seconds) when it is a representable date, else `reset_after_seconds` from now. */
function resetTimeIso(window: Record<string, unknown>, observedAtMs: number): string | undefined {
  const resetAt = positiveSeconds(window.reset_at);
  const resetAfter = positiveSeconds(window.reset_after_seconds);
  return (
    (resetAt === undefined ? undefined : isoFromMilliseconds(Math.round(resetAt * 1000))) ??
    (resetAfter === undefined
      ? undefined
      : isoFromMilliseconds(observedAtMs + Math.round(resetAfter * 1000)))
  );
}

/** A window reporting `used_percent` (rate limits) or `remaining_percent` (spend limits). */
function parseWindowValue(
  window: unknown,
  observedAtMs: number,
  percentField: "used_percent" | "remaining_percent" = "used_percent",
): OpenAIWindowValue | null {
  if (!isRecord(window)) return null;
  const percent = finiteNumber(window[percentField]);
  if (percent === undefined) return null;
  return {
    percentRemaining: clampPercent(percentField === "used_percent" ? 100 - percent : percent),
    resetTimeIso: resetTimeIso(window, observedAtMs),
  };
}

/** A rate-limit window, classified by its duration; unknown durations are dropped. */
function parseRateLimitWindow(
  window: unknown,
  observedAtMs: number,
): { kind: OpenAIWindowKind; value: OpenAIWindowValue } | null {
  if (!isRecord(window) || typeof window.limit_window_seconds !== "number") return null;
  const durationSeconds = window.limit_window_seconds;
  const kind = WINDOW_KIND_BY_DURATION[durationSeconds];
  const value = kind ? parseWindowValue(window, observedAtMs) : null;
  if (!kind || !value) return null;

  const endsAtMs = value.resetTimeIso ? Date.parse(value.resetTimeIso) : Number.NaN;
  const startedAtMs = endsAtMs - durationSeconds * 1000;
  if (Number.isFinite(startedAtMs) && startedAtMs < observedAtMs && observedAtMs < endsAtMs) {
    value.fixedWindow = { startedAtIso: new Date(startedAtMs).toISOString() };
  }
  return { kind, value };
}

function derivePlanLabel(planType: string | undefined): string {
  const normalized = (planType ?? "").trim().toLowerCase();
  if (normalized === "team" || normalized === "business") return "OpenAI (Business)";
  if (normalized.includes("pro")) return "OpenAI (Pro)";
  if (normalized.includes("plus")) return "OpenAI (Plus)";
  if (planType) return `OpenAI (${planType})`;
  return "OpenAI";
}

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
// Not `opencode`: in OpenCode 2 its OAuth entry is the Console login, which
// authorizes Console APIs, not OpenAI.
export const OPENAI_AUTH_SOURCE_KEYS = ["openai", "codex", "chatgpt"] as const;

type OpenAIAuthSourceKey = (typeof OPENAI_AUTH_SOURCE_KEYS)[number];

export type OpenAIResult = { success: true; label: string; windows: OpenAIWindows } | QuotaError;

/** A stored OpenAI login: one OpenCode could not return, or one with an access token. */
export type OpenAIOAuthLogin =
  | { state: "failed"; sourceKey: OpenAIAuthSourceKey; error: string }
  | {
      state: "configured";
      sourceKey: OpenAIAuthSourceKey;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      accountId?: string;
    };

type ResolvedOpenAIOAuth = { state: "none" } | OpenAIOAuthLogin;

/** The first OAuth login under `openai`, `codex`, `chatgpt` with a token or a resolve error. */
export function resolveOpenAIOAuth(auth: AuthData | null | undefined): ResolvedOpenAIOAuth {
  for (const sourceKey of OPENAI_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (entry?.type !== "oauth") continue;
    if (entry.resolveError !== undefined) {
      return { state: "failed", sourceKey, error: entry.resolveError };
    }
    const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
    if (!accessToken) continue;

    const jwt = parseJwtPayload(accessToken);
    return {
      state: "configured",
      sourceKey,
      accessToken,
      refreshToken:
        typeof entry.refresh === "string" && entry.refresh.trim() ? entry.refresh : undefined,
      expiresAt: typeof entry.expires === "number" ? entry.expires : undefined,
      accountId:
        jwt?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? entry.accountId ?? undefined,
    };
  }
  return { state: "none" };
}

/** The login OpenCode reports as active for `openai`, `codex`, or `chatgpt` (cached briefly). */
export async function readOpenAIAuthCached(): Promise<ResolvedOpenAIOAuth> {
  return resolveOpenAIOAuth(
    await readAuthFileCached({
      maxAgeMs: OPENAI_AUTH_CACHE_MAX_AGE_MS,
      integrationIds: OPENAI_AUTH_SOURCE_KEYS,
    }),
  );
}

/** A stored OpenAI login (OAuth or API key) with its OAuth sign-in, when it has one. */
export type OpenAILogin = { row: CredentialRow; oauth?: OpenAIOAuthLogin };

/** Every stored OpenAI login, OAuth and API key; a failed one stays so it shows as an error. */
export async function readOpenAILogins(): Promise<OpenAILogin[]> {
  const rows = await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, { methods: ["oauth", "key"] });
  return rows.map((row) => {
    if (row.value.type === "api") return { row };
    const oauth = resolveOpenAIOAuth(credentialRowAuthData(row));
    return oauth.state === "none" ? { row } : { row, oauth };
  });
}

/**
 * Who OpenAI is signed in as: each OAuth sign-in's account (or token), and each other login by
 * its connection, since its rows do not depend on a secret. A failed login can't be told apart.
 */
export async function openaiLoginsIdentity(
  logins: readonly OpenAILogin[],
): Promise<ResolvedAuthIdentity | null> {
  return loginListIdentity(
    "openai",
    await Promise.all(
      logins.map(async ({ row, oauth }) => {
        if (row.resolveError !== undefined || oauth?.state === "failed") {
          return { row, identity: null };
        }
        const principal = oauth
          ? oauth.accountId
            ? { kind: "stable-id" as const, value: oauth.accountId }
            : { kind: "credential" as const, value: oauth.refreshToken ?? oauth.accessToken }
          : { kind: "stable-id" as const, value: `connection:${row.id}` };
        return {
          row,
          identity: await deriveResolvedAuthIdentity({ providerId: "openai", principal }),
        };
      }),
    ),
  );
}

/** A login label that can go into a shell command unquoted and is not read as an option. */
const SHELL_SAFE_LOGIN_LABEL = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/u;
/** OpenAI's error codes are short snake_case words, e.g. `no_matching_rule`. */
const OPENAI_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * Only OpenAI's short error code, never the free-text body, which can echo
 * account details.
 */
function openAIErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } } | null;
    const code = parsed?.error?.code;
    return typeof code === "string" && OPENAI_ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function parseUsageResponse(data: OpenAIUsageResponse): OpenAIResult {
  const observedAtMs = Date.now();
  const windows: OpenAIWindows = {};
  // Two windows of the same duration that disagree are both dropped instead of guessing.
  const conflictingKinds = new Set<OpenAIWindowKind>();
  for (const window of [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]) {
    const parsed = parseRateLimitWindow(window, observedAtMs);
    if (!parsed || conflictingKinds.has(parsed.kind)) continue;

    const existing = windows[parsed.kind];
    if (!existing) {
      windows[parsed.kind] = parsed.value;
    } else if (
      existing.percentRemaining !== parsed.value.percentRemaining ||
      existing.resetTimeIso !== parsed.value.resetTimeIso
    ) {
      delete windows[parsed.kind];
      conflictingKinds.add(parsed.kind);
    }
  }
  const individualLimit = parseWindowValue(
    data.spend_control?.individual_limit,
    observedAtMs,
    "remaining_percent",
  );
  if (!windows.monthly && individualLimit) windows.monthly = individualLimit;
  const codeReview = parseWindowValue(data.code_review_rate_limit?.primary_window, observedAtMs);
  if (codeReview) windows.codeReview = codeReview;

  if (Object.keys(windows).length === 0) {
    return { success: false, error: "No quota data" };
  }

  return { success: true, label: derivePlanLabel(data.plan_type), windows };
}

export async function queryOpenAIQuota(options: {
  auth: OpenAIOAuthLogin;
  requestTimeoutMs?: number;
  loginLabel?: string;
}): Promise<OpenAIResult> {
  const { auth } = options;
  if (auth.state === "failed") {
    // Signing in again leaves a broken login with another label in place
    // (#316), so name the command that removes it when the label is known.
    // Not trimmed: " Work " is a different login than "Work".
    const label = options.loginLabel;
    const fix =
      label && SHELL_SAFE_LOGIN_LABEL.test(label)
        ? `Run \`opencode auth logout ${auth.sourceKey} ${label}\`, then \`opencode auth login openai\`.`
        : "Run `opencode auth login openai`.";
    return {
      success: false,
      error: `OpenAI sign-in could not be refreshed: ${auth.error}. ${fix}`,
    };
  }

  if (auth.expiresAt && auth.expiresAt < Date.now()) {
    return { success: false, error: "Token expired" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "OpenCode-Quota-Toast/1.0",
    ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
  };
  const reply = await requestJson(OPENAI_USAGE_URL, {
    headers,
    secrets: [auth.accessToken, auth.accountId],
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
