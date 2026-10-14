/**
 * Preload script for the Electron menubar app.
 *
 * Exposes a typed `quotaApi` object to the renderer via contextBridge.
 * The renderer has NO direct access to Node.js or Electron APIs.
 */

import { contextBridge, ipcRenderer } from "electron";

// =============================================================================
// Typed API surface exposed to renderer
// =============================================================================

const quotaApi = {
  // ── Quota ──────────────────────────────────────────────
  quota: {
    fetch: (bypassCache?: boolean) => ipcRenderer.invoke("quota:fetch", { bypassCache }),
    state: () => ipcRenderer.invoke("quota:state"),
    onUpdate: (
      callback: (snapshot: import("./quota-refresh-controller.js").QuotaRefreshSnapshot) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        snapshot: import("./quota-refresh-controller.js").QuotaRefreshSnapshot,
      ) => callback(snapshot);
      ipcRenderer.on("quota:updated", listener);
      return () => {
        ipcRenderer.removeListener("quota:updated", listener);
      };
    },
  },

  // ── Token Usage ────────────────────────────────────────
  tokens: {
    query: (params: { window?: string; windowMs?: number; sinceMs?: number; untilMs?: number }) =>
      ipcRenderer.invoke("tokens:query", params),
    projects: () => ipcRenderer.invoke("tokens:projects"),
    syncExport: () => ipcRenderer.invoke("tokens:sync-export"),
    syncExportAndPush: () => ipcRenderer.invoke("tokens:sync-export-and-push"),
    merged: () => ipcRenderer.invoke("tokens:merged"),
  },

  // ── Pricing ────────────────────────────────────────────
  pricing: {
    list: () => ipcRenderer.invoke("pricing:list"),
    save: (params: {
      provider: string;
      model: string;
      rates: Record<string, number | undefined>;
      label?: string;
    }) => ipcRenderer.invoke("pricing:save", params),
    delete: (provider: string, model: string) =>
      ipcRenderer.invoke("pricing:delete", { provider, model }),
    refreshSnapshot: () => ipcRenderer.invoke("pricing:refresh"),
    listProviders: () => ipcRenderer.invoke("pricing:listProviders"),
    listModels: (provider: string) => ipcRenderer.invoke("pricing:listModels", { provider }),
  },

  // ── Budget Alerts ──────────────────────────────────────
  alerts: {
    list: () => ipcRenderer.invoke("alerts:list"),
    create: (params: {
      name: string;
      scope: { type: string; providerId?: string; modelId?: string };
      window: string;
      metric: string;
      threshold: number;
      direction: "above" | "below";
      enabled?: boolean;
    }) => ipcRenderer.invoke("alerts:create", params),
    update: (id: string, params: Record<string, unknown>) =>
      ipcRenderer.invoke("alerts:update", { id, params }),
    delete: (id: string) => ipcRenderer.invoke("alerts:delete", { id }),
    evaluate: () => ipcRenderer.invoke("alerts:eval"),
    state: () => ipcRenderer.invoke("alerts:state"),
    onUpdate: (
      callback: (state: import("./budget-evaluation.js").BudgetEvaluationState) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: import("./budget-evaluation.js").BudgetEvaluationState,
      ) => callback(state);
      ipcRenderer.on("alerts:updated", listener);
      return () => {
        ipcRenderer.removeListener("alerts:updated", listener);
      };
    },
  },

  // ── API Keys ───────────────────────────────────────────
  apikeys: {
    status: () => ipcRenderer.invoke("apikeys:status"),
    init: (passphrase: string) => ipcRenderer.invoke("apikeys:init", { passphrase }),
    unlock: (passphrase: string) => ipcRenderer.invoke("apikeys:unlock", { passphrase }),
    lock: () => ipcRenderer.invoke("apikeys:lock"),
    isUnlocked: () => ipcRenderer.invoke("apikeys:isUnlocked"),
    list: () => ipcRenderer.invoke("apikeys:list"),
    get: (providerId: string) => ipcRenderer.invoke("apikeys:get", { providerId }),
    getMasked: (providerId: string) => ipcRenderer.invoke("apikeys:getMasked", { providerId }),
    save: (providerId: string, apiKey: string, label?: string) =>
      ipcRenderer.invoke("apikeys:save", { providerId, apiKey, label }),
    delete: (providerId: string) => ipcRenderer.invoke("apikeys:delete", { providerId }),
    changePassphrase: (oldPass: string, newPass: string) =>
      ipcRenderer.invoke("apikeys:changePassphrase", {
        oldPassphrase: oldPass,
        newPassphrase: newPass,
      }),
    export: (sharePassphrase: string) => ipcRenderer.invoke("apikeys:export", { sharePassphrase }),
    import: (filePath: string, sharePassphrase: string) =>
      ipcRenderer.invoke("apikeys:import", { filePath, sharePassphrase }),
  },

  // ── Config ─────────────────────────────────────────────
  config: {
    quota: () => ipcRenderer.invoke("config:quota"),
    reloadQuota: () => ipcRenderer.invoke("config:quota-reload"),
    get: () => ipcRenderer.invoke("config:get"),
    update: (patch: Record<string, unknown>) => ipcRenderer.invoke("config:update", { patch }),
    reset: () => ipcRenderer.invoke("config:reset"),
  },

  // ── App ────────────────────────────────────────────────
  app: {
    getVersion: () => ipcRenderer.invoke("app:version"),
    quit: () => ipcRenderer.invoke("app:quit"),
    onRefresh: (callback: () => void) => {
      ipcRenderer.on("app:refresh", () => callback());
      return () => {
        ipcRenderer.removeAllListeners("app:refresh");
      };
    },
  },

  // ── Shell ──────────────────────────────────────────────
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", { url }),
  },

  // ── Dashboard History ──────────────────────────────────
  dashboardHistory: {
    onUpdate: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("history:updated", listener);
      return () => {
        ipcRenderer.removeListener("history:updated", listener);
      };
    },
    listProviders: () => ipcRenderer.invoke("dashboardHistory:listProviders"),
    quotaHistory: (provider: string, days?: number) =>
      ipcRenderer.invoke("dashboardHistory:quotaHistory", { provider, days }),
    modelBreakdown: (provider: string, days?: number) =>
      ipcRenderer.invoke("dashboardHistory:modelBreakdown", { provider, days }),
    weeklyResets: (provider: string, weeks?: number) =>
      ipcRenderer.invoke("dashboardHistory:weeklyResets", { provider, weeks }),
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld("quotaApi", quotaApi);

// Type declaration for renderer
export type QuotaApi = typeof quotaApi;
