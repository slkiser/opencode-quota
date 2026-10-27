/**
 * The GUI window's quota data, read-only for now: the quota snapshot through the TUI's quota
 * client (`../tui/client.ts`: newest snapshot wins, `changed` events, a poll every minute while
 * something watches), and the usage report and settings the TUI's quota window reads. All of it
 * comes over the quota RPC (`../rpc.ts`) from the server part in the app's own server, so the
 * window computes nothing itself.
 *
 * A call names the folder of the session on screen when that session runs on the app's own
 * server; otherwise (Home, a session on another server) it names none, and the server uses its
 * own folder.
 */
import type { UsageQuery, UsageReport } from "../core/usage.js";
import { QuotaRpc } from "../rpc.js";
import type { ClientSettings } from "../settings/index.js";
import {
  type ClientHost,
  createQuotaClient,
  type QuotaClient,
  type QuotaRpcClient,
  quotaCallOptions,
} from "../tui/client.js";

export type GuiQuotaHost = {
  /** The client of the app's own server; read at every call, as it changes when that server restarts. */
  client(): { rpc: (definition: typeof QuotaRpc) => QuotaRpcClient };
  /** The folder of the session on screen, when it runs on the app's own server. */
  directory(): string | undefined;
};

export type GuiQuota = {
  /** The quota snapshot, as the TUI gets it; `start()` it once and `watch()` while it shows. */
  quota: QuotaClient;
  /** Tokens and cost from OpenCode's history for one range. */
  usage(query: UsageQuery): Promise<UsageReport>;
  /** The server settings a client may read. */
  settings(): Promise<ClientSettings>;
};

export function createGuiQuota(host: GuiQuotaHost): GuiQuota {
  const clientHost: ClientHost = {
    get location() {
      const directory = host.directory();
      return directory ? { directory } : undefined;
    },
    data: {},
    locationOptional: true,
    get client() {
      return host.client();
    },
  };
  const rpc = () => host.client().rpc(QuotaRpc);
  return {
    quota: createQuotaClient(clientHost),
    usage: async (query) => (await rpc().usage(query, quotaCallOptions(clientHost))).report,
    settings: () => rpc().settings({}, quotaCallOptions(clientHost)),
  };
}
