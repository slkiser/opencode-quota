/**
 * OpenCode Zen billing page scraper.
 *
 * Fetches the OpenCode Zen billing page and parses balance, monthly limit,
 * and monthly usage from two possible formats:
 * 1. SolidJS SSR hydration output (`$R[\d+]={...balance...}`)
 * 2. HTML with `data-slot` attributes (fallback)
 *
 * The scraper tries SolidJS SSR first, then falls back to data-slot parsing.
 */

import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplayText } from "./display-sanitize.js";

const BILLING_URL_PREFIX = "https://opencode.ai/workspace/";
const BILLING_URL_SUFFIX = "/billing";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Micro-cents to dollars conversion factor.
 *
 * Based on OpenCode billing internals:
 * - 1 cent = 10_000 micro-cents (Stripe convention)
 * - 1 dollar = 100 cents = 1_000_000 micro-cents
 */
const MICRO_CENTS_PER_DOLLAR = 100_000_000;

// Extracts field:value pairs from SolidJS SSR billing data regardless of order.
const SSR_FIELD_RE = /\b(balance|monthlyLimit|monthlyUsage)\s*:\s*(\d+(?:\.\d+)?)\b/g;

export interface ScrapedBillingData {
  /** Balance in micro-cents */
  balance: number;
  /** Monthly limit in dollars, null if not set */
  monthlyLimit: number | null;
  /** Monthly usage in micro-cents, null if not available */
  monthlyUsage: number | null;
  /** Last payment amount in dollars, null if not available */
  lastPayment: number | null;
}

export type OpenCodeZenResult =
  | {
      success: true;
      data: ScrapedBillingData;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Try to extract billing data from SolidJS SSR hydration output.
 * Extracts all field:value pairs regardless of field order.
 */
function parseSsrBillingData(html: string): ScrapedBillingData | null {
  const fields: Record<string, number> = {};
  for (const match of html.matchAll(SSR_FIELD_RE)) {
    fields[match[1]] = Number(match[2]);
  }

  if (!Number.isFinite(fields.balance) || fields.balance < 0) return null;

  return {
    balance: fields.balance,
    monthlyLimit: Number.isFinite(fields.monthlyLimit) && fields.monthlyLimit >= 0 ? fields.monthlyLimit : null,
    monthlyUsage: Number.isFinite(fields.monthlyUsage) && fields.monthlyUsage >= 0 ? fields.monthlyUsage : null,
    lastPayment: null,
  };
}

/**
 * Parse the data-slot HTML format from the billing page.
 */
function parseDataSlotBillingData(html: string): ScrapedBillingData | null {
  let balance: number | null = null;
  let monthlyLimit: number | null = null;
  let monthlyUsage: number | null = null;

  // Split by data-slot items
  const items = html.split(/data-slot="billing-item"/);

  for (let i = 1; i < items.length; i++) {
    const content = items[i];

    // Extract label
    const labelMatch = content.match(/data-slot="billing-label">([^<]+)</);
    if (!labelMatch) continue;

    const label = labelMatch[1].trim().toLowerCase();

    // Extract value (dollar amount like "$42.50")
    const valueMatch = content.match(
      /data-slot="billing-value">[^$]*\$?(\d+(?:,\d{3})*(?:\.\d+)?)/,
    );
    if (!valueMatch) continue;

    const dollarAmount = parseFloat(valueMatch[1].replace(/,/g, ""));

    if (label.includes("balance")) {
      balance = dollarAmount * MICRO_CENTS_PER_DOLLAR;
    } else if (label.includes("monthly") && label.includes("limit")) {
      monthlyLimit = dollarAmount;
    } else if (label.includes("monthly") && label.includes("usage")) {
      monthlyUsage = dollarAmount * MICRO_CENTS_PER_DOLLAR;
    }
  }

  if (balance === null) return null;

  return { balance, monthlyLimit, monthlyUsage, lastPayment: null };
}

/**
 * Try to extract the first non-zero `"amount":N` from the page where
 * payment list data might appear in SolidStart SSR or inline JSON.
 * Matches multiple SSR serialization formats.
 */
function parseSsrPaymentData(html: string): number | null {
  // Try multiple SSR key formats
  const patterns = [
    /"payment\.list"\]\s*=\s*\[\s*\{[\s\S]*?"amount":\s*(\d+)/,
    /"payment\.list"\s*:\s*\[[\s\S]*?"amount":\s*(\d+)/,
    /__\$S\["payment\.list"\][\s\S]*?"amount":\s*(\d+)/,
  ];

  for (const re of patterns) {
    const match = re.exec(html);
    if (!match) continue;

    const amountMicroCents = Number(match[1]);
    if (Number.isFinite(amountMicroCents) && amountMicroCents > 0) {
      return amountMicroCents / MICRO_CENTS_PER_DOLLAR;
    }
  }

  return null;
}

/**
 * Try to extract the last (most recent) payment from the data-slot HTML format.
 * Looks for payment-amount cells, then returns the first non-refunded, non-zero
 * payment amount. Tries multiple table/attribute formats.
 */
function parseDataSlotPaymentData(html: string): number | null {
  // Try to find payment table by data-slot attribute
  const tableMatch = html.match(/<table[\s\S]*?data-slot="payments-table-element"[\s\S]*?<\/table>/i);
  const tableHtml = tableMatch?.[0] ?? html;

  // Find all payment-amount cells in the table/page
  const amountCellRe = /<td[\s\S]*?data-slot="payment-amount"([^>]*)>([\s\S]*?)<\/td>/gi;
  const amounts: number[] = [];

  for (const cellMatch of tableHtml.matchAll(amountCellRe)) {
    const attrs = cellMatch[1]!;
    const content = cellMatch[2]!;

    // Skip refunded
    if (/data-refunded="true"/.test(attrs)) continue;

    // Extract dollar amount from cell content
    const dollarMatch = content.match(/\$?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/);
    if (!dollarMatch) continue;

    const dollarAmount = parseFloat(dollarMatch[1].replace(/,/g, ""));
    if (dollarAmount > 0) {
      amounts.push(dollarAmount);
    }
  }

  return amounts.length > 0 ? amounts[0] : null;
}



function sanitizeMessage(text: string, maxLength = 120): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

export async function queryOpenCodeZenQuota(
  workspaceId: string,
  authCookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  try {
    const url = `${BILLING_URL_PREFIX}${encodeURIComponent(workspaceId)}${BILLING_URL_SUFFIX}`;

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
        error: `OpenCode Zen billing error ${response.status}: ${sanitizeMessage(text)}`,
      };
    }

    const html = await response.text();

    // Try SolidJS SSR format first
    let data = parseSsrBillingData(html);

    // Fall back to data-slot HTML format
    if (!data) {
      data = parseDataSlotBillingData(html);
    }

    if (!data) {
      return {
        success: false,
        error:
          "Could not parse OpenCode Zen billing data (balance, monthlyLimit, monthlyUsage) from the billing page",
      };
    }

    // Extract last payment amount as fallback monthly limit
    data.lastPayment =
      parseSsrPaymentData(html) ?? parseDataSlotPaymentData(html);

    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

// Exported for testing
export {
  parseSsrBillingData as _parseSsrBillingData,
  parseDataSlotBillingData as _parseDataSlotBillingData,
  parseSsrPaymentData as _parseSsrPaymentData,
  parseDataSlotPaymentData as _parseDataSlotPaymentData,
};
