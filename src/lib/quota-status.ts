import { stat } from "fs/promises";

import { getAuthPath, getAuthPaths, readAuthFileCached } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getGoogleTokenCachePath } from "./google-token-cache.js";
import { inspectAntigravityCompanionPresence } from "./google-antigravity-companion.js";
import { inspectGeminiCliCompanionPresence } from "./google-gemini-cli-companion.js";
import { inspectGeminiCliAuthPresence } from "./google-gemini-cli.js";
import { inspectAntigravityAccountsPresence } from "./google.js";
import { getAnthropicDiagnostics } from "./anthropic.js";
import { getChutesKeyDiagnostics } from "./chutes.js";
import { getNanoGptKeyDiagnostics, queryNanoGptQuota } from "./nanogpt.js";
import { getSyntheticKeyDiagnostics } from "./synthetic.js";
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
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  getAlibabaCodingPlanAuthDiagnostics,
  resolveAlibabaCodingPlanAuthCached,
} from "./alibaba-auth.js";
import { hasQwenOAuthAuth, resolveQwenLocalPlan } from "./qwen-auth.js";
import { resolveOpenAIOAuth } from "./openai.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  getMiniMaxAuthDiagnostics,
  resolveMiniMaxAuthCached,
} from "./minimax-auth.js";
import { DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS, getZaiAuthDiagnostics } from "./zai-auth.js";
import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  getKimiAuthDiagnostics,
  resolveKimiAuthCached,
} from "./kimi-auth.js";
import { queryKimiQuota } from "./kimi.js";
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
import { fmtUsdAmount } from "./format-utils.js";
import { renderPlainTextReport, type ReportKvRow, type ReportSection } from "./report-document.js";
import { totalTokenBuckets } from "./token-buckets.js";
import {
  CURSOR_CANONICAL_PLUGIN_PACKAGE,
  inspectCursorAuthPresence,
  inspectCursorOpenCodeIntegration,
} from "./cursor-detection.js";
import { getCurrentCursorUsageSummary } from "./cursor-usage.js";
import {
  sanitizeSingleLineDisplaySnippet,
  sanitizeSingleLineDisplayText,
  sanitizeDisplayText,
  sanitizeQuotaProviderResult,
} from "./display-sanitize.js";
import {
  QUOTA_TOAST_SETTING_SOURCE_KEYS,
  type LoadConfigIssue,
  type QuotaToastSettingSources,
} from "./config.js";
import { getCursorPlanDisplayName, getEffectiveCursorIncludedApiUsd } from "./cursor-pricing.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import type { QuotaProviderResult, QuotaToastEntry, QuotaToastError } from "./entries.js";
import { isValueEntry } from "./entries.js";
import type { CursorQuotaPlan, PricingSnapshotSource } from "./types.js";
import { queryMiniMaxQuota } from "../providers/minimax-coding-plan.js";
import { queryZaiQuota } from "./zai.js";
import {
  getOpenCodeGoConfigDiagnostics,
  resolveOpenCodeGoConfigCached,
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
} from "./opencode-go-config.js";
import { queryOpenCodeGoQuota } from "./opencode-go.js";

/** Session token fetch error info for status report */
export interface SessionTokenError {
  sessionID: string;
  error: string;
  checkedPath?: string;
}

type BasicApiKeyDiagnostics = {
  configured: boolean;
  source: string | null;
  checkedPaths: string[];
};

type NanoGptApiKeyDiagnostics = BasicApiKeyDiagnostics & {
  authPaths: string[];
};

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

type ConfigClient = {
  config?: {
    get?: () => Promise<{ data?: unknown }>;
  };
};

type PricingCoverageByProvider = {
  pricedKeysSeen: number;
  mappedMissingKeysSeen: number;
  unpricedKeysSeen: number;
};

const STATUS_SAMPLE_LIMIT = 5;
const STATUS_LIVE_ENTRY_LIMIT = 2;
const STATUS_LIVE_ERROR_LIMIT = 2;
const STATUS_LIVE_ROW_MAX_LENGTH = 120;

type ProviderLiveProbe = {
  providerId: string;
  result: QuotaProviderResult;
};

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join(" | ") : "(none)";
}

function formatSettingSources(sources: QuotaToastSettingSources | undefined): string {
  if (!sources) return "(none)";

  const parts = QUOTA_TOAST_SETTING_SOURCE_KEYS.filter(
    (key) => typeof sources[key] === "string" && sources[key].length > 0,
  ).map((key) => `${key}<=${sources[key]}`);

  return parts.length > 0 ? parts.join(" | ") : "(none)";
}

function getConfigPrecedenceLabel(configSource: string): string {
  switch (configSource) {
    case "files":
      return "global defaults -> workspace overrides";
    case "sdk":
      return "sdk fallback (no file-backed config)";
    case "defaults":
      return "built-in defaults only";
    default:
      return configSource;
  }
}

function getDefaultBasicApiKeyDiagnostics(): BasicApiKeyDiagnostics {
  return {
    configured: false,
    source: null,
    checkedPaths: [],
  };
}

async function readBasicApiKeyDiagnostics(
  read: () => Promise<BasicApiKeyDiagnostics>,
): Promise<BasicApiKeyDiagnostics> {
  try {
    return await read();
  } catch {
    return getDefaultBasicApiKeyDiagnostics();
  }
}

function formatInlineApiKeyDiagnosticsValue(diagnostics: BasicApiKeyDiagnostics): string {
  return `configured=${diagnostics.configured ? "true" : "false"}${diagnostics.source ? ` source=${diagnostics.source}` : ""}${diagnostics.checkedPaths.length > 0 ? ` checked=${diagnostics.checkedPaths.join(" | ")}` : ""}`;
}

function createKvSection(id: string, title: string, rows: ReportKvRow[]): ReportSection {
  return {
    id,
    title,
    blocks: [{ kind: "kv", rows }],
  };
}

function createLinesSection(id: string, title: string, lines: string[]): ReportSection {
  return {
    id,
    title,
    blocks: [{ kind: "lines", lines }],
  };
}

function normalizeLiveProbeText(value: string): string {
  return sanitizeSingleLineDisplayText(value).replace(/:+$/u, "").toLowerCase();
}

function isRedundantLiveProbeDescriptor(providerId: string, value?: string): boolean {
  if (!value) return true;

  const normalized = normalizeLiveProbeText(value);
  if (!normalized) return true;

  return (
    normalized === normalizeLiveProbeText(providerId) ||
    normalized === normalizeLiveProbeText(getQuotaProviderDisplayLabel(providerId))
  );
}

function findProviderLiveProbe(
  providerId: string,
  probes?: ProviderLiveProbe[],
): ProviderLiveProbe | undefined {
  return probes?.find((probe) => probe.providerId === providerId);
}

function appendProviderCompactLiveProbeRows(
  rows: ReportKvRow[],
  providerId: string,
  probes?: ProviderLiveProbe[],
): void {
  appendCompactLiveProbeRows(rows, providerId, findProviderLiveProbe(providerId, probes));
}

function createCompactLiveProbeOnlySection(params: {
  id: string;
  title: string;
  providerId: string;
  probes?: ProviderLiveProbe[];
}): ReportSection | null {
  const probe = findProviderLiveProbe(params.providerId, params.probes);
  if (!probe) {
    return null;
  }

  const rows: ReportKvRow[] = [];
  appendCompactLiveProbeRows(rows, params.providerId, probe);
  return createKvSection(params.id, params.title, rows);
}

