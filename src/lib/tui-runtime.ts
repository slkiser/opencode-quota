import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { type RuntimeContextRootHints, resolveRuntimeContextRoots } from "./config-file-utils.js";
import type { AccountingWindow } from "./entries.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds,
  type MaintainerAnnouncement,
} from "./maintainer-announcements.js";
import { getQuotaProviderShape, normalizeQuotaProviderId } from "./provider-metadata.js";
import { projectQuotaProviderResults } from "./quota-accounting-projection.js";
import {
  buildQuotaExport,
  createExportProviderContext,
  resolveExportPath,
  writeQuotaExport,
} from "./quota-export.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import type { CollectQuotaRenderDataResult, SessionModelMeta } from "./quota-render-data.js";
import { collectConcreteEnabledProviderIds, collectQuotaRenderData } from "./quota-render-data.js";
import type { QuotaRuntimeContext } from "./quota-runtime-context.js";
import {
  createQuotaProviderRuntimeContext,
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import { buildCompactQuotaStatusLine } from "./tui-compact-format.js";
import { hasNativeProviderQuotaClient } from "./tui-native-provider-quota.js";
import type {
  CompactStatusState,
  HomeBottomState,
  PromptBarState,
  SidebarPanelState,
} from "./tui-panel-state.js";
import { pickPromptBarEntry } from "./tui-prompt-bar-format.js";
import { buildSidebarQuotaPanelLines, TUI_SIDEBAR_MAX_WIDTH } from "./tui-sidebar-format.js";
import type { OpenCodeGoWindowKey, TuiCommandDisplay } from "./types.js";

const COMPACT_UNAVAILABLE_TEXT = "Quota unavailable";
const tuiQuotaClients = new WeakMap<TuiPluginApi, ReturnType<typeof makeTuiQuotaClient>>();

export function getTuiRuntimeRootHints(api: TuiPluginApi): RuntimeContextRootHints {
  return {
    worktreeRoot: api.state.path.worktree,
    activeDirectory: api.state.path.directory,
    fallbackDirectory: process.cwd(),
  };
}

export function resolveWorkspaceDir(api: TuiPluginApi): string {
  return resolveRuntimeContextRoots(getTuiRuntimeRootHints(api)).workspaceRoot;
}

function makeTuiQuotaClient(api: TuiPluginApi) {
  return {
    config: {
      providers: async () => {
        try {
          if (api.client.config?.providers) {
            const response = await api.client.config.providers();
            return {
              data: {
                providers: response.data?.providers ?? [],
              },
            };
          }
        } catch {
          // Fall back to TUI state provider list below.
        }

        return {
          data: {
            providers: api.state.provider.map((provider) => ({ id: provider.id })),
          },
        };
      },
      get: async () => {
        try {
          if (api.client.config?.get) {
            const response = await api.client.config.get();
            return {
              data: response?.data && typeof response.data === "object" ? response.data : {},
            };
          }
        } catch {
          // Fall back to empty config below.
        }

        return { data: {} };
      },
    },
  };
}

export function createTuiQuotaClient(api: TuiPluginApi) {
  const existing = tuiQuotaClients.get(api);
  if (existing) return existing;
  const client = makeTuiQuotaClient(api);
  tuiQuotaClients.set(api, client);
  return client;
}

export function normalizeTuiSessionID(sessionID: unknown): string | undefined {
  if (typeof sessionID !== "string") return undefined;

  const trimmed = sessionID.trim();
  if (!trimmed) return undefined;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed).trim();
  } catch {
    decoded = trimmed;
  }

  if (!decoded || decoded.includes("{") || decoded.includes("}")) return undefined;
  if (decoded === "sessionID" || decoded === "session_id" || decoded === "id") return undefined;

  return trimmed;
}

function extractSessionModelMeta(input: unknown): SessionModelMeta {
  if (!input || typeof input !== "object") return {};
  const item = input as {
    model?: { providerID?: string; id?: string };
  };
  const providerID = item.model?.providerID;
  const modelID = item.model?.id;
  return providerID || modelID ? { providerID, modelID } : {};
}

