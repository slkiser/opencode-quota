import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SidebarPanelState } from "./tui-panel-state.js";

import type { SessionModelMeta } from "./quota-render-data.js";

import {
  resolveRuntimeContextRoots,
  type RuntimeContextRootHints,
} from "./config-file-utils.js";
import { createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext } from "./quota-runtime-context.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import { buildSidebarQuotaPanelLines } from "./tui-sidebar-format.js";

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
              data:
                response?.data && typeof response.data === "object"
                  ? response.data
                  : {},
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

export async function loadSidebarPanel(params: {
  api: TuiPluginApi;
  sessionID: string;
}): Promise<SidebarPanelState> {
  const quotaClient = createTuiQuotaClient(params.api);
  const runtime = await resolveQuotaRuntimeContext({
    client: quotaClient,
    roots: getTuiRuntimeRootHints(params.api),
    sessionID: params.sessionID,
    resolveSessionMeta: (sessionID) => getTuiSessionModelMeta(params.api, sessionID),
    includeSessionMeta: (config) => config.onlyCurrentModel,
  });

  if (!runtime.config.enabled) {
    return {
      status: "disabled",
      lines: [],
    };
  }

  const request = createQuotaRuntimeRequestContext(runtime);
  const result = await collectQuotaRenderData({
    client: runtime.client,
    config: runtime.config,
    request,
    surfaceExplicitProviderIssues: true,
    formatStyle: runtime.config.formatStyle,
    providers: runtime.providers,
  });

  return {
    status: "ready",
    lines: result.data
      ? buildSidebarQuotaPanelLines({ data: result.data, config: runtime.config })
      : [],
  };
}
