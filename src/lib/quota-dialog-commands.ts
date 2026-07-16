import { formatQuotaCommand } from "./quota-command-format.js";
import {
  aggregateUsage,
  resolveSessionTree,
  SessionNotFoundError,
  type SessionTreeNode,
} from "./quota-stats.js";
import { formatQuotaStatsReport } from "./quota-stats-format.js";
import { buildQuotaStatusReport, type SessionTokenError } from "./quota-status.js";
import { inspectTuiConfig } from "./tui-config-diagnostics.js";
import {
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot,
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
  type PricingRefreshResult,
} from "./modelsdev-pricing.js";
import { refreshGoogleTokensForAllAccounts } from "./google.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import {
  parseOptionalJsonArgs,
  parseQuotaBetweenArgs,
  startOfLocalDayMs,
  startOfNextLocalDayMs,
  formatYmd,
  type Ymd,
} from "./command-parsing.js";
import { renderCommandHeading } from "./format-utils.js";
import type { PricingSnapshotSource } from "./types.js";
import {
  ALL_WINDOWS_FORMAT_STYLE,
  SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE,
} from "./quota-format-style.js";
import {
  collectConcreteEnabledProviderIds,
  collectQuotaRenderData,
  collectQuotaStatusLiveProbes,
  matchesQuotaProviderCurrentSelection,
  resolveQuotaRenderSelection,
  type QuotaRenderData as QuotaCommandRenderData,
  type QuotaStatusLiveProbe,
  type SessionModelMeta,
} from "./quota-render-data.js";
import {
  createQuotaProviderRuntimeContext,
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
  type QuotaRuntimeClient,
  type QuotaRuntimeContext,
} from "./quota-runtime-context.js";
import type { RuntimeContextRootHints } from "./config-file-utils.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  getMaintainerAnnouncementsSummary,
} from "./maintainer-announcements.js";
import { getPackageVersion } from "./version.js";

export type QuotaDialogCommandId =
  | "quota"
  | "quota_status"
  | "quota_announcements"
  | "pricing_refresh"
  | TokenReportCommandId;

export type QuotaDialogCommandSpec = {
  id: QuotaDialogCommandId;
  slashName: string;
  title: string;
  description: string;
  dialogSize: "medium" | "large" | "xlarge";
  requiresSession?: boolean;
  acceptsArguments?: boolean;
};

export type QuotaDialogCommandOutputResult =
  | {
      state: "output";
      command: QuotaDialogCommandId;
      title: string;
      output: string;
      dialogSize: "medium" | "large" | "xlarge";
    }
  | {
      state: "noop";
      command: QuotaDialogCommandId;
      reason: "disabled";
    };

type TokenReportCommandId =
  | "tokens_today"
  | "tokens_daily"
  | "tokens_weekly"
  | "tokens_monthly"
  | "tokens_all"
  | "tokens_session"
  | "tokens_session_all"
  | "tokens_between";

type TokenReportCommandSpec =
  | {
      id: Exclude<TokenReportCommandId, "tokens_between">;
      template: `/${string}`;
      description: string;
      title: string;
      metadataTitle: string;
      kind: "rolling" | "today" | "all" | "session" | "session_tree";
      windowMs?: number;
      topModels?: number;
      topSessions?: number;
    }
  | {
      id: "tokens_between";
      template: "/tokens_between";
      description: string;
      titleForRange: (startYmd: Ymd, endYmd: Ymd) => string;
      metadataTitle: string;
      kind: "between";
    };

