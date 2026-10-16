import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { asRecord } from "./json-guards.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  type OpenCodeConsoleCredential,
} from "./opencode-console-auth.js";
import type { OpenCodeGoResult, OpenCodeGoWindow, OpenCodeGoWindowKey } from "./types.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const CONSOLE_METER_KEYS: Record<OpenCodeGoWindowKey, string> = {
  rolling: "fiveHour",
  weekly: "week",
  monthly: "month",
};
const OFFSET_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Redact the token, strip control characters, collapse whitespace, cap at 120 characters. */
function sanitizeMessage(text: string, accessToken: string): string {
  const redacted = accessToken ? text.replaceAll(accessToken, "[redacted]") : text;
  const sanitized = sanitizeDisplayText(redacted).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, 120);
}

function errorMessage(error: unknown, accessToken: string): string {
  return sanitizeMessage(error instanceof Error ? error.message : String(error), accessToken);
}

function contractError(message: string): OpenCodeGoResult {
  return { success: false, error: `Invalid OpenCode Go API response: ${message}` };
}

/** A real calendar date and time with `Z` or a `±HH:MM` offset. */
function isValidOffsetIsoTimestamp(value: string): boolean {
  const match = OFFSET_ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
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
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

/** All three windows in order; the first invalid window fails the whole response. */
function normalizeWindows(
  normalize: (windowKey: OpenCodeGoWindowKey) => OpenCodeGoWindow | OpenCodeGoResult,
): OpenCodeGoResult {
  const windows = {} as Record<OpenCodeGoWindowKey, OpenCodeGoWindow>;
  for (const windowKey of OPENCODE_GO_WINDOW_ORDER) {
    const window = normalize(windowKey);
    if ("success" in window) return window;
    windows[windowKey] = window;
  }
  return {
    success: true,
    rolling: windows.rolling,
    weekly: windows.weekly,
    monthly: windows.monthly,
  };
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

  const exhausted = window.status === "rate-limited";
  return {
    status: window.status,
    usagePercent: exhausted ? 100 : percent,
    percentRemaining: exhausted ? 0 : 100 - percent,
    resetTimeIso: new Date(Date.parse(resetsAt)).toISOString(),
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
            };
          }
          if (isNotSubscribedResponse(response.status, text)) {
            return {
              success: false,
              error: "OpenCode Go not subscribed (403 EntitlementError)",
              notSubscribed: true,
            };
          }
          return {
            success: false,
            error: `OpenCode Go API error ${response.status}: ${sanitizeMessage(text, accessToken)}`,
          };
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          return contractError(`body is not valid JSON: ${errorMessage(error, accessToken)}`);
        }
        const root = asRecord(payload);
        if (!root) return contractError("root must be an object");
        const usage = asRecord(root.usage);
        if (!usage) return contractError("usage must be an object");
        return normalizeWindows((windowKey) =>
          normalizeWindow(windowKey, usage[windowKey], accessToken),
        );
      },
    });
  } catch (error) {
    return { success: false, error: errorMessage(error, accessToken) };
  }
}

function asMicroCents(value: unknown): number | null {
  const parsed =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
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
    limit === 0
      ? used > 0
        ? 100
        : 0
      : Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  const resetsAt =
    typeof meter.resetsAt === "string" && meter.resetsAt ? meter.resetsAt : fallbackResetsAtIso;
  const resetTime = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(resetTime)) {
    return contractError(`console ${windowKey} resetsAt is missing or invalid`);
  }

  return {
    status: percent >= 100 ? "rate-limited" : "ok",
    usagePercent: percent,
    percentRemaining: 100 - percent,
    resetTimeIso: new Date(resetTime).toISOString(),
  };
}

/**
 * Read OpenCode Go subscription windows from the Console API.
 *
 * The Console tracks Go plan access (five-hour, weekly, and monthly meters)
 * for the member that owns the OAuth credential, so this works for fresh
 * accounts without any pre-2.0 workspace API key. The request goes to the
 * login's Console server, scoped to the login's org when it has one.
 */
export async function queryOpenCodeGoConsoleStatus(
  credential: OpenCodeConsoleCredential,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeGoResult> {
  try {
    return await fetchWithTimeout(`${consoleBaseUrl(credential)}/api/go/status`, {
      request: {
        method: "GET",
        headers: consoleHeaders(credential),
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
        return normalizeWindows((windowKey) => {
          const meterKey = CONSOLE_METER_KEYS[windowKey];
          const meter = asRecord(meters[meterKey]);
          if (!meter) return contractError(`console ${meterKey} meter is missing`);
          return normalizeConsoleMeter(windowKey, meter, endsAt);
        });
      },
    });
  } catch (error) {
    return { success: false, error: errorMessage(error, credential.accessToken) };
  }
}
