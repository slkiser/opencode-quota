import { stat } from "fs/promises";
import { getProviders } from "../providers/registry.js";
import { interpretAccountingRow } from "./accounting-format.js";
import {
  type LoadConfigIssue,
  QUOTA_TOAST_SETTING_SOURCE_KEYS,
  type QuotaToastSettingSources,
} from "./config.js";
import {
  sanitizeQuotaProviderResult,
  sanitizeSingleLineDisplaySnippet,
  sanitizeSingleLineDisplayText,
} from "./display-sanitize.js";
import type {
  QuotaProviderDiagnostic,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "./entries.js";
import type { MaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
import {
  getPricingRefreshPolicy,
  getPricingSnapshotHealth,
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getProviderModelCount,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  listProviders,
  readPricingRefreshState,
  hasProvider as snapshotHasProvider,
} from "./modelsdev-pricing.js";
import { getCredentialDatabasePath, getCredentialDatabasePaths } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import {
  getOpenCodeDbPath,
  getOpenCodeDbPathCandidates,
  getOpenCodeDbStats,
} from "./opencode-storage.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import { isMaintainedQuotaProviderTuning } from "./quota-providers.js";
import { aggregateUsage } from "./quota-stats.js";
import { type ReportKvRow, type ReportSection, renderPlainTextReport } from "./report-document.js";
import { totalTokenBuckets } from "./token-buckets.js";
import type {
  CursorQuotaPlan,
  MaintainerAnnouncementsConfig,
  OpenCodeGoWindowKey,
  PricingSnapshotSource,
} from "./types.js";
import { getPackageVersion } from "./version.js";

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

type PricingCoverageByProvider = {
  pricedKeysSeen: number;
  mappedMissingKeysSeen: number;
  unpricedKeysSeen: number;
};

const STATUS_SAMPLE_LIMIT = 5;
const STATUS_LIVE_ENTRY_LIMIT = 2;
const STATUS_LIVE_ERROR_LIMIT = 2;
const STATUS_LIVE_ROW_MAX_LENGTH = 120;
const OPENCODE_GO_STATUS_DETAIL_KEYS = new Set([
  "auth_state",
  "auth_source",
  "auth_checked_paths",
  "credential_database_paths",
  "auth_error",
  "selected_windows",
  "rolling_usage",
  "weekly_usage",
  "monthly_usage",
  "live_fetch_error",
]);
type ProviderLiveProbe = {
  providerId: string;
  result: QuotaProviderResult;
};
type ProviderAvailability = {
  id: string;
  enabled: boolean;
  available: boolean;
  matchesCurrentModel?: boolean;
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

function formatGoogleModelsSource(sources: QuotaToastSettingSources | undefined): string {
  const source = sources?.googleModels;
  return source ? `configuration file (${sanitizeSingleLineDisplayText(source)})` : "default";
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

function getProviderStatusDetails(
  providerId: string,
  probes?: ProviderLiveProbe[],
): QuotaProviderResult["statusDetails"] {
  const probe = findProviderLiveProbe(providerId, probes);
  return probe ? sanitizeQuotaProviderResult(probe.result).statusDetails : undefined;
}

function appendProviderStatusDetailRows(
  rows: ReportKvRow[],
  providerId: string,
  probes?: ProviderLiveProbe[],
  keys?: ReadonlySet<string>,
): void {
  for (const detail of getProviderStatusDetails(providerId, probes) ?? []) {
    if (!keys || keys.has(detail.key)) {
      rows.push({ key: detail.key, value: detail.value });
    }
  }
}

function findProviderStatusDetail(
  providerId: string,
  key: string,
  probes?: ProviderLiveProbe[],
): string | undefined {
  return getProviderStatusDetails(providerId, probes)?.find((detail) => detail.key === key)?.value;
}

function getLiveProbeState(probe?: ProviderLiveProbe): string {
  if (!probe) return "unavailable";
  if (probe.result.entries.length > 0 && probe.result.errors.length > 0) return "partial";
  if (probe.result.entries.length > 0) return "success";
  if (probe.result.errors.length > 0) return "error";
  return "no_data";
}

function appendProviderCompactLiveProbeRows(
  rows: ReportKvRow[],
  providerId: string,
  probes: ProviderLiveProbe[] | undefined,
  availability: ProviderAvailability[],
): void {
  const provider = availability.find((item) => item.id === providerId);
  if (!provider?.enabled || !provider.available) return;
  appendCompactLiveProbeRows(rows, providerId, findProviderLiveProbe(providerId, probes));
}

function createCompactLiveProbeOnlySection(params: {
  id: string;
  title: string;
  providerId: string;
  probes?: ProviderLiveProbe[];
  availability: ProviderAvailability[];
}): ReportSection | null {
  const provider = params.availability.find((item) => item.id === params.providerId);
  if (!provider?.enabled || !provider.available) return null;
  const probe = findProviderLiveProbe(params.providerId, params.probes);
  if (!probe) {
    return null;
  }

  const rows: ReportKvRow[] = [];
  appendCompactLiveProbeRows(rows, params.providerId, probe);
  return createKvSection(params.id, params.title, rows);
}

function createProviderStatusSection(params: {
  id: string;
  title: string;
  providerId: string;
  probes?: ProviderLiveProbe[];
  availability: ProviderAvailability[];
  includeDetails?: boolean;
  detailKeys?: ReadonlySet<string>;
}): ReportSection {
  const rows: ReportKvRow[] = [];
  if (params.includeDetails !== false) {
    appendProviderStatusDetailRows(rows, params.providerId, params.probes, params.detailKeys);
  }
  appendProviderCompactLiveProbeRows(rows, params.providerId, params.probes, params.availability);
  return createKvSection(params.id, params.title, rows);
}

function getCompactLiveProbeDescriptor(
  providerId: string,
  entry: QuotaToastEntry,
  semanticLabel: string,
): string | undefined {
  if (entry.semantic) {
    return sanitizeSingleLineDisplayText(semanticLabel);
  }

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
  const interpretation = interpretAccountingRow(entry, { booleanWording: "semantic" });
  const parts: string[] = [];
  const descriptor = getCompactLiveProbeDescriptor(providerId, entry, interpretation.label);
  if (descriptor) {
    parts.push(descriptor);
  }

  if (interpretation.display.kind === "value") {
    const value =
      interpretation.display.entryKind === "value"
        ? sanitizeSingleLineDisplayText(interpretation.display.text)
        : interpretation.display.text;
    parts.push(`value=${value}`);
  } else {
    if (entry.right) {
      parts.push(sanitizeSingleLineDisplayText(entry.right));
    }
    const percentRemaining = Number.isFinite(interpretation.display.percentRemaining)
      ? Math.max(0, Math.min(100, Math.round(interpretation.display.percentRemaining)))
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

function getQuotaProviderCredentialCategory(
  source: QuotaProviderDiagnostic["credentialSource"],
): string {
  switch (source) {
    case "explicit_env":
      return "environment";
    case "global_opencode_json":
    case "global_opencode_jsonc":
      return "trusted_global_config";
    case "opencode_db":
      return "opencode_db";
    default:
      return "none";
  }
}

function createQuotaProvidersSection(params: {
  definitions: readonly QuotaProviderDefinition[];
  probes?: ProviderLiveProbe[];
}): ReportSection | null {
  if (params.definitions.length === 0) return null;

  const diagnostics =
    findProviderLiveProbe("quota-providers", params.probes)?.result.diagnostics ?? [];
  const diagnosticsBySource = new Map(
    diagnostics.map((diagnostic) => [diagnostic.sourceId, diagnostic] as const),
  );
  const rows: ReportKvRow[] = [];

  for (const definition of params.definitions) {
    const diagnostic = diagnosticsBySource.get(definition.id);
    const coverage = definition.modelIds ? definition.modelIds.join(",") : "all_models";
    if (definition.mode === "local-estimate" && isMaintainedQuotaProviderTuning(definition)) {
      const probe = findProviderLiveProbe(definition.id, params.probes);
      const statePath = findProviderStatusDetail(definition.id, "local_state_path", params.probes);
      const stateExists = findProviderStatusDetail(
        definition.id,
        "local_state_exists",
        params.probes,
      );
      const stateHealth = findProviderStatusDetail(
        definition.id,
        "local_state_health",
        params.probes,
      );
      const stateVersion = findProviderStatusDetail(
        definition.id,
        "local_state_version",
        params.probes,
      );
      const stateLastUpdate = findProviderStatusDetail(
        definition.id,
        "local_state_last_update",
        params.probes,
      );
      rows.push({
        key: `provider_${definition.id}`,
        value: [
          `provider_id=${definition.providerId}`,
          "mode=local-estimate",
          `coverage=${coverage}`,
          `outcome=${getLiveProbeState(probe)}`,
          `limits=${definition.windows.map((window) => `${window.id}:${window.requestLimit}`).join(",")}`,
          `state_path=${statePath ?? "(none)"}`,
          `state_exists=${stateExists ?? "false"}`,
          `state_health=${stateHealth ?? "missing"}`,
          `state_version=${stateVersion ?? "(none)"}`,
          `state_last_update=${stateLastUpdate ?? "(none)"}`,
        ]
          .map((part) => sanitizeSingleLineDisplayText(part))
          .join(" "),
      });
      continue;
    }

    if (definition.mode === "local-estimate") {
      const stateHealth = diagnostic?.stateHealth ?? "missing";
      rows.push({
        key: `provider_${definition.id}`,
        value: [
          `provider_id=${definition.providerId}`,
          "mode=local-estimate",
          `coverage=${coverage}`,
          `outcome=${diagnostic?.outcome ?? "unavailable"}`,
          `state_path=${diagnostic?.statePath ?? "(none)"}`,
          `state_exists=${diagnostic?.statePath && stateHealth !== "missing" ? "true" : "false"}`,
          `state_health=${stateHealth}`,
          `state_version=${diagnostic?.stateVersion ?? "(none)"}`,
          `state_last_update=${diagnostic?.stateLastUpdatedAt == null ? "(none)" : new Date(diagnostic.stateLastUpdatedAt).toISOString()}`,
        ]
          .map((part) => sanitizeSingleLineDisplayText(part))
          .join(" "),
      });
      continue;
    }

    const checkedPaths = diagnostic
      ? [...new Set([...diagnostic.checkedPaths, ...diagnostic.credentialDatabasePaths])]
      : [];
    rows.push({
      key: `provider_${definition.id}`,
      value: [
        `provider_id=${definition.providerId}`,
        "mode=remote-api",
        `format=${definition.format}`,
        `coverage=${coverage}`,
        `outcome=${diagnostic?.outcome ?? "unavailable"}`,
        `credential_category=${getQuotaProviderCredentialCategory(diagnostic?.credentialSource ?? null)}`,
        `env_name=${definition.apiKeyEnv ?? "(none)"}`,
        `checked_paths=${checkedPaths.length > 0 ? checkedPaths.join(" | ") : "(none)"}`,
      ]
        .map((part) => sanitizeSingleLineDisplayText(part))
        .join(" "),
    });
  }

  return createKvSection("quota_providers", "quota_providers:", rows);
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
    result.entries.length > 0 && result.errors.length > 0
      ? "partial"
      : result.entries.length > 0
        ? "success"
        : result.errors.length > 0
          ? "error"
          : "no_data";

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
    Math.max(0, result.entries.length - entryCount) +
    Math.max(0, result.errors.length - errorCount);
  if (suppressedCount > 0) {
    rows.push({
      key: "live_more",
      value: `+${suppressedCount} additional rows suppressed`,
    });
  }
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

  if (id === "deepseek") {
    return {
      id,
      pricing: "no",
      notes: "account balance only (not token-priced)",
    };
  }

  if (id === "opencode-go") {
    return {
      id,
      pricing: "no",
      notes: "subscription percentage quota from the OpenCode Go usage API (not token-priced)",
    };
  }

  if (id === "xiaomi") {
    return {
      id,
      pricing: "no",
      notes: "dashboard monthly token quota and balances; per-key costs unsupported",
    };
  }

  if (id === "kimi-for-coding" || id === "kimi-code") {
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
  googleModels: readonly string[];
  anthropicBinaryPath?: string;
  cursorPlan: CursorQuotaPlan;
  cursorIncludedApiUsd?: number;
  cursorBillingCycleStartDay?: number;
  opencodeGoWindows?: OpenCodeGoWindowKey[];
  pricingSnapshotSource: PricingSnapshotSource;
  onlyCurrentModel: boolean;
  currentModel?: string;
  /** Whether a session was available for model lookup */
  sessionModelLookup?: "ok" | "not_found" | "no_session";
  providerAvailability: ProviderAvailability[];
  providerLiveProbes?: ProviderLiveProbe[];
  quotaProviders?: readonly QuotaProviderDefinition[];
  googleRefresh?: {
    attempted: boolean;
    total?: number;
    successCount?: number;
    failures?: Array<{ email?: string; error: string }>;
  };
  sessionTokenError?: SessionTokenError;
  maintainerAnnouncements?: {
    config: MaintainerAnnouncementsConfig;
    summary: MaintainerAnnouncementsSummary;
  };
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
    `- googleModels: ${params.googleModels.length > 0 ? params.googleModels.join(",") : "(none)"}`,
    `- googleModels_source: ${formatGoogleModelsSource(params.settingSources)}`,
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
    toastLines.push(
      `- candidate_config_paths: ${joinOrNone(params.tuiDiagnostics.candidatePaths)}`,
    );
    toastLines.push(
      `- quota_plugin_configured: ${params.tuiDiagnostics.quotaPluginConfigured ? "true" : "false"}`,
    );
    toastLines.push(
      `- quota_plugin_paths: ${joinOrNone(params.tuiDiagnostics.quotaPluginConfigPaths)}`,
    );
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

  const quotaProvidersSection = createQuotaProvidersSection({
    definitions: params.quotaProviders ?? [],
    probes: params.providerLiveProbes,
  });
  if (quotaProvidersSection) {
    sections.push(quotaProvidersSection);
  }

  if (params.maintainerAnnouncements) {
    const announcements = params.maintainerAnnouncements;
    const summary = announcements.summary;
    sections.push(
      createLinesSection("maintainer_announcements", "maintainer_announcements:", [
        `- enabled: ${announcements.config.enabled ? "true" : "false"}`,
        `- home: ${announcements.config.home ? "true" : "false"}`,
        `- source: ${summary.source}`,
        `- network: ${summary.network ? "true" : "false"}`,
        `- active: ${summary.activeCount}`,
        `- future: ${summary.futureCount}`,
        `- expired: ${summary.expiredCount}`,
      ]),
    );
  }

  // === paths ===
  const pathsRows: ReportKvRow[] = [];
  const runtime = getOpencodeRuntimeDirs();
  pathsRows.push({
    key: "opencode_dirs",
    value: `data=${runtime.dataDir} config=${runtime.configDir} cache=${runtime.cacheDir} state=${runtime.stateDir}`,
  });
  const authCandidates = getCredentialDatabasePaths();
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
    key: "opencode.db",
    value: `preferred=${getCredentialDatabasePath()} present=${joinOrNone(authPresent)} candidates=${joinOrNone(authCandidates)}`,
  });

  appendProviderStatusDetailRows(
    pathsRows,
    "qwen-code",
    params.providerLiveProbes,
    new Set(["qwen oauth auth configured", "qwen_oauth_source", "qwen_local_plan"]),
  );
  appendProviderStatusDetailRows(
    pathsRows,
    "alibaba-coding-plan",
    params.providerLiveProbes,
    new Set([
      "alibaba auth configured",
      "alibaba_api_key_source",
      "alibaba_api_key_checked_paths",
      "alibaba_api_key_credential_database_paths",
      "alibaba_coding_plan",
      "alibaba_auth_error",
    ]),
  );
  sections.push(createKvSection("paths", "paths:", pathsRows));

  for (const [id, providerId] of [
    ["openai", "openai"],
    ["anthropic", "anthropic"],
  ] as const) {
    sections.push(
      createProviderStatusSection({
        id,
        title: `${id}:`,
        providerId,
        probes: params.providerLiveProbes,
        availability: params.providerAvailability,
      }),
    );
  }

  // === cursor ===
  const cursorRows: ReportKvRow[] = [];
  appendProviderStatusDetailRows(cursorRows, "cursor", params.providerLiveProbes);

  appendProviderStatusDetailRows(
    cursorRows,
    "qwen-code",
    params.providerLiveProbes,
    new Set(["qwen free local quota"]),
  );
  appendProviderStatusDetailRows(
    cursorRows,
    "alibaba-coding-plan",
    params.providerLiveProbes,
    new Set(["alibaba coding plan local quota", "alibaba coding plan error"]),
  );
  appendProviderCompactLiveProbeRows(
    cursorRows,
    "cursor",
    params.providerLiveProbes,
    params.providerAvailability,
  );
  sections.push(createKvSection("cursor", "cursor:", cursorRows));

  const qwenCodeLiveProbeSection = createCompactLiveProbeOnlySection({
    id: "qwen_code",
    title: "qwen_code:",
    providerId: "qwen-code",
    probes: params.providerLiveProbes,
    availability: params.providerAvailability,
  });
  if (qwenCodeLiveProbeSection) {
    sections.push(qwenCodeLiveProbeSection);
  }

  const alibabaCodingPlanLiveProbeSection = createCompactLiveProbeOnlySection({
    id: "alibaba_coding_plan",
    title: "alibaba_coding_plan:",
    providerId: "alibaba-coding-plan",
    probes: params.providerLiveProbes,
    availability: params.providerAvailability,
  });
  if (alibabaCodingPlanLiveProbeSection) {
    sections.push(alibabaCodingPlanLiveProbeSection);
  }

  for (const section of [
    { id: "minimax", title: "minimax:", providerId: "minimax-coding-plan" },
    {
      id: "minimax_china",
      title: "minimax_china:",
      providerId: "minimax-china-coding-plan",
    },
    { id: "kimi", title: "kimi:", providerId: "kimi-for-coding" },
    {
      id: "opencode_go",
      title: "opencode_go:",
      providerId: "opencode-go",
      detailKeys: OPENCODE_GO_STATUS_DETAIL_KEYS,
    },
    { id: "opencode_zen", title: "opencode_zen:", providerId: "opencode" },
    { id: "xiaomi", title: "xiaomi:", providerId: "xiaomi" },
    { id: "zai", title: "zai:", providerId: "zai" },
    { id: "zhipu", title: "zhipu:", providerId: "zhipu" },
    { id: "synthetic", title: "synthetic:", providerId: "synthetic" },
    { id: "chutes", title: "chutes:", providerId: "chutes" },
    { id: "deepseek", title: "deepseek:", providerId: "deepseek" },
    { id: "xai", title: "xai:", providerId: "xai", includeDetails: false },
    { id: "nanogpt", title: "nanogpt:", providerId: "nanogpt" },
    {
      id: "copilot_quota_auth",
      title: "copilot_quota_auth:",
      providerId: "copilot",
    },
  ] as const) {
    sections.push(
      createProviderStatusSection({
        ...section,
        probes: params.providerLiveProbes,
        availability: params.providerAvailability,
      }),
    );
  }

  if (findProviderLiveProbe("kilo", params.providerLiveProbes)) {
    sections.push(
      createProviderStatusSection({
        id: "kilo",
        title: "kilo:",
        providerId: "kilo",
        probes: params.providerLiveProbes,
        availability: params.providerAvailability,
      }),
    );
  }

  // === google antigravity + db path ===
  const dbCandidates = getOpenCodeDbPathCandidates();
  const dbSelected = getOpenCodeDbPath();
  const dbPresent: string[] = [];
  await Promise.all(
    dbCandidates.map(async (p) => {
      if (await pathExists(p)) dbPresent.push(p);
    }),
  );
  const googleRows: ReportKvRow[] = [];
  appendProviderStatusDetailRows(googleRows, "google-antigravity", params.providerLiveProbes);
  googleRows.push({
    key: "opencode db",
    value: `preferred=${dbSelected} present=${joinOrNone(dbPresent)} candidates=${joinOrNone(dbCandidates)}`,
  });
  appendProviderCompactLiveProbeRows(
    googleRows,
    "google-antigravity",
    params.providerLiveProbes,
    params.providerAvailability,
  );
  sections.push(createKvSection("google_antigravity", "google_antigravity:", googleRows));

  for (const [id, providerId] of [
    ["google_gemini_cli", "google-gemini-cli"],
    ["google_agy", "google-agy"],
  ] as const) {
    sections.push(
      createProviderStatusSection({
        id,
        title: `${id}:`,
        providerId,
        probes: params.providerLiveProbes,
        availability: params.providerAvailability,
      }),
    );
  }

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
    sections.push(
      createKvSection("google_token_refresh", "google_token_refresh:", googleRefreshRows),
    );
  }

  // === session token errors ===
  if (params.sessionTokenError) {
    const sessionTokenErrorRows: ReportKvRow[] = [
      { key: "session_id", value: params.sessionTokenError.sessionID },
      { key: "error", value: params.sessionTokenError.error },
    ];
    if (params.sessionTokenError.checkedPath) {
      sessionTokenErrorRows.push({
        key: "checked_path",
        value: params.sessionTokenError.checkedPath,
      });
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
      value:
        "bundled config pins the packaged snapshot and ignores runtime refresh for active pricing",
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
      unpricedRows.push({ key: `… (${fmtInt(agg.unpriced.length - STATUS_SAMPLE_LIMIT)} more)` });
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
      unknownRows.push({ key: `… (${fmtInt(agg.unknown.length - STATUS_SAMPLE_LIMIT)} more)` });
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
