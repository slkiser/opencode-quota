import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-metadata.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
} from "./result-helpers.js";

type GlmQuotaWindow = {
  percentRemaining: number;
  resetTimeIso?: string;
};

type GlmQuotaResult = {
  success: true;
  label: string;
  windows: {
    fiveHour?: GlmQuotaWindow;
    weekly?: GlmQuotaWindow;
    mcp?: GlmQuotaWindow;
  };
};

export function createGlmCodingPlanProvider(params: {
  id: "zai" | "zhipu";
  providerId: CanonicalQuotaProviderId;
  errorLabel: string;
  authCacheMaxAgeMs: number;
  resolveAuth: (params: { maxAgeMs: number }) => Promise<{ state: string }>;
  queryQuota: (params: {
    requestTimeoutMs?: number;
  }) => Promise<GlmQuotaResult | { success: false; error: string } | null>;
  matchesCurrentModel: (model: string) => boolean;
}): QuotaProvider {
  return {
    id: params.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable = await isCanonicalProviderAvailable({
        ctx,
        providerId: params.providerId,
        fallbackOnError: false,
      });
      if (!providerAvailable) return false;

      const auth = await params.resolveAuth({ maxAgeMs: params.authCacheMaxAgeMs });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel: params.matchesCurrentModel,

    async fetch(ctx: QuotaProviderContext) {
      const result = await params.queryQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
      return mapNullableProviderResult(result, {
        errorLabel: params.errorLabel,
        onSuccess: (quota) =>
          attemptedResult(
            groupedPercentWindowEntries({
              group: quota.label,
              accounting: {
                resultType: "quota",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
              },
              windows: [
                { window: quota.windows.fiveHour, suffix: "5h", label: "5h:" },
                { window: quota.windows.weekly, suffix: "Weekly", label: "Weekly:" },
                { window: quota.windows.mcp, suffix: "MCP", label: "MCP:" },
              ],
            }),
            [],
            { singleWindowDisplayName: quota.label },
          ),
      });
    },
  };
}
