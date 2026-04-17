import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SidebarPanelState } from "./tui-panel-state.js";

import type { ProviderFetchCacheStore, SessionModelMeta } from "./quota-render-data.js";

import { createLoadConfigMeta, loadConfig } from "./config.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import { buildSidebarQuotaPanelLines } from "./tui-sidebar-format.js";

export function resolveWorkspaceDir(api: TuiPluginApi): string {
  return api.state.path.worktree || api.state.path.directory || process.cwd();
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
  providerFetchCache: ProviderFetchCacheStore;
}): Promise<SidebarPanelState> {
  const quotaClient = createTuiQuotaClient(params.api);
  const configMeta = createLoadConfigMeta();
  const config = await loadConfig(quotaClient, configMeta, {
    cwd: resolveWorkspaceDir(params.api),
  });

  if (!config.enabled) {
    return {
      status: "disabled",
      lines: [],
    };
  }

  const request = {
    sessionID: params.sessionID,
    sessionMeta: config.onlyCurrentModel
      ? await getTuiSessionModelMeta(params.api, params.sessionID)
      : undefined,
  };
  const result = await collectQuotaRenderData({
    client: quotaClient,
    config,
    request,
    providerFetchCache: params.providerFetchCache,
    surfaceExplicitProviderIssues: true,
    style: config.toastStyle,
  });

  return {
    status: "ready",
    lines: result.data ? buildSidebarQuotaPanelLines({ data: result.data, config }) : [],
  };
}