function getCompactLiveProbeDescriptor(providerId: string, entry: QuotaToastEntry): string | undefined {
  const candidates = [entry.label, entry.name, entry.group];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = sanitizeSingleLineDisplayText(candidate);
    if (!cleaned || isRedundantLiveProbeDescriptor(providerId, cleaned)) {
      continue;
    }
    return cleaned;
  }
  return undefined;
}

function formatCompactLiveProbeEntry(providerId: string, entry: QuotaToastEntry): string {
  const parts: string[] = [];
  const descriptor = getCompactLiveProbeDescriptor(providerId, entry);
  if (descriptor) {
    parts.push(descriptor);
  }

  if (isValueEntry(entry)) {
    parts.push(`value=${sanitizeSingleLineDisplayText(entry.value)}`);
  } else {
    if (entry.right) {
      parts.push(sanitizeSingleLineDisplayText(entry.right));
    }
    const percentRemaining = Number.isFinite(entry.percentRemaining)
      ? Math.max(0, Math.min(100, Math.round(entry.percentRemaining)))
      : 0;
    parts.push(`percent_remaining=${percentRemaining}`);
  }

  if (entry.resetTimeIso) {
    parts.push(`reset_at=${sanitizeSingleLineDisplayText(entry.resetTimeIso)}`);
  }

  return sanitizeSingleLineDisplaySnippet(parts.join(" "), STATUS_LIVE_ROW_MAX_LENGTH);
}

function formatCompactLiveProbeError(providerId: string, error: QuotaToastError): string {
  const label = isRedundantLiveProbeDescriptor(providerId, error.label)
    ? ""
    : sanitizeSingleLineDisplayText(error.label);
  const message = sanitizeSingleLineDisplayText(error.message);
  return sanitizeSingleLineDisplaySnippet(
    label ? `${label}: ${message}` : message,
    STATUS_LIVE_ROW_MAX_LENGTH,
  );
}

function appendCompactLiveProbeRows(
  rows: ReportKvRow[],
  providerId: string,
  probe?: ProviderLiveProbe,
): void {
  if (!probe) return;

  const result = sanitizeQuotaProviderResult(probe.result);
  const entryCount = Math.min(result.entries.length, STATUS_LIVE_ENTRY_LIMIT);
  const errorCount = Math.min(result.errors.length, STATUS_LIVE_ERROR_LIMIT);
  const state =
    result.entries.length > 0 ? "success" : result.errors.length > 0 ? "error" : "no_data";

  rows.push({ key: "live_probe", value: state });

  for (let index = 0; index < entryCount; index += 1) {
    rows.push({
      key: `live_entry_${index + 1}`,
      value: formatCompactLiveProbeEntry(providerId, result.entries[index]!),
    });
  }

  for (let index = 0; index < errorCount; index += 1) {
    rows.push({
      key: `live_error_${index + 1}`,
      value: formatCompactLiveProbeError(providerId, result.errors[index]!),
    });
  }

  const suppressedCount =
    Math.max(0, result.entries.length - entryCount) + Math.max(0, result.errors.length - errorCount);
  if (suppressedCount > 0) {
    rows.push({
      key: "live_more",
      value: `+${suppressedCount} additional rows suppressed`,
    });
  }
}

function getDefaultNanoGptApiKeyDiagnostics(): NanoGptApiKeyDiagnostics {
  return {
    ...getDefaultBasicApiKeyDiagnostics(),
    authPaths: [],
  };
}

