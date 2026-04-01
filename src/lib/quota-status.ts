import { stat } from "fs/promises";

import { getAuthPath, getAuthPaths, readAuthFileCached } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getGoogleTokenCachePath } from "./google-token-cache.js";
import { getAntigravityAccountsCandidatePaths, readAntigravityAccounts } from "./google.js";
import { getAnthropicDiagnostics } from "./anthropic.js";
import { getFirmwareKeyDiagnostics } from "./firmware.js";
import { getChutesKeyDiagnostics } from "./chutes.js";
import { getNanoGptKeyDiagnostics, queryNanoGptQuota } from "./nanogpt.js";
import { getCopilotQuotaAuthDiagnostics } from "./copilot.js";
import {
  computeAlibabaCodingPlanQuota,
  computeQwenQuota,
  getAlibabaCodingPlanQuotaPath,
  getQwenLocalQuotaPath,
  readAlibabaCodingPlanQuotaState,
  readQwenLocalQuotaState,
} from "./qwen-local-quota.js";
import {
  hasAlibabaAuth,
  resolveAlibabaCodingPlanAuth,
} from "./alibaba-auth.js";
import { hasQwenOAuthAuth, resolveQwenLocalPlan } from "./qwen-auth.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  resolveMiniMaxAuthCached,
} from "./minimax-auth.js";
import {
  getPricingSnapshotHealth,
  getPricingRefreshPolicy,
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  listProviders,
  getProviderModelCount,
  hasProvider as snapshotHasProvider,
  readPricingRefreshState,
} from "./modelsdev-pricing.js";
import { getProviders } from "../providers/registry.js";
import { getPackageVersion } from "./version.js";
import {
  getOpenCodeDbPath,
  getOpenCodeDbPathCandidates,
  getOpenCodeDbStats,
} from "./opencode-storage.js";
import { aggregateUsage } from "./quota-stats.js";
import { fmtUsdAmount, renderCommandHeading } from "./format-utils.js";
import { inspectCursorAuthPresence, inspectCursorOpenCodeIntegration } from "./cursor-detection.js";
import { getCurrentCursorUsageSummary } from "./cursor-usage.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import {
  getCursorPlanDisplayName,
  getEffectiveCursorIncludedApiUsd,
} from "./cursor-pricing.js";
import type { CursorQuotaPlan, PricingSnapshotSource } from "./types.js";
import { queryMiniMaxQuota } from "../providers/minimax-coding-plan.js";

