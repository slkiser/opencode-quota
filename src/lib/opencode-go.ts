import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { OPENCODE_CONSOLE_BASE_URL } from "./opencode-console-auth.js";
import type { OpenCodeGoResult, OpenCodeGoWindow, OpenCodeGoWindowKey } from "./types.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OFFSET_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redactToken(text: string, accessToken: string): string {
  return accessToken ? text.replaceAll(accessToken, "[redacted]") : text;
}

function sanitizeMessage(text: string, accessToken: string, maxLength = 120): string {
  const redacted = redactToken(text, accessToken);
  const sanitized = sanitizeDisplayText(redacted).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

function errorMessage(error: unknown, accessToken: string): string {
  return sanitizeMessage(error instanceof Error ? error.message : String(error), accessToken);
}

function contractError(message: string): OpenCodeGoResult {
  return { success: false, error: `Invalid OpenCode Go API response: ${message}` };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isValidOffsetIsoTimestamp(value: string): boolean {
  const match = OFFSET_ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (offsetHour === undefined || Number(offsetHour) <= 23) &&
    (offsetMinute === undefined || Number(offsetMinute) <= 59)
  );
}

function normalizeWindow(
  windowKey: OpenCodeGoWindowKey,
  value: unknown,
  accessToken: string,
): OpenCodeGoWindow | OpenCodeGoResult {
  const window = asRecord(value);
  if (!window) {
    return contractError(`${windowKey} window is missing or malformed`);
  }

  if (window.status !== "ok" && window.status !== "rate-limited") {
    return contractError(
      `${windowKey} status is not ok: ${sanitizeMessage(String(window.status), accessToken)}`,
    );
  }

  const percent = window.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return contractError(`${windowKey} percent must be a finite number from 0 to 100`);
  }

  const resetsAt = window.resetsAt;
  if (typeof resetsAt !== "string" || !isValidOffsetIsoTimestamp(resetsAt)) {
    return contractError(`${windowKey} resetsAt must be an offset-qualified ISO timestamp`);
  }

  const resetTime = Date.parse(resetsAt);
  if (!Number.isFinite(resetTime)) {
    return contractError(`${windowKey} resetsAt must be a valid timestamp`);
  }

  const exhausted = window.status === "rate-limited";
  return {
    status: window.status as "ok" | "rate-limited",
    usagePercent: exhausted ? 100 : percent,
    percentRemaining: exhausted ? 0 : 100 - percent,
    resetTimeIso: new Date(resetTime).toISOString(),
  };
}

function normalizeResponse(payload: unknown, accessToken: string): OpenCodeGoResult {
  const root = asRecord(payload);
  if (!root) return contractError("root must be an object");

  const usage = asRecord(root.usage);
  if (!usage) return contractError("usage must be an object");

  const normalized = {} as Record<OpenCodeGoWindowKey, OpenCodeGoWindow>;
  for (const windowKey of OPENCODE_GO_WINDOW_ORDER) {
    const window = normalizeWindow(windowKey, usage[windowKey], accessToken);
    if ("success" in window) return window;
    normalized[windowKey] = window;
  }

  return {
    success: true,
    rolling: normalized.rolling,
    weekly: normalized.weekly,
    monthly: normalized.monthly,
  };
}

function isNotSubscribedResponse(status: number, text: string): boolean {
  if (status !== 403) return false;
  try {
    const payload = asRecord(JSON.parse(text));
    const error = asRecord(payload?.error);
    return payload?.type === "error" && error?.type === "EntitlementError";
  } catch {
    return false;
  }
}

export async function queryOpenCodeGoQuota(
  accessToken: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeGoResult> {
  try {
    return await fetchWithTimeout(OPENCODE_GO_USAGE_URL, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          let text: string;
          try {
            text = await response.text();
          } catch (error) {
            return {
              success: false,
              error: `OpenCode Go API error ${response.status}: ${errorMessage(error, accessToken)}`,
              retryable: isRetryableHttpStatus(response.status),
            };
          }
          if (isNotSubscribedResponse(response.status, text)) {
            return {
              success: false,
              error: "OpenCode Go not subscribed (403 EntitlementError)",
              notSubscribed: true,
              retryable: false,
            };
          }
          return {
            success: false,
            error: `OpenCode Go API error ${response.status}: ${sanitizeMessage(text, accessToken)}`,
            retryable: isRetryableHttpStatus(response.status),
          };
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          return contractError(`body is not valid JSON: ${errorMessage(error, accessToken)}`);
        }
        return normalizeResponse(payload, accessToken);
      },
    });
  } catch (error) {
    return { success: false, error: errorMessage(error, accessToken), retryable: true };
  }
}

