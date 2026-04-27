/**
 * OpenCode Go dashboard scraper.
 *
 * Fetches the OpenCode Go workspace page and parses SolidJS SSR hydration
 * output for rolling, weekly, and monthly usage.
 */

import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import type { OpenCodeGoResult } from "./types.js";

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

const SCRAPE_TIMEOUT_MS = 10_000;

interface ScrapedUsage {
  usagePercent: number;
  resetInSec: number;
}

/**
 * Parses usage data (usagePercent and resetInSec) for a specific key from the HTML.
 *
 * This version uses a strict anchor approach to ignore unrelated scalar properties
 * (like billing metadata) and isolates the correct hydration object.
 */
function parseUsage(html: string, key: string): ScrapedUsage | null {
  // Strategy 1: Strict Anchor Matching
  // Find occurrences of the key that are part of a SolidJS hydration assignment
  // e.g. weeklyUsage:$R[32]={...}
  const anchorRegex = new RegExp(`${key}[:\\s]*\\$R(?:[:\\d\\[\\]]*)[:\\s]*=`, "gi");
  const keyMatches = Array.from(html.matchAll(anchorRegex));

  for (const match of keyMatches) {
    const keyIndex = match.index!;

    // Find the first '{' after this anchor
    const startBraceIndex = html.indexOf("{", keyIndex);
    if (startBraceIndex === -1 || startBraceIndex - keyIndex > 100) continue;

    // Isolate the object string with string-aware brace matching
    let endBraceIndex = -1;
    let depth = 0;
    let inString: string | null = null;
    let isEscaped = false;

    for (let i = startBraceIndex; i < html.length; i++) {
      const char = html[i];

      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (inString) {
        if (char === inString) {
          inString = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = char;
        continue;
      }

      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          endBraceIndex = i;
          break;
        }
      }

      // Safety break if we're scanning too much (e.g. 5KB per object)
      if (i - startBraceIndex > 5000) break;
    }

    if (endBraceIndex === -1) continue;

    const objectText = html.slice(startBraceIndex, endBraceIndex + 1);

    // Extract fields using robust regexes that handle quotes and spacing
    const RE_VAL = /:\s*["']?(\d+(?:\.\d+)?)["']?/;
    const usageMatch = new RegExp(`["']?usagePercent["']?${RE_VAL.source}`, "i").exec(objectText);
    const resetMatch = new RegExp(`["']?resetInSec["']?${RE_VAL.source}`, "i").exec(objectText);

    if (usageMatch && resetMatch) {
      const usagePercent = Number(usageMatch[1]);
      const resetInSec = Number(resetMatch[1]);
      if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
        return { usagePercent, resetInSec };
      }
    }
  }

  // Strategy 2: Loose Fallback
  // If no strict anchor found, try a looser search but still isolate the object.
  // This handles cases where the dashboard might change its hydration pattern.
  const looseMatches = Array.from(html.matchAll(new RegExp(`["']?${key}["']?[:\\s]*`, "gi")));
  for (const match of looseMatches) {
    const keyIndex = match.index!;
    const startBraceIndex = html.indexOf("{", keyIndex);
    if (startBraceIndex === -1 || startBraceIndex - keyIndex > 50) continue;

    // Isolate and parse as above
    let endBraceIndex = -1;
    let depth = 0;
    for (let i = startBraceIndex; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") {
        depth--;
        if (depth === 0) {
          endBraceIndex = i;
          break;
        }
      }
    }
    if (endBraceIndex === -1) continue;
    const objectText = html.slice(startBraceIndex, endBraceIndex + 1);
    const RE_VAL = /:\s*["']?(\d+(?:\.\d+)?)["']?/;
    const usageMatch = new RegExp(`["']?usagePercent["']?${RE_VAL.source}`, "i").exec(objectText);
    const resetMatch = new RegExp(`["']?resetInSec["']?${RE_VAL.source}`, "i").exec(objectText);
    if (usageMatch && resetMatch) {
      const usagePercent = Number(usageMatch[1]);
      const resetInSec = Number(resetMatch[1]);
      if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
        return { usagePercent, resetInSec };
      }
    }
  }

  return null;
}

/**
 * Extracts a masked snippet of the HTML for diagnostics.
 */
function getMaskedHtmlSnippet(html: string, maxLength = 200): string {
  // Find "rollingUsage", "weeklyUsage", "monthlyUsage" or "usagePercent" to center the snippet
  const keys = ["rollingUsage", "weeklyUsage", "monthlyUsage", "usagePercent"];
  let index = -1;
  for (const key of keys) {
    const found = html.indexOf(key);
    if (found !== -1) {
      index = found;
      break;
    }
  }

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
    const rolling = parseUsage(html, "rollingUsage");
    const weekly = parseUsage(html, "weeklyUsage");
    const monthly = parseUsage(html, "monthlyUsage");

    if (!rolling || !weekly || !monthly) {
      const snippet = getMaskedHtmlSnippet(html);
      const maskedUrl = url.replace(workspaceId, "REDACTED");
      const missing = [!rolling && "rolling", !weekly && "weekly", !monthly && "monthly"]
        .filter(Boolean)
        .join(", ");

      return {
        success: false,
        error: `Could not parse ${missing} usage from dashboard. Status: ${response.status}. URL: ${maskedUrl}. Snippet: ${snippet} (v3.4.0-diag)`,
      };
    }

    const now = Date.now();

    return {
      success: true,
      rolling: {
        usagePercent: Math.max(0, rolling.usagePercent),
        resetInSec: Math.max(0, rolling.resetInSec),
        percentRemaining: Math.max(0, 100 - rolling.usagePercent),
        resetTimeIso: new Date(now + Math.max(0, rolling.resetInSec) * 1000).toISOString(),
      },
      weekly: {
        usagePercent: Math.max(0, weekly.usagePercent),
        resetInSec: Math.max(0, weekly.resetInSec),
        percentRemaining: Math.max(0, 100 - weekly.usagePercent),
        resetTimeIso: new Date(now + Math.max(0, weekly.resetInSec) * 1000).toISOString(),
      },
      monthly: {
        usagePercent: Math.max(0, monthly.usagePercent),
        resetInSec: Math.max(0, monthly.resetInSec),
        percentRemaining: Math.max(0, 100 - monthly.usagePercent),
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

export { parseUsage as _parseUsage };