/** Session token fetch error info for status report */
export interface SessionTokenError {
  sessionID: string;
  error: string;
  checkedPath?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fmtInt(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

function tokensTotal(t: {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}): number {
  return t.input + t.output + t.reasoning + t.cache_read + t.cache_write;
}

type PricingCoverageByProvider = {
  pricedKeysSeen: number;
  mappedMissingKeysSeen: number;
  unpricedKeysSeen: number;
};

const STATUS_SAMPLE_LIMIT = 5;

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join(" | ") : "(none)";
}

function fmtNanoGptMetric(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(Math.trunc(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function computePricingCoverageFromAgg(agg: Awaited<ReturnType<typeof aggregateUsage>>): {
  byProvider: Map<string, PricingCoverageByProvider>;
  totals: { pricedKeysSeen: number; mappedMissingKeysSeen: number; unpricedKeysSeen: number };
} {
  const byProvider = new Map<string, PricingCoverageByProvider>();
  let pricedKeysSeen = 0;
  let mappedMissingKeysSeen = 0;
  let unpricedKeysSeen = 0;

  // Priced keys seen in history
  for (const row of agg.byModel) {
    const p = row.key.provider;
    const existing = byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    existing.pricedKeysSeen += 1;
    byProvider.set(p, existing);
    pricedKeysSeen += 1;
  }

  // Keys that mapped to an official provider/model but were missing pricing
  for (const row of agg.unknown) {
    const p = row.key.mappedProvider;
    if (!p || !row.key.mappedModel) continue;
    const existing = byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    existing.mappedMissingKeysSeen += 1;
    byProvider.set(p, existing);
    mappedMissingKeysSeen += 1;
  }

  // Mapped keys that we explicitly consider unpriced
  for (const row of agg.unpriced) {
    const p = row.key.mappedProvider;
    const existing = byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    existing.unpricedKeysSeen += 1;
    byProvider.set(p, existing);
    unpricedKeysSeen += 1;
  }

  return { byProvider, totals: { pricedKeysSeen, mappedMissingKeysSeen, unpricedKeysSeen } };
}

function supportedProviderPricingRow(params: {
  id: string;
  agg: Awaited<ReturnType<typeof aggregateUsage>>;
  snapshotProviders: string[];
}): { id: string; pricing: "yes" | "partial" | "no"; notes: string } {
  const id = params.id;

  if (id === "firmware") {
    return {
      id,
      pricing: "no",
      notes: "credits-based quota (not token-priced)",
    };
  }

  if (id === "qwen-code") {
    return {
      id,
      pricing: "no",
      notes: "local request-count estimate (free tier, no token pricing API)",
    };
  }

  if (id === "alibaba-coding-plan") {
    return {
      id,
      pricing: "no",
      notes: "local request-count estimate (tiered rolling windows, no token pricing API)",
    };
  }

  if (id === "cursor") {
    return {
      id,
      pricing: "partial",
      notes: "API-pool models map to official pricing; Auto/Composer use bundled static Cursor rates",
    };
  }

  if (id === "nanogpt") {
    return {
      id,
      pricing: "no",
      notes: "subscription request quota + account balance (not token-priced)",
    };
  }

  // Providers that correspond directly to models.dev providers.
  if (params.snapshotProviders.includes(id)) {
    return { id, pricing: "yes", notes: "models.dev snapshot provider" };
  }

  // Connector to snapshot provider; treat as priced if snapshot has OpenAI pricing.
  // Copilot is an OpenCode provider but token costs still map into official model pricing.
  if (id === "copilot") {
    return snapshotHasProvider("openai")
      ? { id, pricing: "yes", notes: "connector (priced via models.dev openai)" }
      : { id, pricing: "partial", notes: "connector (pricing snapshot missing openai)" };
  }

  // Connector provider; maps to models.dev provider ids depending on model.
  if (id === "google-antigravity") {
    return snapshotHasProvider("google") || snapshotHasProvider("anthropic")
      ? { id, pricing: "yes", notes: "connector (priced via models.dev google/anthropic)" }
      : { id, pricing: "partial", notes: "connector (pricing snapshot missing google/anthropic)" };
  }

  // Connector providers: pricing exists when model IDs can be mapped into snapshot pricing keys.
  // Use local history as the source of truth.
  const hasAnyUsage = params.agg.bySourceProvider.some((p) => p.providerID === id);
  const hasAnyUnknown = params.agg.unknown.some((u) => u.key.sourceProviderID === id);

  // Note: agg.byModel is already mapped to official pricing keys, not source provider IDs.
  // So for connector providers we infer pricing availability based on whether we saw usage at all
  // and whether it was mappable.
  if (!hasAnyUsage && !hasAnyUnknown) {
    return { id, pricing: "no", notes: "no local usage observed" };
  }

  if (hasAnyUnknown) {
    return {
      id,
      pricing: "partial",
      notes: "some models not in snapshot (see unpriced_models / unknown_pricing)",
    };
  }

  return {
    id,
    pricing: "yes",
    notes: "model IDs map into snapshot pricing",
  };
}

export async function buildQuotaStatusReport(params: {
  configSource: string;
  configPaths: string[];
  enabledProviders: string[] | "auto";
  anthropicBinaryPath?: string;
  alibabaCodingPlanTier: "lite" | "pro";
  cursorPlan: CursorQuotaPlan;
  cursorIncludedApiUsd?: number;
  cursorBillingCycleStartDay?: number;
  pricingSnapshotSource: PricingSnapshotSource;
  onlyCurrentModel: boolean;
  currentModel?: string;
  /** Whether a session was available for model lookup */
  sessionModelLookup?: "ok" | "not_found" | "no_session";
  providerAvailability: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    matchesCurrentModel?: boolean;
  }>;
  googleRefresh?: {
    attempted: boolean;
    total?: number;
    successCount?: number;
    failures?: Array<{ email?: string; error: string }>;
  };
  sessionTokenError?: SessionTokenError;
  generatedAtMs?: number;
}): Promise<string> {
  const lines: string[] = [];

  const version = await getPackageVersion();
  const v = version ?? "unknown";

  lines.push(
    renderCommandHeading({
      title: `Quota Status (opencode-quota v${v}) (/quota_status)`,
      generatedAtMs: params.generatedAtMs,
    }),
  );
  lines.push("");

  // === toast diagnostics ===
  lines.push("toast:");
  lines.push(
    `- configSource: ${params.configSource}${params.configPaths.length ? ` (${params.configPaths.join(" | ")})` : ""}`,
  );
  lines.push(
    `- enabledProviders: ${params.enabledProviders === "auto" ? "(auto)" : params.enabledProviders.length ? params.enabledProviders.join(",") : "(none)"}`,
  );
  lines.push(`- onlyCurrentModel: ${params.onlyCurrentModel ? "true" : "false"}`);
  const modelDisplay = params.currentModel
    ? params.currentModel
    : params.sessionModelLookup === "not_found"
      ? "(error: session.get returned no modelID)"
      : params.sessionModelLookup === "no_session"
        ? "(no session available)"
        : "(unknown)";
  lines.push(`- currentModel: ${modelDisplay}`);
  lines.push("- providers:");
  for (const p of params.providerAvailability) {
    const bits: string[] = [];
    bits.push(p.enabled ? "enabled" : "disabled");
    bits.push(p.available ? "available" : "unavailable");
    if (p.matchesCurrentModel !== undefined) {
      bits.push(`matchesCurrentModel=${p.matchesCurrentModel ? "yes" : "no"}`);
    }
    lines.push(`  - ${p.id}: ${bits.join(" ")}`);
  }

  lines.push("");
  lines.push("paths:");

  const runtime = getOpencodeRuntimeDirs();
  lines.push(
    `- opencode_dirs: data=${runtime.dataDir} config=${runtime.configDir} cache=${runtime.cacheDir} state=${runtime.stateDir}`,
  );
  const authCandidates = getAuthPaths();
  const authPresent: string[] = [];
  await Promise.all(
    authCandidates.map(async (p) => {
      try {
        await stat(p);
        authPresent.push(p);
      } catch {
        // ignore missing/unreadable
      }
    }),
  );
  lines.push(
    `- auth.json: preferred=${getAuthPath()} present=${joinOrNone(authPresent)} candidates=${joinOrNone(authCandidates)}`,
  );

  const authData = await readAuthFileCached({ maxAgeMs: 5_000 });
  const qwenAuthConfigured = hasQwenOAuthAuth(authData);
  const qwenLocalPlan = resolveQwenLocalPlan(authData);
  const alibabaAuthConfigured = hasAlibabaAuth(authData);
  const alibabaCodingPlanAuth = resolveAlibabaCodingPlanAuth(authData, params.alibabaCodingPlanTier);
  lines.push(`- qwen oauth auth configured: ${qwenAuthConfigured ? "true" : "false"}`);
  lines.push(`- qwen_local_plan: ${qwenLocalPlan.state === "qwen_free" ? "qwen-code/free" : "(none)"}`);
  lines.push(`- alibaba auth configured: ${alibabaAuthConfigured ? "true" : "false"}`);
  lines.push(`- alibaba coding plan fallback tier: ${params.alibabaCodingPlanTier}`);
  lines.push(
    `- alibaba_coding_plan: ${alibabaCodingPlanAuth.state === "configured" ? alibabaCodingPlanAuth.tier : alibabaCodingPlanAuth.state === "invalid" ? "invalid" : "(none)"}`,
  );

  lines.push("");
  lines.push("anthropic:");
  try {
    const anthropicDiagnostics = await getAnthropicDiagnostics({
      binaryPath: params.anthropicBinaryPath,
    });
    lines.push(`- cli_installed: ${anthropicDiagnostics.installed ? "true" : "false"}`);
    lines.push(`- cli_version: ${anthropicDiagnostics.version ?? "(none)"}`);
    lines.push(`- auth_status: ${anthropicDiagnostics.authStatus}`);
    lines.push(`- quota_supported: ${anthropicDiagnostics.quotaSupported ? "true" : "false"}`);
    lines.push(
      `- quota_source: ${anthropicDiagnostics.quotaSource === "none" ? "(none)" : anthropicDiagnostics.quotaSource}`,
    );
    lines.push(
      `- checked_commands: ${anthropicDiagnostics.checkedCommands.length > 0 ? anthropicDiagnostics.checkedCommands.join(" | ") : "(none)"}`,
    );
    if (anthropicDiagnostics.message) {
      lines.push(`- message: ${anthropicDiagnostics.message}`);
    }
    if (anthropicDiagnostics.quotaSupported && anthropicDiagnostics.quota) {
      lines.push(
        `- five_hour_remaining: ${anthropicDiagnostics.quota.five_hour.percentRemaining}% reset_at=${anthropicDiagnostics.quota.five_hour.resetTimeIso ?? "(none)"}`,
      );
      lines.push(
        `- seven_day_remaining: ${anthropicDiagnostics.quota.seven_day.percentRemaining}% reset_at=${anthropicDiagnostics.quota.seven_day.resetTimeIso ?? "(none)"}`,
      );
    }
  } catch (err) {
    lines.push("- cli_installed: false");
    lines.push(
      `- message: failed to probe Claude CLI${
        err ? `: ${sanitizeDisplayText(err instanceof Error ? err.message : String(err))}` : ""
      }`,
    );
  }

  const cursorPlanLabel = getCursorPlanDisplayName(params.cursorPlan);
  const cursorIncludedApiUsd = getEffectiveCursorIncludedApiUsd({
    plan: params.cursorPlan,
    overrideUsd: params.cursorIncludedApiUsd,
  });
  const cursorAuth = await inspectCursorAuthPresence();
  const cursorIntegration = await inspectCursorOpenCodeIntegration();
  lines.push("");
  lines.push("cursor:");
  lines.push(`- plan: ${cursorPlanLabel ?? "none"}`);
  lines.push(
    `- included_api_usd: ${typeof cursorIncludedApiUsd === "number" ? fmtUsdAmount(cursorIncludedApiUsd) : "(none)"}`,
  );
  lines.push(
    `- billing_cycle_start_day: ${typeof params.cursorBillingCycleStartDay === "number" ? params.cursorBillingCycleStartDay : "(calendar month)"}`,
  );
  lines.push(`- auth_state: ${cursorAuth.state}`);
  lines.push(`- auth_selected_path: ${cursorAuth.selectedPath ?? "(none)"}`);
  lines.push(`- auth_present_paths: ${joinOrNone(cursorAuth.presentPaths)}`);
  lines.push(`- auth_candidate_paths: ${joinOrNone(cursorAuth.candidatePaths)}`);
  if (cursorAuth.error) {
    lines.push(`- auth_error: ${cursorAuth.error}`);
  }
  lines.push(`- plugin_enabled: ${cursorIntegration.pluginEnabled ? "true" : "false"}`);
  lines.push(`- provider_configured: ${cursorIntegration.providerConfigured ? "true" : "false"}`);
  lines.push(`- config_matches: ${joinOrNone(cursorIntegration.matchedPaths)}`);
  lines.push(`- config_checked_paths: ${joinOrNone(cursorIntegration.checkedPaths)}`);
  try {
    const cursorUsage = await getCurrentCursorUsageSummary({
      billingCycleStartDay: params.cursorBillingCycleStartDay,
    });
    lines.push(`- cycle_source: ${cursorUsage.window.source}`);
    lines.push(`- cycle_reset_at: ${cursorUsage.window.resetTimeIso}`);
    lines.push(`- api_usage: ${fmtUsdAmount(cursorUsage.api.costUsd)} across ${fmtInt(cursorUsage.api.messageCount)} messages`);
    lines.push(
      `- auto_composer_usage: ${fmtUsdAmount(cursorUsage.autoComposer.costUsd)} across ${fmtInt(cursorUsage.autoComposer.messageCount)} messages`,
    );
    lines.push(
      `- total_cursor_usage: ${fmtUsdAmount(cursorUsage.total.costUsd)} across ${fmtInt(cursorUsage.total.messageCount)} messages`,
    );
    lines.push(`- unknown_cursor_models: ${fmtInt(cursorUsage.unknownModels.length)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`- usage_error: ${msg}`);
  }

  const qwenLocalQuotaPath = getQwenLocalQuotaPath();
  const qwenLocalQuotaExists = await pathExists(qwenLocalQuotaPath);
  lines.push(
    `- qwen free local quota: path=${qwenLocalQuotaPath} exists=${qwenLocalQuotaExists ? "true" : "false"}`,
  );
  try {
    const qwenState = await readQwenLocalQuotaState();
    const qwenQuota = computeQwenQuota({ state: qwenState });
    const qwenUsageSuffix = qwenLocalQuotaExists ? "" : " (default state)";
    lines.push(
      `- qwen free local usage: daily=${qwenQuota.day.used}/${qwenQuota.day.limit} rpm=${qwenQuota.rpm.used}/${qwenQuota.rpm.limit}${qwenUsageSuffix}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`- qwen free local usage: error (${msg})`);
  }

  const alibabaLocalQuotaPath = getAlibabaCodingPlanQuotaPath();
  const alibabaLocalQuotaExists = await pathExists(alibabaLocalQuotaPath);
  lines.push(
    `- alibaba coding plan local quota: path=${alibabaLocalQuotaPath} exists=${alibabaLocalQuotaExists ? "true" : "false"}`,
  );
  if (alibabaCodingPlanAuth.state === "configured") {
    try {
      const alibabaState = await readAlibabaCodingPlanQuotaState();
      const alibabaQuota = computeAlibabaCodingPlanQuota({
        state: alibabaState,
        tier: alibabaCodingPlanAuth.tier,
      });
      const alibabaUsageSuffix = alibabaLocalQuotaExists ? "" : " (default state)";
      lines.push(
        `- alibaba coding plan usage: tier=${alibabaCodingPlanAuth.tier} 5h=${alibabaQuota.fiveHour.used}/${alibabaQuota.fiveHour.limit} weekly=${alibabaQuota.weekly.used}/${alibabaQuota.weekly.limit} monthly=${alibabaQuota.monthly.used}/${alibabaQuota.monthly.limit}${alibabaUsageSuffix}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`- alibaba coding plan usage: error (${msg})`);
    }
  } else if (alibabaCodingPlanAuth.state === "invalid") {
    lines.push(`- alibaba coding plan error: ${alibabaCodingPlanAuth.error}`);
  }

  lines.push("");
  lines.push("minimax:");
  const minimaxAuth = await resolveMiniMaxAuthCached({
    maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  });
  lines.push(`- auth_state: ${minimaxAuth.state}`);
  lines.push(`- api_key_configured: ${minimaxAuth.state === "configured" ? "true" : "false"}`);
  if (minimaxAuth.state === "invalid") {
    lines.push(`- auth_error: ${sanitizeDisplayText(minimaxAuth.error)}`);
  }
  if (minimaxAuth.state === "configured") {
    const minimaxQuota = await queryMiniMaxQuota(minimaxAuth.apiKey);
    if (!minimaxQuota.success) {
      lines.push(`- live_fetch_error: ${minimaxQuota.error}`);
    } else {
      const fiveHourEntry = minimaxQuota.entries.find((entry) => entry.window === "five_hour");
      const weeklyEntry = minimaxQuota.entries.find((entry) => entry.window === "weekly");
      if (fiveHourEntry) {
        lines.push(
          `- five_hour_usage: ${fiveHourEntry.right ?? "(none)"} percent_remaining=${fiveHourEntry.percentRemaining} reset_at=${fiveHourEntry.resetTimeIso ?? "(none)"}`,
        );
      }
      if (weeklyEntry) {
        lines.push(
          `- weekly_usage: ${weeklyEntry.right ?? "(none)"} percent_remaining=${weeklyEntry.percentRemaining} reset_at=${weeklyEntry.resetTimeIso ?? "(none)"}`,
        );
      }
      if (!fiveHourEntry && !weeklyEntry) {
        lines.push("- live_state: no reportable MiniMax Coding Plan quota");
      }
    }
  }

  // Firmware API key diagnostics
  lines.push("");
  lines.push("firmware:");
  let firmwareDiag: { configured: boolean; source: string | null; checkedPaths: string[] } = {
    configured: false,
    source: null,
    checkedPaths: [],
  };
  try {
    firmwareDiag = await getFirmwareKeyDiagnostics();
  } catch {
    // ignore
  }
  lines.push(
    `- firmware api key: configured=${firmwareDiag.configured ? "true" : "false"}${firmwareDiag.source ? ` source=${firmwareDiag.source}` : ""}${firmwareDiag.checkedPaths.length > 0 ? ` checked=${firmwareDiag.checkedPaths.join(" | ")}` : ""}`,
  );

  // Chutes API key diagnostics
  lines.push("");
  lines.push("chutes:");
  let chutesDiag: { configured: boolean; source: string | null; checkedPaths: string[] } = {
    configured: false,
    source: null,
    checkedPaths: [],
  };
  try {
    chutesDiag = await getChutesKeyDiagnostics();
  } catch {
    // ignore
  }
  lines.push(
    `- chutes api key: configured=${chutesDiag.configured ? "true" : "false"}${chutesDiag.source ? ` source=${chutesDiag.source}` : ""}${chutesDiag.checkedPaths.length > 0 ? ` checked=${chutesDiag.checkedPaths.join(" | ")}` : ""}`,
  );

  lines.push("");
  lines.push("nanogpt:");
  let nanoGptDiag: {
    configured: boolean;
    source: string | null;
    checkedPaths: string[];
    authPaths: string[];
  } = {
    configured: false,
    source: null,
    checkedPaths: [],
    authPaths: [],
  };
  try {
    nanoGptDiag = await getNanoGptKeyDiagnostics();
  } catch {
    // ignore
  }
  lines.push(`- api_key_configured: ${nanoGptDiag.configured ? "true" : "false"}`);
  lines.push(`- api_key_source: ${nanoGptDiag.source ?? "(none)"}`);
  lines.push(`- api_key_checked_paths: ${joinOrNone(nanoGptDiag.checkedPaths)}`);
  lines.push(`- api_key_auth_paths: ${joinOrNone(nanoGptDiag.authPaths)}`);
  if (nanoGptDiag.configured) {
    try {
      const nanoGptQuota = await queryNanoGptQuota();
      if (!nanoGptQuota) {
        lines.push("- live_fetch_error: NanoGPT API key became unavailable before fetch");
      } else if (!nanoGptQuota.success) {
        lines.push(`- live_fetch_error: ${nanoGptQuota.error}`);
      } else {
        if (nanoGptQuota.subscription) {
          lines.push(
            `- subscription_active: ${nanoGptQuota.subscription.active ? "true" : "false"}`,
          );
          lines.push(`- subscription_state: ${nanoGptQuota.subscription.state}`);
          lines.push(
            `- enforce_daily_limit: ${nanoGptQuota.subscription.enforceDailyLimit ? "true" : "false"}`,
          );
          if (nanoGptQuota.subscription.daily) {
            const daily = nanoGptQuota.subscription.daily;
            lines.push(
              `- daily_usage: ${fmtNanoGptMetric(daily.used)}/${fmtNanoGptMetric(daily.limit)} remaining=${fmtNanoGptMetric(daily.remaining)} percent_remaining=${daily.percentRemaining} reset_at=${daily.resetTimeIso ?? "(none)"}`,
            );
          }
          if (nanoGptQuota.subscription.monthly) {
            const monthly = nanoGptQuota.subscription.monthly;
            lines.push(
              `- monthly_usage: ${fmtNanoGptMetric(monthly.used)}/${fmtNanoGptMetric(monthly.limit)} remaining=${fmtNanoGptMetric(monthly.remaining)} percent_remaining=${monthly.percentRemaining} reset_at=${monthly.resetTimeIso ?? "(none)"}`,
            );
          }
          lines.push(
            `- billing_period_end: ${nanoGptQuota.subscription.currentPeriodEndIso ?? "(none)"}`,
          );
          if (nanoGptQuota.subscription.graceUntilIso) {
            lines.push(`- grace_until: ${nanoGptQuota.subscription.graceUntilIso}`);
          }
        }
        lines.push(
          `- balance_usd: ${typeof nanoGptQuota.balance?.usdBalance === "number" ? fmtUsdAmount(nanoGptQuota.balance.usdBalance) : "(none)"}`,
        );
        lines.push(`- balance_nano: ${nanoGptQuota.balance?.nanoBalanceRaw ?? "(none)"}`);
        for (const entry of nanoGptQuota.endpointErrors ?? []) {
          lines.push(`- live_error_${entry.endpoint}: ${entry.message}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`- live_fetch_error: ${msg}`);
    }
  }

  const copilotDiag = getCopilotQuotaAuthDiagnostics(authData);
  lines.push("");
  lines.push("copilot_quota_auth:");
  lines.push(`- pat_state: ${copilotDiag.pat.state}`);
  if (copilotDiag.pat.selectedPath) {
    lines.push(`- pat_path: ${copilotDiag.pat.selectedPath}`);
  }
  if (copilotDiag.pat.tokenKind) {
    lines.push(`- pat_token_kind: ${copilotDiag.pat.tokenKind}`);
  }
  if (copilotDiag.pat.config?.tier) {
    lines.push(`- pat_tier: ${copilotDiag.pat.config.tier}`);
  }
  if (copilotDiag.pat.config?.organization) {
    lines.push(`- pat_organization: ${copilotDiag.pat.config.organization}`);
  }
  if (copilotDiag.pat.config?.enterprise) {
    lines.push(`- pat_enterprise: ${copilotDiag.pat.config.enterprise}`);
  }
  lines.push(`- billing_mode: ${copilotDiag.billingMode}`);
  lines.push(`- billing_scope: ${copilotDiag.billingScope}`);
  lines.push(`- quota_api: ${copilotDiag.quotaApi}`);
  lines.push(`- billing_api_access_likely: ${copilotDiag.billingApiAccessLikely ? "true" : "false"}`);
  lines.push(`- remaining_totals_state: ${copilotDiag.remainingTotalsState}`);
  if (copilotDiag.queryPeriod) {
    lines.push(`- billing_period: ${copilotDiag.queryPeriod.year}-${String(copilotDiag.queryPeriod.month).padStart(2, "0")}`);
  }
  if (copilotDiag.usernameFilter) {
    lines.push(`- username_filter: ${copilotDiag.usernameFilter}`);
  }
  if (copilotDiag.billingMode === "organization_usage") {
    lines.push("- billing_usage_note: organization premium usage for the current billing period");
    lines.push("- remaining_quota_note: valid PAT access can query billing usage, but pooled org usage does not provide a true per-user remaining quota");
  }
  if (copilotDiag.billingMode === "enterprise_usage") {
    lines.push("- billing_usage_note: enterprise premium usage for the current billing period");
    lines.push("- remaining_quota_note: valid enterprise billing access can query pooled enterprise usage, but it does not provide a true per-user remaining quota");
  }
  if (copilotDiag.billingTargetError) {
    lines.push(`- billing_target_error: ${copilotDiag.billingTargetError}`);
  }
  if (copilotDiag.tokenCompatibilityError) {
    lines.push(`- token_compatibility_error: ${copilotDiag.tokenCompatibilityError}`);
  }
  if (copilotDiag.pat.error) {
    lines.push(`- pat_error: ${copilotDiag.pat.error}`);
  }
  lines.push(
    `- pat_checked_paths: ${copilotDiag.pat.checkedPaths.length ? copilotDiag.pat.checkedPaths.join(" | ") : "(none)"}`,
  );
  lines.push(
    `- oauth_configured: ${copilotDiag.oauth.configured ? "true" : "false"} key=${copilotDiag.oauth.keyName ?? "(none)"} refresh=${copilotDiag.oauth.hasRefreshToken ? "true" : "false"} access=${copilotDiag.oauth.hasAccessToken ? "true" : "false"}`,
  );
  lines.push(`- effective_source: ${copilotDiag.effectiveSource}`);
  lines.push(`- override: ${copilotDiag.override}`);
  const googleTokenCachePath = getGoogleTokenCachePath();
  lines.push(
    `- google token cache: path=${googleTokenCachePath} exists=${(await pathExists(googleTokenCachePath)) ? "true" : "false"}`,
  );

  const candidates = getAntigravityAccountsCandidatePaths();
  const presentCandidates: string[] = [];
  await Promise.all(
    candidates.map(async (p) => {
      if (await pathExists(p)) presentCandidates.push(p);
    }),
  );
  const selected = presentCandidates[0] ?? null;
  lines.push(
    `- antigravity accounts: selected=${selected ?? "(none)"} present=${joinOrNone(presentCandidates)} candidates=${joinOrNone(candidates)}`,
  );

  const dbCandidates = getOpenCodeDbPathCandidates();
  const dbSelected = getOpenCodeDbPath();
  const dbPresent: string[] = [];
  await Promise.all(
    dbCandidates.map(async (p) => {
      if (await pathExists(p)) dbPresent.push(p);
    }),
  );

  lines.push(
    `- opencode db: preferred=${dbSelected} present=${joinOrNone(dbPresent)} candidates=${joinOrNone(dbCandidates)}`,
  );

  if (params.googleRefresh?.attempted) {
    lines.push("");
    lines.push("google_token_refresh:");
    if (
      typeof params.googleRefresh.total === "number" &&
      typeof params.googleRefresh.successCount === "number"
    ) {
      lines.push(`- refreshed: ${params.googleRefresh.successCount}/${params.googleRefresh.total}`);
    } else {
      lines.push("- attempted");
    }
    for (const f of params.googleRefresh.failures ?? []) {
      lines.push(`- ${f.email ?? "Unknown"}: ${f.error}`);
    }
  }

  let accountCount = 0;
  try {
    const accounts = await readAntigravityAccounts();
    accountCount = accounts?.length ?? 0;
  } catch {
    accountCount = 0;
  }
  lines.push("");
  lines.push(`google accounts: count=${accountCount}`);

  // === session token errors ===
  if (params.sessionTokenError) {
    lines.push("");
    lines.push("session_tokens_error:");
    lines.push(`- session_id: ${params.sessionTokenError.sessionID}`);
    lines.push(`- error: ${params.sessionTokenError.error}`);
    if (params.sessionTokenError.checkedPath) {
      lines.push(`- checked_path: ${params.sessionTokenError.checkedPath}`);
    }
  }

  // === storage scan ===
  const dbStats = await getOpenCodeDbStats();
  lines.push("");
  lines.push("storage:");
  lines.push(`- sessions_in_db: ${fmtInt(dbStats.sessionCount)}`);
  lines.push(`- messages_in_db: ${fmtInt(dbStats.messageCount)}`);
  lines.push(`- assistant_messages_in_db: ${fmtInt(dbStats.assistantMessageCount)}`);

  // === pricing snapshot ===
  // We intentionally compute all-time usage once so that pricing coverage and unknown_pricing
  // are consistent and do not require multiple storage scans.
  const agg = await aggregateUsage({});
  const meta = getPricingSnapshotMeta();
  const providers = listProviders();
  const coverage = computePricingCoverageFromAgg(agg);
  const refreshPolicy = getPricingRefreshPolicy();
  const autoRefreshDays = Math.round(refreshPolicy.maxAgeMs / (24 * 60 * 60 * 1000));
  const health = getPricingSnapshotHealth({
    maxAgeMs: refreshPolicy.maxAgeMs,
  });
  const snapshotSource = getPricingSnapshotSource();
  const runtimeSnapshotPath = getRuntimePricingSnapshotPath();
  const refreshStatePath = getRuntimePricingRefreshStatePath();
  const pricingRefreshState = await readPricingRefreshState();

  lines.push("");
  lines.push("pricing_snapshot:");
  lines.push(
    `- pricing: source=${meta.source} active_source=${snapshotSource} generated_at=${new Date(meta.generatedAt).toISOString()} units=${meta.units}`,
  );
  lines.push(
    `- selection: configured=${params.pricingSnapshotSource} active=${snapshotSource}`,
  );
  if (params.pricingSnapshotSource === "bundled") {
    lines.push(
      "- selection_note: bundled config pins the packaged snapshot and ignores runtime refresh for active pricing",
    );
  } else if (params.pricingSnapshotSource === "runtime" && snapshotSource !== "runtime") {
    lines.push(
      "- selection_note: runtime config requested the local runtime snapshot, but bundled fallback is active because no valid runtime snapshot is available",
    );
  }
  lines.push(`- runtime_paths: snapshot=${runtimeSnapshotPath} refresh_state=${refreshStatePath}`);
  lines.push(
    `- staleness: age_ms=${fmtInt(health.ageMs)} max_age_ms=${fmtInt(health.maxAgeMs)} stale=${health.stale ? "true" : "false"}`,
  );
  lines.push(`- refresh_policy: auto_refresh_days=${fmtInt(autoRefreshDays)}`);
  if (pricingRefreshState) {
    lines.push(
      `- refresh: last_attempt_at=${pricingRefreshState.lastAttemptAt ? new Date(pricingRefreshState.lastAttemptAt).toISOString() : "(none)"} last_success_at=${pricingRefreshState.lastSuccessAt ? new Date(pricingRefreshState.lastSuccessAt).toISOString() : "(none)"} last_failure_at=${pricingRefreshState.lastFailureAt ? new Date(pricingRefreshState.lastFailureAt).toISOString() : "(none)"} last_result=${pricingRefreshState.lastResult ?? "(none)"}`,
    );
    if (pricingRefreshState.lastError) {
      lines.push(`- refresh_error: ${pricingRefreshState.lastError}`);
    }
  } else {
    lines.push("- refresh: (no runtime refresh state yet)");
  }
  lines.push(`- providers: ${providers.join(",")}`);
  lines.push(
    `- coverage_seen: priced_keys=${fmtInt(coverage.totals.pricedKeysSeen)} mapped_but_missing=${fmtInt(coverage.totals.mappedMissingKeysSeen)} unpriced_keys=${fmtInt(coverage.totals.unpricedKeysSeen)}`,
  );
  for (const p of providers) {
    const c = coverage.byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    lines.push(
      `  - ${p}: models=${fmtInt(getProviderModelCount(p))} priced_models_seen=${fmtInt(c.pricedKeysSeen)} mapped_but_missing_models_seen=${fmtInt(c.mappedMissingKeysSeen)} unpriced_models_seen=${fmtInt(c.unpricedKeysSeen)}`,
    );
  }

  // === supported providers pricing ===
  const supported = getProviders().map((p) => p.id);
  lines.push("");
  lines.push("supported_providers_pricing:");
  for (const id of supported) {
    const row = supportedProviderPricingRow({ id, agg, snapshotProviders: providers });
    lines.push(`- ${row.id}: pricing=${row.pricing} (${row.notes})`);
  }

  // === unpriced models ===
  // Mapped keys that are deterministically not token-priced by our snapshot.
  lines.push("");
  lines.push("unpriced_models:");
  if (agg.unpriced.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      `- keys: ${fmtInt(agg.unpriced.length)} tokens_total=${fmtInt(tokensTotal(agg.totals.unpriced))}`,
    );
    for (const row of agg.unpriced.slice(0, STATUS_SAMPLE_LIMIT)) {
      const src = `${row.key.sourceProviderID}/${row.key.sourceModelID}`;
      const mapped = `${row.key.mappedProvider}/${row.key.mappedModel}`;
      lines.push(
        `- ${src} mapped=${mapped} tokens=${fmtInt(tokensTotal(row.tokens))} msgs=${fmtInt(row.messageCount)} reason=${row.key.reason}`,
      );
    }
    if (agg.unpriced.length > STATUS_SAMPLE_LIMIT) {
      lines.push(`- ... (${fmtInt(agg.unpriced.length - STATUS_SAMPLE_LIMIT)} more)`);
    }
  }

  // === unknown pricing ===
  // We intentionally report unknowns for *all time* so users can see what needs mapping.
  lines.push("");
  lines.push("unknown_pricing:");
  if (agg.unknown.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      `- keys: ${fmtInt(agg.unknown.length)} tokens_total=${fmtInt(tokensTotal(agg.totals.unknown))}`,
    );
    for (const row of agg.unknown.slice(0, STATUS_SAMPLE_LIMIT)) {
      const src = `${row.key.sourceProviderID}/${row.key.sourceModelID}`;
      const mappedBase =
        row.key.mappedProvider && row.key.mappedModel
          ? `${row.key.mappedProvider}/${row.key.mappedModel}`
          : "(none)";
      const candidates =
        row.key.providerCandidates && row.key.providerCandidates.length > 0
          ? ` candidates=${row.key.providerCandidates.join(",")}`
          : "";
      lines.push(
        `- ${src} mapped=${mappedBase}${candidates} tokens=${fmtInt(tokensTotal(row.tokens))} msgs=${fmtInt(row.messageCount)}`,
      );
    }
    if (agg.unknown.length > STATUS_SAMPLE_LIMIT) {
      lines.push(`- ... (${fmtInt(agg.unknown.length - STATUS_SAMPLE_LIMIT)} more)`);
    }
  }

  return lines.join("\n");
}
