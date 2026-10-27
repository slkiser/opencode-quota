/**
 * The TUI's quota data: the server's last snapshot, kept in Solid signals so every surface
 * redraws when it changes. It asks the server over the quota RPC (`snapshot` when a surface
 * shows, `refresh` after a turn), applies every `changed` event, and asks again every minute
 * in case an event was missed. Nothing reaches OpenCode until a surface shows or a turn ends.
 *
 * Answers can arrive out of order. The newest snapshot (highest `revision`) wins; a snapshot
 * from another server (a new `serverId`: OpenCode restarted it) always wins, as its revisions
 * start over, and from then on the old server's answers are ignored. What a snapshot says
 * about one session comes from the latest call about it.
 */
import { createSignal } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import {
  QuotaRpc,
  type QuotaRpcRefreshInput,
  type QuotaRpcRefreshReason,
  type QuotaRpcSnapshotOutput,
} from "../rpc.js";

const POLL_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;

/** Without `location`, OpenCode runs the call in its server's own folder. */
export type QuotaRpcCallOptions = { location?: { directory: string }; signal: AbortSignal };

type Methods = (typeof QuotaRpc)["methods"];
/** The type a method's schema carries for TypeScript (`schema<T>` in `rpc.ts`). */
type Carried<Schema> = Schema extends { "~standard": { types?: infer Types } }
  ? NonNullable<Types> extends { output: infer T }
    ? T
    : never
  : never;

/** The quota RPC as OpenCode's TUI client offers it: every method of `QuotaRpc`, and its event. */
export type QuotaRpcClient = {
  [Name in keyof Methods]: (
    input: Carried<Methods[Name]["input"]>,
    options: QuotaRpcCallOptions,
  ) => Promise<Carried<Methods[Name]["output"]>>;
} & {
  events: {
    on(
      name: "changed",
      handler: (event: { location?: { directory: string }; data: QuotaRpcSnapshotOutput }) => void,
      options?: { signal?: AbortSignal },
    ): () => void;
  };
};

/**
 * Where a quota RPC call goes: the TUI's folder. A GUI window (`../gui/`) has a folder only while
 * it shows a session, so it sets `locationOptional`.
 */
export type RpcLocationHost = {
  location?: { directory: string };
  data: { location?: { default: () => { directory: string } } };
  /** True when a call without a folder goes to the server's own folder instead of failing. */
  locationOptional?: boolean;
};

/** What the client needs from the TUI context (or a GUI window). */
export type ClientHost = RpcLocationHost & {
  client: { rpc: (definition: typeof QuotaRpc) => QuotaRpcClient };
  /**
   * When set, a `changed` event is applied only if this answers true for the folder it came from.
   * A GUI window hears the events of every folder of its server, so it keeps its folder's only.
   */
  acceptsEventFrom?: (location: { directory: string } | undefined) => boolean;
};

/**
 * Each call names the TUI's folder, so the server uses that folder's settings, and gives up
 * after a minute. The RPC client itself is made per call, never during setup.
 */
export function quotaCallOptions(host: RpcLocationHost): QuotaRpcCallOptions {
  const location = host.location ?? host.data.location?.default();
  const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
  if (location) return { location, signal };
  if (host.locationOptional) return { signal };
  throw new Error("OpenCode gave the TUI no location");
}

/** What a snapshot says only about one session. */
type SessionPart = Pick<
  QuotaSnapshot,
  "currentModelProviderIds" | "currentModelRowPrefixes" | "sessionTokens"
>;

export type QuotaClient = {
  /** The latest snapshot with what is known about `sessionID`; undefined before the first answer. */
  snapshot(sessionID?: string): QuotaSnapshot | undefined;
  /** The Home notice line ("" when there is none). */
  homeLine(): string;
  /** A surface shows `sessionID`: load its part now and on every poll until the returned stop. */
  watch(sessionID?: string): () => void;
  /** Loads the Home notice line now and on every poll until the returned stop. */
  watchHome(): () => void;
  /** Asks the server to refresh; answers the new snapshot, or undefined when the call failed. */
  refresh(reason: QuotaRpcRefreshReason, sessionID?: string): Promise<QuotaSnapshot | undefined>;
  /**
   * Starts the minute poll and allows the `changed` subscription, made with the first call;
   * the returned function stops both and drops the answers to calls made before it.
   */
  start(): () => void;
};

/** RPC calls reject with a plain `{ type, message }` object, not an Error. */
export function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

/** The toast for a failed call: its reason, cleaned for the terminal. */
export function errorToast(error: unknown, title = "OpenCode Quota") {
  const message = sanitizeDisplayText(rpcErrorMessage(error));
  return { variant: "error", title, message } as const;
}

export function reportFailure(error: unknown): void {
  // OpenCode answers rpc.unavailable when no server plugin registered the quota RPC here.
  const hint =
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "rpc.unavailable"
      ? " (OpenCode Quota's server plugin is not loaded for this folder)"
      : "";
  console.warn(`[opencode-quota] failed to load quota: ${rpcErrorMessage(error)}${hint}`);
}

/**
 * @param onSnapshot called with every snapshot the client takes (from any call or event), so
 *   toasts can announce new reset notices.
 * @param onFailure called when a `snapshot` or `refresh` call made since the last `start()`
 *   fails, so a GUI window can say why it shows nothing or an older snapshot.
 */
