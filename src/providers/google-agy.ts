import type { QuotaProvider } from "../lib/entries.js";
import { AGY_AUTH_KEYS, AGY_FLAVOR, compareAgyBuckets } from "../lib/google-agy.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import type {
  GoogleAgyAuthSourceKey,
  GoogleAgyQuotaBucket,
  GoogleAgyQuotaSummaryResponse,
} from "../lib/types.js";
import { FIVE_HOUR, keySlug, type ProviderRow, quotaRow, WEEKLY } from "./contract.js";
import {
  fetchGoogleProviderQuota,
  type GoogleProviderFlavor,
  googleCachePolicy,
  isGoogleProviderAvailable,
  remainingCount,
} from "./google-oauth-provider.js";

function formatFamilyLabel(family: string): string {
  if (family === "Gemini Models") return "Gemini";
  if (family === "Claude and GPT models") return "Claude/GPT";
  return family;
}

/**
 * `<family>.<window>`, for example `claude_gpt.weekly`, labelled "Claude/GPT Weekly", with the
 * remaining count when AGY gives one (AGY does not name its unit).
 */
function agyRow(bucket: GoogleAgyQuotaBucket): ProviderRow | undefined {
  const family = formatFamilyLabel(bucket.family);
  const familyKey = keySlug(family);
  if (!familyKey) return undefined;
  const slot = bucket.window === "weekly" ? WEEKLY : FIVE_HOUR;
  const remaining = remainingCount(bucket.remainingAmount, "unit");
  return {
    ...quotaRow({
      key: `${familyKey}.${slot.key}`,
      label: `${family} ${slot.label}`,
      window: slot.window,
      percentRemaining: bucket.percentRemaining,
      resetsAt: bucket.resetTimeIso,
    }),
    ...(remaining ? { remaining } : {}),
  };
}

const AGY_PROVIDER: GoogleProviderFlavor<
  GoogleAgyAuthSourceKey,
  GoogleAgyQuotaSummaryResponse,
  GoogleAgyQuotaBucket
> = {
  quota: AGY_FLAVOR,
  compareBuckets: compareAgyBuckets,
  row: agyRow,
};

export const googleAgyProvider: QuotaProvider = {
  id: "google-agy",
  cachePolicy: googleCachePolicy(AGY_PROVIDER),
  isAvailable: () => isGoogleProviderAvailable(AGY_PROVIDER),
  matchesCurrentModel: (model) =>
    (AGY_AUTH_KEYS as readonly string[]).includes(parseProviderModelRef(model).providerId),
  fetch: (ctx) => fetchGoogleProviderQuota(AGY_PROVIDER, ctx),
};
