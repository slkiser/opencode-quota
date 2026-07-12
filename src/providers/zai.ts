/**
 * Z.ai provider wrapper.
 *
 * Normalizes Z.ai quota into generic toast entries.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryZaiQuota } from "../lib/zai.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS, resolveZaiAuthCached } from "../lib/zai-auth.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
} from "./result-helpers.js";

export const zaiProvider: QuotaProvider = {
  id: "zai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "zai",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    const auth = await resolveZaiAuthCached({
      maxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured" || auth.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0];
    if (provider && (provider.includes("zai") || provider.includes("glm"))) {
      return true;
    }
    return lower.includes("glm");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryZaiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "Z.ai",
      onSuccess: (result) =>
        attemptedResult(
          groupedPercentWindowEntries({
            group: result.label,
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            windows: [
              { window: result.windows.fiveHour, suffix: "5h", label: "5h:" },
              { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
              { window: result.windows.mcp, suffix: "MCP", label: "MCP:" },
            ],
          }),
          [],
          {
            singleWindowDisplayName: result.label,
          },
        ),
    });
  },
};