function extractMessageModelMeta(input: unknown): SessionModelMeta {
  if (!input || typeof input !== "object") return {};
  const item = input as {
    role?: string;
    providerID?: string;
    modelID?: string;
    model?: { providerID?: string; modelID?: string };
  };
  if (item.role === "assistant") {
    return item.providerID || item.modelID
      ? { providerID: item.providerID, modelID: item.modelID }
      : {};
  }
  if (item.role === "user") {
    return item.model?.providerID || item.model?.modelID
      ? { providerID: item.model?.providerID, modelID: item.model?.modelID }
      : {};
  }
  return {};
}

function getMessageSessionModelMeta(api: TuiPluginApi, sessionID: string): SessionModelMeta {
  const messages = api.state.session.messages(sessionID);
  for (let index = messages.length - 1; index >= 0; index--) {
    const meta = extractMessageModelMeta(messages[index]);
    if (meta.providerID || meta.modelID) return meta;
  }
  return {};
}

export async function getTuiSessionModelMeta(
  api: TuiPluginApi,
  sessionID: string,
): Promise<SessionModelMeta> {
  const safeSessionID = normalizeTuiSessionID(sessionID);
  if (!safeSessionID) return {};

  const stateSession = api.state.session as { get?: (sessionID: string) => unknown };
  try {
    const stateMeta = extractSessionModelMeta(stateSession.get?.(safeSessionID));
    if (stateMeta.providerID || stateMeta.modelID) return stateMeta;
  } catch {
    // Fall back to the client lookup below.
  }

  try {
    const sessionGet = (api.client.session as any)?.get;
    const response = await sessionGet?.({ sessionID: safeSessionID });
    const meta = extractSessionModelMeta(response?.data);
    if (meta.providerID || meta.modelID) return meta;
  } catch {
    // Fall back to session message state below.
  }

  return getMessageSessionModelMeta(api, safeSessionID);
}

export type TuiSidebarPanelRegistration = {
  enabled: boolean;
};

export type TuiCompactStatusRegistration = {
  enabled: boolean;
  homeBottom: boolean;
  sessionPrompt: boolean;
  hasNativeProviderQuota: boolean;
  suppressedByNativeProviderQuota: boolean;
};

export type TuiPromptBarRegistration = {
  enabled: boolean;
};

export type TuiMaintainerAnnouncementsRegistration = {
  homeBottom: boolean;
};

export type TuiSurfaceRegistration = {
  commandDisplay: TuiCommandDisplay;
  sidebar: TuiSidebarPanelRegistration;
  compact: TuiCompactStatusRegistration;
  promptBar: TuiPromptBarRegistration;
  announcements: TuiMaintainerAnnouncementsRegistration;
  homeBottom: boolean;
};

export type TuiSessionQuotaSurfaces = {
  sidebar: SidebarPanelState;
  compact: CompactStatusState;
  promptBar: PromptBarState;
};

export type TuiInitialRuntimeSeed = Readonly<
  Pick<QuotaRuntimeContext, "roots" | "config" | "configMeta" | "providers">
>;

export type TuiSurfaceRegistrationOptions = {
  captureInitialRuntime?: (seed: TuiInitialRuntimeSeed) => void;
};

function getMatchingInitialRuntimeSeed(
  api: TuiPluginApi,
  seed: TuiInitialRuntimeSeed | undefined,
): TuiInitialRuntimeSeed | undefined {
  if (!seed) return undefined;

  const roots = resolveRuntimeContextRoots(getTuiRuntimeRootHints(api));
  return roots.workspaceRoot === seed.roots.workspaceRoot &&
    roots.configRoot === seed.roots.configRoot
    ? seed
    : undefined;
}

function isSessionSidebarEnabled(runtime: QuotaRuntimeContext): boolean {
  return runtime.config.enabled && runtime.config.tuiSidebarPanel.enabled;
}

