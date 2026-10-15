import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { resolveKiloApiKey, hasKiloApiKey } from "../lib/kilo-config.js";
import { queryKiloQuota } from "../lib/kilo.js";
import { projectAccountingToLegacy } from "../lib/accounting.js";
import { createResolvedAuthCachePolicy } from "./account-cache.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { notAttemptedResult } from "./result-helpers.js";
async function selectedFetch(key: string, ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
  const result = await queryKiloQuota(key, ctx.config.requestTimeoutMs);
  return {
    attempted: true,
    entries: projectAccountingToLegacy(result.accounting),
    accounting: result.accounting,
    errors: result.errors.map((message) => ({ label: "Kilo", message })),
  };
}
export const kiloProvider: QuotaProvider = {
  id: "kilo",
  cachePolicy: createResolvedAuthCachePolicy("kilo", async (ctx) => {
    const selected = await resolveKiloApiKey();
    if (!selected) return null;
    const key = selected.key;
    return { credential: key, fetch: () => selectedFetch(key, ctx) };
  }),
  isAvailable: async () => hasKiloApiKey(),
  matchesCurrentModel: (model) => modelProviderIncludesAny(model, ["kilo"]),
  async fetch(ctx) {
    const selected = await resolveKiloApiKey();
    return selected ? selectedFetch(selected.key, ctx) : notAttemptedResult();
  },
};
