/**
 * The GUI window's quota data: the quota snapshot through the TUI's quota client
 * (`../tui/client.ts`: newest snapshot wins, `changed` events, a poll every minute), a manual
 * check of the providers, and the usage report, settings, setup check and notices the TUI's quota
 * window reads, and its settings saves. All of
 * it comes over the quota RPC (`../rpc.ts`) from the server part in the app's own server; the
 * window only lays it out.
 *
 * A call names the folder of the session on screen when that session runs on the app's own
 * server; otherwise (Home, a session on another server) it names none, and the server uses its
 * own folder.
 *
 * Each folder has its own quota client, so one folder's snapshots and events never show in
 * another. A folder's client runs (polls, listens to events) only while something watches that
 * folder; when the last watcher stops, answers to its calls still on their way are dropped. While
 * it runs, it checks every few seconds whether the server's client was replaced (the server
 * restarted) and then starts again on the new one.
 */
import { createSignal } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import type { UsageQuery, UsageReport } from "../core/usage.js";
import {
  type Notice,
  QuotaRpc,
  type QuotaRpcRefreshReason,
  type QuotaRpcSaveSettingsInput,
  type QuotaRpcSaveSettingsOutput,
  type QuotaRpcSettingsSchemaOutput,
} from "../rpc.js";
import type { ClientSettings } from "../settings/index.js";
import {
  type ClientHost,
  createQuotaClient,
  type QuotaClient,
  type QuotaRpcClient,
  quotaCallOptions,
  type RpcLocationHost,
  rpcErrorMessage,
} from "../tui/client.js";

const CLIENT_CHECK_MS = 5_000;

type ServerClient = { rpc: (definition: typeof QuotaRpc) => QuotaRpcClient };

export type GuiQuotaHost = {
  /** The client of the app's own server; read at every call, as it changes when that server restarts. */
  client(): ServerClient;
  /** The folder of the session on screen, when it runs on the app's own server. */
  directory(): string | undefined;
  /**
   * Called with every snapshot any folder's client takes, and its folder (none: the server's
   * own), so toasts can announce reset notices.
   */
  onSnapshot?(snapshot: QuotaSnapshot, directory: string | undefined): void;
};

/** Why a folder has no snapshot: no quota RPC on the server, or a failed call. */
export type GuiQuotaFailure = { kind: "unavailable" } | { kind: "error"; message: string };

export type GuiQuota = {
  /**
   * The folder's latest snapshot (none: the server's own folder), with what it says about
   * `sessionID` (its tokens, the providers serving its model) once a watch of it loaded that;
   * undefined before its first answer.
   */
  snapshot(directory: string | undefined, sessionID?: string): QuotaSnapshot | undefined;
  /** Why the folder's last snapshot or refresh call failed; undefined once a snapshot arrives. */
  failure(directory: string | undefined): GuiQuotaFailure | undefined;
  /**
   * A surface shows the folder, and `sessionID` in it: load its snapshot now and keep it current
   * until the returned stop.
   */
  watch(directory: string | undefined, sessionID?: string): () => void;
  /**
   * Asks the server to check the folder's providers now ("manual"), or when due ("turn", after a
   * turn); resolves once the new snapshot is in. A failed check shows in `failure`; answers after
   * the last watcher stopped, and failures from the client of a server since restarted, are
   * dropped.
   */
  refresh(
    directory: string | undefined,
    sessionID?: string,
    reason?: QuotaRpcRefreshReason,
  ): Promise<void>;
  /** Tokens and cost from OpenCode's history for one range. */
  usage(query: UsageQuery): Promise<UsageReport>;
  /** The server settings a client may read. */
  settings(): Promise<ClientSettings>;
  /** A patch of settings.jsonc, through the server's settings code; see `QuotaRpc`. */
  saveSettings(input: QuotaRpcSaveSettingsInput): Promise<QuotaRpcSaveSettingsOutput>;
  /** Every setting's rule, and where settings.jsonc is. */
  settingsSchema(): Promise<QuotaRpcSettingsSchemaOutput>;
  /** The /quota_status report as text, with the session's model when it names one. */
  status(sessionID?: string): Promise<string>;
  /** The active maintainer notices. */
  notices(): Promise<Notice[]>;
};