function isSessionCompactEnabled(runtime: QuotaRuntimeContext): boolean {
  return (
    runtime.config.enabled &&
    runtime.config.tuiCompactStatus.enabled &&
    runtime.config.tuiCompactStatus.sessionPrompt
  );
}

function isSessionPromptBarEnabled(runtime: QuotaRuntimeContext): boolean {
  return runtime.config.enabled && runtime.config.tuiPromptBar.enabled;
}

function buildDisabledSessionQuotaSurfaces(): TuiSessionQuotaSurfaces {
  return {
    sidebar: { status: "disabled", lines: [] },
    compact: { status: "disabled" },
    promptBar: { status: "disabled" },
  };
}

function buildCompactStatusFromData(params: {
  runtime: QuotaRuntimeContext;
  result: CollectQuotaRenderDataResult;
  enabled: boolean;
  maxWidth?: number;
  formatStyle?: ReturnType<typeof resolveQuotaFormatStyle>;
}): CompactStatusState {
  if (!params.enabled) return { status: "disabled" };

  if (params.result.selection?.waitingForCurrentSelection) {
    return { status: "loading" };
  }

  const effectiveFormatStyle =
    params.formatStyle ?? resolveQuotaFormatStyle(params.runtime.config.formatStyle);
  const data =
    effectiveFormatStyle === "allWindows" && params.result.allWindowsData
      ? params.result.allWindowsData
      : effectiveFormatStyle === "singleWindow" && params.result.singleWindowData !== undefined
        ? params.result.singleWindowData
        : params.result.data;

  const text = data
    ? buildCompactQuotaStatusLine({
        data,
        percentDisplayMode: params.runtime.config.percentDisplayMode,
        accountingDetail: params.runtime.config.accountingDetail,
        ...(params.runtime.config.resetTimeSpaced !== undefined
          ? { resetTimeSpaced: params.runtime.config.resetTimeSpaced }
          : {}),
        maxWidth: params.maxWidth ?? params.runtime.config.tuiCompactStatus.maxWidth,
      })
    : "";

  return {
    status: "ready",
    text: text.trim() ? text : COMPACT_UNAVAILABLE_TEXT,
  };
}

const OPENCODE_GO_ACCOUNTING_WINDOWS: Readonly<Record<OpenCodeGoWindowKey, AccountingWindow>> = {
  rolling: "five_hour",
  weekly: "week",
  monthly: "month",
};

