/**
 * The GUI window's quota data, read-only for now: the quota snapshot through the TUI's quota
 * client (`../tui/client.ts`: newest snapshot wins, `changed` events, a poll every minute), and
 * the usage report and settings the TUI's quota window reads. All of it comes over the quota RPC
 * (`../rpc.ts`) from the server part in the app's own server, so the window computes nothing
 * itself.
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
import { QuotaRpc } from "../rpc.js";
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
};

/** Why a folder has no snapshot: no quota RPC on the server, or a failed call. */
export type GuiQuotaFailure = { kind: "unavailable" } | { kind: "error"; message: string };

export type GuiQuota = {
  /** The folder's latest snapshot (none: the server's own folder); undefined before its first answer. */
  snapshot(directory: string | undefined): QuotaSnapshot | undefined;
  /** Why the folder's last snapshot call failed; undefined once a snapshot arrives. */
  failure(directory: string | undefined): GuiQuotaFailure | undefined;
  /** A surface shows the folder: load its snapshot now and keep it current until the returned stop. */
  watch(directory: string | undefined): () => void;
  /** Tokens and cost from OpenCode's history for one range. */
  usage(query: UsageQuery): Promise<UsageReport>;
  /** The server settings a client may read. */
  settings(): Promise<ClientSettings>;
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
        () => setFailure(undefined),
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
    snapshot: (directory) => folderFor(directory).quota.snapshot(),
    failure: (directory) => folderFor(directory).failure(),

    watch(directory) {
      const key = directory ?? "";
      const folder = folderFor(directory);
      folder.watchers += 1;
      if (folder.watchers === 1) start(folder);
      const unwatchQuota = folder.quota.watch();
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

    usage: async (query) => (await rpc().usage(query, quotaCallOptions(currentHost()))).report,
    settings: () => rpc().settings({}, quotaCallOptions(currentHost())),
  };
}