export function createQuotaClient(
  host: ClientHost,
  onSnapshot: (snapshot: QuotaSnapshot) => void = () => {},
  onFailure: (error: unknown) => void = () => {},
): QuotaClient {
  const [latest, setLatest] = createSignal<QuotaSnapshot>();
  const [sessions, setSessions] = createSignal<Record<string, SessionPart>>({});
  const [homeLine, setHomeLine] = createSignal("");
  /** Sessions on screen, with how many surfaces show each. */
  const watched = new Map<string, number>();
  /** Surfaces on screen without a session (the status line on Home). */
  let globalWatchers = 0;
  let homeWatchers = 0;
  let running = false;
  /** Numbers every call; a session's part is kept only from a later call than the last one. */
  let calls = 0;
  const sessionCalls = new Map<string, number>();
  /** Servers this client moved away from; their answers are ignored. */
  const retiredServers = new Set<string>();
  /** Bumped when the TUI stops: answers to calls made before then are dropped. */
  let mount = 0;
  /** Snapshot calls on their way, by session ("" for none), with their call numbers. */
  const loading = new Map<string, number>();
  /** The `changed` subscription while running, made with the first snapshot call. */
  let events: AbortController | undefined;

  const rpc = () => host.client.rpc(QuotaRpc);

  /** `call` numbers the request a session's part came from. */
  function apply(snapshot: QuotaSnapshot, session?: { id: string; call: number }): void {
    const { currentModelProviderIds, currentModelRowPrefixes, sessionTokens, ...shared } = snapshot;
    if (retiredServers.has(shared.serverId)) return;
    // An answer that left before a newer snapshot arrived must not undo it.
    const current = latest();
    if (current && current.serverId !== shared.serverId) retiredServers.add(current.serverId);
    if (!current || current.serverId !== shared.serverId || current.revision < shared.revision) {
      setLatest(shared);
    }
    if (session && session.call > (sessionCalls.get(session.id) ?? 0)) {
      sessionCalls.set(session.id, session.call);
      setSessions((all) => ({
        ...all,
        [session.id]: {
          ...(currentModelProviderIds ? { currentModelProviderIds } : {}),
          ...(currentModelRowPrefixes ? { currentModelRowPrefixes } : {}),
          ...(sessionTokens ? { sessionTokens } : {}),
        },
      }));
    }
    onSnapshot(snapshot);
  }

  function subscribe(): void {
    if (!running || events) return;
    events = new AbortController();
    const signal = events.signal;
    try {
      rpc().events.on(
        "changed",
        (event) => {
          if (signal.aborted) return;
          if (host.acceptsEventFrom && !host.acceptsEventFrom(event.location)) return;
          apply(event.data.snapshot);
        },
        { signal },
      );
    } catch (error) {
      // The poll still updates every minute.
      reportFailure(error);
    }
  }

  function load(sessionID?: string): void {
    // The sidebar and the status line of one session ask together; one call answers both.
    const key = sessionID ?? "";
    if (loading.has(key)) return;
    const call = ++calls;
    const at = mount;
    loading.set(key, call);
    subscribe();
    let request: Promise<QuotaRpcSnapshotOutput>;
    try {
      request = rpc().snapshot(sessionID ? { sessionID } : {}, quotaCallOptions(host));
    } catch (error) {
      // A client without the RPC, or no folder to name: fail like a rejected call.
      request = Promise.reject(error);
    }
    request
      .then((output) => {
        if (at === mount) apply(output.snapshot, sessionID ? { id: sessionID, call } : undefined);
      })
      .catch((error) => {
        if (at === mount) onFailure(error);
        reportFailure(error);
      })
      .finally(() => {
        if (loading.get(key) === call) loading.delete(key);
      });
  }

  function loadHomeLine(): void {
    const at = mount;
    rpc()
      .notices({}, quotaCallOptions(host))
      .then((output) => {
        if (at === mount) setHomeLine(output.homeLine);
      })
      .catch(reportFailure);
  }

  function snapshot(sessionID?: string): QuotaSnapshot | undefined {
    const shared = latest();
    if (!shared) return undefined;
    const part = sessionID ? sessions()[sessionID] : undefined;
    return part ? { ...shared, ...part } : shared;
  }

  function poll(): void {
    if (globalWatchers > 0) load();
    for (const sessionID of watched.keys()) load(sessionID);
    if (homeWatchers > 0) loadHomeLine();
  }

  return {
    snapshot,
    homeLine,

    watch(sessionID) {
      if (!sessionID) {
        globalWatchers += 1;
        load();
        return () => {
          globalWatchers -= 1;
        };
      }
      watched.set(sessionID, (watched.get(sessionID) ?? 0) + 1);
      load(sessionID);
      return () => {
        const count = (watched.get(sessionID) ?? 1) - 1;
        if (count > 0) watched.set(sessionID, count);
        else watched.delete(sessionID);
      };
    },

    watchHome() {
      homeWatchers += 1;
      loadHomeLine();
      return () => {
        homeWatchers -= 1;
      };
    },

    async refresh(reason, sessionID) {
      const call = ++calls;
      const at = mount;
      try {
        const input: QuotaRpcRefreshInput = sessionID ? { reason, sessionID } : { reason };
        subscribe();
        const output = await rpc().refresh(input, quotaCallOptions(host));
        if (at !== mount) return undefined;
        apply(output.snapshot, sessionID ? { id: sessionID, call } : undefined);
        return snapshot(sessionID);
      } catch (error) {
        if (at === mount) onFailure(error);
        reportFailure(error);
        return undefined;
      }
    },

    start() {
      running = true;
      // After a reconnect, the surfaces already on screen ask again at once.
      poll();
      const timer = setInterval(poll, POLL_INTERVAL_MS);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        running = false;
        mount += 1;
        loading.clear();
        events?.abort();
        events = undefined;
        clearInterval(timer);
      };
    },
  };
}
