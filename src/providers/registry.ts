/**
 * Each provider in `provider-registration.ts` order (the display order), bound to its id.
 * A provider's facts live there; its fetch and cache policy in `src/providers/<vendor>.ts`.
 */

import type { QuotaProvider } from "../lib/entries.js";
import {
  type CanonicalQuotaProviderId,
  QUOTA_PROVIDER_REGISTRATION_SOURCE,
} from "../lib/provider-registration.js";
import { alibabaCodingPlanProvider, alibabaTokenPlanProvider } from "./alibaba.js";
import { anthropicProvider } from "./anthropic.js";
import { copilotProvider } from "./copilot.js";
import { cursorProvider } from "./cursor.js";
import { deepseekProvider } from "./deepseek.js";
import { zaiProvider, zhipuProvider } from "./glm-coding-plan.js";
import { googleAgyProvider } from "./google-agy.js";
import { googleGeminiCliProvider } from "./google-gemini-cli.js";
import { kimiCodePlanCnProvider, kimiCodePlanGlobalProvider } from "./kimi-code.js";
import { xiaomiProvider } from "./mimo.js";
import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
} from "./minimax-coding-plan.js";
import { ollamaCloudProvider } from "./ollama-cloud.js";
import { openaiProvider } from "./openai.js";
import { opencodeGoProvider } from "./opencode-go.js";
import { opencodeZenProvider } from "./opencode-zen.js";
import { openRouterProvider } from "./openrouter.js";
import { quotaProvidersProvider } from "./quota-providers.js";
import { xaiProvider } from "./xai.js";

const PROVIDERS_BY_ID = {
  anthropic: anthropicProvider,
  copilot: copilotProvider,
  openai: openaiProvider,
  openrouter: openRouterProvider,
  cursor: cursorProvider,
  "alibaba-coding-plan": alibabaCodingPlanProvider,
  "alibaba-token-plan": alibabaTokenPlanProvider,
  "google-gemini-cli": googleGeminiCliProvider,
  "google-agy": googleAgyProvider,
  zai: zaiProvider,
  zhipu: zhipuProvider,
  "minimax-coding-plan": minimaxCodingPlanProvider,
  "minimax-china-coding-plan": minimaxChinaCodingPlanProvider,
  "kimi-code-plan-global": kimiCodePlanGlobalProvider,
  "kimi-code-plan-cn": kimiCodePlanCnProvider,
  deepseek: deepseekProvider,
  xai: xaiProvider,
  xiaomi: xiaomiProvider,
  "opencode-go": opencodeGoProvider,
  opencode: opencodeZenProvider,
  "ollama-cloud": ollamaCloudProvider,
  "quota-providers": quotaProvidersProvider,
} satisfies Record<CanonicalQuotaProviderId, QuotaProvider>;

export function getProviders(): QuotaProvider[] {
  return QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => {
    const provider = PROVIDERS_BY_ID[id];
    if (provider.id !== id) {
      throw new Error(
        `Quota provider registration mismatch: expected ${id}, received ${provider.id}`,
      );
    }
    return provider;
  });
}
