import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";
import {
  buildLiteLLMEntries,
  modelsTodayEntries,
  queryLiteLLM,
  resolveStaticApiKey,
  resolveBaseURL,
  resolveToken,
  hasLiteLLMAuthAvailable,
} from "../lib/litellm.js";
import {
  attemptedResult,
  mapNullableProviderResult,
} from "./result-helpers.js";

export { modelsTodayEntries, buildLiteLLMEntries };

export const litellmProvider: QuotaProvider = {
  id: "litellm",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "litellm",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return hasLiteLLMAuthAvailable();
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const authData = await readAuthFileCached({ maxAgeMs: 5_000 });
    const auth = authData?.litellm;
    const token = resolveToken(auth, resolveStaticApiKey());

    if (!token) {
      return {
        attempted: false,
        entries: [],
        errors: [],
      };
    }

    const baseURL = await resolveBaseURL();
    const result = await queryLiteLLM(token, baseURL, ctx.config?.requestTimeoutMs);

    return mapNullableProviderResult(result, {
      errorLabel: "LiteLLM",
      onSuccess: (data) => attemptedResult(buildLiteLLMEntries(data)),
    });
  },
};