const TOKEN_REPORT_COMMANDS: readonly TokenReportCommandSpec[] = [
  {
    id: "tokens_today",
    template: "/tokens_today",
    description: "Token + deterministic cost summary for today (calendar day, local timezone).",
    title: "Tokens used (Today) (/tokens_today)",
    metadataTitle: "Tokens used (Today)",
    kind: "today",
  },
  {
    id: "tokens_daily",
    template: "/tokens_daily",
    description: "Token + deterministic cost summary for the last 24 hours (rolling).",
    title: "Tokens used (Last 24 Hours) (/tokens_daily)",
    metadataTitle: "Tokens used (Last 24 Hours)",
    kind: "rolling",
    windowMs: 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_weekly",
    template: "/tokens_weekly",
    description: "Token + deterministic cost summary for the last 7 days (rolling).",
    title: "Tokens used (Last 7 Days) (/tokens_weekly)",
    metadataTitle: "Tokens used (Last 7 Days)",
    kind: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_monthly",
    template: "/tokens_monthly",
    description: "Token + deterministic cost summary for the last 30 days (rolling).",
    title: "Tokens used (Last 30 Days) (/tokens_monthly)",
    metadataTitle: "Tokens used (Last 30 Days)",
    kind: "rolling",
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_all",
    template: "/tokens_all",
    description: "Token + deterministic cost summary for all locally saved OpenCode history.",
    title: "Tokens used (All Time) (/tokens_all)",
    metadataTitle: "Tokens used (All Time)",
    kind: "all",
    topModels: 12,
    topSessions: 12,
  },
  {
    id: "tokens_session",
    template: "/tokens_session",
    description: "Token + deterministic cost summary for current session only.",
    title: "Tokens used (Current Session) (/tokens_session)",
    metadataTitle: "Tokens used (Current Session)",
    kind: "session",
  },
  {
    id: "tokens_session_all",
    template: "/tokens_session_all",
    description:
      "Token + deterministic cost summary for current session and all descendant child/subagent sessions.",
    title: "Tokens used (Current Session Tree) (/tokens_session_all)",
    metadataTitle: "Tokens used (Current Session Tree)",
    kind: "session_tree",
  },
  {
    id: "tokens_between",
    template: "/tokens_between",
    description:
      "Token + deterministic cost report between two YYYY-MM-DD dates (local timezone, inclusive).",
    titleForRange: (startYmd: Ymd, endYmd: Ymd) => {
      return `Tokens used (${formatYmd(startYmd)} .. ${formatYmd(endYmd)}) (/tokens_between)`;
    },
    metadataTitle: "Tokens used (Date Range)",
    kind: "between",
  },
] as const;

// Token report model names are capped at the length of this reference model.
const TUI_TOKEN_REPORT_MODEL_NAME_WIDTH_REFERENCE = "gemini-3-pro-preview";
const TUI_TOKEN_REPORT_MODEL_MAX_WIDTH = TUI_TOKEN_REPORT_MODEL_NAME_WIDTH_REFERENCE.length;

const TOKEN_REPORT_COMMANDS_BY_ID: ReadonlyMap<TokenReportCommandId, TokenReportCommandSpec> =
  (() => {
    const map = new Map<TokenReportCommandId, TokenReportCommandSpec>();
    for (const spec of TOKEN_REPORT_COMMANDS) {
      map.set(spec.id, spec);
    }
    return map;
  })();

export const QUOTA_DIALOG_COMMANDS: readonly QuotaDialogCommandSpec[] = [
  {
    id: "quota",
    slashName: "quota",
    title: "OpenCode Quota",
    description: "Show deterministic quota output.",
    dialogSize: "xlarge",
    requiresSession: true,
  },
  {
    id: "quota_status",
    slashName: "quota_status",
    title: "OpenCode Quota Status",
    description: "Diagnostics for quota, TUI, pricing, and local storage.",
    dialogSize: "xlarge",
    requiresSession: true,
    acceptsArguments: true,
  },
  {
    id: "quota_announcements",
    slashName: "quota_announcements",
    title: "OpenCode Quota Announcements",
    description: "List active bundled maintainer announcements.",
    dialogSize: "xlarge",
    acceptsArguments: true,
  },
  {
    id: "pricing_refresh",
    slashName: "pricing_refresh",
    title: "OpenCode Quota Pricing Refresh",
    description: "Refresh the local runtime pricing snapshot from models.dev.",
    dialogSize: "xlarge",
    acceptsArguments: true,
  },
  ...TOKEN_REPORT_COMMANDS.map(
    (spec): QuotaDialogCommandSpec => ({
      id: spec.id,
      slashName: spec.id,
      title: spec.kind === "between" ? "OpenCode Quota Token Report" : spec.metadataTitle,
      description: spec.description,
      dialogSize: "xlarge",
      requiresSession: spec.kind === "session" || spec.kind === "session_tree",
      acceptsArguments: spec.kind === "between",
    }),
  ),
] as const;

