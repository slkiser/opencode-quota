import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryKimiQuota } from "../lib/kimi.js";
import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  getKimiCodePlanCnAuthDiagnostics,
  getKimiCodePlanGlobalAuthDiagnostics,
  type KimiAuthDiagnostics,
  type ResolvedKimiAuth,
  resolveKimiCodePlanCnAuthCached,
  resolveKimiCodePlanGlobalAuthCached,
} from "../lib/kimi-auth.js";
import { getKimiQuotaEndpoint, type KimiQuotaEndpointId } from "../lib/kimi-endpoints.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  apiKeyStatusDetails,
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${window.used}/${window.limit}`;
}

type KimiProviderSpec = {
  id: "kimi-code-plan-global" | "kimi-code-plan-cn";
  label: string;
  endpoint: KimiQuotaEndpointId;
  resolveAuthCached: (params?: { maxAgeMs?: number }) => Promise<ResolvedKimiAuth>;
  getAuthDiagnostics: (params?: { maxAgeMs?: number }) => Promise<KimiAuthDiagnostics>;
};

function createKimiProvider(spec: KimiProviderSpec): QuotaProvider {
  return {
    id: spec.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable = await isCanonicalProviderAvailable({
        ctx,
        providerId: spec.id,
        fallbackOnError: false,
      });
      if (!providerAvailable) {
        return false;
      }

      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel(model: string): boolean {
      const [provider] = model.toLowerCase().split("/", 2);
      return normalizeQuotaProviderId(provider) === spec.id;
    },

    async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
      const diagnostics = await spec.getAuthDiagnostics({
        maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      });
      const endpoint = getKimiQuotaEndpoint(spec.endpoint);
      const authDetails = [
        ...apiKeyStatusDetails(diagnostics),
        ...statusDetailsFromRecord({
          api_endpoint: endpoint.id,
          api_base_url: endpoint.apiBaseUrl,
        }),
      ];
      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      });

      if (auth.state === "none") {
        return withStatusDetails(notAttemptedResult(), authDetails);
      }

      if (auth.state === "invalid") {
        return withStatusDetails(attemptedErrorResult(spec.label, auth.error), authDetails);
      }

      const result = await queryKimiQuota({
        apiKey: auth.apiKey,
        endpoint: spec.endpoint,
        label: spec.label,
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
      });

      if (!result.success) {
        return withStatusDetails(attemptedErrorResult(spec.label, result.error), [
          ...authDetails,
          { key: "live_fetch_error", value: result.error },
        ]);
      }

      const entries: QuotaToastEntry[] = result.windows.map((window) => ({
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: `${result.label} ${window.label}`,
        group: result.label,
        label: `${window.label}:`,
        right: formatUsageRight(window),
        percentRemaining: window.percentRemaining,
        resetTimeIso: window.resetTimeIso,
      }));

      return withStatusDetails(
        attemptedResult(entries, [], {
          singleWindowDisplayName: result.label,
        }),
        [
          ...authDetails,
          ...result.windows.map((window) => ({
            key: window.label.toLowerCase().replace(/\s+/g, "_"),
            value: `used=${window.used}/${window.limit} percent_remaining=${window.percentRemaining} reset_at=${window.resetTimeIso ?? "(none)"}`,
          })),
          ...(result.windows.length === 0
            ? [{ key: "live_state", value: `no reportable ${spec.label} quota` }]
            : []),
        ],
      );
    },
  };
}

export const kimiCodePlanGlobalProvider: QuotaProvider = createKimiProvider({
  id: "kimi-code-plan-global",
  label: "Kimi Code",
  endpoint: "global",
  resolveAuthCached: resolveKimiCodePlanGlobalAuthCached,
  getAuthDiagnostics: getKimiCodePlanGlobalAuthDiagnostics,
});

export const kimiCodePlanCnProvider: QuotaProvider = createKimiProvider({
  id: "kimi-code-plan-cn",
  label: "Kimi Code (CN)",
  endpoint: "china",
  resolveAuthCached: resolveKimiCodePlanCnAuthCached,
  getAuthDiagnostics: getKimiCodePlanCnAuthDiagnostics,
});
