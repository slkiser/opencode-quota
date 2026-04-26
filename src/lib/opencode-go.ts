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
 * Regex patterns matching the SolidJS SSR hydration output and general JSON-like objects.
 * We use a "strategy" approach: first look for SolidJS markers, then fuzzy match objects.
 */
const RE_STRATEGY_HYDRATION =
  /monthlyUsage[:\s]*\$R(?:[:\d\[\]]*)\s*=\s*\{.*?["']?usagePercent["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?.*?["']?resetInSec["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?.*?\}/i;
const RE_STRATEGY_HYDRATION_REVERSE =
  /monthlyUsage[:\s]*\$R(?:[:\d\[\]]*)\s*=\s*\{.*?["']?resetInSec["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?.*?["']?usagePercent["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?.*?\}/i;
const RE_STRATEGY_FUZZY_OBJECT =
  /\{.*?["']?usagePercent["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?.*?["']?resetInSec["']?\s*:\s*["']?(\d+(?:\.\d+)?)["']?.*?\}/i;

interface ScrapedMonthlyUsage {
  usagePercent: number;
  resetInSec: number;
}

function parseMonthlyUsage(html: string): ScrapedMonthlyUsage | null {
  // Strategy 1: Standard or slightly varied SolidJS hydration
  const hydrationMatch = RE_STRATEGY_HYDRATION.exec(html);
  if (hydrationMatch) {
    const usagePercent = Number(hydrationMatch[1]);
    const resetInSec = Number(hydrationMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  const hydrationReverseMatch = RE_STRATEGY_HYDRATION_REVERSE.exec(html);
  if (hydrationReverseMatch) {
    const resetInSec = Number(hydrationReverseMatch[1]);
    const usagePercent = Number(hydrationReverseMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  // Strategy 2: Fuzzy JSON-like object match (backup)
  const fuzzyMatch = RE_STRATEGY_FUZZY_OBJECT.exec(html);
  if (fuzzyMatch) {
    const usagePercent = Number(fuzzyMatch[1]);
    const resetInSec = Number(fuzzyMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  return null;
}

/**
 * Extracts a masked snippet of the HTML for diagnostics.
 */
function getMaskedHtmlSnippet(html: string, maxLength = 200): string {
  // Find "monthlyUsage" or "usagePercent" to center the snippet
  const index =
    html.indexOf("monthlyUsage") !== -1
      ? html.indexOf("monthlyUsage")
      : html.indexOf("usagePercent");

  let snippet: string;
  if (index === -1) {
    // If not found, just take the first part of the HTML to see what we're looking at
    snippet = `[Keys not found. Start of HTML]: ${html.slice(0, maxLength)}`;
  } else {
    const start = Math.max(0, index - 50);
    const end = Math.min(html.length, start + maxLength);
    snippet = html.slice(start, end);
  }

  // Mask digits and potential email-like patterns
  return snippet
    .replace(/\d+/g, "***")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]")
    .replace(/\s+/g, " ")
    .trim();
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
    // If workspaceId is a full URL, strip the prefix and suffix to get just the ID.
    // e.g. https://opencode.ai/workspace/wrk_123/go -> wrk_123
    let normalizedId = workspaceId.trim();
    if (normalizedId.includes("://")) {
      const match = normalizedId.match(/\/workspace\/([^\/]+)/);
      if (match) {
        normalizedId = match[1];
      }
    }

    const url = `${DASHBOARD_URL_PREFIX}${encodeURIComponent(normalizedId)}${DASHBOARD_URL_SUFFIX}`;

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
      const snippet = getMaskedHtmlSnippet(html);
      const maskedUrl = url.replace(workspaceId, "REDACTED");
      return {
        success: false,
        error: `Could not parse monthly usage from dashboard. Status: ${response.status}. URL: ${maskedUrl}. Snippet: ${snippet} (v3.3.2-diag)`,
      };
    }

    const usagePercent = Math.max(0, monthly.usagePercent);
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
