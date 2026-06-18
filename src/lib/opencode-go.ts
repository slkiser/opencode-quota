/**
 * OpenCode Go dashboard scraper.
 *
 * Fetches the OpenCode Go workspace page and parses usage data from two
 * possible formats:
 * 1. SolidJS SSR hydration output (`$R[\d+]={...usagePercent...resetInSec...}`)
 * 2. HTML with `data-slot` attributes (newer format)
 *
 * The scraper tries SolidJS SSR first, then falls back to data-slot parsing.
 */

import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import type { OpenCodeGoResult, OpenCodeGoWindow } from "./types.js";

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Regex patterns matching the SolidJS SSR hydration output.
 * Field order may vary, so we try both orderings.
 */
const SCRAPED_NUMBER_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`;

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

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

/**
 * Parse human-readable time strings like "1 hour 56 minutes", "6 days 2 hours", "26 days 17 hours"
 * into seconds.
 */
function parseHumanReadableTime(timeStr: string): number | null {
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, " ");
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) {
    return 0;
  }

  let totalSeconds = 0;

  // Match patterns like "X days", "X hours", "X minutes", "X seconds"
  const dayMatch = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hourMatch = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const minuteMatch = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const secondMatch = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  const hasDuration = Boolean(dayMatch || hourMatch || minuteMatch || secondMatch);

  if (dayMatch) totalSeconds += Number(dayMatch[1]) * 86400;
  if (hourMatch) totalSeconds += Number(hourMatch[1]) * 3600;
  if (minuteMatch) totalSeconds += Number(minuteMatch[1]) * 60;
  if (secondMatch) totalSeconds += Number(secondMatch[1]);

  return hasDuration ? totalSeconds : null;
}

/**
 * Parse the newer data-slot HTML format.
 * Returns a record of window names to their usage data.
 */
function parseDataSlotFormat(html: string): Partial<Record<string, ScrapedWindowUsage>> {
  const result: Partial<Record<string, ScrapedWindowUsage>> = {};

  const items = html.split(/data-slot="usage-item"/);

  for (let i = 1; i < items.length; i++) {
    const content = items[i];

    // Extract the label (Rolling Usage, Weekly Usage, Monthly Usage)
    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</);
    if (!labelMatch) continue;

    const label = labelMatch[1].trim().toLowerCase();

    // Extract usage percentage - get the number after data-slot="usage-value">
    const usageMatch = content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
    if (!usageMatch) continue;
    const usagePercent = Number(usageMatch[1]);

    // Extract reset time - get content between reset-time/reset-now and </span>
    const resetMatch = content.match(/data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/);
    if (!resetMatch) continue;

    // Clean up SolidJS comments and "Resets in" prefix
    const resetContent = resetMatch[2]
      .replace(/<!--\$-->/g, "")
      .replace(/<!--\/-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim();

    const resetInSec = resetMatch[1] === "reset-now" ? 0 : parseHumanReadableTime(resetContent);

    if (!Number.isFinite(usagePercent) || resetInSec === null || !Number.isFinite(resetInSec)) continue;

    // Map label to window key
    let windowKey: string | null = null;
    if (label.includes("rolling")) windowKey = "rolling";
    else if (label.includes("weekly")) windowKey = "weekly";
    else if (label.includes("monthly")) windowKey = "monthly";

    if (windowKey) {
      result[windowKey] = { usagePercent, resetInSec };
    }
  }

  return result;
}

function sanitizeMessage(text: string, maxLength = 120): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

function normalizeWindowUsage(window: ScrapedWindowUsage, now: number): OpenCodeGoWindow {
  const usagePercent = Math.max(0, window.usagePercent);
  const resetInSec = Math.max(0, window.resetInSec);

  return {
    usagePercent,
    resetInSec,
    percentRemaining: 100 - usagePercent,
    resetTimeIso: new Date(now + resetInSec * 1000).toISOString(),
  };
}

export async function queryOpenCodeGoQuota(
  workspaceId: string,
  authCookie: string,
  options: { requestTimeoutMs?: number } = {},
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
      options.requestTimeoutMs ?? SCRAPE_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `OpenCode Go dashboard error ${response.status}: ${sanitizeMessage(text)}`,
      };
    }

    const html = await response.text();

    // Try SolidJS SSR format first (more reliable when present)
    let rolling = parseWindowUsage(html, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST);
    let weekly = parseWindowUsage(html, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST);
    let monthly = parseWindowUsage(html, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST);

    // Fall back to data-slot HTML format if SSR found nothing
    if (!rolling && !weekly && !monthly) {
      const dataSlotResult = parseDataSlotFormat(html);
      rolling = dataSlotResult.rolling ?? null;
      weekly = dataSlotResult.weekly ?? null;
      monthly = dataSlotResult.monthly ?? null;
    }

    if (!rolling && !weekly && !monthly) {
      return {
        success: false,
        error:
          "Could not parse any known OpenCode Go dashboard usage windows (rollingUsage, weeklyUsage, monthlyUsage)",
      };
    }

    const now = Date.now();
    return {
      success: true,
      ...(rolling ? { rolling: normalizeWindowUsage(rolling, now) } : {}),
      ...(weekly ? { weekly: normalizeWindowUsage(weekly, now) } : {}),
      ...(monthly ? { monthly: normalizeWindowUsage(monthly, now) } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

export { parseWindowUsage as _parseWindowUsage, parseDataSlotFormat as _parseDataSlotFormat };
