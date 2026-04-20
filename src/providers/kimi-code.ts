import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryKimiQuota } from "../lib/kimi.js";
import { DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS, resolveKimiAuthCached } from "../lib/kimi-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${window.used}/${window.limit}`;
}

export const kimiCodeProvider: QuotaProvider = {
  id: "kimi-for-coding",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "kimi-for-coding",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    const auth = await resolveKimiAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured" || auth.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "kimi-for-coding";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = await resolveKimiAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });

    if (auth.state === "none") {
      return notAttemptedResult();
    }

    if (auth.state === "invalid") {
      return attemptedErrorResult("Kimi Code", auth.error);
    }

    const result = await queryKimiQuota();

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Kimi Code", result.error);
    }

    const style = ctx.config.formatStyle ?? "classic";

    if (style === "classic") {
      const worst = [...result.windows].sort((a, b) => a.percentRemaining - b.percentRemaining)[0];
      if (!worst) {
        return attemptedResult([]);
      }
      return attemptedResult([
        {
          name: result.label,
          percentRemaining: worst.percentRemaining,
          resetTimeIso: worst.resetTimeIso,
        },
      ]);
    }

    const entries: QuotaToastEntry[] = result.windows.map((window) => ({
      name: `${result.label} ${window.label}`,
      group: result.label,
      label: `${window.label}:`,
      right: formatUsageRight(window),
      percentRemaining: window.percentRemaining,
      resetTimeIso: window.resetTimeIso,
    }));

    return attemptedResult(entries);
  },
};
