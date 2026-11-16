/** Mistral AI: select the budget belonging to the key's Chat/Vibe or API plan. */
import { API_KEY_VENDORS, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { errorWords, failureFacts, requestJson } from "../lib/http.js";
import { isRecord, nonEmptyString } from "../lib/json-guards.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  failedAccount,
  fetchError,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { fetchStoredKeys, isKeyVendorAvailable } from "./key-vendor.js";
import { vendorKeyDetails } from "./result-helpers.js";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";
const WHOAMI_URL = "https://console.mistral.ai/api/vibe/whoami";
const NAME = "Mistral AI";
const SPEC = API_KEY_VENDORS.mistral;

type BudgetResult = { row: ProviderRow; plan: string };
type FetchResult = BudgetResult | { error: string; facts?: ReturnType<typeof failureFacts> };

function parseBudget(budget: unknown, identity: unknown): BudgetResult {
  if (!isRecord(identity)) throw new Error("Mistral plan response has an unexpected shape");
  const planType = nonEmptyString(identity.plan_type)?.toUpperCase();
  const key = planType === "CHAT" ? "vibe_budget" : planType === "API" ? "api_budget" : null;
  if (!key) throw new Error("Mistral plan type is unavailable or unsupported");
  if (!isRecord(budget)) throw new Error("Mistral budget response has an unexpected shape");
  // The top-level budget can refer to API even for a Chat plan. Never substitute it for a
  // missing plan-specific section: that could report a different, unenforced limit.
  const section = budget[key];
  if (!isRecord(section)) throw new Error(`Mistral ${key} is unavailable`);
  const percentage = section.usage_percentage;
  const limit = section.initial_budget;
  const currency = nonEmptyString(section.currency)?.toUpperCase();
  if (
    typeof percentage !== "number" ||
    !Number.isFinite(percentage) ||
    percentage < 0 ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit < 0 ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new Error(`Mistral ${key} has invalid budget values`);
  }
  const reset = nonEmptyString(section.reset_at);
  const resetMs = reset ? Date.parse(reset) : NaN;
  const unit = { kind: "currency" as const, code: currency };
  const row: ProviderRow = {
    key,
    label: planType === "CHAT" ? "Vibe budget" : "API budget",
    type: "budget",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    window: "month",
    percentRemaining: Math.max(0, Math.min(100, 100 - percentage)),
    limit: { decimal: accountingDecimalFromNumber(limit), unit },
    ...(Number.isFinite(resetMs) ? { resetsAt: new Date(resetMs).toISOString() } : {}),
  };
  return { row, plan: planType === "CHAT" ? "Vibe" : "API" };
}

async function queryBudget(apiKey: string, timeoutMs?: number): Promise<FetchResult> {
  const options = {
    method: "GET" as const,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    secrets: [apiKey],
    timeoutMs,
  };
  const identityReply = await requestJson(WHOAMI_URL, options);
  if (!identityReply.ok) {
    const { failure } = identityReply;
    return {
      error:
        failure.kind === "http"
          ? `Mistral plan API error ${failure.status}${errorWords(sanitizeDisplaySnippet(failure.detail, 120))}`
          : failure.detail,
      facts: failureFacts(failure),
    };
  }
  const reply = await requestJson(BUDGET_URL, options);
  if (!reply.ok) {
    const { failure } = reply;
    return {
      error:
        failure.kind === "http"
          ? `Mistral budget API error ${failure.status}${errorWords(sanitizeDisplaySnippet(failure.detail, 120))}`
          : failure.detail,
      facts: failureFacts(failure),
    };
  }
  try {
    return parseBudget(reply.json, identityReply.json);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid Mistral budget response" };
  }
}

export const mistralProvider: QuotaProvider = {
  id: "mistral",
  cachePolicy: vendorKeysPolicy("mistral"),
  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return isKeyVendorAvailable({
      ctx,
      providerId: "mistral",
      availability: "listed-or-key",
      readKeys: () => readVendorKeys(SPEC, ctx.locationDirectory),
    });
  },
  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["mistral"]);
  },
  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keys = await readVendorKeys(SPEC, ctx.locationDirectory);
    const debug = vendorKeyDetails(SPEC, keys, ctx.locationDirectory);
    const query = (key: string) => queryBudget(key, ctx.config?.requestTimeoutMs);
    if (keys.envOrConfig) {
      const result = await query(keys.envOrConfig.key);
      return {
        attempted: true,
        accounts: [
          "row" in result
            ? { name: result.plan, rows: [result.row], errors: [] }
            : failedAccount(NAME, result.error, result.facts),
        ],
        debug,
      };
    }
    const { attempted, accounts } = await fetchStoredKeys({
      providerName: NAME,
      keys,
      brokenFirst: false,
      async fetchKey(key) {
        const result = await query(key);
        return "row" in result
          ? { rows: [result.row], errors: [], fallbackName: result.plan }
          : { rows: [], errors: [fetchError(result.error, result.facts)] };
      },
    });
    return { attempted, accounts, debug };
  },
};
