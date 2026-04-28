/**
 * OpenCode Go provider wrapper.
 *
 * Scrapes the OpenCode Go workspace dashboard and reports rolling (~5h),
 * weekly, and monthly usage as percentage-based quota entries.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import {
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
  resolveOpenCodeGoConfigCached,
} from "../lib/opencode-go-config.js";
import { queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_WINDOW_LABELS: Record<
  OpenCodeGoWindowKey,
  { name: string; label: string; dashboardField: string }
> = {
  rolling: {
    name: `${OPENCODE_GO_PROVIDER_LABEL} 5h`,
    label: "5h:",
    dashboardField: "rollingUsage",
  },
  weekly: {
    name: `${OPENCODE_GO_PROVIDER_LABEL} Weekly`,
    label: "Weekly:",
    dashboardField: "weeklyUsage",
  },
  monthly: {
    name: `${OPENCODE_GO_PROVIDER_LABEL} Monthly`,
    label: "Monthly:",
    dashboardField: "monthlyUsage",
  },
};

function isDefaultOpenCodeGoWindowSelection(windows: OpenCodeGoWindowKey[]): boolean {
  return (
    windows.length === OPENCODE_GO_WINDOW_ORDER.length &&
    OPENCODE_GO_WINDOW_ORDER.every((window, index) => windows[index] === window)
  );
}

function formatMissingWindowList(windows: OpenCodeGoWindowKey[]): string {
  return windows.map((window) => `${window} (${OPENCODE_GO_WINDOW_LABELS[window].dashboardField})`).join(", ");
}

function buildOpenCodeGoEntries(
  result: Extract<OpenCodeGoResult, { success: true }>,
  selectedWindows: OpenCodeGoWindowKey[],
): QuotaToastEntry[] {
  const selected = new Set(selectedWindows);
  const entries: QuotaToastEntry[] = [];

  for (const window of OPENCODE_GO_WINDOW_ORDER) {
    if (!selected.has(window)) continue;

    const usage = result[window];
    if (!usage) continue;

    const labels = OPENCODE_GO_WINDOW_LABELS[window];
    entries.push({
      name: labels.name,
      group: OPENCODE_GO_PROVIDER_LABEL,
      label: labels.label,
      percentRemaining: usage.percentRemaining,
      resetTimeIso: usage.resetTimeIso,
    });
  }

  return entries;
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveOpenCodeGoConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
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
      return notAttemptedResult();
    }

    if (config.state === "incomplete") {
      return attemptedErrorResult(
        OPENCODE_GO_PROVIDER_LABEL,
        `Missing ${config.missing} (source: ${config.source})`,
      );
    }

    if (config.state === "invalid") {
      return attemptedErrorResult(
        OPENCODE_GO_PROVIDER_LABEL,
        `Invalid config (${config.source}): ${config.error}`,
      );
    }

    const result = await queryOpenCodeGoQuota(config.config.workspaceId, config.config.authCookie);

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, result.error);
    }

    const windows = _ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
    const entries = buildOpenCodeGoEntries(result, windows);
    const missingSelectedWindows = windows.filter((window) => !result[window]);

    if (missingSelectedWindows.length > 0 && !isDefaultOpenCodeGoWindowSelection(windows)) {
      return attemptedResult(entries, [
        {
          label: OPENCODE_GO_PROVIDER_LABEL,
          message: `Selected OpenCode Go dashboard window(s) missing: ${formatMissingWindowList(missingSelectedWindows)}`,
        },
      ]);
    }

    return attemptedResult(entries);
  },
};
