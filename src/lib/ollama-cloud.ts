/**
 * Ollama Cloud settings page scraper.
 *
 * Fetches the Ollama Cloud settings page and parses the HTML for session
 * and weekly usage percentages, plan tier, and reset times from the
 * `data-usage-track` aria-labels, `usage-meter__fill` style attributes,
 * and `.local-time` data-time attributes.
 */

import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplaySnippet, sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { OllamaCloudResult } from "./types.js";

const SETTINGS_URL = "https://ollama.com/settings";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

const SCRAPE_TIMEOUT_MS = 10_000;

const USAGE_PERCENT_RE = /(\d+(?:\.\d+)?)%\s*used/;
const WIDTH_PERCENT_RE = /(?:^|;)\s*width\s*:\s*([0-9.]+)%/;
const DATA_USAGE_TRACK_RE = /<[^>]*\bdata-usage-track\b[^>]*>/gs;
const LOCAL_TIME_RE = /class="[^"]*local-time[^"]*"[^>]*data-time="([^"]*)"/gs;
const PLAN_TIER_RE = /class="[^"]*capitalize[^"]*"[^>]*>([^<]*)</;

interface ScrapedUsage {
  usagePercent: number;
  resetTimeIso: string;
}

function extractUsagePercentFromTrack(trackHtml: string): number | null {
  const ariaMatch = trackHtml.match(USAGE_PERCENT_RE);
  if (ariaMatch) {
    const pct = Number(ariaMatch[1]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      return pct;
    }
  }

  const styleMatch = trackHtml.match(/style="([^"]*)"/);
  if (styleMatch) {
    const widthMatch = styleMatch[1].match(WIDTH_PERCENT_RE);
    if (widthMatch) {
      const pct = Number(widthMatch[1]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        return pct;
      }
    }
  }

  return null;
}

function extractResetTimes(html: string): string[] {
  const times: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(LOCAL_TIME_RE.source, LOCAL_TIME_RE.flags);
  while ((match = re.exec(html)) !== null) {
    times.push(match[1]);
  }
  return times;
}

function extractPlanTier(html: string): string | null {
  const match = html.match(PLAN_TIER_RE);
  return match ? match[1].trim() : null;
}

function sanitizeMessage(text: string, maxLength = 200): string {
  const sanitized = sanitizeSingleLineDisplayText(text);
  return (sanitized || "unknown").slice(0, maxLength);
}

const COOKIE_NAME_PREFIX = "__Secure-session=";

function normalizeCookie(raw: string): string {
  let value = raw.trim();
  if (value.startsWith(COOKIE_NAME_PREFIX)) value = value.slice(COOKIE_NAME_PREFIX.length);
  return value;
}

export async function queryOllamaCloudQuota(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<OllamaCloudResult> {
  if (cookie.includes("\r") || cookie.includes("\n")) {
    return {
      success: false,
      error: "Cookie contains invalid CRLF characters",
    };
  }

  try {
    const response = await fetchWithTimeout(
      SETTINGS_URL,
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html",
          Cookie: `${COOKIE_NAME_PREFIX}${normalizeCookie(cookie)}`,
        },
        redirect: "manual",
      },
      options.requestTimeoutMs ?? SCRAPE_TIMEOUT_MS,
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") || "";
      return {
        success: false,
        error: `Authentication error: redirected to ${sanitizeMessage(location, 80)} — cookie may be expired`,
      };
    }

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Ollama Cloud settings error ${response.status}: ${sanitizeMessage(text)}`,
      };
    }

    const html = await response.text();

    const planTier = extractPlanTier(html);

    const tracks: string[] = [];
    let trackMatch: RegExpExecArray | null;
    const trackRe = new RegExp(DATA_USAGE_TRACK_RE.source, DATA_USAGE_TRACK_RE.flags);
    while ((trackMatch = trackRe.exec(html)) !== null) {
      tracks.push(trackMatch[0]);
    }

    if (tracks.length === 0) {
      return {
        success: false,
        error: "Could not parse usage tracks from Ollama Cloud settings page (found 0)",
      };
    }

    const sessionPercent = tracks[0] ? extractUsagePercentFromTrack(tracks[0]) : null;
    const weeklyPercent = tracks[1] ? extractUsagePercentFromTrack(tracks[1]) : null;

    if (sessionPercent === null && weeklyPercent === null) {
      return {
        success: false,
        error: "Could not extract any usage percentages from Ollama Cloud settings page",
      };
    }

    const resetTimes = extractResetTimes(html);
    const sessionResetsAt = resetTimes[0] || undefined;
    const weeklyResetsAt = resetTimes[1] || undefined;

    return {
      success: true,
      ...(sessionPercent !== null
        ? {
            session: {
              usagePercent: sessionPercent,
              percentRemaining: 100 - sessionPercent,
              resetTimeIso: sessionResetsAt,
            },
          }
        : {}),
      ...(weeklyPercent !== null
        ? {
            weekly: {
              usagePercent: weeklyPercent,
              percentRemaining: 100 - weeklyPercent,
              resetTimeIso: weeklyResetsAt,
            },
          }
        : {}),
      ...(planTier ? { planTier } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

export { extractUsagePercentFromTrack as _extractUsagePercentFromTrack, extractResetTimes as _extractResetTimes, extractPlanTier as _extractPlanTier };
