import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { CompactStatusState, SidebarPanelState } from "./tui-panel-state.js";

import type { CollectQuotaRenderDataResult, SessionModelMeta } from "./quota-render-data.js";
import type { QuotaRuntimeContext } from "./quota-runtime-context.js";

import { resolveRuntimeContextRoots, type RuntimeContextRootHints } from "./config-file-utils.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import { buildCompactQuotaStatusLine } from "./tui-compact-format.js";
import { hasNativeProviderQuotaClient } from "./tui-native-provider-quota.js";
import { buildSidebarQuotaPanelLines } from "./tui-sidebar-format.js";

const COMPACT_UNAVAILABLE_TEXT = "Quota unavailable";

function getTuiRuntimeRootHints(api: TuiPluginApi): RuntimeContextRootHints {
  return {
    worktreeRoot: api.state.path.worktree,
    activeDirectory: api.state.path.directory,
    fallbackDirectory: process.cwd(),
  };
}

export function resolveWorkspaceDir(api: TuiPluginApi): string {
  return resolveRuntimeContextRoots(getTuiRuntimeRootHints(api)).workspaceRoot;
}

function createTuiQuotaClient(api: TuiPluginApi) {
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

function getMessageSessionModelMeta(api: TuiPluginApi, sessionID: string): SessionModelMeta {
  const messages = api.state.session.messages(sessionID);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      | { providerID?: string; modelID?: string; model?: { providerID?: string; modelID?: string } }
      | undefined;
    const providerID = message?.providerID ?? message?.model?.providerID;
    const modelID = message?.modelID ?? message?.model?.modelID;
    if (providerID || modelID) {
      return { providerID, modelID };
    }
  }
  return {};
}

export async function getTuiSessionModelMeta(
  api: TuiPluginApi,
  sessionID: string,
): Promise<SessionModelMeta> {
  try {
    const response = await api.client.session?.get?.({ path: { id: sessionID } });
    if (response?.data?.providerID || response?.data?.modelID) {
      return {
        providerID: response.data?.providerID,
        modelID: response.data?.modelID,
      };
    }
  } catch {
    // Fall back to session message state below.
  }

  return getMessageSessionModelMeta(api, sessionID);
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

export type TuiSurfaceRegistration = {
  sidebar: TuiSidebarPanelRegistration;
  compact: TuiCompactStatusRegistration;
};

export type TuiSessionQuotaSurfaces = {
  sidebar: SidebarPanelState;
  compact: CompactStatusState;
};

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

function buildDisabledSessionQuotaSurfaces(): TuiSessionQuotaSurfaces {
  return {
    sidebar: { status: "disabled", lines: [] },
    compact: { status: "disabled" },
  };
}

function buildCompactStatusFromData(params: {
  runtime: QuotaRuntimeContext;
  result: CollectQuotaRenderDataResult;
  enabled: boolean;
  maxWidth?: number;
}): CompactStatusState {
  if (!params.enabled) return { status: "disabled" };

  if (params.result.selection?.waitingForCurrentSelection) {
    return { status: "loading" };
  }

  const text = params.result.data
    ? buildCompactQuotaStatusLine({
        data: params.result.data,
        percentDisplayMode: params.runtime.config.percentDisplayMode,
        maxWidth: params.maxWidth ?? params.runtime.config.tuiCompactStatus.maxWidth,
      })
    : "";

  return {
    status: "ready",
    text: text.trim() ? text : COMPACT_UNAVAILABLE_TEXT,
  };
}

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

  const lines = params.result.data
    ? buildSidebarQuotaPanelLines({
        data: params.result.data,
        config: { ...params.runtime.config, formatStyle: params.formatStyle },
      })
    : [];

  let linesExpanded: string[] | undefined;
  if (params.result.allWindowsData) {
    linesExpanded = buildSidebarQuotaPanelLines({
      data: params.result.allWindowsData,
      config: { ...params.runtime.config, formatStyle: "allWindows" },
    });
  }

  const providerCount = params.result.active.length;

  return {
    status: "ready",
    lines,
    ...(providerCount > 0 ? { providerCount } : {}),
    ...(linesExpanded ? { linesExpanded } : {}),
  };
}

