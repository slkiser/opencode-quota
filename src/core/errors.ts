/**
 * One error vocabulary for every surface: `classifyError` turns a provider's free-text failure
 * into a `QuotaError`, and `describeError` gives the short words users see. The raw text is
 * kept in `detail`, scrubbed by `publicDetail`; /quota_status shows the code, status and words.
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
    /token (?:expired|revoked)|token refresh failed|sign-in could not be|sign-in expired|session (?:is missing or )?expired|requires login|could not read this login|invalid api key|login fail|\b401\b|unauthorized/i,
  ],
  [
    "not_configured",
    /not configured|auth entry|missing a refresh token|has no access token|unsupported .*(?:auth type|tier)|invalid config|config must be|config file|invalid cookie header/i,
  ],
  [
    "network",
    /fetch failed|\beconn(?:refused|reset|aborted)\b|\benotfound\b|\beai_again\b|socket hang up|request failed:/i,
  ],
  ["provider_error", /\b(?:http|api error|error|status)\s*\(?\d{3}\b|\(http \d{3}\)/i],
  [
    "bad_response",
    /invalid|parse|valid json|unexpected response|response missing|exceeded \d+ bytes|redirect rejected|expected a json|did not match/i,
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

export function classifyError(message: string, nowMs: number = Date.now()): QuotaError {
  const code = RULES.find(([, pattern]) => pattern.test(message))?.[0] ?? "internal";
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