const QUOTA_DIALOG_COMMANDS_BY_ID: ReadonlyMap<QuotaDialogCommandId, QuotaDialogCommandSpec> =
  (() => {
    const map = new Map<QuotaDialogCommandId, QuotaDialogCommandSpec>();
    for (const spec of QUOTA_DIALOG_COMMANDS) {
      map.set(spec.id, spec);
    }
    return map;
  })();

export function isQuotaDialogCommand(command: string): command is QuotaDialogCommandId {
  return QUOTA_DIALOG_COMMANDS_BY_ID.has(command as QuotaDialogCommandId);
}

function isTokenReportCommand(cmd: string): cmd is TokenReportCommandId {
  return TOKEN_REPORT_COMMANDS_BY_ID.has(cmd as TokenReportCommandId);
}

function describeQuotaCommandCurrentSelection(params: {
  currentModel?: string;
  currentProviderID?: string;
}): string {
  if (isCursorProviderId(params.currentProviderID)) {
    return `current provider: ${params.currentProviderID}`;
  }
  if (params.currentModel) {
    return `current model: ${params.currentModel}`;
  }
  return "current session";
}

async function buildQuotaCommandUnavailableMessage(runtime: QuotaRuntimeContext): Promise<string> {
  const selection = await resolveQuotaRenderSelection({
    client: runtime.client,
    config: runtime.config,
    request: createQuotaRuntimeRequestContext(runtime),
    providers: runtime.providers,
  });
  if (!selection) {
    return "Quota unavailable\n\nNo enabled quota providers are configured.\n\nRun /quota_status for diagnostics.";
  }

  if (selection.filteringByCurrentSelection && selection.filtered.length === 0) {
    const detail = describeQuotaCommandCurrentSelection({
      currentModel: selection.currentModel,
      currentProviderID: selection.currentProviderID,
    });
    return `Quota unavailable\n\nNo enabled quota providers matched the ${detail}.\n\nRun /quota_status for diagnostics.`;
  }

  const avail = await Promise.all(
    selection.filtered.map(async (p) => {
      try {
        return { id: p.id, ok: await p.isAvailable(selection.ctx) };
      } catch {
        return { id: p.id, ok: false };
      }
    }),
  );
  const availableIds = avail.filter((x) => x.ok).map((x) => x.id);

  if (availableIds.length === 0) {
    const scopedDetail = selection.filteringByCurrentSelection
      ? ` for the ${describeQuotaCommandCurrentSelection({
          currentModel: selection.currentModel,
          currentProviderID: selection.currentProviderID,
        })}`
      : "";
    return (
      `Quota unavailable\n\nNo provider data available${scopedDetail}. ` +
      "Make sure you are logged in to a supported provider (Copilot, OpenAI, etc.).\n\n" +
      "Run /quota_status for diagnostics."
    );
  }

  return (
    `Quota unavailable\n\nNo provider data available for detected providers (${availableIds.join(", ")}). ` +
    "This may be a temporary API error.\n\n" +
    "Run /quota_status for diagnostics."
  );
}

async function fetchQuotaCommandData(params: {
  runtime: QuotaRuntimeContext;
  setLastSessionTokenError?: (error: SessionTokenError | undefined) => void;
}): Promise<QuotaCommandRenderData | null> {
  const { runtime } = params;
  const request = createQuotaRuntimeRequestContext(runtime);
  const quotaResult = await collectQuotaRenderData({
    client: runtime.client,
    config: runtime.config,
    configMeta: runtime.configMeta,
    request,
    surfaceExplicitProviderIssues: false,
    formatStyle: ALL_WINDOWS_FORMAT_STYLE,
    providers: runtime.providers,
  });

  if (runtime.config.showSessionTokens && request.sessionID) {
    params.setLastSessionTokenError?.(quotaResult.sessionTokenError);
  }

  if (
    quotaResult.selection?.filteringByCurrentSelection &&
    quotaResult.selection.filtered.length === 0
  ) {
    return null;
  }

  return quotaResult.data;
}