async function collectTuiQuotaRenderData(params: {
  runtime: QuotaRuntimeContext;
  request: ReturnType<typeof createQuotaRuntimeRequestContext>;
}): Promise<{
  result: CollectQuotaRenderDataResult;
  formatStyle: ReturnType<typeof resolveQuotaFormatStyle>;
}> {
  const formatStyle = resolveQuotaFormatStyle(params.runtime.config.formatStyle);
  const result = await collectQuotaRenderData({
    client: params.runtime.client,
    config: params.runtime.config,
    configMeta: params.runtime.configMeta,
    request: params.request,
    surfaceExplicitProviderIssues: true,
    formatStyle,
    providers: params.runtime.providers,
    includeAllWindowsData: true,
  });

  return { result, formatStyle };
}

export async function resolveTuiSurfaceRegistration(
  api: TuiPluginApi,
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

  return {
    sidebar: {
      enabled: runtime.config.enabled && runtime.config.tuiSidebarPanel.enabled,
    },
    compact: {
      enabled: compactEnabled,
      homeBottom: compactEnabled && compact.homeBottom,
      sessionPrompt: compactEnabled && compact.sessionPrompt,
      hasNativeProviderQuota,
      suppressedByNativeProviderQuota,
    },
  };
}

export async function resolveTuiCompactStatusRegistration(
  api: TuiPluginApi,
): Promise<TuiCompactStatusRegistration> {
  return (await resolveTuiSurfaceRegistration(api)).compact;
}

export async function loadTuiSessionQuotaSurfaces(params: {
  api: TuiPluginApi;
  sessionID: string;
}): Promise<TuiSessionQuotaSurfaces> {
  const quotaClient = createTuiQuotaClient(params.api);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(params.api),
    sessionID: params.sessionID,
    resolveSessionMeta: (sessionID) => getTuiSessionModelMeta(params.api, sessionID),
    includeSessionMeta: (config) => config.onlyCurrentModel,
  });

  const sidebarEnabled = isSessionSidebarEnabled(runtime);
  const compactEnabled = isSessionCompactEnabled(runtime);

  if (!sidebarEnabled && !compactEnabled) {
    return buildDisabledSessionQuotaSurfaces();
  }

  const { result, formatStyle } = await collectTuiQuotaRenderData({
    runtime,
    request: createQuotaRuntimeRequestContext(runtime),
  });

  return {
    sidebar: sidebarEnabled
      ? buildSidebarPanelFromData({ runtime, result, formatStyle })
      : { status: "disabled", lines: [] },
    compact: buildCompactStatusFromData({
      runtime,
      result,
      enabled: compactEnabled,
    }),
  };
}

export async function loadTuiHomeCompactStatus(params: {
  api: TuiPluginApi;
}): Promise<CompactStatusState> {
  const quotaClient = createTuiQuotaClient(params.api);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(params.api),
  });

  if (
    !runtime.config.enabled ||
    !runtime.config.tuiCompactStatus.enabled ||
    !runtime.config.tuiCompactStatus.homeBottom
  ) {
    return { status: "disabled" };
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

  const { result } = await collectTuiQuotaRenderData({
    runtime: homeRuntime,
    request: createQuotaRuntimeRequestContext(homeRuntime),
  });

  return buildCompactStatusFromData({
    runtime: homeRuntime,
    result,
    enabled: true,
  });
}

export async function loadSidebarPanel(params: {
  api: TuiPluginApi;
  sessionID: string;
}): Promise<SidebarPanelState> {
  return (await loadTuiSessionQuotaSurfaces(params)).sidebar;
}
