/**
 * OpenCode Go dashboard scraper.
 *
 * Fetches the OpenCode Go workspace page and parses SolidJS SSR hydration
 * output for `monthlyUsage` containing `usagePercent` and `resetInSec`.
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
const RE_MONTHLY_PCT_FIRST =
  /monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(\d+)[^}]*resetInSec:(\d+)[^}]*\}/;
const RE_MONTHLY_RESET_FIRST =
  /monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(\d+)[^}]*usagePercent:(\d+)[^}]*\}/;

interface ScrapedMonthlyUsage {
  usagePercent: number;
  resetInSec: number;
}

function parseMonthlyUsage(html: string): ScrapedMonthlyUsage | null {
  const pctFirstMatch = RE_MONTHLY_PCT_FIRST.exec(html);
  if (pctFirstMatch) {
    const usagePercent = Number(pctFirstMatch[1]);
    const resetInSec = Number(pctFirstMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  const resetFirstMatch = RE_MONTHLY_RESET_FIRST.exec(html);
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
    const monthly = parseMonthlyUsage(html);

    if (!monthly) {
      return {
        success: false,
        error: "Could not parse monthly usage from OpenCode Go dashboard",
      };
    }

    const usagePercent = Math.max(0, Math.min(100, monthly.usagePercent));
    const percentRemaining = 100 - usagePercent;
    const resetInSec = Math.max(0, monthly.resetInSec);
    const resetTimeIso = new Date(Date.now() + resetInSec * 1000).toISOString();

    return {
      success: true,
      usagePercent,
      resetInSec,
      percentRemaining,
      resetTimeIso,
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

export { parseMonthlyUsage as _parseMonthlyUsage };
