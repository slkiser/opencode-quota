import { loadConfiguredOpenCodeConfig } from "./opencode-config-providers.js";
import { readAuthFileCached } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

export {
  getLiteLLMKeyDiagnostics,
  hasLiteLLMApiKey as hasLiteLLMApiKeyConfigured,
  type LiteLLMKeySource,
} from "./litellm-auth.js";

const LITELLM_ENV_VARS = [
  "LITELLM_API_KEY",
  "LITELLM_KEY",
] as const;

export function resolveStaticApiKey(): string | null {
  for (const envVar of LITELLM_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }
  return null;
}

export function resolveToken(
  auth: Record<string, unknown> | null | undefined,
  staticKey: string | null,
): string | null {
  // OAuth access token (from device flow)
  const access = typeof auth?.access === "string" ? auth.access.trim() : "";
  if (access) return access;
  // API key stored directly in auth.json
  const key = typeof auth?.key === "string" ? auth.key.trim() : "";
  if (key) return key;
  // Env var fallback
  return staticKey;
}

export interface LiteLLMUserInfoV2 {
  user_id?: string;
  user_email?: string;
  spend?: number;
  max_budget?: number | null;
  budget_reset_at?: string | null;
}

export interface LiteLLMDailyMetrics {
  spend?: number;
  successful_requests?: number;
  failed_requests?: number;
  api_requests?: number;
  total_tokens?: number;
}

export interface LiteLLMDailyModelEntry {
  metrics?: LiteLLMDailyMetrics;
}

export interface LiteLLMDailyResult {
  date?: string;
  metrics?: LiteLLMDailyMetrics;
  breakdown?: {
    models?: Record<string, LiteLLMDailyModelEntry>;
  };
}

export interface LiteLLMDailyActivityResponse {
  results?: LiteLLMDailyResult[];
}

const DEFAULT_BASE_URL = "http://localhost:4000";

export async function resolveBaseURL(): Promise<string> {
  try {
    const config = await loadConfiguredOpenCodeConfig({ configRootDir: process.cwd() });
    const baseURL = (((config.provider as Record<string, unknown>)?.litellm as Record<string, unknown>)?.options as Record<string, unknown>)?.baseURL;
    if (typeof baseURL === "string" && baseURL.trim()) {
      return baseURL.trim();
    }
  } catch {
    // fall through
  }

  try {
    const authData = await readAuthFileCached({ maxAgeMs: 5_000 });
    const baseURL = ((authData?.litellm as Record<string, unknown>)?.metadata as Record<string, unknown>)?.baseURL;
    if (typeof baseURL === "string" && baseURL.trim()) {
      return baseURL.trim();
    }
  } catch {
    // fall through to default
  }

  return DEFAULT_BASE_URL;
}

export function buildURL(
  baseURL: string,
  path: string,
  params?: Record<string, string>,
): string {
  const normalized = baseURL.replace(/\/+$/, "");
  const url = new URL(path, normalized + "/");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function fetchUserInfo(
  token: string,
  baseURL: string,
  requestTimeoutMs?: number,
): Promise<LiteLLMUserInfoV2 | null> {
  try {
    const url = buildURL(baseURL, "/v2/user/info");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Proxy-Id": "litellm",
      },
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as LiteLLMUserInfoV2;
  } catch {
    return null;
  }
}

export async function fetchTodayActivity(
  token: string,
  baseURL: string,
  requestTimeoutMs?: number,
): Promise<LiteLLMDailyResult | null> {
  try {
    const today = todayDateString();
    const url = buildURL(baseURL, "/user/daily/activity", {
      start_date: today,
      end_date: today,
      page_size: "1000",
      page: "1",
    });
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Proxy-Id": "litellm",
      },
      signal: requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as LiteLLMDailyActivityResponse;
    return data.results?.[0] ?? null;
  } catch {
    return null;
  }
}

export function topModelBySpend(
  models: Record<string, LiteLLMDailyModelEntry> | undefined,
): string | null {
  if (!models) return null;
  let topModel: string | null = null;
  let topSpend = -Infinity;
  for (const [modelId, entry] of Object.entries(models)) {
    const spend = entry.metrics?.spend ?? 0;
    if (spend > topSpend) {
      topSpend = spend;
      topModel = modelId;
    }
  }
  return topModel;
}