const OPENCODE_CONSOLE_GO_STATUS_URL = `${OPENCODE_CONSOLE_BASE_URL}/api/go/status`;

function asMicroCents(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeConsoleMeter(
  windowKey: OpenCodeGoWindowKey,
  meter: Record<string, unknown>,
  fallbackResetsAtIso: string | null,
): OpenCodeGoWindow | OpenCodeGoResult {
  const limit = asMicroCents(meter.limitMicroCents);
  const used = asMicroCents(meter.usedMicroCents);
  if (limit === null || used === null || limit < 0 || used < 0) {
    return contractError(`console ${windowKey} meter microcents are invalid`);
  }

  const percent =
    limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  const resetsAt = typeof meter.resetsAt === "string" && meter.resetsAt ? meter.resetsAt : fallbackResetsAtIso;
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) {
    return contractError(`console ${windowKey} resetsAt is missing or invalid`);
  }

  return {
    status: percent >= 100 ? "rate-limited" : "ok",
    usagePercent: percent,
    percentRemaining: 100 - percent,
    resetTimeIso: new Date(Date.parse(resetsAt)).toISOString(),
  };
}

/**
 * Read OpenCode Go subscription windows from the Console API.
 *
 * The Console tracks Go plan access (five-hour, weekly, and monthly meters)
 * for the member that owns the OAuth credential, so this works for fresh
 * accounts without any pre-2.0 workspace API key.
 */
export async function queryOpenCodeGoConsoleStatus(
  credential: { accessToken: string },
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeGoResult> {
  try {
    return await fetchWithTimeout(OPENCODE_CONSOLE_GO_STATUS_URL, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          Accept: "application/json",
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          // 404 on this member-scoped route is read as "no Go subscription".
          // 403 is kept ambiguous (it could be an access/permission issue on
          // the console side rather than a subscription state), so callers
          // fall back instead of showing a not-subscribed state.
          if (response.status === 404) {
            return {
              success: false,
              error: "OpenCode Go subscription not found for this console account (404)",
              notSubscribed: true,
            };
          }
          return {
            success: false,
            error: `OpenCode Console API error ${response.status} (/api/go/status)`,
            retryable: isRetryableHttpStatus(response.status),
          };
        }

        let payload: unknown;
        try {
          payload = JSON.parse(await response.text());
        } catch {
          return contractError("console response is not valid JSON");
        }
        const root = asRecord(payload);
        if (!root) return contractError("console root must be an object");

        const access = asRecord(root.access);
        if (!access) {
          return {
            success: false,
            error: "OpenCode Go subscription is not active",
            notSubscribed: true,
          };
        }

        const meters = asRecord(access.meters);
        if (!meters) return contractError("console access meters are missing");

        const endsAt = typeof access.endsAt === "string" ? access.endsAt : null;
        const normalized = {} as Record<OpenCodeGoWindowKey, OpenCodeGoWindow>;
        const meterByKey: Array<[OpenCodeGoWindowKey, string]> = [
          ["rolling", "fiveHour"],
          ["weekly", "week"],
          ["monthly", "month"],
        ];
        for (const [windowKey, meterKey] of meterByKey) {
          const meter = meters[meterKey];
          const meterRecord = asRecord(meter);
          if (!meterRecord) return contractError(`console ${meterKey} meter is missing`);
          const window = normalizeConsoleMeter(windowKey, meterRecord, endsAt);
          if ("success" in window) return window;
          normalized[windowKey] = window;
        }

        return { success: true, rolling: normalized.rolling, weekly: normalized.weekly, monthly: normalized.monthly };
      },
    });
  } catch (error) {
    return { success: false, error: errorMessage(error, credential.accessToken), retryable: true };
  }
}
