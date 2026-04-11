/**
 * OpenCode Go provider wrapper.
 *
 * Scrapes the OpenCode Go workspace dashboard and reports monthly usage
 * as a percentage-based quota entry.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
  resolveOpenCodeGoConfigCached,
} from "../lib/opencode-go-config.js";
import { queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";

const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveOpenCodeGoConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured" || config.state === "incomplete";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const config = await resolveOpenCodeGoConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") {
      return { attempted: false, entries: [], errors: [] };
    }

    if (config.state === "incomplete") {
      return {
        attempted: true,
        entries: [],
        errors: [
          {
            label: OPENCODE_GO_PROVIDER_LABEL,
            message: `Missing ${config.missing} (source: ${config.source})`,
          },
        ],
      };
    }

    const result = await queryOpenCodeGoQuota(config.config.workspaceId, config.config.authCookie);

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: OPENCODE_GO_PROVIDER_LABEL, message: result.error }],
      };
    }

    return {
      attempted: true,
      entries: [
        {
          name: OPENCODE_GO_PROVIDER_LABEL,
          group: OPENCODE_GO_PROVIDER_LABEL,
          label: "Monthly:",
          percentRemaining: result.percentRemaining,
          resetTimeIso: result.resetTimeIso,
        },
      ],
      errors: [],
    };
  },
};
