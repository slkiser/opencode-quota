/** Opt-in Claude API wallet, separate from Claude subscription quota. */
import {
  CONSOLE_COOKIE_ENV,
  queryAnthropicConsoleCredits,
  resolveAnthropicConsoleConfig,
} from "../lib/anthropic-console.js";
import type { QuotaProvider } from "../lib/entries.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { resolvedCredentialPolicy } from "./cache-policies.js";
import { failedAccount } from "./contract.js";

export const anthropicApiProvider: QuotaProvider = {
  id: "anthropic-api",
  cachePolicy: resolvedCredentialPolicy("anthropic-api", async () => {
    const config = resolveAnthropicConsoleConfig();
    return config.state === "configured"
      ? { credential: config.cookie, qualifiers: [config.organization ?? ""] }
      : null;
  }),
  async isAvailable() {
    return resolveAnthropicConsoleConfig().state !== "none";
  },
  matchesCurrentModel(model) {
    return modelProviderIncludesAny(model, ["anthropic", "claude-code", "claude-agent"]);
  },
  async fetch(ctx) {
    const config = resolveAnthropicConsoleConfig();
    const debug = [
      { key: "config_state", value: config.state },
      { key: "config_source", value: `env:${CONSOLE_COOKIE_ENV}` },
    ];
    if (config.state === "none") return { attempted: false, accounts: [], debug };
    if (config.state === "invalid")
      return {
        attempted: true,
        accounts: [failedAccount("Claude API", `Invalid cookie header (${CONSOLE_COOKIE_ENV})`)],
        debug,
      };
    const result = await queryAnthropicConsoleCredits(
      config,
      ctx.config?.requestTimeoutMsConfigured ? ctx.config.requestTimeoutMs : undefined,
    );
    if (!result.success)
      return {
        attempted: true,
        accounts: [failedAccount("Claude API", result.error, result.facts)],
        debug,
      };
    return {
      attempted: true,
      debug,
      accounts: [
        {
          name: "Claude API",
          errors: [],
          rows: [
            {
              key: "balance",
              label: "Balance",
              type: "balance",
              method: "dashboard_scrape",
              authority: "provider_reported",
              prominence: "primary",
              ...(result.data ? { amount: result.data } : { text: "No data" }),
            },
          ],
        },
      ],
    };
  },
};