function buildSidebarPanelFromData(params: {
  runtime: QuotaRuntimeContext;
  result: CollectQuotaRenderDataResult;
  formatStyle: ReturnType<typeof resolveQuotaFormatStyle>;
}): SidebarPanelState {
  if (params.result.selection?.waitingForCurrentSelection) {
    return {
      status: "loading",
      lines: [],
    };
  }

  const hasExpandedDetail =
    params.formatStyle === "allWindows" && Boolean(params.result.allWindowsData);
  const baseCompactData = params.result.singleWindowData ?? params.result.data;
  const preferredWindowKey = params.runtime.config.tuiSidebarPanel.opencodeGoPreferredWindow;
  const providerResults = params.result.providerResults ?? [];
  const openCodeGoResultIndex = providerResults.findIndex(
    ({ providerId }) => providerId === "opencode-go",
  );
  const compactData =
    baseCompactData && preferredWindowKey && openCodeGoResultIndex >= 0
      ? {
          ...baseCompactData,
          entries: projectQuotaProviderResults(
            providerResults.map(({ result }) => result),
            "singleWindow",
            params.runtime.config.accountingDetail,
            {
              preferredWindowsByResultIndex: new Map([
                [openCodeGoResultIndex, OPENCODE_GO_ACCOUNTING_WINDOWS[preferredWindowKey]],
              ]),
              quotaProjection: params.runtime.config.quotaProjection,
            },
          ),
        }
      : baseCompactData;
  const primaryData = compactData;
  const primaryFormatStyle =
    params.formatStyle === "allWindows" && params.result.allWindowsData
      ? "singleWindow"
      : params.formatStyle;

  const lines = primaryData
    ? hasExpandedDetail
      ? [
          buildCompactQuotaStatusLine({
            data: primaryData,
            percentDisplayMode: params.runtime.config.percentDisplayMode,
            accountingDetail: params.runtime.config.accountingDetail,
            ...(params.runtime.config.resetTimeSpaced !== undefined
              ? { resetTimeSpaced: params.runtime.config.resetTimeSpaced }
              : {}),
            maxWidth: TUI_SIDEBAR_MAX_WIDTH,
          }),
        ].filter((line): line is string => Boolean(line))
      : buildSidebarQuotaPanelLines({
          data: primaryData,
          config: { ...params.runtime.config, formatStyle: primaryFormatStyle },
        })
    : [];

  const expandedLines = params.result.allWindowsData
    ? (buildSidebarQuotaPanelLines({
        data: params.result.allWindowsData,
        config: { ...params.runtime.config, formatStyle: "allWindows" },
      }) ?? [])
    : [];
  const linesExpanded =
    expandedLines.length > 0 && expandedLines.join("\n") !== lines.join("\n")
      ? expandedLines
      : undefined;

  const visibleData = params.result.allWindowsData ?? primaryData;
  const providerCount = visibleData ? groupQuotaEntries(visibleData.entries, "toast").length : 0;

  return {
    status: "ready",
    lines,
    ...(providerCount > 0 ? { providerCount } : {}),
    ...(linesExpanded ? { linesExpanded } : {}),
    ...(params.runtime.config.percentLabelStyle === "bare"
      ? { headerPercentMode: params.runtime.config.percentDisplayMode }
      : {}),
  };
}

function buildPromptBarFromData(params: {
  runtime: QuotaRuntimeContext;
  result: CollectQuotaRenderDataResult;
  enabled: boolean;
}): PromptBarState {
  if (!params.enabled) {
    return { status: "disabled" };
  }

  if (params.result.selection?.waitingForCurrentSelection) {
    return { status: "loading" };
  }

  const entry = pickPromptBarEntry(params.result.allWindowsData ?? params.result.data);
  return {
    status: "ready",
    ...(entry ? { entry } : {}),
    percentDisplayMode: params.runtime.config.percentDisplayMode,
    resetTimeDecimals: params.runtime.config.resetTimeDecimals,
    ...(params.runtime.config.resetTimeSpaced !== undefined
      ? { resetTimeSpaced: params.runtime.config.resetTimeSpaced }
      : {}),
  };
}

async function collectTuiQuotaRenderData(params: {
  runtime: QuotaRuntimeContext;
  request: ReturnType<typeof createQuotaRuntimeRequestContext>;
}): Promise<{
  result: CollectQuotaRenderDataResult;
  formatStyle: ReturnType<typeof resolveQuotaFormatStyle>;
  sidebarFormatStyle: ReturnType<typeof resolveQuotaFormatStyle>;
  compactFormatStyle: ReturnType<typeof resolveQuotaFormatStyle>;
}> {
  const formatStyle = resolveQuotaFormatStyle(params.runtime.config.formatStyle);
  const sidebarFormatStyle = params.runtime.config.tuiSidebarPanel.formatStyle
    ? resolveQuotaFormatStyle(params.runtime.config.tuiSidebarPanel.formatStyle)
    : formatStyle;
  const compactFormatStyle = params.runtime.config.tuiCompactStatus.formatStyle
    ? resolveQuotaFormatStyle(params.runtime.config.tuiCompactStatus.formatStyle)
    : formatStyle;
  const result = await collectQuotaRenderData({
    client: params.runtime.client,
    resolveRuntimeProviderIds: params.runtime.resolveRuntimeProviderIds,
    config: params.runtime.config,
    configMeta: params.runtime.configMeta,
    request: params.request,
    surfaceExplicitProviderIssues: true,
    formatStyle,
    providers: params.runtime.providers,
    includeAllWindowsData: true,
  });

  return { result, formatStyle, sidebarFormatStyle, compactFormatStyle };
}