export interface LiteLLMQueryResult {
  success: true;
  spend: number;
  budget?: number;
  budgetResetAt?: string;
  today?: LiteLLMDailyResult;
}

export async function queryLiteLLM(
  token: string,
  baseURL: string,
  requestTimeoutMs?: number,
): Promise<LiteLLMQueryResult | null> {
  const [userInfo, todayActivity] = await Promise.all([
    fetchUserInfo(token, baseURL, requestTimeoutMs),
    fetchTodayActivity(token, baseURL, requestTimeoutMs),
  ]);

  if (!userInfo) return null;

  return {
    success: true,
    spend: userInfo.spend ?? 0,
    budget: typeof userInfo.max_budget === "number" ? userInfo.max_budget : undefined,
    budgetResetAt: userInfo.budget_reset_at ?? undefined,
    today: todayActivity ?? undefined,
  };
}

export async function hasLiteLLMAuthAvailable(): Promise<boolean> {
  const authData = await readAuthFileCached({ maxAgeMs: 5_000 });
  const litellmAuth = authData?.litellm;
  
  // allow oauth access keys if available for those using oauth
  if (litellmAuth?.access) return true;
  const key = (litellmAuth as Record<string, unknown> | undefined)?.key;
  // use default key if one is avaialble
  if (typeof key === "string" && key.trim()) return true;
  
  // check for static API key from env
  return resolveStaticApiKey() !== null;
}

import type { QuotaToastEntry } from "./entries.js";

export function modelsTodayEntries(today: LiteLLMDailyResult): QuotaToastEntry[] {
  const models = today.breakdown?.models;
  if (!models || Object.keys(models).length === 0) {
    // No per-model breakdown — fall back to aggregate line
    const spend = today.metrics?.spend ?? 0;
    const requests = today.metrics?.successful_requests ?? 0;
    const reqLabel = requests === 1 ? "1 req" : `${requests} reqs`;
    return [{
      kind: "value",
      name: "LiteLLM",
      group: "LiteLLM",
      label: "Today:",
      value: [`$${spend.toFixed(4)}`, reqLabel].join(" | "),
    }];
  }

  // Sort models by spend descending, emit one entry each
  const sortedEntries = Object.entries(models)
    .filter(([, entry]) => (entry.metrics?.spend ?? 0) > 0 || (entry.metrics?.successful_requests ?? 0) > 0)
    .sort(([, a], [, b]) => (b.metrics?.spend ?? 0) - (a.metrics?.spend ?? 0));

  return sortedEntries.map(([modelId, entry], index) => {
    const spend = entry.metrics?.spend ?? 0;
    const requests = entry.metrics?.successful_requests ?? 0;
    const reqLabel = requests === 1 ? "1 req" : `${requests} reqs`;
    return {
      kind: "value" as const,
      name: "LiteLLM",
      group: "LiteLLM",
      label: index === 0 ? "Today:" : "",
      value: [`$${spend.toFixed(4)}`, reqLabel, modelId].join(" | "),
    };
  });
}

export function buildLiteLLMEntries(data: LiteLLMQueryResult): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];

  if (data.budget && data.budget > 0) {
    const remaining = Math.max(0, data.budget - data.spend);
    const percentRemaining = Math.round((remaining / data.budget) * 100);
    entries.push({
      name: "LiteLLM",
      group: "LiteLLM",
      label: "Budget:",
      right: `$${data.spend.toFixed(2)}/$${data.budget.toFixed(2)}`,
      percentRemaining,
      resetTimeIso: data.budgetResetAt,
    });
  } else {
    entries.push({
      kind: "value",
      name: "LiteLLM",
      group: "LiteLLM",
      label: "Spend:",
      value: data.today?.metrics?.spend != null
        ? `$${data.spend.toFixed(2)} (today: $${data.today.metrics.spend.toFixed(4)})`
        : `$${data.spend.toFixed(2)}`,
    });
  }

  if (data.today) {
    entries.push(...modelsTodayEntries(data.today));
  }

  return entries;
}