async function readNanoGptApiKeyDiagnostics(
  read: () => Promise<NanoGptApiKeyDiagnostics>,
): Promise<NanoGptApiKeyDiagnostics> {
  try {
    return await read();
  } catch {
    return getDefaultNanoGptApiKeyDiagnostics();
  }
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

  if (id === "synthetic") {
    return {
      id,
      pricing: "no",
      notes: "subscription request quota (not token-priced)",
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
      notes:
        "API-pool models map to official pricing; Auto/Composer use bundled static Cursor rates",
    };
  }

  if (id === "nanogpt") {
    return {
      id,
      pricing: "no",
      notes: "subscription request quota + account balance (not token-priced)",
    };
  }

  if (id === "opencode-go") {
    return {
      id,
      pricing: "no",
      notes: "subscription percentage quota via dashboard scraping (not token-priced)",
    };
  }

  if (id === "kimi-code") {
    return {
      id,
      pricing: "no",
      notes: "request quota via Kimi Code API (not token-priced)",
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

  if (id === "google-gemini-cli") {
    return snapshotHasProvider("google")
      ? { id, pricing: "yes", notes: "connector (priced via models.dev google)" }
      : { id, pricing: "partial", notes: "connector (pricing snapshot missing google)" };
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
  globalConfigPaths?: string[];
  workspaceConfigPaths?: string[];
  settingSources?: QuotaToastSettingSources;
  configIssues?: LoadConfigIssue[];
  /** @deprecated compatibility only; not rendered */
  networkSettingSources?: Record<string, string>;
  tuiDiagnostics?: {
    workspaceRoot: string;
    configRoot: string;
    configured: boolean;
    inferredSelectedPath: string | null;
    presentPaths: string[];
    candidatePaths: string[];
    quotaPluginConfigured: boolean;
    quotaPluginConfigPaths: string[];
  };
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
  providerLiveProbes?: ProviderLiveProbe[];
  googleRefresh?: {
    attempted: boolean;
    total?: number;
    successCount?: number;
    failures?: Array<{ email?: string; error: string }>;
  };
  sessionTokenError?: SessionTokenError;
  geminiCliClient?: ConfigClient;
  generatedAtMs?: number;
}): Promise<string> {
  const version = await getPackageVersion();
  const v = version ?? "unknown";
  const modelDisplay = params.currentModel
    ? params.currentModel
    : params.sessionModelLookup === "not_found"
      ? "(error: session.get returned no modelID)"
      : params.sessionModelLookup === "no_session"
        ? "(no session available)"
        : "(unknown)";
  const sections: ReportSection[] = [];

  // === toast diagnostics ===
  const toastLines: string[] = [
    `- configSource: ${params.configSource}`,
    `- configPaths: ${joinOrNone(params.configPaths)}`,
    `- precedence: ${getConfigPrecedenceLabel(params.configSource)}`,
    `- global_config_paths: ${joinOrNone(params.globalConfigPaths ?? [])}`,
    `- workspace_config_paths: ${joinOrNone(params.workspaceConfigPaths ?? [])}`,
    `- setting_sources: ${formatSettingSources(params.settingSources)}`,
    `- enabledProviders: ${params.enabledProviders === "auto" ? "(auto)" : params.enabledProviders.length ? params.enabledProviders.join(",") : "(none)"}`,
    `- onlyCurrentModel: ${params.onlyCurrentModel ? "true" : "false"}`,
    `- currentModel: ${modelDisplay}`,
  ];
  if (params.configIssues?.length) {
    toastLines.push("- config_errors:");
    for (const issue of params.configIssues) {
      toastLines.push(
        `  - ${sanitizeSingleLineDisplayText(issue.path)} ${sanitizeSingleLineDisplayText(issue.key)}: ${sanitizeSingleLineDisplayText(issue.message)}`,
      );
    }
  }
  if (params.tuiDiagnostics) {
    toastLines.push("");
    toastLines.push("tui:");
    toastLines.push(`- workspace_root: ${params.tuiDiagnostics.workspaceRoot}`);
    toastLines.push(`- config_root: ${params.tuiDiagnostics.configRoot}`);
    toastLines.push(`- config_configured: ${params.tuiDiagnostics.configured ? "true" : "false"}`);
    toastLines.push(
      `- inferred_selected_config_path: ${params.tuiDiagnostics.inferredSelectedPath ?? "(none)"}`,
    );
    toastLines.push(`- present_config_paths: ${joinOrNone(params.tuiDiagnostics.presentPaths)}`);
    toastLines.push(`- candidate_config_paths: ${joinOrNone(params.tuiDiagnostics.candidatePaths)}`);
    toastLines.push(
      `- quota_plugin_configured: ${params.tuiDiagnostics.quotaPluginConfigured ? "true" : "false"}`,
    );
    toastLines.push(`- quota_plugin_paths: ${joinOrNone(params.tuiDiagnostics.quotaPluginConfigPaths)}`);
  }
  toastLines.push("- providers:");
  for (const p of params.providerAvailability) {
    const bits: string[] = [];
    bits.push(p.enabled ? "enabled" : "disabled");
    bits.push(p.available ? "available" : "unavailable");
    if (p.matchesCurrentModel !== undefined) {
      bits.push(`matchesCurrentModel=${p.matchesCurrentModel ? "yes" : "no"}`);
    }
    toastLines.push(`  - ${p.id}: ${bits.join(" ")}`);
  }
  sections.push(createLinesSection("toast", "toast:", toastLines));

  // === paths ===
  const pathsRows: ReportKvRow[] = [];
  const runtime = getOpencodeRuntimeDirs();
  pathsRows.push({
    key: "opencode_dirs",
    value: `data=${runtime.dataDir} config=${runtime.configDir} cache=${runtime.cacheDir} state=${runtime.stateDir}`,
  });
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
  pathsRows.push({
    key: "auth.json",
    value: `preferred=${getAuthPath()} present=${joinOrNone(authPresent)} candidates=${joinOrNone(authCandidates)}`,
  });

  const authData = await readAuthFileCached({ maxAgeMs: 5_000 });
  const qwenAuthConfigured = hasQwenOAuthAuth(authData);
  const qwenLocalPlan = resolveQwenLocalPlan(authData);
  const openaiAuth = resolveOpenAIOAuth(authData);
  const alibabaAuthDiagnostics = await getAlibabaCodingPlanAuthDiagnostics({
    maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
    fallbackTier: params.alibabaCodingPlanTier,
  });
  const alibabaCodingPlanAuth = await resolveAlibabaCodingPlanAuthCached({
    maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
    fallbackTier: params.alibabaCodingPlanTier,
  });
  pathsRows.push({ key: "qwen oauth auth configured", value: qwenAuthConfigured ? "true" : "false" });
  pathsRows.push({
    key: "qwen_oauth_source",
    value: qwenLocalPlan.state === "qwen_free" ? qwenLocalPlan.sourceKey : "(none)",
  });
  pathsRows.push({
    key: "qwen_local_plan",
    value: qwenLocalPlan.state === "qwen_free" ? "qwen-code/free" : "(none)",
  });
  pathsRows.push({
    key: "alibaba auth configured",
    value: alibabaAuthDiagnostics.state === "none" ? "false" : "true",
  });
  pathsRows.push({ key: "alibaba_api_key_source", value: alibabaAuthDiagnostics.source ?? "(none)" });
  pathsRows.push({
    key: "alibaba_api_key_checked_paths",
    value: joinOrNone(alibabaAuthDiagnostics.checkedPaths),
  });
  pathsRows.push({
    key: "alibaba_api_key_auth_paths",
    value: joinOrNone(alibabaAuthDiagnostics.authPaths),
  });
  pathsRows.push({
    key: "alibaba coding plan fallback tier",
    value: params.alibabaCodingPlanTier,
  });
  pathsRows.push({
    key: "alibaba_coding_plan",
    value:
      alibabaAuthDiagnostics.state === "configured"
        ? alibabaAuthDiagnostics.tier
        : alibabaAuthDiagnostics.state === "invalid"
          ? "invalid"
          : "(none)",
  });
  if (alibabaAuthDiagnostics.state === "invalid") {
    pathsRows.push({
      key: "alibaba_auth_error",
      value: sanitizeDisplayText(alibabaAuthDiagnostics.error),
    });
  }
  sections.push(createKvSection("paths", "paths:", pathsRows));

  // === openai ===
  const openaiRows: ReportKvRow[] = [
    { key: "auth_configured", value: openaiAuth.state === "configured" ? "true" : "false" },
    {
      key: "auth_source",
      value: openaiAuth.state === "configured" ? openaiAuth.sourceKey : "(none)",
    },
  ];
  const openaiTokenStatus =
    openaiAuth.state !== "configured"
      ? "(none)"
      : openaiAuth.expiresAt && openaiAuth.expiresAt < Date.now()
        ? "expired"
        : "valid";
  openaiRows.push({ key: "token_status", value: openaiTokenStatus });
  openaiRows.push({
    key: "token_expires_at",
    value:
      openaiAuth.state === "configured" && openaiAuth.expiresAt
        ? new Date(openaiAuth.expiresAt).toISOString()
        : "(none)",
  });
  openaiRows.push({
    key: "account_email",
    value:
      openaiAuth.state === "configured" && openaiAuth.email
        ? sanitizeDisplayText(openaiAuth.email)
        : "(none)",
  });
  openaiRows.push({
    key: "account_id",
    value:
      openaiAuth.state === "configured" && openaiAuth.accountId
        ? sanitizeDisplayText(openaiAuth.accountId)
        : "(none)",
  });
  appendProviderCompactLiveProbeRows(openaiRows, "openai", params.providerLiveProbes);
  sections.push(createKvSection("openai", "openai:", openaiRows));

  // === anthropic ===
  const anthropicRows: ReportKvRow[] = [];
  try {
    const anthropicDiagnostics = await getAnthropicDiagnostics({
      binaryPath: params.anthropicBinaryPath,
    });
    anthropicRows.push({
      key: "cli_installed",
      value: anthropicDiagnostics.installed ? "true" : "false",
    });
    anthropicRows.push({ key: "cli_version", value: anthropicDiagnostics.version ?? "(none)" });
    anthropicRows.push({ key: "auth_status", value: anthropicDiagnostics.authStatus });
    anthropicRows.push({
      key: "quota_supported",
      value: anthropicDiagnostics.quotaSupported ? "true" : "false",
    });
    anthropicRows.push({
      key: "quota_source",
      value: anthropicDiagnostics.quotaSource === "none" ? "(none)" : anthropicDiagnostics.quotaSource,
    });
    anthropicRows.push({
      key: "checked_commands",
      value:
        anthropicDiagnostics.checkedCommands.length > 0
          ? anthropicDiagnostics.checkedCommands.join(" | ")
          : "(none)",
    });
    if (anthropicDiagnostics.message) {
      anthropicRows.push({ key: "message", value: anthropicDiagnostics.message });
    }
    if (anthropicDiagnostics.quotaSupported && anthropicDiagnostics.quota) {
      anthropicRows.push({
        key: "five_hour_remaining",
        value: `${anthropicDiagnostics.quota.five_hour.percentRemaining}% reset_at=${anthropicDiagnostics.quota.five_hour.resetTimeIso ?? "(none)"}`,
      });
      anthropicRows.push({
        key: "seven_day_remaining",
        value: `${anthropicDiagnostics.quota.seven_day.percentRemaining}% reset_at=${anthropicDiagnostics.quota.seven_day.resetTimeIso ?? "(none)"}`,
      });
    }
  } catch (err) {
    anthropicRows.push({ key: "cli_installed", value: "false" });
    anthropicRows.push({
      key: "message",
      value: `failed to probe Claude CLI${
        err ? `: ${sanitizeDisplayText(err instanceof Error ? err.message : String(err))}` : ""
      }`, 
    });
  }
  appendProviderCompactLiveProbeRows(anthropicRows, "anthropic", params.providerLiveProbes);
  sections.push(createKvSection("anthropic", "anthropic:", anthropicRows));

  // === cursor ===
  const cursorPlanLabel = getCursorPlanDisplayName(params.cursorPlan);
  const cursorIncludedApiUsd = getEffectiveCursorIncludedApiUsd({
    plan: params.cursorPlan,
    overrideUsd: params.cursorIncludedApiUsd,
  });
  const cursorAuth = await inspectCursorAuthPresence();
  const cursorIntegration = await inspectCursorOpenCodeIntegration();
  const cursorRows: ReportKvRow[] = [
    { key: "plan", value: cursorPlanLabel ?? "none" },
    {
      key: "included_api_usd",
      value: typeof cursorIncludedApiUsd === "number" ? fmtUsdAmount(cursorIncludedApiUsd) : "(none)",
    },
    {
      key: "billing_cycle_start_day",
      value:
        typeof params.cursorBillingCycleStartDay === "number"
          ? String(params.cursorBillingCycleStartDay)
          : "(calendar month)",
    },
    { key: "auth_state", value: cursorAuth.state },
    { key: "auth_selected_path", value: cursorAuth.selectedPath ?? "(none)" },
    { key: "auth_present_paths", value: joinOrNone(cursorAuth.presentPaths) },
    { key: "auth_candidate_paths", value: joinOrNone(cursorAuth.candidatePaths) },
  ];
  if (cursorAuth.error) {
    cursorRows.push({ key: "auth_error", value: cursorAuth.error });
  }
  cursorRows.push({ key: "plugin_enabled", value: cursorIntegration.pluginEnabled ? "true" : "false" });
  cursorRows.push({ key: "canonical_plugin_package", value: CURSOR_CANONICAL_PLUGIN_PACKAGE });
  cursorRows.push({
    key: "provider_configured",
    value: cursorIntegration.providerConfigured ? "true" : "false",
  });
  cursorRows.push({ key: "config_matches", value: joinOrNone(cursorIntegration.matchedPaths) });
  cursorRows.push({ key: "config_checked_paths", value: joinOrNone(cursorIntegration.checkedPaths) });
  try {
    const cursorUsage = await getCurrentCursorUsageSummary({
      billingCycleStartDay: params.cursorBillingCycleStartDay,
    });
    cursorRows.push({ key: "cycle_source", value: cursorUsage.window.source });
    cursorRows.push({ key: "cycle_reset_at", value: cursorUsage.window.resetTimeIso });
    cursorRows.push({
      key: "api_usage",
      value: `${fmtUsdAmount(cursorUsage.api.costUsd)} across ${fmtInt(cursorUsage.api.messageCount)} messages`,
    });
    cursorRows.push({
      key: "auto_composer_usage",
      value: `${fmtUsdAmount(cursorUsage.autoComposer.costUsd)} across ${fmtInt(cursorUsage.autoComposer.messageCount)} messages`,
    });
    cursorRows.push({
      key: "total_cursor_usage",
      value: `${fmtUsdAmount(cursorUsage.total.costUsd)} across ${fmtInt(cursorUsage.total.messageCount)} messages`,
    });
    cursorRows.push({ key: "unknown_cursor_models", value: fmtInt(cursorUsage.unknownModels.length) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cursorRows.push({ key: "usage_error", value: msg });
  }

  const qwenLocalQuotaPath = getQwenLocalQuotaPath();
  const qwenLocalQuotaExists = await pathExists(qwenLocalQuotaPath);
  cursorRows.push({
    key: "qwen free local quota",
    value: `path=${qwenLocalQuotaPath} exists=${qwenLocalQuotaExists ? "true" : "false"}`,
  });
  try {
    const qwenState = await readQwenLocalQuotaState();
    const qwenQuota = computeQwenQuota({ state: qwenState });
    const qwenUsageSuffix = qwenLocalQuotaExists ? "" : " (default state)";
    cursorRows.push({
      key: "qwen free local usage",
      value: `daily=${qwenQuota.day.used}/${qwenQuota.day.limit} rpm=${qwenQuota.rpm.used}/${qwenQuota.rpm.limit}${qwenUsageSuffix}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cursorRows.push({ key: "qwen free local usage", value: `error (${msg})` });
  }

  const alibabaLocalQuotaPath = getAlibabaCodingPlanQuotaPath();
  const alibabaLocalQuotaExists = await pathExists(alibabaLocalQuotaPath);
  cursorRows.push({
    key: "alibaba coding plan local quota",
    value: `path=${alibabaLocalQuotaPath} exists=${alibabaLocalQuotaExists ? "true" : "false"}`,
  });
  if (alibabaCodingPlanAuth.state === "configured") {
    try {
      const alibabaState = await readAlibabaCodingPlanQuotaState();
      const alibabaQuota = computeAlibabaCodingPlanQuota({
        state: alibabaState,
        tier: alibabaCodingPlanAuth.tier,
      });
      const alibabaUsageSuffix = alibabaLocalQuotaExists ? "" : " (default state)";
      cursorRows.push({
        key: "alibaba coding plan usage",
        value: `tier=${alibabaCodingPlanAuth.tier} 5h=${alibabaQuota.fiveHour.used}/${alibabaQuota.fiveHour.limit} weekly=${alibabaQuota.weekly.used}/${alibabaQuota.weekly.limit} monthly=${alibabaQuota.monthly.used}/${alibabaQuota.monthly.limit}${alibabaUsageSuffix}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cursorRows.push({ key: "alibaba coding plan usage", value: `error (${msg})` });
    }
  } else if (alibabaCodingPlanAuth.state === "invalid") {
    cursorRows.push({ key: "alibaba coding plan error", value: alibabaCodingPlanAuth.error });
  }
  appendProviderCompactLiveProbeRows(cursorRows, "cursor", params.providerLiveProbes);
  sections.push(createKvSection("cursor", "cursor:", cursorRows));

  const qwenCodeLiveProbeSection = createCompactLiveProbeOnlySection({
    id: "qwen_code",
    title: "qwen_code:",
    providerId: "qwen-code",
    probes: params.providerLiveProbes,
  });
  if (qwenCodeLiveProbeSection) {
    sections.push(qwenCodeLiveProbeSection);
  }

  const alibabaCodingPlanLiveProbeSection = createCompactLiveProbeOnlySection({
    id: "alibaba_coding_plan",
    title: "alibaba_coding_plan:",
    providerId: "alibaba-coding-plan",
    probes: params.providerLiveProbes,
  });
  if (alibabaCodingPlanLiveProbeSection) {
    sections.push(alibabaCodingPlanLiveProbeSection);
  }

  // === minimax ===
  const minimaxRows: ReportKvRow[] = [];
  const minimaxAuth = await getMiniMaxAuthDiagnostics({
    maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  });
  minimaxRows.push({ key: "auth_state", value: minimaxAuth.state });
  minimaxRows.push({
    key: "api_key_configured",
    value: minimaxAuth.state === "configured" ? "true" : "false",
  });
  minimaxRows.push({ key: "api_key_source", value: minimaxAuth.source ?? "(none)" });
  minimaxRows.push({ key: "api_key_checked_paths", value: joinOrNone(minimaxAuth.checkedPaths) });
  minimaxRows.push({ key: "api_key_auth_paths", value: joinOrNone(minimaxAuth.authPaths) });
  if (minimaxAuth.state === "invalid") {
    minimaxRows.push({ key: "auth_error", value: sanitizeDisplayText(minimaxAuth.error) });
  }
  if (minimaxAuth.state === "configured") {
    const resolvedMiniMaxAuth = await resolveMiniMaxAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });
    if (resolvedMiniMaxAuth.state !== "configured") {
      minimaxRows.push({
        key: "live_fetch_error",
        value: "MiniMax API key became unavailable before fetch",
      });
    } else {
      const minimaxQuota = await queryMiniMaxQuota(resolvedMiniMaxAuth.apiKey);
      if (!minimaxQuota.success) {
        minimaxRows.push({ key: "live_fetch_error", value: minimaxQuota.error });
      } else {
        const fiveHourEntry = minimaxQuota.entries.find((entry) => entry.window === "five_hour");
        const weeklyEntry = minimaxQuota.entries.find((entry) => entry.window === "weekly");
        if (fiveHourEntry) {
          minimaxRows.push({
            key: "five_hour_usage",
            value: `${fiveHourEntry.right ?? "(none)"} percent_remaining=${fiveHourEntry.percentRemaining} reset_at=${fiveHourEntry.resetTimeIso ?? "(none)"}`,
          });
        }
        if (weeklyEntry) {
          minimaxRows.push({
            key: "weekly_usage",
            value: `${weeklyEntry.right ?? "(none)"} percent_remaining=${weeklyEntry.percentRemaining} reset_at=${weeklyEntry.resetTimeIso ?? "(none)"}`,
          });
        }
        if (!fiveHourEntry && !weeklyEntry) {
          minimaxRows.push({ key: "live_state", value: "no reportable MiniMax Coding Plan quota" });
        }
      }
    }
  }
  appendProviderCompactLiveProbeRows(minimaxRows, "minimax-coding-plan", params.providerLiveProbes);
  sections.push(createKvSection("minimax", "minimax:", minimaxRows));

  // === kimi ===
  const kimiRows: ReportKvRow[] = [];
  const kimiAuth = await getKimiAuthDiagnostics({
    maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  });
  kimiRows.push({ key: "auth_state", value: kimiAuth.state });
  kimiRows.push({
    key: "api_key_configured",
    value: kimiAuth.state === "configured" ? "true" : "false",
  });
  kimiRows.push({ key: "api_key_source", value: kimiAuth.source ?? "(none)" });
  kimiRows.push({ key: "api_key_checked_paths", value: joinOrNone(kimiAuth.checkedPaths) });
  kimiRows.push({ key: "api_key_auth_paths", value: joinOrNone(kimiAuth.authPaths) });
  if (kimiAuth.state === "invalid") {
    kimiRows.push({ key: "auth_error", value: sanitizeDisplayText(kimiAuth.error) });
  }
  if (kimiAuth.state === "configured") {
    const kimiQuota = await queryKimiQuota();
    if (!kimiQuota) {
      kimiRows.push({
        key: "live_fetch_error",
        value: "Kimi API key became unavailable before fetch",
      });
    } else if (!kimiQuota.success) {
      kimiRows.push({ key: "live_fetch_error", value: kimiQuota.error });
    } else {
      for (const window of kimiQuota.windows) {
        kimiRows.push({
          key: window.label.toLowerCase().replace(/\s+/g, "_"),
          value: `used=${window.used}/${window.limit} percent_remaining=${window.percentRemaining} reset_at=${window.resetTimeIso ?? "(none)"}`,
        });
      }
      if (kimiQuota.windows.length === 0) {
        kimiRows.push({ key: "live_state", value: "no reportable Kimi quota" });
      }
    }
  }
  appendProviderCompactLiveProbeRows(kimiRows, "kimi-for-coding", params.providerLiveProbes);
  sections.push(createKvSection("kimi", "kimi:", kimiRows));

  // === opencode_go ===
  const openCodeGoRows: ReportKvRow[] = [];
  const openCodeGoDiag = await getOpenCodeGoConfigDiagnostics();
  openCodeGoRows.push({ key: "config_state", value: openCodeGoDiag.state });
  openCodeGoRows.push({ key: "config_source", value: openCodeGoDiag.source ?? "(none)" });
  if (openCodeGoDiag.missing) {
    openCodeGoRows.push({ key: "config_missing", value: openCodeGoDiag.missing });
  }
  if (openCodeGoDiag.error) {
    openCodeGoRows.push({ key: "config_error", value: sanitizeDisplayText(openCodeGoDiag.error) });
  }
  openCodeGoRows.push({ key: "config_checked_paths", value: joinOrNone(openCodeGoDiag.checkedPaths) });
  if (openCodeGoDiag.state === "configured") {
    const openCodeGoConfig = await resolveOpenCodeGoConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
    });
    if (openCodeGoConfig.state !== "configured") {
      openCodeGoRows.push({
        key: "live_fetch_error",
        value: "OpenCode Go config became unavailable before fetch",
      });
    } else {
      const openCodeGoQuota = await queryOpenCodeGoQuota(
        openCodeGoConfig.config.workspaceId,
        openCodeGoConfig.config.authCookie,
      );
      if (!openCodeGoQuota) {
        openCodeGoRows.push({ key: "live_fetch_error", value: "OpenCode Go returned null" });
      } else if (!openCodeGoQuota.success) {
        openCodeGoRows.push({ key: "live_fetch_error", value: openCodeGoQuota.error });
      } else {
        openCodeGoRows.push({
          key: "rolling_usage",
          value: `percent_used=${openCodeGoQuota.rolling.usagePercent} percent_remaining=${openCodeGoQuota.rolling.percentRemaining} reset_in_sec=${openCodeGoQuota.rolling.resetInSec} reset_at=${openCodeGoQuota.rolling.resetTimeIso}`,
        });
        openCodeGoRows.push({
          key: "weekly_usage",
          value: `percent_used=${openCodeGoQuota.weekly.usagePercent} percent_remaining=${openCodeGoQuota.weekly.percentRemaining} reset_in_sec=${openCodeGoQuota.weekly.resetInSec} reset_at=${openCodeGoQuota.weekly.resetTimeIso}`,
        });
        openCodeGoRows.push({
          key: "monthly_usage",
          value: `percent_used=${openCodeGoQuota.monthly.usagePercent} percent_remaining=${openCodeGoQuota.monthly.percentRemaining} reset_in_sec=${openCodeGoQuota.monthly.resetInSec} reset_at=${openCodeGoQuota.monthly.resetTimeIso}`,
        });
      }
    }
  }
  appendProviderCompactLiveProbeRows(openCodeGoRows, "opencode-go", params.providerLiveProbes);
  sections.push(createKvSection("opencode_go", "opencode_go:", openCodeGoRows));

  // === zai ===
  const zaiRows: ReportKvRow[] = [];
  const zaiAuth = await getZaiAuthDiagnostics({
    maxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
  });
  zaiRows.push({ key: "auth_state", value: zaiAuth.state });
  zaiRows.push({
    key: "api_key_configured",
    value: zaiAuth.state === "configured" ? "true" : "false",
  });
  zaiRows.push({ key: "api_key_source", value: zaiAuth.source ?? "(none)" });
  zaiRows.push({ key: "api_key_checked_paths", value: joinOrNone(zaiAuth.checkedPaths) });
  zaiRows.push({ key: "api_key_auth_paths", value: joinOrNone(zaiAuth.authPaths) });
  if (zaiAuth.state === "invalid") {
    zaiRows.push({ key: "auth_error", value: sanitizeDisplayText(zaiAuth.error) });
  }
  if (zaiAuth.state === "configured") {
    const zaiQuota = await queryZaiQuota();
    if (!zaiQuota) {
      zaiRows.push({ key: "live_fetch_error", value: "Z.ai API key became unavailable before fetch" });
    } else if (!zaiQuota.success) {
      zaiRows.push({ key: "live_fetch_error", value: zaiQuota.error });
    } else {
      if (zaiQuota.windows.fiveHour) {
        zaiRows.push({
          key: "five_hour_remaining",
          value: `${zaiQuota.windows.fiveHour.percentRemaining}% reset_at=${zaiQuota.windows.fiveHour.resetTimeIso ?? "(none)"}`,
        });
      }
      if (zaiQuota.windows.weekly) {
        zaiRows.push({
          key: "weekly_remaining",
          value: `${zaiQuota.windows.weekly.percentRemaining}% reset_at=${zaiQuota.windows.weekly.resetTimeIso ?? "(none)"}`,
        });
      }
      if (zaiQuota.windows.mcp) {
        zaiRows.push({
          key: "mcp_remaining",
          value: `${zaiQuota.windows.mcp.percentRemaining}% reset_at=${zaiQuota.windows.mcp.resetTimeIso ?? "(none)"}`,
        });
      }
      if (!zaiQuota.windows.fiveHour && !zaiQuota.windows.weekly && !zaiQuota.windows.mcp) {
        zaiRows.push({ key: "live_state", value: "no reportable Z.ai quota windows" });
      }
    }
  }
  appendProviderCompactLiveProbeRows(zaiRows, "zai", params.providerLiveProbes);
  sections.push(createKvSection("zai", "zai:", zaiRows));

  // === simple API key sections ===
  const syntheticDiag = await readBasicApiKeyDiagnostics(getSyntheticKeyDiagnostics);
  const syntheticRows: ReportKvRow[] = [
    {
      key: "synthetic api key",
      value: formatInlineApiKeyDiagnosticsValue(syntheticDiag),
    },
  ];
  appendProviderCompactLiveProbeRows(syntheticRows, "synthetic", params.providerLiveProbes);
  sections.push(createKvSection("synthetic", "synthetic:", syntheticRows));

  const chutesDiag = await readBasicApiKeyDiagnostics(getChutesKeyDiagnostics);
  const chutesRows: ReportKvRow[] = [
    {
      key: "chutes api key",
      value: formatInlineApiKeyDiagnosticsValue(chutesDiag),
    },
  ];
  appendProviderCompactLiveProbeRows(chutesRows, "chutes", params.providerLiveProbes);
  sections.push(createKvSection("chutes", "chutes:", chutesRows));

  // === nanogpt ===
  const nanoGptDiag = await readNanoGptApiKeyDiagnostics(getNanoGptKeyDiagnostics);
  const nanoGptRows: ReportKvRow[] = [
    { key: "api_key_configured", value: nanoGptDiag.configured ? "true" : "false" },
    { key: "api_key_source", value: nanoGptDiag.source ?? "(none)" },
    { key: "api_key_checked_paths", value: joinOrNone(nanoGptDiag.checkedPaths) },
    { key: "api_key_auth_paths", value: joinOrNone(nanoGptDiag.authPaths) },
  ];
  if (nanoGptDiag.configured) {
    try {
      const nanoGptQuota = await queryNanoGptQuota();
      if (!nanoGptQuota) {
        nanoGptRows.push({
          key: "live_fetch_error",
          value: "NanoGPT API key became unavailable before fetch",
        });
      } else if (!nanoGptQuota.success) {
        nanoGptRows.push({ key: "live_fetch_error", value: nanoGptQuota.error });
      } else {
        if (nanoGptQuota.subscription) {
          nanoGptRows.push({
            key: "subscription_active",
            value: nanoGptQuota.subscription.active ? "true" : "false",
          });
          nanoGptRows.push({ key: "subscription_state", value: nanoGptQuota.subscription.state });
          nanoGptRows.push({
            key: "enforce_daily_limit",
            value: nanoGptQuota.subscription.enforceDailyLimit ? "true" : "false",
          });
          if (nanoGptQuota.subscription.daily) {
            const daily = nanoGptQuota.subscription.daily;
            nanoGptRows.push({
              key: "daily_usage",
              value: `${fmtNanoGptMetric(daily.used)}/${fmtNanoGptMetric(daily.limit)} remaining=${fmtNanoGptMetric(daily.remaining)} percent_remaining=${daily.percentRemaining} reset_at=${daily.resetTimeIso ?? "(none)"}`,
            });
          }
          if (nanoGptQuota.subscription.monthly) {
            const monthly = nanoGptQuota.subscription.monthly;
            nanoGptRows.push({
              key: "monthly_usage",
              value: `${fmtNanoGptMetric(monthly.used)}/${fmtNanoGptMetric(monthly.limit)} remaining=${fmtNanoGptMetric(monthly.remaining)} percent_remaining=${monthly.percentRemaining} reset_at=${monthly.resetTimeIso ?? "(none)"}`,
            });
          }
          nanoGptRows.push({
            key: "billing_period_end",
            value: nanoGptQuota.subscription.currentPeriodEndIso ?? "(none)",
          });
          if (nanoGptQuota.subscription.graceUntilIso) {
            nanoGptRows.push({ key: "grace_until", value: nanoGptQuota.subscription.graceUntilIso });
          }
        }
        nanoGptRows.push({
          key: "balance_usd",
          value:
            typeof nanoGptQuota.balance?.usdBalance === "number"
              ? fmtUsdAmount(nanoGptQuota.balance.usdBalance)
              : "(none)",
        });
        nanoGptRows.push({ key: "balance_nano", value: nanoGptQuota.balance?.nanoBalanceRaw ?? "(none)" });
        for (const entry of nanoGptQuota.endpointErrors ?? []) {
          nanoGptRows.push({ key: `live_error_${entry.endpoint}`, value: entry.message });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      nanoGptRows.push({ key: "live_fetch_error", value: msg });
    }
  }
  appendProviderCompactLiveProbeRows(nanoGptRows, "nanogpt", params.providerLiveProbes);
  sections.push(createKvSection("nanogpt", "nanogpt:", nanoGptRows));

  // === copilot auth ===
  const copilotDiag = getCopilotQuotaAuthDiagnostics(authData);
  const copilotRows: ReportKvRow[] = [{ key: "pat_state", value: copilotDiag.pat.state }];
  if (copilotDiag.pat.selectedPath) {
    copilotRows.push({ key: "pat_path", value: copilotDiag.pat.selectedPath });
  }
  if (copilotDiag.pat.tokenKind) {
    copilotRows.push({ key: "pat_token_kind", value: copilotDiag.pat.tokenKind });
  }
  if (copilotDiag.pat.config?.tier) {
    copilotRows.push({ key: "pat_tier", value: copilotDiag.pat.config.tier });
  }
  if (copilotDiag.pat.config?.organization) {
    copilotRows.push({ key: "pat_organization", value: copilotDiag.pat.config.organization });
  }
  if (copilotDiag.pat.config?.enterprise) {
    copilotRows.push({ key: "pat_enterprise", value: copilotDiag.pat.config.enterprise });
  }
  copilotRows.push({ key: "billing_mode", value: copilotDiag.billingMode });
  copilotRows.push({ key: "billing_scope", value: copilotDiag.billingScope });
  copilotRows.push({ key: "quota_api", value: copilotDiag.quotaApi });
  copilotRows.push({
    key: "billing_api_access_likely",
    value: copilotDiag.billingApiAccessLikely ? "true" : "false",
  });
  copilotRows.push({ key: "remaining_totals_state", value: copilotDiag.remainingTotalsState });
  if (copilotDiag.queryPeriod) {
    copilotRows.push({
      key: "billing_period",
      value: `${copilotDiag.queryPeriod.year}-${String(copilotDiag.queryPeriod.month).padStart(2, "0")}`,
    });
  }
  if (copilotDiag.usernameFilter) {
    copilotRows.push({ key: "username_filter", value: copilotDiag.usernameFilter });
  }
  if (copilotDiag.billingMode === "organization_usage") {
    copilotRows.push({
      key: "billing_usage_note",
      value: "organization premium usage for the current billing period",
    });
    copilotRows.push({
      key: "remaining_quota_note",
      value:
        "valid PAT access can query billing usage, but pooled org usage does not provide a true per-user remaining quota",
    });
  }
  if (copilotDiag.billingMode === "enterprise_usage") {
    copilotRows.push({
      key: "billing_usage_note",
      value: "enterprise premium usage for the current billing period",
    });
    copilotRows.push({
      key: "remaining_quota_note",
      value:
        "valid enterprise billing access can query pooled enterprise usage, but it does not provide a true per-user remaining quota",
    });
  }
  if (copilotDiag.billingTargetError) {
    copilotRows.push({ key: "billing_target_error", value: copilotDiag.billingTargetError });
  }
  if (copilotDiag.tokenCompatibilityError) {
    copilotRows.push({ key: "token_compatibility_error", value: copilotDiag.tokenCompatibilityError });
  }
  if (copilotDiag.pat.error) {
    copilotRows.push({ key: "pat_error", value: copilotDiag.pat.error });
  }
  copilotRows.push({
    key: "pat_checked_paths",
    value: copilotDiag.pat.checkedPaths.length ? copilotDiag.pat.checkedPaths.join(" | ") : "(none)",
  });
  copilotRows.push({
    key: "oauth_configured",
    value: `${copilotDiag.oauth.configured ? "true" : "false"} key=${copilotDiag.oauth.keyName ?? "(none)"} refresh=${copilotDiag.oauth.hasRefreshToken ? "true" : "false"} access=${copilotDiag.oauth.hasAccessToken ? "true" : "false"}`,
  });
  copilotRows.push({ key: "effective_source", value: copilotDiag.effectiveSource });
  copilotRows.push({ key: "override", value: copilotDiag.override });
  appendProviderCompactLiveProbeRows(copilotRows, "copilot", params.providerLiveProbes);
  sections.push(createKvSection("copilot_quota_auth", "copilot_quota_auth:", copilotRows));

  // === google antigravity + db path ===
  const googleTokenCachePath = getGoogleTokenCachePath();
  const googleAuthPresence = await inspectAntigravityAccountsPresence();
  const googleCompanionPresence = await inspectAntigravityCompanionPresence();
  const dbCandidates = getOpenCodeDbPathCandidates();
  const dbSelected = getOpenCodeDbPath();
  const dbPresent: string[] = [];
  await Promise.all(
    dbCandidates.map(async (p) => {
      if (await pathExists(p)) dbPresent.push(p);
    }),
  );
  const googleRows: ReportKvRow[] = [
    { key: "auth_state", value: googleAuthPresence.state },
    { key: "selected_accounts_path", value: googleAuthPresence.selectedPath ?? "(none)" },
    { key: "present_accounts_paths", value: joinOrNone(googleAuthPresence.presentPaths) },
    { key: "candidate_accounts_paths", value: joinOrNone(googleAuthPresence.candidatePaths) },
    { key: "account_count", value: String(googleAuthPresence.accountCount) },
    { key: "valid_account_count", value: String(googleAuthPresence.validAccountCount) },
    { key: "companion_package_state", value: googleCompanionPresence.state },
    {
      key: "companion_package_path",
      value:
        googleCompanionPresence.state === "present" || googleCompanionPresence.state === "invalid"
          ? googleCompanionPresence.resolvedPath ?? "(none)"
          : "(none)",
    },
  ];
  if (googleCompanionPresence.state !== "present") {
    googleRows.push({
      key: "companion_error",
      value: sanitizeDisplayText(googleCompanionPresence.error),
    });
  }
  googleRows.push({
    key: "token_cache_path",
    value: `${googleTokenCachePath} exists=${(await pathExists(googleTokenCachePath)) ? "true" : "false"}`,
  });
  if (googleAuthPresence.state === "invalid" && googleAuthPresence.error) {
    googleRows.push({ key: "auth_error", value: sanitizeDisplayText(googleAuthPresence.error) });
  }
  googleRows.push({
    key: "opencode db",
    value: `preferred=${dbSelected} present=${joinOrNone(dbPresent)} candidates=${joinOrNone(dbCandidates)}`,
  });
  appendProviderCompactLiveProbeRows(googleRows, "google-antigravity", params.providerLiveProbes);
  sections.push(createKvSection("google_antigravity", "google_antigravity:", googleRows));

  // === google gemini cli ===
  const geminiCliAuthPresence = await inspectGeminiCliAuthPresence(params.geminiCliClient);
  const geminiCliCompanionPresence = await inspectGeminiCliCompanionPresence();
  const geminiCliRows: ReportKvRow[] = [
    { key: "auth_state", value: geminiCliAuthPresence.state },
    { key: "auth_source", value: geminiCliAuthPresence.sourceKey ?? "(none)" },
    { key: "account_count", value: String(geminiCliAuthPresence.accountCount) },
    { key: "valid_account_count", value: String(geminiCliAuthPresence.validAccountCount) },
    { key: "companion_package_state", value: geminiCliCompanionPresence.state },
    {
      key: "companion_package_path",
      value:
        geminiCliCompanionPresence.state === "present" || geminiCliCompanionPresence.state === "invalid"
          ? geminiCliCompanionPresence.resolvedPath ?? "(none)"
          : "(none)",
    },
  ];
  if (geminiCliAuthPresence.state === "invalid") {
    geminiCliRows.push({ key: "auth_error", value: sanitizeDisplayText(geminiCliAuthPresence.error) });
  }
  if (geminiCliCompanionPresence.state !== "present") {
    geminiCliRows.push({
      key: "companion_error",
      value: sanitizeDisplayText(geminiCliCompanionPresence.error),
    });
  }
  appendProviderCompactLiveProbeRows(geminiCliRows, "google-gemini-cli", params.providerLiveProbes);
  sections.push(createKvSection("google_gemini_cli", "google_gemini_cli:", geminiCliRows));

  if (params.googleRefresh?.attempted) {
    const googleRefreshRows: ReportKvRow[] = [];
    if (
      typeof params.googleRefresh.total === "number" &&
      typeof params.googleRefresh.successCount === "number"
    ) {
      googleRefreshRows.push({
        key: "refreshed",
        value: `${params.googleRefresh.successCount}/${params.googleRefresh.total}`,
      });
    } else {
      googleRefreshRows.push({ key: "attempted" });
    }
    for (const f of params.googleRefresh.failures ?? []) {
      googleRefreshRows.push({ key: f.email ?? "Unknown", value: f.error });
    }
    sections.push(createKvSection("google_token_refresh", "google_token_refresh:", googleRefreshRows));
  }

  // === session token errors ===
  if (params.sessionTokenError) {
    const sessionTokenErrorRows: ReportKvRow[] = [
      { key: "session_id", value: params.sessionTokenError.sessionID },
      { key: "error", value: params.sessionTokenError.error },
    ];
    if (params.sessionTokenError.checkedPath) {
      sessionTokenErrorRows.push({ key: "checked_path", value: params.sessionTokenError.checkedPath });
    }
    sections.push(
      createKvSection("session_tokens_error", "session_tokens_error:", sessionTokenErrorRows),
    );
  }

  // === storage scan ===
  const dbStats = await getOpenCodeDbStats();
  sections.push(
    createKvSection("storage", "storage:", [
      { key: "sessions_in_db", value: fmtInt(dbStats.sessionCount) },
      { key: "messages_in_db", value: fmtInt(dbStats.messageCount) },
      { key: "assistant_messages_in_db", value: fmtInt(dbStats.assistantMessageCount) },
    ]),
  );

  // === pricing snapshot ===
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

  const pricingRows: ReportKvRow[] = [
    {
      key: "pricing",
      value: `source=${meta.source} active_source=${snapshotSource} generated_at=${new Date(meta.generatedAt).toISOString()} units=${meta.units}`,
    },
    {
      key: "selection",
      value: `configured=${params.pricingSnapshotSource} active=${snapshotSource}`,
    },
  ];
  if (params.pricingSnapshotSource === "bundled") {
    pricingRows.push({
      key: "selection_note",
      value: "bundled config pins the packaged snapshot and ignores runtime refresh for active pricing",
    });
  } else if (params.pricingSnapshotSource === "runtime" && snapshotSource !== "runtime") {
    pricingRows.push({
      key: "selection_note",
      value:
        "runtime config requested the local runtime snapshot, but bundled fallback is active because no valid runtime snapshot is available",
    });
  }
  pricingRows.push({
    key: "runtime_paths",
    value: `snapshot=${runtimeSnapshotPath} refresh_state=${refreshStatePath}`,
  });
  pricingRows.push({
    key: "staleness",
    value: `age_ms=${fmtInt(health.ageMs)} max_age_ms=${fmtInt(health.maxAgeMs)} stale=${health.stale ? "true" : "false"}`,
  });
  pricingRows.push({
    key: "refresh_policy",
    value: `auto_refresh_days=${fmtInt(autoRefreshDays)}`,
  });
  if (pricingRefreshState) {
    pricingRows.push({
      key: "refresh",
      value: `last_attempt_at=${pricingRefreshState.lastAttemptAt ? new Date(pricingRefreshState.lastAttemptAt).toISOString() : "(none)"} last_success_at=${pricingRefreshState.lastSuccessAt ? new Date(pricingRefreshState.lastSuccessAt).toISOString() : "(none)"} last_failure_at=${pricingRefreshState.lastFailureAt ? new Date(pricingRefreshState.lastFailureAt).toISOString() : "(none)"} last_result=${pricingRefreshState.lastResult ?? "(none)"}`,
    });
    if (pricingRefreshState.lastError) {
      pricingRows.push({ key: "refresh_error", value: pricingRefreshState.lastError });
    }
  } else {
    pricingRows.push({ key: "refresh", value: "(no runtime refresh state yet)" });
  }
  pricingRows.push({ key: "providers", value: providers.join(",") });
  pricingRows.push({
    key: "coverage_seen",
    value: `priced_keys=${fmtInt(coverage.totals.pricedKeysSeen)} mapped_but_missing=${fmtInt(coverage.totals.mappedMissingKeysSeen)} unpriced_keys=${fmtInt(coverage.totals.unpricedKeysSeen)}`,
  });
  for (const p of providers) {
    const c = coverage.byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    pricingRows.push({
      key: p,
      value: `models=${fmtInt(getProviderModelCount(p))} priced_models_seen=${fmtInt(c.pricedKeysSeen)} mapped_but_missing_models_seen=${fmtInt(c.mappedMissingKeysSeen)} unpriced_models_seen=${fmtInt(c.unpricedKeysSeen)}`,
      indent: 1,
    });
  }
  sections.push(createKvSection("pricing_snapshot", "pricing_snapshot:", pricingRows));

  // === supported providers pricing ===
  const supported = getProviders().map((p) => p.id);
  const supportedRows: ReportKvRow[] = supported.map((id) => {
    const row = supportedProviderPricingRow({ id, agg, snapshotProviders: providers });
    return {
      key: row.id,
      value: `pricing=${row.pricing} (${row.notes})`,
    };
  });
  sections.push(
    createKvSection("supported_providers_pricing", "supported_providers_pricing:", supportedRows),
  );

  // === unpriced models ===
  const unpricedRows: ReportKvRow[] = [];
  if (agg.unpriced.length === 0) {
    unpricedRows.push({ key: "none" });
  } else {
    unpricedRows.push({
      key: "keys",
      value: `${fmtInt(agg.unpriced.length)} tokens_total=${fmtInt(totalTokenBuckets(agg.totals.unpriced))}`,
    });
    for (const row of agg.unpriced.slice(0, STATUS_SAMPLE_LIMIT)) {
      const src = `${row.key.sourceProviderID}/${row.key.sourceModelID}`;
      const mapped = `${row.key.mappedProvider}/${row.key.mappedModel}`;
      unpricedRows.push({
        key: src,
        value: `mapped=${mapped} tokens=${fmtInt(totalTokenBuckets(row.tokens))} msgs=${fmtInt(row.messageCount)} reason=${row.key.reason}`,
      });
    }
    if (agg.unpriced.length > STATUS_SAMPLE_LIMIT) {
      unpricedRows.push({ key: `... (${fmtInt(agg.unpriced.length - STATUS_SAMPLE_LIMIT)} more)` });
    }
  }
  sections.push(createKvSection("unpriced_models", "unpriced_models:", unpricedRows));

  // === unknown pricing ===
  const unknownRows: ReportKvRow[] = [];
  if (agg.unknown.length === 0) {
    unknownRows.push({ key: "none" });
  } else {
    unknownRows.push({
      key: "keys",
      value: `${fmtInt(agg.unknown.length)} tokens_total=${fmtInt(totalTokenBuckets(agg.totals.unknown))}`,
    });
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
      unknownRows.push({
        key: src,
        value: `mapped=${mappedBase}${candidates} tokens=${fmtInt(totalTokenBuckets(row.tokens))} msgs=${fmtInt(row.messageCount)}`,
      });
    }
    if (agg.unknown.length > STATUS_SAMPLE_LIMIT) {
      unknownRows.push({ key: `... (${fmtInt(agg.unknown.length - STATUS_SAMPLE_LIMIT)} more)` });
    }
  }
  sections.push(createKvSection("unknown_pricing", "unknown_pricing:", unknownRows));

  return renderPlainTextReport({
    heading: {
      title: `Quota Status (opencode-quota v${v}) (/quota_status)`,
      generatedAtMs: params.generatedAtMs,
    },
    sections,
  });
}