export async function resolveTuiSurfaceRegistration(
  api: TuiPluginApi,
  options?: TuiSurfaceRegistrationOptions,
): Promise<TuiSurfaceRegistration> {
  const quotaClient = createTuiQuotaClient(api);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(api),
  });
  const compact = runtime.config.tuiCompactStatus;
  const hasNativeProviderQuota = hasNativeProviderQuotaClient(api.client);
  const suppressedByNativeProviderQuota =
    compact.suppressWhenNativeProviderQuota && hasNativeProviderQuota;
  const compactEnabled =
    runtime.config.enabled && compact.enabled && !suppressedByNativeProviderQuota;
  const announcementHomeBottom =
    runtime.config.enabled &&
    runtime.config.maintainerAnnouncements.enabled &&
    runtime.config.maintainerAnnouncements.home;
  const exportHomeBottom = runtime.config.enabled && runtime.config.export.enabled;
  const compactHomeBottom = compactEnabled && compact.homeBottom;

  const registration = {
    commandDisplay: runtime.config.tuiCommandDisplay,
    sidebar: {
      enabled: runtime.config.enabled && runtime.config.tuiSidebarPanel.enabled,
    },
    compact: {
      enabled: compactEnabled,
      homeBottom: compactHomeBottom,
      sessionPrompt: compactEnabled && compact.sessionPrompt,
      hasNativeProviderQuota,
      suppressedByNativeProviderQuota,
    },
    promptBar: {
      enabled: runtime.config.enabled && runtime.config.tuiPromptBar.enabled,
    },
    announcements: {
      homeBottom: announcementHomeBottom,
    },
    homeBottom: compactHomeBottom || announcementHomeBottom || exportHomeBottom,
  };

  options?.captureInitialRuntime?.({
    roots: runtime.roots,
    config: runtime.config,
    configMeta: runtime.configMeta,
    providers: runtime.providers,
  });
  return registration;
}

export async function loadTuiSessionQuotaSurfaces(params: {
  api: TuiPluginApi;
  sessionID: string;
  initialRuntimeSeed?: TuiInitialRuntimeSeed;
}): Promise<TuiSessionQuotaSurfaces> {
  const quotaClient = createTuiQuotaClient(params.api);
  const initialRuntimeSeed = getMatchingInitialRuntimeSeed(params.api, params.initialRuntimeSeed);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(params.api),
    sessionID: params.sessionID,
    resolveSessionMeta: (sessionID) => getTuiSessionModelMeta(params.api, sessionID),
    includeSessionMeta: (config) => config.onlyCurrentModel,
    config: initialRuntimeSeed?.config,
    configMeta: initialRuntimeSeed?.configMeta,
    providers: initialRuntimeSeed?.providers,
  });

  const sidebarEnabled = isSessionSidebarEnabled(runtime);
  const compactEnabled = isSessionCompactEnabled(runtime);
  const promptBarEnabled = isSessionPromptBarEnabled(runtime);

  if (!sidebarEnabled && !compactEnabled && !promptBarEnabled) {
    return buildDisabledSessionQuotaSurfaces();
  }

  const { result, sidebarFormatStyle, compactFormatStyle } = await collectTuiQuotaRenderData({
    runtime,
    request: createQuotaRuntimeRequestContext(runtime),
  });

  return {
    sidebar: sidebarEnabled
      ? buildSidebarPanelFromData({ runtime, result, formatStyle: sidebarFormatStyle })
      : { status: "disabled", lines: [] },
    compact: buildCompactStatusFromData({
      runtime,
      result,
      enabled: compactEnabled,
      formatStyle: compactFormatStyle,
    }),
    promptBar: buildPromptBarFromData({
      runtime,
      result,
      enabled: promptBarEnabled,
    }),
  };
}

