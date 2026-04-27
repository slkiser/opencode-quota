/**
 * OpenCode Go dashboard scraper.
 *
 * Fetches the OpenCode Go workspace page and parses SolidJS SSR hydration
 * output for `rollingUsage`, `weeklyUsage`, and `monthlyUsage` containing
 * `usagePercent` and `resetInSec`.
 */

import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import type { OpenCodeGoResult } from "./types.js";

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Regex patterns matching the SolidJS SSR hydration output.
 * Field order may vary, so we try both orderings.
 */
const RE_ROLLING_PCT_FIRST =
  /rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:(\d+)[^}]*resetInSec:(\d+)[^}]*\}/;
const RE_ROLLING_RESET_FIRST =
  /rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:(\d+)[^}]*usagePercent:(\d+)[^}]*\}/;

const RE_WEEKLY_PCT_FIRST =
  /weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(\d+)[^}]*resetInSec:(\d+)[^}]*\}/;
const RE_WEEKLY_RESET_FIRST =
  /weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(\d+)[^}]*usagePercent:(\d+)[^}]*\}/;

const RE_MONTHLY_PCT_FIRST =
  /monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(\d+)[^}]*resetInSec:(\d+)[^}]*\}/;
const RE_MONTHLY_RESET_FIRST =
  /monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(\d+)[^}]*usagePercent:(\d+)[^}]*\}/;

interface ScrapedWindowUsage {
  usagePercent: number;
  resetInSec: number;
}

function parseWindowUsage(
  html: string,
  rePctFirst: RegExp,
  reResetFirst: RegExp,
): ScrapedWindowUsage | null {
  const pctFirstMatch = rePctFirst.exec(html);
  if (pctFirstMatch) {
    const usagePercent = Number(pctFirstMatch[1]);
    const resetInSec = Number(pctFirstMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  const resetFirstMatch = reResetFirst.exec(html);
  if (resetFirstMatch) {
    const resetInSec = Number(resetFirstMatch[1]);
    const usagePercent = Number(resetFirstMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  return null;
}

function sanitizeMessage(text: string, maxLength = 120): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

export async function queryOpenCodeGoQuota(
  workspaceId: string,
  authCookie: string,
): Promise<OpenCodeGoResult> {
  try {
    const url = `${DASHBOARD_URL_PREFIX}${encodeURIComponent(workspaceId)}${DASHBOARD_URL_SUFFIX}`;

    const response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html",
          Cookie: `auth=${authCookie}`,
        },
      },
      SCRAPE_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `OpenCode Go dashboard error ${response.status}: ${sanitizeMessage(text)}`,
      };
    }

    const html = await response.text();
    const rolling = parseWindowUsage(html, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST);
    const weekly = parseWindowUsage(html, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST);
    const monthly = parseWindowUsage(html, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST);

    if (!rolling || !weekly || !monthly) {
      const missing: string[] = [];
      if (!rolling) missing.push("rollingUsage");
      if (!weekly) missing.push("weeklyUsage");
      if (!monthly) missing.push("monthlyUsage");
      return {
        success: false,
        error: `Could not parse ${missing.join(", ")} from OpenCode Go dashboard`,
      };
    }

    const now = Date.now();

    const rollingUsagePercent = Math.max(0, rolling.usagePercent);
    const weeklyUsagePercent = Math.max(0, weekly.usagePercent);
    const monthlyUsagePercent = Math.max(0, monthly.usagePercent);

    return {
      success: true,
      rolling: {
        usagePercent: rollingUsagePercent,
        resetInSec: Math.max(0, rolling.resetInSec),
        percentRemaining: 100 - rollingUsagePercent,
        resetTimeIso: new Date(now + Math.max(0, rolling.resetInSec) * 1000).toISOString(),
      },
      weekly: {
        usagePercent: weeklyUsagePercent,
        resetInSec: Math.max(0, weekly.resetInSec),
        percentRemaining: 100 - weeklyUsagePercent,
        resetTimeIso: new Date(now + Math.max(0, weekly.resetInSec) * 1000).toISOString(),
      },
      monthly: {
        usagePercent: monthlyUsagePercent,
        resetInSec: Math.max(0, monthly.resetInSec),
        percentRemaining: 100 - monthlyUsagePercent,
        resetTimeIso: new Date(now + Math.max(0, monthly.resetInSec) * 1000).toISOString(),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

export { parseWindowUsage as _parseWindowUsage };
