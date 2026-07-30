import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  DEFAULT_KILO_CONFIG_CACHE_MAX_AGE_MS,
  getKiloConfigDiagnostics,
  resolveKiloConfigCached,
} from "../lib/kilo-config.js";
import type { KiloUsageResult } from "../lib/kilo.js";
import { queryKiloDashboard } from "../lib/kilo.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  configStatusDetails,
  attemptedResult,
  notAttemptedResult,
  withStatusDetails,
} from "./result-helpers.js";

const KILO_LABEL = "Kilo Gateway";
const KILO_DISPLAY_LABEL = "Kilo";
const KILO_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("kilo"));

const QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const USAGE_ACCOUNTING: AccountingMetadata = {
  resultType: "usage",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

function formatMicrodollars(value: number): string {
  const d = value / 1_000_000;
  return d % 1 === 0 ? `$${d.toFixed(0)}` : `$${d.toFixed(2)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function getGroup(result: KiloUsageResult): string {
  const plan = result.planName ? sanitizeSingleLineDisplaySnippet(result.planName, 40) : "";
  return plan ? `[${KILO_DISPLAY_LABEL}] (${plan})` : KILO_DISPLAY_LABEL;
}

function buildEntries(result: KiloUsageResult): QuotaToastEntry[] {
  const group = getGroup(result);
  const entries: QuotaToastEntry[] = [];

  if (result.usedMicrodollars !== null && result.limitMicrodollars !== null && result.limitMicrodollars > 0) {
    entries.push({
      accounting: QUOTA_ACCOUNTING,
      name: `${KILO_DISPLAY_LABEL} Credits`,
      group,
      label: "Credits:",
      percentRemaining:
        result.limitMicrodollars > 0
          ? 100 - (result.usedMicrodollars / result.limitMicrodollars) * 100
          : 100,
    });
  }

  if (result.balanceMicrodollars !== null) {
    let val = formatMicrodollars(result.balanceMicrodollars);
    if (result.periodBonusCreditsUsd != null && result.periodBonusCreditsUsd > 0) {
      val += ` +${formatMicrodollars(result.periodBonusCreditsUsd)} bonus`;
    }
    if (result.usedMicrodollars !== null) {
      val += ` | Usage ${formatMicrodollars(result.usedMicrodollars)}`;
    }
    entries.push({
      accounting: BALANCE_ACCOUNTING,
      kind: "value",
      name: `${KILO_DISPLAY_LABEL} Credit Balance`,
      group,
      label: "Balance",
      value: val,
    });
  } else if (result.usedMicrodollars !== null) {
    entries.push({
      accounting: USAGE_ACCOUNTING,
      kind: "value",
      name: `${KILO_DISPLAY_LABEL} Usage`,
      group,
      label: "Usage",
      value: formatMicrodollars(result.usedMicrodollars),
    });
  }

  return entries;
}

export const kiloProvider: QuotaProvider = {
  id: "kilo",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveKiloConfigCached({ maxAgeMs: DEFAULT_KILO_CONFIG_CACHE_MAX_AGE_MS });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.trim().toLowerCase().split("/", 2);
    return KILO_RUNTIME_IDS.has(provider);
  },

  async fetch(ctx: QuotaProviderContext) {
    const diagnostics = await getKiloConfigDiagnostics();
    const statusDetails = configStatusDetails({
      ...diagnostics,
      error: diagnostics.error ? sanitizeSingleLineDisplaySnippet(diagnostics.error, 120) : undefined,
    });
    const config = await resolveKiloConfigCached({ maxAgeMs: DEFAULT_KILO_CONFIG_CACHE_MAX_AGE_MS });

    if (config.state === "none") return withStatusDetails(notAttemptedResult(), statusDetails);
    if (config.state === "invalid") {
      return withStatusDetails(
        attemptedErrorResult(KILO_LABEL, `Invalid config (${config.source}): ${config.error}`),
        statusDetails,
      );
    }

    const result = await queryKiloDashboard(config.config.cookie, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured ? ctx.config.requestTimeoutMs : undefined,
    });
    if (!result.success) {
      return withStatusDetails(attemptedErrorResult(KILO_LABEL, result.error), statusDetails);
    }

    const entries = buildEntries(result.data);
    if (entries.length === 0) {
      return withStatusDetails(
        attemptedErrorResult(KILO_LABEL, "No usage data found in Kilo Gateway usage API or page"),
        statusDetails,
      );
    }

    return withStatusDetails(attemptedResult(entries), statusDetails);
  },
};