type Folder = {
  quota: QuotaClient;
  failure: () => GuiQuotaFailure | undefined;
  watchers: number;
  /** While the folder runs: stops its quota client and its client check. */
  stop?: () => void;
};

function failureOf(error: unknown): GuiQuotaFailure {
  // OpenCode answers rpc.unavailable when no server plugin registered the quota RPC.
  if (typeof error === "object" && error !== null && "type" in error) {
    if (error.type === "rpc.unavailable") return { kind: "unavailable" };
  }
  return { kind: "error", message: rpcErrorMessage(error) };
}

export function createGuiQuota(host: GuiQuotaHost): GuiQuota {
  /** By folder ("" for none). */
  const folders = new Map<string, Folder>();

  function hostFor(directory: string | undefined): RpcLocationHost {
    return directory
      ? { location: { directory }, data: {}, locationOptional: true }
      : { data: {}, locationOptional: true };
  }

  function folderFor(directory: string | undefined): Folder {
    const key = directory ?? "";
    const existing = folders.get(key);
    if (existing) return existing;
    const clientHost: ClientHost = {
      ...hostFor(directory),
      get client() {
        return host.client();
      },
      // Events name the folder they are about; without one, the folder the server uses is
      // unknown here, so that folder gets its updates from the poll alone.
      acceptsEventFrom: (location) => directory !== undefined && location?.directory === directory,
    };
    const [failure, setFailure] = createSignal<GuiQuotaFailure>();
    const folder: Folder = {
      quota: createQuotaClient(
        clientHost,
        (snapshot) => {
          setFailure(undefined);
          host.onSnapshot?.(snapshot, directory);
        },
        (error) => setFailure(failureOf(error)),
      ),
      failure,
      watchers: 0,
    };
    folders.set(key, folder);
    return folder;
  }

  function start(folder: Folder): void {
    const client = host.client();
    const stopQuota = folder.quota.start();
    const check = setInterval(() => {
      if (host.client() === client) return;
      stop(folder);
      start(folder);
    }, CLIENT_CHECK_MS);
    folder.stop = () => {
      clearInterval(check);
      stopQuota();
    };
  }

  function stop(folder: Folder): void {
    folder.stop?.();
    folder.stop = undefined;
  }

  const rpc = () => host.client().rpc(QuotaRpc);
  const currentHost = (): RpcLocationHost => hostFor(host.directory());

  return {
    snapshot: (directory, sessionID) => folderFor(directory).quota.snapshot(sessionID),
    failure: (directory) => folderFor(directory).failure(),

    watch(directory, sessionID) {
      const key = directory ?? "";
      const folder = folderFor(directory);
      folder.watchers += 1;
      if (folder.watchers === 1) start(folder);
      const unwatchQuota = folder.quota.watch(sessionID);
      let unwatched = false;
      return () => {
        if (unwatched) return;
        unwatched = true;
        unwatchQuota();
        folder.watchers -= 1;
        if (folder.watchers > 0) return;
        stop(folder);
        // A folder nothing watches is forgotten; watching it again asks the server afresh.
        if (folders.get(key) === folder) folders.delete(key);
      };
    },

    async refresh(directory, sessionID, reason = "manual") {
      await folderFor(directory).quota.refresh(reason, sessionID);
    },

    usage: async (query) => (await rpc().usage(query, quotaCallOptions(currentHost()))).report,
    settings: () => rpc().settings({}, quotaCallOptions(currentHost())),
    saveSettings: (input) => rpc().saveSettings(input, quotaCallOptions(currentHost())),
    settingsSchema: () => rpc().settingsSchema({}, quotaCallOptions(currentHost())),
    status: async (sessionID) =>
      (await rpc().status(sessionID ? { sessionID } : {}, quotaCallOptions(currentHost()))).text,
    notices: async () => (await rpc().noticeList({}, quotaCallOptions(currentHost()))).notices,
  };
}
