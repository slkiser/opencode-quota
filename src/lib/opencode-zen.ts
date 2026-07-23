import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

const BILLING_URL_PREFIX = "https://opencode.ai/workspace/";
const BILLING_URL_SUFFIX = "/billing";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Conversion used by the OpenCode billing-page values in PR #140.
 * The source represents one US dollar as 100,000,000 billing units.
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

const SSR_FIELD_RE = /\b(balance|monthlyLimit|monthlyUsage)\s*:\s*(\d+(?:\.\d+)?)\b/g;

export interface OpenCodeZenBillingData {
  balance: number;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  lastPayment: number | null;
}

export type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData }
  | { success: false; error: string };

function parseSsrBillingData(html: string): OpenCodeZenBillingData | null {
  const fields: Record<string, number> = {};
  for (const match of html.matchAll(SSR_FIELD_RE)) {
    fields[match[1]] = Number(match[2]);
  }

  if (!Number.isFinite(fields.balance) || fields.balance < 0) return null;

  return {
    balance: fields.balance,
    monthlyLimit:
      Number.isFinite(fields.monthlyLimit) && fields.monthlyLimit >= 0 ? fields.monthlyLimit : null,
    monthlyUsage:
      Number.isFinite(fields.monthlyUsage) && fields.monthlyUsage >= 0 ? fields.monthlyUsage : null,
    lastPayment: null,
  };
}

function parseDataSlotBillingData(html: string): OpenCodeZenBillingData | null {
  let balance: number | null = null;
  let monthlyLimit: number | null = null;
  let monthlyUsage: number | null = null;

  const items = html.split(/data-slot="billing-item"/);
  for (let index = 1; index < items.length; index++) {
    const content = items[index];
    const labelMatch = content.match(/data-slot="billing-label">([^<]+)</);
    if (!labelMatch) continue;

    const valueMatch = content.match(
      /data-slot="billing-value">[^$]*\$?(\d+(?:,\d{3})*(?:\.\d+)?)/,
    );
    if (!valueMatch) continue;

    const dollarAmount = Number.parseFloat(valueMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(dollarAmount) || dollarAmount < 0) continue;

    const label = labelMatch[1].trim().toLowerCase();
    if (label.includes("balance")) {
      balance = dollarAmount * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    } else if (label.includes("monthly") && label.includes("limit")) {
      monthlyLimit = dollarAmount;
    } else if (label.includes("monthly") && label.includes("usage")) {
      monthlyUsage = dollarAmount * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    }
  }

  if (balance === null) return null;
  return { balance, monthlyLimit, monthlyUsage, lastPayment: null };
}

function parseSsrPaymentData(html: string): number | null {
  const patterns = [
    /"payment\.list"\]\s*=\s*\[\s*\{[\s\S]*?"amount":\s*(\d+)/,
    /"payment\.list"\s*:\s*\[[\s\S]*?"amount":\s*(\d+)/,
    /__\$S\["payment\.list"\][\s\S]*?"amount":\s*(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;

    const amount = Number(match[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return amount / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    }
  }

  return null;
}

function parseDataSlotPaymentData(html: string): number | null {
  const tableMatch = html.match(
    /<table[\s\S]*?data-slot="payments-table-element"[\s\S]*?<\/table>/i,
  );
  const tableHtml = tableMatch?.[0] ?? html;
  const amountCellRe = /<td[\s\S]*?data-slot="payment-amount"([^>]*)>([\s\S]*?)<\/td>/gi;

  for (const match of tableHtml.matchAll(amountCellRe)) {
    if (/data-refunded="true"/.test(match[1])) continue;

    const dollarMatch = match[2].match(/\$?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/);
    if (!dollarMatch) continue;

    const amount = Number.parseFloat(dollarMatch[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) return amount;
  }

  return null;
}

function sanitizeMessage(text: string, secrets: string[] = [], maxLength = 120): string {
  let sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return (sanitized || "unknown").slice(0, maxLength);
}

export async function queryOpenCodeZenQuota(
  workspaceId: string,
  authCookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  try {
    const url = `${BILLING_URL_PREFIX}${encodeURIComponent(workspaceId)}${BILLING_URL_SUFFIX}`;
    return await fetchWithTimeout(url, {
      request: {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html",
          Cookie: `auth=${authCookie}`,
        },
      },
      timeoutMs: options.requestTimeoutMs ?? SCRAPE_TIMEOUT_MS,
      consume: async (response) => {
        if (!response.ok) {
          return {
            success: false,
            error: `OpenCode Zen billing error ${response.status}`,
          };
        }

        const html = await response.text();
        const data = parseSsrBillingData(html) ?? parseDataSlotBillingData(html);
        if (!data) {
          return {
            success: false,
            error:
              "Could not parse OpenCode Zen billing data (balance, monthlyLimit, monthlyUsage) from the billing page",
          };
        }

        data.lastPayment = parseSsrPaymentData(html) ?? parseDataSlotPaymentData(html);
        return { success: true, data };
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), [
        authCookie,
        workspaceId,
      ]),
    };
  }
}

export {
  parseDataSlotBillingData as _parseDataSlotBillingData,
  parseDataSlotPaymentData as _parseDataSlotPaymentData,
  parseSsrBillingData as _parseSsrBillingData,
  parseSsrPaymentData as _parseSsrPaymentData,
};