export async function loadTuiHomeBottomStatus(params: {
  api: TuiPluginApi;
  nowMs?: number;
  announcements?: readonly MaintainerAnnouncement[];
  initialRuntimeSeed?: TuiInitialRuntimeSeed;
}): Promise<HomeBottomState> {
  const quotaClient = createTuiQuotaClient(params.api);
  const initialRuntimeSeed = getMatchingInitialRuntimeSeed(params.api, params.initialRuntimeSeed);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(params.api),
    config: initialRuntimeSeed?.config,
    configMeta: initialRuntimeSeed?.configMeta,
    providers: initialRuntimeSeed?.providers,
  });

  const announcementEnabled =
    runtime.config.enabled &&
    runtime.config.maintainerAnnouncements.enabled &&
    runtime.config.maintainerAnnouncements.home;
  const compactSuppressedByNativeProviderQuota =
    runtime.config.tuiCompactStatus.suppressWhenNativeProviderQuota &&
    hasNativeProviderQuotaClient(params.api.client);
  const compactEnabled =
    runtime.config.enabled &&
    runtime.config.tuiCompactStatus.enabled &&
    runtime.config.tuiCompactStatus.homeBottom &&
    !compactSuppressedByNativeProviderQuota;

  if (!announcementEnabled && !compactEnabled) {
    return { status: "disabled", compact: { status: "disabled" } };
  }

  let announcementText: string | undefined;
  if (announcementEnabled) {
    const announcements = params.announcements ?? BUNDLED_MAINTAINER_ANNOUNCEMENTS;
    const targetProviderIds = new Set(
      getMaintainerAnnouncementTargetProviderIds({ announcements }),
    );
    const announcementProviders = runtime.providers.filter((provider) => {
      const shape = getQuotaProviderShape(normalizeQuotaProviderId(provider.id));
      return shape ? targetProviderIds.has(shape.id) : false;
    });
    const providerIds = await collectConcreteEnabledProviderIds({
      providers: announcementProviders,
      ctx: createQuotaProviderRuntimeContext(runtime),
      enabledProviders: runtime.config.enabledProviders,
    });
    const summary = getMaintainerAnnouncementsSummary({
      nowMs: params.nowMs,
      enabledProviders: providerIds,
      announcements,
    });
    announcementText = formatMaintainerAnnouncementHomeCountLine(summary.activeCount) || undefined;
  }

  if (!compactEnabled) {
    return announcementText
      ? { status: "ready", announcementText, compact: { status: "disabled" } }
      : { status: "disabled", compact: { status: "disabled" } };
  }

  const homeRuntime: QuotaRuntimeContext = {
    ...runtime,
    config: {
      ...runtime.config,
      onlyCurrentModel: false,
      showSessionTokens: false,
    },
    session: {},
  };

  const { result, compactFormatStyle } = await collectTuiQuotaRenderData({
    runtime: homeRuntime,
    request: createQuotaRuntimeRequestContext(homeRuntime),
  });

  const compact = buildCompactStatusFromData({
    runtime: homeRuntime,
    result,
    enabled: true,
    formatStyle: compactFormatStyle,
  });

  return { status: "ready", announcementText, compact };
}

/**
 * Writes the quota export file if `config.export.enabled` is true.
 *
 * Called from the TUI home bottom status refresh loop. Errors propagate to
 * the caller; the call-site in `tui.tsx` is responsible for catching and
 * logging them so a failed write never affects rendering.
 */
export async function writeTuiQuotaExportIfEnabled(params: { api: TuiPluginApi }): Promise<void> {
  const quotaClient = createTuiQuotaClient(params.api);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(params.api),
  });

  if (!runtime.config.enabled || !runtime.config.export.enabled) {
    return;
  }

  const resolvedPath = resolveExportPath(runtime.config.export.path);
  const ctx = createExportProviderContext(runtime);

  const exportData = await buildQuotaExport({
    providers: runtime.providers,
    ctx,
    ttlMs: runtime.config.minIntervalMs,
    fromCache: true,
  });

  await writeQuotaExport(exportData, resolvedPath);
}
