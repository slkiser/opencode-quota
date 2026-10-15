import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { resolveOpenRouterApiKey, hasOpenRouterApiKey } from "../lib/openrouter-config.js";
import { queryOpenRouterQuota } from "../lib/openrouter.js";
import { projectAccountingToLegacy } from "../lib/accounting.js";
import { createResolvedAuthCachePolicy } from "./account-cache.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedErrorResult, notAttemptedResult } from "./result-helpers.js";
async function selectedFetch(
  key: string,
  source: string,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderResult> {
  const response = await queryOpenRouterQuota(key, ctx.config.requestTimeoutMs);
  if (!response.success) return attemptedErrorResult("OpenRouter", response.error);
  const entries = projectAccountingToLegacy(response.accounting);
  response.accounting.rows.push({
    id: "auth-source",
    name: "OpenRouter auth source",
    resultType: "status",
    prominence: "supplementary",
    source: {
      id: "local-auth-resolution",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
    },
    account: { kind: "unknown" },
    freshness: { kind: "unknown" },
    window: { kind: "unknown" },
    value: { kind: "status", status: "available", detail: source },
  });
  return {
    attempted: true,
    entries,
    errors: response.warnings.map((message) => ({ label: "OpenRouter", message })),
    accounting: response.accounting,
  };
}
export const openRouterProvider: QuotaProvider = {
  id: "openrouter",
  cachePolicy: createResolvedAuthCachePolicy("openrouter", async (ctx) => {
    const selected = await resolveOpenRouterApiKey();
    if (!selected) return null;
    const { key, source } = selected;
    return { credential: key, fetch: () => selectedFetch(key, source, ctx) };
  }),
  isAvailable: async () => hasOpenRouterApiKey(),
  matchesCurrentModel: (model) => modelProviderIncludesAny(model, ["openrouter"]),
  async fetch(ctx) {
    const selected = await resolveOpenRouterApiKey();
    return selected ? selectedFetch(selected.key, selected.source, ctx) : notAttemptedResult();
  },
};
