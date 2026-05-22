/**
 * Anthropic Enterprise quota queries.
 *
 * Queries the claude.ai web API for Enterprise usage-based plan data:
 * - Organization-level monthly spend usage
 * - Per-user/group monthly spend limits
 */

import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplayText } from "./display-sanitize.js";

const CLAUDE_AI_BASE_URL = "https://claude.ai/api";

export interface AnthropicEnterpriseUsage {
  isEnabled: boolean;
  monthlyLimitUsd: number;
  usedCreditsUsd: number;
  utilization: number;
  currency: string;
}

export interface AnthropicEnterpriseUserLimit {
  isEnabled: boolean;
  monthlyLimitUsd: number;
  usedCreditsUsd: number;
  accountName: string | null;
  groupName: string | null;
  period: string;
  currency: string;
}

export interface AnthropicEnterpriseQuotaResult {
  success: true;
  orgUsage: AnthropicEnterpriseUsage | null;
  userLimit: AnthropicEnterpriseUserLimit | null;
}

export interface AnthropicEnterpriseQuotaError {
  success: false;
  error: string;
}

export type AnthropicEnterpriseResult =
  | AnthropicEnterpriseQuotaResult
  | AnthropicEnterpriseQuotaError;

export interface AnthropicEnterpriseQueryOptions {
  orgId: string;
  sessionKey: string;
  accountId?: string;
  requestTimeoutMs?: number;
}

function buildHeaders(sessionKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `sessionKey=${sessionKey}`,
    "anthropic-client-platform": "web_claude_ai",
  };
}

async function fetchOrgUsage(
  orgId: string,
  sessionKey: string,
  requestTimeoutMs?: number,
): Promise<AnthropicEnterpriseUsage | null> {
  const url = `${CLAUDE_AI_BASE_URL}/organizations/${orgId}/usage`;

  const response = await fetchWithTimeout(
    url,
    { headers: buildHeaders(sessionKey) },
    requestTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Org usage API returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const extraUsage = data["extra_usage"] as Record<string, unknown> | undefined;

  if (!extraUsage || typeof extraUsage !== "object") {
    return null;
  }

  const isEnabled = extraUsage["is_enabled"] === true;
  const monthlyLimit =
    typeof extraUsage["monthly_limit"] === "number" ? extraUsage["monthly_limit"] : 0;
  const usedCredits =
    typeof extraUsage["used_credits"] === "number" ? extraUsage["used_credits"] : 0;
  const utilization =
    typeof extraUsage["utilization"] === "number" ? extraUsage["utilization"] : 0;
  const currency =
    typeof extraUsage["currency"] === "string" ? extraUsage["currency"] : "USD";

  return {
    isEnabled,
    monthlyLimitUsd: monthlyLimit,
    usedCreditsUsd: usedCredits,
    utilization,
    currency,
  };
}

async function fetchUserLimit(
  orgId: string,
  accountId: string,
  sessionKey: string,
  requestTimeoutMs?: number,
): Promise<AnthropicEnterpriseUserLimit | null> {
  const url = `${CLAUDE_AI_BASE_URL}/organizations/${orgId}/overage_spend_limit?account_uuid=${accountId}`;

  const response = await fetchWithTimeout(
    url,
    { headers: buildHeaders(sessionKey) },
    requestTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`User limit API returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  const isEnabled = data["is_enabled"] === true;
  const monthlyLimit =
    typeof data["monthly_credit_limit"] === "number" ? data["monthly_credit_limit"] : 0;
  const usedCredits =
    typeof data["used_credits"] === "number" ? data["used_credits"] : 0;
  const accountName =
    typeof data["account_name"] === "string" ? data["account_name"] : null;
  const groupName =
    typeof data["group_name"] === "string" ? data["group_name"] : null;
  const period = typeof data["period"] === "string" ? data["period"] : "monthly";
  const currency = typeof data["currency"] === "string" ? data["currency"] : "USD";

  return {
    isEnabled,
    monthlyLimitUsd: monthlyLimit,
    usedCreditsUsd: usedCredits,
    accountName,
    groupName,
    period,
    currency,
  };
}

export async function queryAnthropicEnterpriseQuota(
  options: AnthropicEnterpriseQueryOptions,
): Promise<AnthropicEnterpriseResult> {
  try {
    const orgUsage = await fetchOrgUsage(
      options.orgId,
      options.sessionKey,
      options.requestTimeoutMs,
    );

    let userLimit: AnthropicEnterpriseUserLimit | null = null;
    if (options.accountId) {
      userLimit = await fetchUserLimit(
        options.orgId,
        options.accountId,
        options.sessionKey,
        options.requestTimeoutMs,
      );
    }

    return { success: true, orgUsage, userLimit };
  } catch (error) {
    return {
      success: false,
      error: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    };
  }
}
