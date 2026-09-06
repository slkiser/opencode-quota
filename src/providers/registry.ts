/**
 * Provider implementation registry.
 *
 * Add metadata and display order in provider-registration.ts, then bind the
 * corresponding provider singleton here. Everything else stays provider-agnostic.
 */

import type { QuotaProvider } from "../lib/entries.js";
import {
  type CanonicalQuotaProviderId,
  QUOTA_PROVIDER_REGISTRATION_SOURCE,
} from "../lib/provider-registration.js";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan.js";
import { anthropicProvider } from "./anthropic.js";
import { PROVIDER_CACHE_POLICIES } from "./cache-policies.js";
import { chutesProvider } from "./chutes.js";
import { copilotProvider } from "./copilot.js";
import { cursorProvider } from "./cursor.js";
import { deepseekProvider } from "./deepseek.js";
import { googleAgyProvider } from "./google-agy.js";
import { googleAntigravityProvider } from "./google-antigravity.js";
import { googleGeminiCliProvider } from "./google-gemini-cli.js";
import { kiloProvider } from "./kilo.js";
import { kimiCodeProvider } from "./kimi-code.js";
import { xiaomiProvider } from "./mimo.js";
import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
} from "./minimax-coding-plan.js";
import { nanoGptProvider } from "./nanogpt.js";
import { ollamaCloudProvider } from "./ollama-cloud.js";
import { openaiProvider } from "./openai.js";
import { opencodeGoProvider } from "./opencode-go.js";
import { opencodeZenProvider } from "./opencode-zen.js";
import { openRouterProvider } from "./openrouter.js";
import { quotaProvidersProvider } from "./quota-providers.js";
import { qwenCodeProvider } from "./qwen-code.js";
import { syntheticProvider } from "./synthetic.js";
import { xaiProvider } from "./xai.js";
import { zaiProvider } from "./zai.js";
import { zhipuProvider } from "./zhipu.js";

const PROVIDERS_BY_ID = {
  anthropic: anthropicProvider,
  copilot: copilotProvider,
  openai: openaiProvider,
  openrouter: openRouterProvider,
  kilo: kiloProvider,
  cursor: cursorProvider,
  "qwen-code": qwenCodeProvider,
  "alibaba-coding-plan": alibabaCodingPlanProvider,
  synthetic: syntheticProvider,
  chutes: chutesProvider,
  "google-antigravity": googleAntigravityProvider,
  "google-gemini-cli": googleGeminiCliProvider,
  "google-agy": googleAgyProvider,
  zai: zaiProvider,
  zhipu: zhipuProvider,
  nanogpt: nanoGptProvider,
  "minimax-coding-plan": minimaxCodingPlanProvider,
  "minimax-china-coding-plan": minimaxChinaCodingPlanProvider,
  "kimi-for-coding": kimiCodeProvider,
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
    provider.cachePolicy = PROVIDER_CACHE_POLICIES[id];
    return provider;
  });
}
