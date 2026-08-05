/**
 * Provider registry.
 *
 * Add new providers here; everything else should stay provider-agnostic.
 */

import type { QuotaProvider } from "../lib/entries.js";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan.js";
import { anthropicProvider } from "./anthropic.js";
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
import { nineRouterProvider } from "./nine-router.js";
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

export function getProviders(): QuotaProvider[] {
  // Order here defines display ordering in the toast.
  return [
    anthropicProvider,
    copilotProvider,
    openaiProvider,
    nineRouterProvider,
    openRouterProvider,
    kiloProvider,
    cursorProvider,
    qwenCodeProvider,
    alibabaCodingPlanProvider,
    syntheticProvider,
    chutesProvider,
    googleAntigravityProvider,
    googleGeminiCliProvider,
    googleAgyProvider,
    zaiProvider,
    zhipuProvider,
    nanoGptProvider,
    minimaxCodingPlanProvider,
    minimaxChinaCodingPlanProvider,
    kimiCodeProvider,
    deepseekProvider,
    xaiProvider,
    xiaomiProvider,
    opencodeGoProvider,
    opencodeZenProvider,
    ollamaCloudProvider,
    quotaProvidersProvider,
  ];
}
