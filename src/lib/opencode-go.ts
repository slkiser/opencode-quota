import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
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

  return {
    status: window.status as "ok" | "rate-limited",
    usagePercent: percent,
    percentRemaining: 100 - percent,
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