async function kickPricingRefresh(params: {
  reason: "init" | "tokens" | "status";
  maxWaitMs?: number;
  snapshotSelection: PricingSnapshotSource;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  try {
    const refreshPromise = maybeRefreshPricingSnapshot({
      reason: params.reason,
      snapshotSelection: params.snapshotSelection,
    });
    const guardedRefreshPromise = refreshPromise.catch(() => undefined);
    if (!params.maxWaitMs || params.maxWaitMs <= 0) {
      void guardedRefreshPromise;
      return;
    }

    await Promise.race([
      guardedRefreshPromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, params.maxWaitMs);
      }),
    ]);
  } catch (error) {
    await params.log?.("Pricing refresh failed", {
      reason: params.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function buildQuotaReport(params: {
  title: string;
  sinceMs?: number;
  untilMs?: number;
  sessionID: string;
  topModels?: number;
  topSessions?: number;
  filterSessionID?: string;
  filterSessionIDs?: string[];
  sessionOnly?: boolean;
  reportKind?: "standard" | "session" | "session_tree";
  sessionTree?: {
    rootSessionID: string;
    nodes: SessionTreeNode[];
  };
  generatedAtMs: number;
}): Promise<string> {
  const result = await aggregateUsage({
    sinceMs: params.sinceMs,
    untilMs: params.untilMs,
    sessionID: params.filterSessionID,
    sessionIDs: params.filterSessionIDs,
  });
  return formatQuotaStatsReport({
    title: params.title,
    result,
    topModels: params.topModels,
    topSessions: params.topSessions,
    focusSessionID: params.sessionID,
    sessionOnly: params.sessionOnly,
    reportKind: params.reportKind,
    sessionTree: params.sessionTree,
    generatedAtMs: params.generatedAtMs,
    tableOptions: {
      compactHeaders: true,
      modelNameMaxWidth: TUI_TOKEN_REPORT_MODEL_MAX_WIDTH,
    },
  });
}

export interface QuotaStatusReportConfigPayload {
  configSource: string;
  configPaths: string[];
  globalConfigPaths?: string[];
  workspaceConfigPaths?: string[];
  enabledProviders: string[] | "auto";
  onlyCurrentModel: boolean;
  pricingSnapshotSource: PricingSnapshotSource;
}

export interface QuotaStatusReportPricingPayload {
  selection: PricingSnapshotSource;
  activeSource: string;
  snapshot: {
    source: string;
    generatedAt: string | null;
    units: string;
  };
  snapshotPath: string;
  refreshStatePath: string;
}

export interface QuotaStatusReportPayload {
  version: string;
  generatedAt: string;
  config: QuotaStatusReportConfigPayload;
  providers: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    matchesCurrentModel?: boolean;
  }>;
  pricing: QuotaStatusReportPricingPayload;
  liveProbes: QuotaStatusLiveProbe[];
}

export interface QuotaStatusReportData {
  output: string | null;
  payload: QuotaStatusReportPayload | null;
}

export async function buildStatusReportData(params: {
  runtime: QuotaRuntimeContext;
  refreshGoogleTokens?: boolean;
  skewMs?: number;
  force?: boolean;
  sessionID?: string;
  generatedAtMs: number;
  lastSessionTokenError?: SessionTokenError;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  /** When set, restrict provider availability and live probes to this provider id. */
  providerFilterId?: string;
}): Promise<QuotaStatusReportData> {
  const runtimeConfig = params.runtime.config;
  if (!runtimeConfig.enabled) {
    return { output: null, payload: null };
  }
  await kickPricingRefresh({
    reason: "status",
    maxWaitMs: 750,
    snapshotSelection: runtimeConfig.pricingSnapshot.source,
    log: params.log,
  });

  const currentSession = params.runtime.session.sessionMeta ?? {};
  const currentModel = currentSession.modelID;
  const currentProviderID = currentSession.providerID;
  const sessionModelLookup: "ok" | "not_found" | "no_session" = !params.sessionID
    ? "no_session"
    : currentModel
      ? "ok"
      : "not_found";

  const isAutoMode = runtimeConfig.enabledProviders === "auto";

  const providers = params.runtime.providers;
  const providerContext = createQuotaProviderRuntimeContext(params.runtime);
  let availability = await Promise.all(
    providers.map(async (p) => {
      let ok = false;
      try {
        ok = await p.isAvailable(providerContext);
      } catch {
        ok = false;
      }
      return {
        id: p.id,
        enabled: isAutoMode ? ok : runtimeConfig.enabledProviders.includes(p.id),
        available: ok,
        matchesCurrentModel:
          currentModel || isCursorProviderId(currentProviderID)
            ? matchesQuotaProviderCurrentSelection({
                provider: p,
                currentModel,
                currentProviderID,
                enabledProviders: runtimeConfig.enabledProviders,
                quotaProviders: runtimeConfig.quotaProviders,
              })
            : undefined,
      };
    }),
  );

  const providersById = new Map(providers.map((provider) => [provider.id, provider] as const));
  let liveProbeProviders = availability.flatMap((item) => {
    if (!item.enabled || !item.available) {
      return [];
    }
    const provider = providersById.get(item.id);
    return provider ? [provider] : [];
  });

  if (params.providerFilterId) {
    availability = availability.filter((item) => item.id === params.providerFilterId);
    liveProbeProviders = liveProbeProviders.filter(
      (provider) => provider.id === params.providerFilterId,
    );
  }

  let providerLiveProbes: QuotaStatusLiveProbe[] = [];
  if (liveProbeProviders.length > 0) {
    try {
      providerLiveProbes = await collectQuotaStatusLiveProbes({
        client: params.runtime.client,
        config: runtimeConfig,
        configMeta: params.runtime.configMeta,
        request: createQuotaRuntimeRequestContext(params.runtime),
        formatStyle: SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE,
        providers: liveProbeProviders,
      });
    } catch (error) {
      await params.log?.("Failed to collect /quota_status live probes", {
        providers: liveProbeProviders.map((provider) => provider.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refresh = params.refreshGoogleTokens
    ? await refreshGoogleTokensForAllAccounts({ skewMs: params.skewMs, force: params.force })
    : null;

  const tuiDiagnostics = await inspectTuiConfig({ roots: params.runtime.roots });
  const announcementProviderIds = availability
    .filter((item) => item.enabled && item.available)
    .map((item) => item.id);
  const maintainerAnnouncementsSummary = getMaintainerAnnouncementsSummary({
    enabledProviders: announcementProviderIds,
  });

  const output = await buildQuotaStatusReport({
    tuiDiagnostics,
    configSource: params.runtime.configMeta.source,
    configPaths: params.runtime.configMeta.paths,
    globalConfigPaths: params.runtime.configMeta.globalConfigPaths,
    workspaceConfigPaths: params.runtime.configMeta.workspaceConfigPaths,
    settingSources: params.runtime.configMeta.settingSources,
    configIssues: params.runtime.configMeta.configIssues,
    enabledProviders: runtimeConfig.enabledProviders,
    anthropicBinaryPath: runtimeConfig.anthropicBinaryPath,
    cursorPlan: runtimeConfig.cursorPlan,
    cursorIncludedApiUsd: runtimeConfig.cursorIncludedApiUsd,
    cursorBillingCycleStartDay: runtimeConfig.cursorBillingCycleStartDay,
    opencodeGoWindows: runtimeConfig.opencodeGoWindows,
    pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
    onlyCurrentModel: runtimeConfig.onlyCurrentModel,
    currentModel,
    sessionModelLookup,
    providerAvailability: availability,
    providerLiveProbes,
    quotaProviders: runtimeConfig.quotaProviders,
    googleRefresh: refresh
      ? {
          attempted: true,
          total: refresh.total,
          successCount: refresh.successCount,
          failures: refresh.failures,
        }
      : { attempted: false },
    sessionTokenError: params.lastSessionTokenError,
    maintainerAnnouncements: {
      config: runtimeConfig.maintainerAnnouncements,
      summary: maintainerAnnouncementsSummary,
    },
    geminiCliClient: params.runtime.client,
    generatedAtMs: params.generatedAtMs,
  });

  const version = (await getPackageVersion()) ?? "unknown";
  const pricingMeta = getPricingSnapshotMeta();
  const activePricingSource = getPricingSnapshotSource();
  const payload: QuotaStatusReportPayload = {
    version,
    generatedAt: new Date(params.generatedAtMs).toISOString(),
    config: {
      configSource: params.runtime.configMeta.source,
      configPaths: params.runtime.configMeta.paths,
      globalConfigPaths: params.runtime.configMeta.globalConfigPaths,
      workspaceConfigPaths: params.runtime.configMeta.workspaceConfigPaths,
      enabledProviders: runtimeConfig.enabledProviders,
      onlyCurrentModel: runtimeConfig.onlyCurrentModel,
      pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
    },
    providers: availability,
    pricing: {
      selection: runtimeConfig.pricingSnapshot.source,
      activeSource: activePricingSource,
      snapshot: {
        source: pricingMeta.source,
        generatedAt:
          pricingMeta.generatedAt > 0 ? new Date(pricingMeta.generatedAt).toISOString() : null,
        units: pricingMeta.units,
      },
      snapshotPath: getRuntimePricingSnapshotPath(),
      refreshStatePath: getRuntimePricingRefreshStatePath(),
    },
    liveProbes: providerLiveProbes,
  };

  return { output, payload };
}

async function buildStatusReport(params: {
  runtime: QuotaRuntimeContext;
  refreshGoogleTokens?: boolean;
  skewMs?: number;
  force?: boolean;
  sessionID?: string;
  generatedAtMs: number;
  lastSessionTokenError?: SessionTokenError;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<string | null> {
  return (await buildStatusReportData(params)).output;
}

function formatIsoTimestamp(timestampMs: number | undefined): string {
  return typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
    ? new Date(timestampMs).toISOString()
    : "(none)";
}

function buildPricingRefreshCommandOutput(params: {
  result: PricingRefreshResult;
  configuredSelection: string;
  generatedAtMs: number;
}): string {
  const meta = getPricingSnapshotMeta();
  const activeSource = getPricingSnapshotSource();
  const resultLabel =
    params.result.reason ??
    params.result.state.lastResult ??
    (params.result.updated ? "success" : "unknown");

  const lines = [
    renderCommandHeading({
      title: "Pricing Refresh (/pricing_refresh)",
      generatedAtMs: params.generatedAtMs,
    }),
    "",
    "refresh:",
    `- attempted: ${params.result.attempted ? "true" : "false"}`,
    `- result: ${resultLabel}`,
    `- runtime_snapshot_persisted: ${params.result.updated ? "true" : "false"}`,
  ];

  if (params.result.error) {
    lines.push(`- error: ${params.result.error}`);
  }

  lines.push("");
  lines.push("pricing_snapshot:");
  lines.push(`- selection: configured=${params.configuredSelection} active=${activeSource}`);
  lines.push(
    `- active_snapshot: source=${meta.source} generated_at=${formatIsoTimestamp(meta.generatedAt)} units=${meta.units}`,
  );
  lines.push(
    `- runtime_paths: snapshot=${getRuntimePricingSnapshotPath()} refresh_state=${getRuntimePricingRefreshStatePath()}`,
  );
  if (params.configuredSelection === "bundled" && params.result.updated) {
    lines.push(
      "- selection_note: runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing",
    );
  }

  return lines.join("\n");
}

function buildTokenReportUnavailableOutput(params: {
  command: `/${string}`;
  generatedAtMs: number;
  error: SessionNotFoundError;
}): string {
  const lines = [
    renderCommandHeading({
      title: `Token report unavailable (${params.command})`,
      generatedAtMs: params.generatedAtMs,
    }),
    "",
    "session_lookup_error:",
    `- session_id: ${params.error.sessionID}`,
    `- error: ${params.error.message}`,
    `- checked_path: ${params.error.checkedPath}`,
  ];

  return lines.join("\n");
}

async function buildQuotaAnnouncementsCommandOutput(runtime: QuotaRuntimeContext): Promise<string> {
  let activeAnnouncements: ReturnType<
    typeof getMaintainerAnnouncementsSummary
  >["activeAnnouncements"] = [];

  if (runtime.config.enabled && runtime.config.maintainerAnnouncements.enabled) {
    const providerIds = await collectConcreteEnabledProviderIds({
      providers: runtime.providers,
      ctx: createQuotaProviderRuntimeContext(runtime),
      enabledProviders: runtime.config.enabledProviders,
    });
    const summary = getMaintainerAnnouncementsSummary({
      announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
      enabledProviders: providerIds,
    });
    activeAnnouncements = summary.activeAnnouncements;
  }

  const lines = ["Maintainer announcements", ""];

  if (activeAnnouncements.length === 0) {
    lines.push("No current announcements.");
    return lines.join("\n");
  }

  for (const evaluation of activeAnnouncements) {
    lines.push(`- ${evaluation.announcement.message}`);
    if (evaluation.announcement.url) {
      lines.push(`  ${evaluation.announcement.url}`);
    }
  }

  return lines.join("\n");
}

function outputResult(params: {
  command: QuotaDialogCommandId;
  output: string;
}): QuotaDialogCommandOutputResult {
  const spec = QUOTA_DIALOG_COMMANDS_BY_ID.get(params.command)!;
  return {
    state: "output",
    command: params.command,
    title: spec.title,
    output: params.output,
    dialogSize: spec.dialogSize,
  };
}

async function buildTokenReportCommandOutput(params: {
  command: TokenReportCommandId;
  arguments?: string;
  sessionID?: string;
  generatedAtMs: number;
  runtime: QuotaRuntimeContext;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<string> {
  const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(params.command)!;
  const sessionID = params.sessionID;
  const untilMs = params.generatedAtMs;
  await kickPricingRefresh({
    reason: "tokens",
    maxWaitMs: 750,
    snapshotSelection: params.runtime.config.pricingSnapshot.source,
    log: params.log,
  });

  if (!sessionID && (spec.kind === "session" || spec.kind === "session_tree")) {
    return buildTokenReportUnavailableOutput({
      command: spec.template,
      generatedAtMs: params.generatedAtMs,
      error: new SessionNotFoundError("(none)", "(none)"),
    });
  }

  try {
    if (spec.kind === "between") {
      const parsed = parseQuotaBetweenArgs(params.arguments);
      if (!parsed.ok) {
        return `Invalid arguments for /${spec.id}\n\n${parsed.error}\n\nExpected: /${spec.id} YYYY-MM-DD YYYY-MM-DD\nExample: /${spec.id} 2026-01-01 2026-01-15`;
      }

      const sinceMs = startOfLocalDayMs(parsed.startYmd);
      const rangeUntilMs = startOfNextLocalDayMs(parsed.endYmd);
      return await buildQuotaReport({
        title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
        sinceMs,
        untilMs: rangeUntilMs,
        sessionID: sessionID ?? "",
        generatedAtMs: params.generatedAtMs,
      });
    }

    let sinceMs: number | undefined;
    let filterSessionID: string | undefined;
    let filterSessionIDs: string[] | undefined;
    let sessionOnly: boolean | undefined;
    let topModels: number | undefined;
    let topSessions: number | undefined;
    let reportKind: "standard" | "session" | "session_tree" | undefined;
    let sessionTree: { rootSessionID: string; nodes: SessionTreeNode[] } | undefined;

    switch (spec.kind) {
      case "rolling":
        sinceMs = untilMs - spec.windowMs!;
        break;
      case "today": {
        const now = new Date(untilMs);
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        sinceMs = startOfDay.getTime();
        break;
      }
      case "session":
        filterSessionID = sessionID;
        sessionOnly = true;
        reportKind = "session";
        break;
      case "session_tree": {
        const nodes = await resolveSessionTree(sessionID!);
        filterSessionIDs = nodes.map((node) => node.sessionID);
        reportKind = "session_tree";
        sessionTree = { rootSessionID: sessionID!, nodes };
        break;
      }
      case "all":
        topModels = spec.topModels;
        topSessions = spec.topSessions;
        break;
    }

    return await buildQuotaReport({
      title: spec.title,
      sinceMs,
      untilMs: spec.kind === "rolling" || spec.kind === "today" ? untilMs : undefined,
      sessionID: sessionID ?? "",
      filterSessionID,
      filterSessionIDs,
      sessionOnly,
      reportKind,
      sessionTree,
      topModels,
      topSessions,
      generatedAtMs: params.generatedAtMs,
    });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return buildTokenReportUnavailableOutput({
        command: spec.template,
        generatedAtMs: params.generatedAtMs,
        error: err,
      });
    }
    throw err;
  }
}

export async function buildQuotaDialogCommandOutput(params: {
  command: QuotaDialogCommandId;
  arguments?: string;
  client: QuotaRuntimeClient;
  roots: RuntimeContextRootHints;
  sessionID?: string;
  sessionMeta?: SessionModelMeta;
  resolveSessionMeta?: (sessionID: string) => Promise<SessionModelMeta>;
  generatedAtMs?: number;
  lastSessionTokenError?: SessionTokenError;
  setLastSessionTokenError?: (error: SessionTokenError | undefined) => void;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<QuotaDialogCommandOutputResult> {
  const generatedAtMs = params.generatedAtMs ?? Date.now();
  const runtime = await resolveQuotaRuntimeContext({
    client: params.client,
    roots: params.roots,
    sessionID: params.sessionID,
    sessionMeta: params.sessionMeta,
    resolveSessionMeta: params.resolveSessionMeta,
    includeSessionMeta: (config) => config.onlyCurrentModel || params.command === "quota_status",
  });

  setPricingSnapshotAutoRefresh(runtime.config.pricingSnapshot.autoRefresh);
  setPricingSnapshotSelection(runtime.config.pricingSnapshot.source);

  if (!runtime.config.enabled && params.command !== "quota_announcements") {
    return { state: "noop", command: params.command, reason: "disabled" };
  }

  if (params.command === "quota") {
    const reportData = await fetchQuotaCommandData({
      runtime,
      setLastSessionTokenError: params.setLastSessionTokenError,
    });
    if (!reportData) {
      return outputResult({
        command: params.command,
        output: await buildQuotaCommandUnavailableMessage(runtime),
      });
    }

    return outputResult({
      command: params.command,
      output: formatQuotaCommand({
        ...reportData,
        generatedAtMs,
        percentDisplayMode: runtime.config.percentDisplayMode,
      }),
    });
  }

  if (params.command === "quota_status") {
    const parsed = parseOptionalJsonArgs(params.arguments);
    if (!parsed.ok) {
      return outputResult({
        command: params.command,
        output: `Invalid arguments for /quota_status\n\n${parsed.error}\n\nExample:\n/quota_status {"refreshGoogleTokens": true}`,
      });
    }

    const output = await buildStatusReport({
      runtime,
      refreshGoogleTokens: parsed.value["refreshGoogleTokens"] === true,
      skewMs:
        typeof parsed.value["skewMs"] === "number" ? (parsed.value["skewMs"] as number) : undefined,
      force: parsed.value["force"] === true,
      sessionID: params.sessionID,
      generatedAtMs,
      lastSessionTokenError: params.lastSessionTokenError,
      log: params.log,
    });
    return output
      ? outputResult({ command: params.command, output })
      : { state: "noop", command: params.command, reason: "disabled" };
  }

  if (params.command === "quota_announcements") {
    if ((params.arguments ?? "").trim()) {
      return outputResult({
        command: params.command,
        output:
          "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
      });
    }

    return outputResult({
      command: params.command,
      output: await buildQuotaAnnouncementsCommandOutput(runtime),
    });
  }

  if (params.command === "pricing_refresh") {
    if ((params.arguments ?? "").trim()) {
      return outputResult({
        command: params.command,
        output:
          "Invalid arguments for /pricing_refresh\n\nThis command does not accept arguments.\n\nUsage:\n/pricing_refresh",
      });
    }

    const result = await maybeRefreshPricingSnapshot({
      reason: "manual",
      force: true,
      snapshotSelection: runtime.config.pricingSnapshot.source,
      allowRefreshWhenSelectionBundled: true,
    });
    return outputResult({
      command: params.command,
      output: buildPricingRefreshCommandOutput({
        result,
        configuredSelection: runtime.config.pricingSnapshot.source,
        generatedAtMs,
      }),
    });
  }

  if (isTokenReportCommand(params.command)) {
    return outputResult({
      command: params.command,
      output: await buildTokenReportCommandOutput({
        command: params.command,
        arguments: params.arguments,
        sessionID: params.sessionID,
        generatedAtMs,
        runtime,
        log: params.log,
      }),
    });
  }

  return { state: "noop", command: params.command, reason: "disabled" };
}
