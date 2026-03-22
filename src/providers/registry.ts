/**
 * Provider registry.
 *
 * Add new providers here; everything else should stay provider-agnostic.
 */

import type { QuotaProvider } from "../lib/entries.js";
import { copilotProvider } from "./copilot.js";
import { openaiProvider } from "./openai.js";
import { cursorProvider } from "./cursor.js";
import { googleAntigravityProvider } from "./google-antigravity.js";
import { firmwareProvider } from "./firmware.js";
import { chutesProvider } from "./chutes.js";
import { qwenCodeProvider } from "./qwen-code.js";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan.js";
import { zaiProvider } from "./zai.js";
import { nanogptProvider } from "./nanogpt.js";

export function getProviders(): QuotaProvider[] {
  // Order here defines display ordering in the toast.
  return [
    copilotProvider,
    openaiProvider,
    cursorProvider,
    qwenCodeProvider,
    alibabaCodingPlanProvider,
    firmwareProvider,
    chutesProvider,
    googleAntigravityProvider,
    zaiProvider,
    nanogptProvider,
  ];
}
