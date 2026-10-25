/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import { createResolvedAuthCachePolicy } from "./account-cache.js";
import { openAIAccounting } from "./accounting-adapters.js";
import { readAuthFile } from "../lib/opencode-auth.js";
import {
  resolveOpenAIOAuthWithCodexCli,
  queryOpenAIQuotaWithAuth,
  type ResolvedOpenAIOAuth,
} from "../lib/openai.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
} from "../lib/openai.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
} from "./result-helpers.js";

export const openaiProvider: QuotaProvider = {
  id: "openai",
  cachePolicy: createResolvedAuthCachePolicy("openai", async (ctx) => {
    const auth = await resolveOpenAIOAuthWithCodexCli(await readAuthFile());
    if (auth.state !== "configured" || (auth.expiresAt && auth.expiresAt < Date.now())) return null;
    return {
      credential: auth.accessToken,
      qualifiers: [auth.accountId ?? "", auth.email ?? "", String(auth.expiresAt ?? "")],
      ...(auth.accountId ? { historyPrincipal: { stableId: auth.accountId } } : {}),
      fetch: () => fetchWithAuth(ctx, auth),
    };
  }),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  fetch: fetchWithAuth,
};

async function fetchWithAuth(
  ctx: QuotaProviderContext,
  auth?: Extract<ResolvedOpenAIOAuth, { state: "configured" }>,
): Promise<QuotaProviderResult> {
  const result = auth
    ? await queryOpenAIQuotaWithAuth(auth, { requestTimeoutMs: ctx.config?.requestTimeoutMs })
    : await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

  return mapNullableProviderResult(result, {
    errorLabel: "OpenAI",
    onSuccess: (result) => ({
      ...attemptedResult(
        groupedPercentWindowEntries({
          group: result.label,
          windows: [
            { window: result.windows.hourly, suffix: "5h", label: "5h:" },
            { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
            { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
            { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
          ],
        }),
        [],
        {
          singleWindowDisplayName: result.label,
        },
      ),
      accounting: openAIAccounting(result),
    }),
  });
}
