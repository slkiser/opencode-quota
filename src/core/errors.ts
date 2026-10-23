/**
 * One error vocabulary for every surface: `providerError` turns a provider's failure into a
 * `QuotaError` (from the facts its request gave, else by reading its words with
 * `classifyError`), and `describeError` gives the short words users see. The raw text is kept
 * in `detail`, scrubbed by `publicDetail`; /quota_status shows the code, status and words.
 */
import { publicDetail } from "./redact.js";
import type { QuotaError, QuotaErrorCode } from "./types.js";

const DETAIL_MAX_LENGTH = 300;

/** Every error code, to check a code read from a file or a provider answer. */
const ERROR_CODES: Readonly<Record<QuotaErrorCode, true>> = {
  not_configured: true,
  login_expired: true,
  no_plan: true,
  rate_limited: true,
  timeout: true,
  network: true,
  provider_error: true,
  bad_response: true,
  no_data: true,
  local_tool: true,
  internal: true,
};

export function isQuotaErrorCode(code: unknown): code is QuotaErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_CODES, code);
}

/** An HTTP status as shown: a whole number from 100 to 599. */
export function httpStatus(status: unknown): number | undefined {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600
    ? status
    : undefined;
}

/** An error's code and HTTP status, "provider_error, http 503": never its message's words. */
export function errorKind(error: QuotaError): string {
  if (!isQuotaErrorCode(error.code)) return "(unknown error code)";
  const status = httpStatus(error.status);
  return status === undefined ? error.code : `${error.code}, http ${status}`;
}

/** Local programs named in provider messages, longest names first. */
export const LOCAL_TOOLS: readonly string[] = ["Alibaba Cloud CLI", "Claude CLI"];

/** Checked in order; the first match wins. Patterns run on the raw message, case-insensitive. */
const RULES: ReadonlyArray<readonly [QuotaErrorCode, RegExp]> = [
  ["internal", /invalid normalized provider result|failed to read quota data/i],
  ["rate_limited", /\b429\b|rate.?limit|too many requests/i],
  ["timeout", /timed? ?out\b|timeout/i],
  [
    "local_tool",
    /not found on the trusted path|could not start|cli probe failed|not supported on this platform/i,
  ],
  [
    "no_plan",
    /not subscribed|subscription (?:not found|is not active)|not an active subscription/i,
  ],
  [
    "login_expired",
    /token (?:expired|revoked)|token refresh failed|sign-in could not be|sign-in expired|session (?:is missing or )?expired|requires login|could not read this login|invalid api key|login fail|\bauth error\b|\b401\b|unauthorized/i,
  ],
  [
    "not_configured",
    /not configured|auth entry|missing a refresh token|has no access token|unsupported .*(?:auth type|tier)|invalid config|config must be|config file|invalid cookie header/i,
  ],
  [
    "network",
    /fetch failed|\beconn(?:refused|reset|aborted)\b|\benotfound\b|\beai_again\b|socket hang up|request failed:/i,
  ],
  [
    "provider_error",
    /\b(?:http|api error|error|status):?\s*\(?\d{3}\b|\(http \d{3}\)|\breturned [3-5]\d{2}\b/i,
  ],
  [
    "bad_response",
    /invalid|parse|valid json|unexpected\b.*\bresponse|response shape|response missing|exceeded \d+ bytes|redirect rejected|expected a json|did not match/i,
  ],
  [
    "no_data",
    /\bno\b.*\bdata\b|no usable|returned no|unavailable|no local usage|nothing to report/i,
  ],
];

function findStatus(message: string): number | undefined {
  const match = /\b([1-5]\d{2})\b/u.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** Anthropic's cooldown text says "retry in 42s". */
function findRetryAtMs(message: string, nowMs: number): number | undefined {
  const match = /retry in (\d+)\s*s\b/iu.exec(message);
  return match ? nowMs + Number(match[1]) * 1000 : undefined;
}

function codeFromWords(message: string): QuotaErrorCode {
  return RULES.find(([, pattern]) => pattern.test(message))?.[0] ?? "internal";
}

export function classifyError(message: string, nowMs: number = Date.now()): QuotaError {
  const code = codeFromWords(message);
  // Hidden before it is cut, so a cut never leaves part of an email address or home dir.
  const detail = publicDetail(message, DETAIL_MAX_LENGTH);
  const error: QuotaError = { code, ...(detail ? { detail } : {}) };
  if (code === "provider_error" || code === "rate_limited") {
    const status = findStatus(message);
    if (status !== undefined) error.status = status;
  }
  if (code === "rate_limited") {
    const retryAtMs = findRetryAtMs(message, nowMs);
    if (retryAtMs !== undefined) error.retryAtMs = retryAtMs;
  }
  if (code === "local_tool") {
    const tool = LOCAL_TOOLS.find((name) => message.includes(name));
    if (tool) error.tool = tool;
    if (/not found|not supported/i.test(message)) error.missing = true;
  }
  return error;
}

/** What a failed request says about itself: its code, HTTP status and when to try again. */
export type ErrorFacts = Pick<QuotaError, "code" | "status" | "retryAtMs">;

/** The latest retry time a provider's reply may set: a daily quota resets within it. */
export const RETRY_WAIT_MAX_MS = 24 * 60 * 60_000;

/**
 * Codes the words name more exactly than a bare status: a 403 that says "secondary rate limit"
 * or "not subscribed", a 504 "Gateway Timeout".
 */
const CODES_OVER_PROVIDER_ERROR: ReadonlySet<QuotaErrorCode> = new Set([
  "rate_limited",
  "no_plan",
  "login_expired",
  "timeout",
]);

/**
 * A provider's failure: its own facts when its request gave them, else read from its words.
 * When the facts only say `provider_error`, words that name a rate limit, a missing plan, an
 * expired login or a timeout win; the status and retry time stay.
 */
export function providerError(
  message: string,
  facts: ErrorFacts | undefined,
  nowMs: number = Date.now(),
): QuotaError {
  if (!facts || !isQuotaErrorCode(facts.code)) return classifyError(message, nowMs);
  const wordsCode = facts.code === "provider_error" ? codeFromWords(message) : undefined;
  const code =
    wordsCode !== undefined && CODES_OVER_PROVIDER_ERROR.has(wordsCode) ? wordsCode : facts.code;
  const detail = publicDetail(message, DETAIL_MAX_LENGTH);
  const status = httpStatus(facts.status);
  return {
    code,
    ...(detail ? { detail } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(facts.retryAtMs !== undefined ? { retryAtMs: facts.retryAtMs } : {}),
  };
}

function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
}

/** The short words every surface shows for an error, for example "Sign in again". */
export function describeError(error: QuotaError, providerLabel: string, nowMs: number): string {
  switch (error.code) {
    case "not_configured":
      return "Not set up";
    case "login_expired":
      return "Sign in again";
    case "no_plan":
      return "No active plan";
    case "rate_limited":
      return error.retryAtMs !== undefined && error.retryAtMs > nowMs
        ? `Rate limited, retry in ${formatWait(error.retryAtMs - nowMs)}`
        : "Rate limited";
    case "timeout":
      return "Timed out";
    case "network":
      return `Can't reach ${providerLabel}`;
    case "provider_error":
      return error.status === undefined ? "Provider error" : `Provider error ${error.status}`;
    case "bad_response":
      return "Unexpected reply";
    case "no_data":
      return "Nothing reported";
    case "local_tool":
      return `${error.tool ?? "Local tool"} ${error.missing ? "not found" : "failed"}`;
    case "internal":
      return "Couldn't read";
  }
}
