import { fetchWithTimeout } from "./http.js";

const CONSOLE_BASE_URL = "https://opencode.ai/console";
const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Conversion used by the OpenCode Console billing APIs.
 * The source represents one US dollar as 100,000,000 microcents.
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

export interface OpenCodeZenBillingData {
  balance: number;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  lastPayment: number | null;
  reload: boolean;
  reloadAmount: number | null;
  reloadTrigger: number | null;
}

export type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData }
  | { success: false; error: string };

export interface OpenCodeConsoleQuotaAuth {
  accessToken: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asMicroCents(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asDollars(microCents: number | null): number | null {
  return microCents === null ? null : microCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
}

function currentMonthStartDate(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

type ConsoleJsonResponse =
  | { ok: true; json: unknown }
  | { ok: false; error: string };

async function getConsoleJson(
  path: string,
  accessToken: string,
  timeoutMs: number,
): Promise<ConsoleJsonResponse> {
  try {
    return await fetchWithTimeout<ConsoleJsonResponse>(`${CONSOLE_BASE_URL}${path}`, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      timeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          return { ok: false, error: `OpenCode Console API error ${response.status} (${path})` };
        }
        let json: unknown = null;
        try {
          json = JSON.parse(await response.text());
        } catch {
          json = null;
        }
        return { ok: true, json };
      },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function contractError(path: string): { success: false; error: string } {
  return {
    success: false,
    error: `Could not parse OpenCode Console response (${path})`,
  };
}

export async function queryOpenCodeZenQuota(
  auth: { accessToken: string },
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  const timeoutMs = options.requestTimeoutMs ?? SCRAPE_TIMEOUT_MS;

  const statusResponse = await getConsoleJson("/api/billing/status", auth.accessToken, timeoutMs);
  if (!statusResponse.ok) return { success: false, error: statusResponse.error };
  const status = asRecord(statusResponse.json);
  const balanceMicroCents = status ? asMicroCents(status.balanceMicroCents) : null;
  if (status === null || balanceMicroCents === null || balanceMicroCents < 0) {
    return contractError("/api/billing/status");
  }

  const accountResponse = await getConsoleJson("/api/billing/account", auth.accessToken, timeoutMs);
  const account = accountResponse.ok ? asRecord(accountResponse.json) : null;
  const creditLimitMicroCents = account ? asMicroCents(account.creditLimitMicroCents) : null;

  const autoRechargeResponse = await getConsoleJson(
    "/api/billing/auto-recharge",
    auth.accessToken,
    timeoutMs,
  );
  const autoRecharge = autoRechargeResponse.ok ? asRecord(autoRechargeResponse.json) : null;
  const rechargeEnabled = autoRecharge?.enabled === true;
  const rechargeAmount =
    rechargeEnabled && typeof autoRecharge?.rechargeAmountDollars === "number"
      ? autoRecharge.rechargeAmountDollars
      : null;
  const rechargeTrigger =
    rechargeEnabled && typeof autoRecharge?.thresholdDollars === "number"
      ? autoRecharge.thresholdDollars
      : null;

  let monthlyUsageMicroCents: number | null = null;
  const costByDayResponse = await getConsoleJson("/api/usage/cost-by-day", auth.accessToken, timeoutMs);
  if (!costByDayResponse.ok) return { success: false, error: costByDayResponse.error };
  if (Array.isArray(costByDayResponse.json)) {
    const monthStart = currentMonthStartDate();
    let sum = 0;
    let seen = false;
    for (const entry of costByDayResponse.json) {
      const record = asRecord(entry);
      const day = typeof record?.date === "string" ? record.date : "";
      if (!day || day < monthStart) continue;
      const cost = asMicroCents(record?.totalCostMicroCents);
      if (cost === null) continue;
      sum += cost;
      seen = true;
    }
    if (seen) monthlyUsageMicroCents = sum;
  }

  return {
    success: true,
    data: {
      balance: balanceMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      monthlyLimit:
        creditLimitMicroCents === null || creditLimitMicroCents < 0
          ? null
          : creditLimitMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      monthlyUsage:
        monthlyUsageMicroCents === null
          ? null
          : monthlyUsageMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      lastPayment: null,
      reload: rechargeEnabled,
      reloadAmount: rechargeAmount,
      reloadTrigger: rechargeTrigger,
    },
  };
}