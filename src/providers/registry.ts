/**
 * Provider registry.
 *
 * Add new providers here; everything else should stay provider-agnostic.
 */

import type { QuotaProvider } from "../lib/entries.js";
import { anthropicProvider } from "./anthropic.js";
import { copilotProvider } from "./copilot.js";
import { openaiProvider } from "./openai.js";
import { openRouterProvider } from "./openrouter.js";
import { cursorProvider } from "./cursor.js";
import { googleAntigravityProvider } from "./google-antigravity.js";
import { googleGeminiCliProvider } from "./google-gemini-cli.js";
import { googleAgyProvider } from "./google-agy.js";
import { syntheticProvider } from "./synthetic.js";
import { chutesProvider } from "./chutes.js";
import { qwenCodeProvider } from "./qwen-code.js";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan.js";
import { zaiProvider } from "./zai.js";
import { zhipuProvider } from "./zhipu.js";
import { nanoGptProvider } from "./nanogpt.js";
import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
} from "./minimax-coding-plan.js";
import { opencodeGoProvider } from "./opencode-go.js";
import { opencodeZenProvider } from "./opencode-zen.js";
import { kimiCodeProvider } from "./kimi-code.js";
import { deepseekProvider } from "./deepseek.js";
import { xaiProvider } from "./xai.js";
import { xiaomiProvider } from "./mimo.js";
import { ollamaCloudProvider } from "./ollama-cloud.js";
import { quotaProvidersProvider } from "./quota-providers.js";

export function getProviders(): QuotaProvider[] {
  // Order here defines display ordering in the toast.
  return [
    anthropicProvider,
    copilotProvider,
    openaiProvider,
    openRouterProvider,
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
