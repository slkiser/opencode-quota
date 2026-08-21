import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-metadata.js";
import {
  apiKeyStatusDetails,
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
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
  getAuthDiagnostics: (params: { maxAgeMs: number }) => Promise<{
    state: string;
    source: string | null;
    checkedPaths: string[];
    credentialDatabasePaths: string[];
    error?: string;
  }>;
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
      const diagnostics = await params.getAuthDiagnostics({ maxAgeMs: params.authCacheMaxAgeMs });
      const authDetails = apiKeyStatusDetails(diagnostics);
      const result = await params.queryQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
      const providerResult = mapNullableProviderResult(result, {
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
      const windows = result?.success ? result.windows : {};
      const formatWindow = (window: GlmQuotaWindow | undefined): string | undefined =>
        window
          ? `${window.percentRemaining}% reset_at=${window.resetTimeIso ?? "(none)"}`
          : undefined;
      return withStatusDetails(providerResult, [
        ...authDetails,
        ...statusDetailsFromRecord({
          live_fetch_error: !result
            ? `${params.errorLabel} API key became unavailable before fetch`
            : result.success
              ? undefined
              : result.error,
          five_hour_remaining: formatWindow(windows.fiveHour),
          weekly_remaining: formatWindow(windows.weekly),
          mcp_remaining: formatWindow(windows.mcp),
          live_state:
            result?.success && !windows.fiveHour && !windows.weekly && !windows.mcp
              ? `no reportable ${params.errorLabel} quota windows`
              : undefined,
        }),
      ]);
    },
  };
}
