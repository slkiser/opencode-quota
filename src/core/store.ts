/**
 * The server's quota store. It keeps the last known rows of every provider (in memory and in
 * one snapshot file), refreshes them in the background, and tells subscribers when they change.
 *
 * - `snapshot()` answers at once from what is known; when a provider is due it starts a
 *   background refresh.
 * - Refreshes are single-flight per cache identity and keep a minimum interval (30 s after a turn,
 *   none for a manual or retry refresh); failures back off from 1 to 15 minutes, or until the
 *   provider's own retry time.
 * - Every snapshot, refresh, login-change and settings-change pass is one operation: it reads
 *   the providers and who each one is signed in as once, and keeps both to its end. A login,
 *   settings or session model change starts a new generation: an older operation stores nothing and
 *   tells subscribers nothing, and a snapshot or refresh it was answering answers with the
 *   providers and rows of the new one.
 * - Rows and reset notices belong to an identity (account plus provider settings). Those of
 *   another identity are never shown; those whose identity can't be saved stay in memory and
 *   go on a login change. For those the file keeps only when their provider was last checked
 *   (with its failures and retry time), so a restarted store waits that check out before it
 *   asks the provider; a login change or settings recheck ends that wait, also one that comes
 *   before the file is read.
 * - Rows also carry their login. A failed refresh keeps the last good rows and records the
 *   error; when one of several logins fails, that login keeps its last rows. Logins that share
 *   an account name are numbered here ("Pro", "Pro 2"), by login, so the numbers stay put;
 *   numbers skip names other rows already have.
 * - When a quota window resets between two checks, a reset notice is recorded once.
 * - A fetch may bring how to write its provider's part of the export file. The store writes it
 *   from the check's rows as shown (numbered like the snapshot) and the error it records, and
 *   keeps the last check's part in memory only, never in the file, like its debug details.
 * - Subscribers hear of every change: a fetch, the rows read from the file at the start, and a
 *   change in which providers are on.
 * - Each snapshot write saves all the store keeps. A write that saved nothing (another process
 *   kept the file's lock) is made up by the next one, and `dispose` tries once more.
 * - Reads from OpenCode and provider fetches have time limits, so `dispose` always ends.
 */
import { createHash, randomUUID } from "node:crypto";
import type { QuotaExportProvider } from "../lib/quota-export-types.js";
import { classifyError, RETRY_WAIT_MAX_MS } from "./errors.js";
import {
  joinNotices,
  type LastCheck,
  type LoginRow,
  readSavedState,
  rowSlot,
  type SavedEntry,
  type SavedState,
  writeSavedState,
} from "./persist.js";
import type {
  DebugDetail,
  ProviderSnapshot,
  QuotaError,
  QuotaRow,
  QuotaSnapshot,
  ResetNotice,
  SessionModel,
} from "./types.js";
import { WINDOWS } from "./windows.js";

const TURN_MIN_INTERVAL_MS = 30_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** A reset notice stays in snapshots this long; each TUI shows it once. */
const RESET_NOTICE_KEEP_MS = 60 * 60_000;
/** A window that reset longer ago than this when we noticed gets no notice. */
const RESET_NOTICE_MAX_LATENESS_MS = 24 * 60 * 60_000;
/** Reading the providers or a login from OpenCode. */
const READ_TIMEOUT_MS = 15_000;
/** One provider fetch; the TUI waits up to 60 s for an RPC answer. */
const FETCH_TIMEOUT_MS = 60_000;

/** One provider fetch, already turned into rows. */
export type ProviderFetch = {
  rows: QuotaRow[];
  /**
   * The login each row came from, in the order of `rows`; omitted for one login. An opaque id
   * keyed with the identity key (`keyedLogins`), never a source id such as an email.
   */
  rowLogins?: string[];
  error?: QuotaError;
  /** The provider answered that it has nothing to show: the rows are cleared, with no error. */
  empty?: true;
  debug: DebugDetail[];
  /** Writes this check's part of the export file from its rows as shown and its error. */
  buildExportPart?: (check: CheckForExport) => QuotaExportProvider;
};

/** One check as the store records it: its rows as shown, its error, and when it was. */
export type CheckForExport = { rows: QuotaRow[]; error?: QuotaError; checkedAtMs: number };

/** Whose rows a fetch returns. */
export type ProviderIdentity = {
  /** Changes whenever the rows would differ: another account or other provider settings. */
  key: string;
  /**
   * False when the account can't be told apart safely, or only until a reload (its key is held
   * in memory): rows stay in memory only.
   */
  persist: boolean;
};

export type StoreProvider = {
  id: string;
  /** Registration label, for example "Anthropic". */
  label: string;
  /** Overrides the source's minimum interval (0 for providers that only read local data). */
  minIntervalMs?: number;
  identity: () => Promise<ProviderIdentity>;
  fetch: () => Promise<ProviderFetch>;
};

/** The providers to show and refresh now (enabled and available, in registration order). */
export type StoreSource = {
  /** Credential sources selected by the runtime, including providers with no available login. */
  scope?: string;
  providers: StoreProvider[];
  minIntervalMs: number;
  /** The providers serving a session's model, from the same settings read as `providers`. */
  providerIdsForModel?: (model: SessionModel) => string[];
  /** By provider id, the row id prefixes serving a session's model (`currentModelRowPrefixes`). */
  rowPrefixesForModel?: (model: SessionModel) => Record<string, string[]>;
};

type RefreshReason = "poll" | "turn" | "manual" | "retry";
/**
 * With a model, the snapshot also names the providers serving it. `refresh: false` answers the
 * saved rows without asking any provider, also for the due ones.
 */
type SnapshotOptions = { model?: SessionModel; sessionID?: string; refresh?: boolean };
type RefreshOptions = {
  model?: SessionModel;
  sessionID?: string;
  reason: RefreshReason;
  providerIds?: readonly string[];
  /** Refreshes only the providers serving `model` (the snapshot's `currentModelProviderIds`). */
  onlyModelProviders?: boolean;
};

type QuotaStoreDeps = {
  source: (model?: SessionModel) => Promise<StoreSource>;
  /** Reads a session's current model, including for background refreshes. */
  sessionModel?: (sessionID: string) => Promise<SessionModel>;
  /** The snapshot file; null keeps everything in memory. */
  file: string | null;
  now?: () => number;
  log?: (message: string) => void;
  /** Time limits for reading providers and logins, and for one fetch (tests shorten them). */
  timeouts?: { readMs: number; fetchMs: number };
};

export type QuotaStore = {
  snapshot(options?: SnapshotOptions): Promise<QuotaSnapshot>;
  /** Refreshes the due providers (all, or `providerIds`) and answers when they are done. */
  refresh(options: RefreshOptions): Promise<QuotaSnapshot>;
  subscribe(listener: (snapshot: QuotaSnapshot) => void): () => void;
  /** A login changed: identities are resolved again and memory-only rows are dropped. */
  invalidateIdentity(): void;
  /**
   * The settings changed: running work is superseded and the providers are read again. With
   * `recheck` (another time limit, interval or price list), every provider's backoff is cleared
   * and each one is checked again at once.
   */
  settingsChanged(options: { recheck: boolean }): void;
  /** A tracked session selected another model: resolve its scope and refresh due providers. */
  sessionModelChanged(sessionID: string): void;
  /** Refuses new work and waits for running operations and the last file write. */
  dispose(): Promise<void>;
};

/** A saved entry and what this process keeps of it in memory only (see `ProviderSnapshot`). */
type Entry = SavedEntry & {
  persist: boolean;
  debug: DebugDetail[];
  exportPart?: QuotaExportProvider;
};

/** Where a provider's rows live for its current identity. */
type ResolvedKey = { key: string; persist: boolean };

/** One snapshot, refresh or login-change pass: its generation, providers and identities. */
type Operation = {
  generation: number;
  source: StoreSource;
  keys: Map<string, ResolvedKey>;
  model?: SessionModel;
  sessionID?: string;
  scope: string;
};

function hashText(text: string, length: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function resolvedKey(providerId: string, identity: ProviderIdentity): ResolvedKey {
  const hash = hashText(identity.key, 32);
  return {
    key: `${providerId}|${identity.persist ? hash : `memory-${hash}`}`,
    persist: identity.persist,
  };
}

/** `promise`, or a rejection with `message` once `ms` have passed. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1));
}

/** When an entry's provider was last checked; none before its first check. */
function lastCheckOf(entry: Entry | undefined): LastCheck | undefined {
  if (entry?.checkedAtMs === undefined) return undefined;
  const retryAtMs = entry.error?.retryAtMs;
  return {
    checkedAtMs: entry.checkedAtMs,
    failures: entry.failures,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  };
}

function isDue(
  last: LastCheck | undefined,
  reason: RefreshReason,
  minIntervalMs: number,
  nowMs: number,
): boolean {
  if (reason === "manual" || reason === "retry") return true;
  if (last === undefined || last.checkedAtMs > nowMs) return true;
  // The one exception to the configured minimum: a model turn just used quota, so it may
  // refresh 30 s after the last check even when `minIntervalMs` is longer.
  let waitMs = reason === "turn" ? Math.min(minIntervalMs, TURN_MIN_INTERVAL_MS) : minIntervalMs;
  if (last.failures > 0) waitMs = Math.max(waitMs, backoffMs(last.failures));
  if (nowMs - last.checkedAtMs < waitMs) return false;
  // A retry time waits at most a day (the most a reply can ask), so a far one never stalls checks.
  const { retryAtMs } = last;
  return (
    retryAtMs === undefined || nowMs >= Math.min(retryAtMs, last.checkedAtMs + RETRY_WAIT_MAX_MS)
  );
}

/** Each fetched row with its login, shortened to a hash of the keyed id it arrives as. */
function loginRows(result: ProviderFetch): LoginRow[] {
  return result.rows.map((row, index) => {
    const login = result.rowLogins?.[index] ?? "";
    return { login: login ? hashText(login, 16) : "", row };
  });
}

/**
 * The rows as shown. Logins that share an account name (or have none) are told apart: each
 * login after the first (by login key) gets " 2", " 3"... on all its rows ("Account 2" without
 * a name), skipping names that rows already have or got. Numbering by login keeps a login's
 * number while another login fails.
 */
function shownRows(rows: readonly LoginRow[]): QuotaRow[] {
  const loginsByAccount = new Map<string, string[]>();
  for (const { login, row } of rows) {
    const logins = loginsByAccount.get(row.account ?? "") ?? [];
    if (!logins.includes(login)) logins.push(login);
    loginsByAccount.set(row.account ?? "", logins);
  }
  const taken = new Set(loginsByAccount.keys());
  /** The shown account per `${account}\u001f${login}`. */
  const shown = new Map<string, string>();
  for (const [account, logins] of [...loginsByAccount].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let number = 1;
    for (const login of logins.sort().slice(1)) {
      let name: string;
      do {
        number += 1;
        name = account ? `${account} ${number}` : `Account ${number}`;
      } while (taken.has(name));
      taken.add(name);
      shown.set(`${account}\u001f${login}`, name);
    }
  }
  return rows.map(({ login, row }) => {
    const account = shown.get(`${row.account ?? ""}\u001f${login}`);
    return account === undefined ? row : { ...row, account };
  });
}

/** Rows by slot (id, account, login); a slot that appears twice can't be matched. */
function rowsBySlot(rows: readonly LoginRow[]): Map<string, LoginRow | null> {
  const bySlot = new Map<string, LoginRow | null>();
  for (const row of rows) {
    const slot = rowSlot(row);
    bySlot.set(slot, bySlot.has(slot) ? null : row);
  }
  return bySlot;
}

/**
 * True when `before` (its reset time first seen at `observedAtMs`, before that time) has reset
 * by now: the reset time passed less than a day ago and the new row has a later reset and more
 * left.
 */
function didReset(before: QuotaRow, after: QuotaRow, observedAtMs: number, nowMs: number): boolean {
  const resetMs = Date.parse(before.resetsAt ?? "");
  const nextResetMs = Date.parse(after.resetsAt ?? "");
  if (!Number.isFinite(resetMs) || !Number.isFinite(nextResetMs)) return false;
  if (before.percentRemaining === undefined || after.percentRemaining === undefined) return false;
  const lateMs = nowMs - resetMs;
  return (
    observedAtMs <= resetMs &&
    lateMs >= 0 &&
    lateMs <= RESET_NOTICE_MAX_LATENESS_MS &&
    nextResetMs > resetMs &&
    nextResetMs > nowMs &&
    after.percentRemaining > before.percentRemaining &&
    before.percentRemaining < 100
  );
}

/**
 * Reset notices for `rows` (the new rows of `previous`'s entry), with their shown accounts.
 * A notice's id names its row's slot (id, account, login), so each login's reset is one notice.
 */
function findResets(previous: Entry, rows: readonly LoginRow[], nowMs: number): ResetNotice[] {
  const before = rowsBySlot(previous.rows);
  const after = rowsBySlot(rows);
  const shown = shownRows(rows);
  const notices: ResetNotice[] = [];
  rows.forEach((current, index) => {
    const slot = rowSlot(current);
    const old = before.get(slot)?.row;
    const { row } = current;
    if (!old || after.get(slot) === null) return;
    if (row.type !== "quota" || !row.window || !WINDOWS[row.window].resets) return;
    const observedAtMs = previous.resetSeenAtMs[slot] ?? previous.okAtMs;
    if (observedAtMs === undefined || !didReset(old, row, observedAtMs, nowMs)) return;
    const account = shown[index]?.account;
    notices.push({
      id: `${row.id}|${row.account ?? ""}|${current.login}|${old.resetsAt}`,
      rowId: row.id,
      providerId: row.providerId,
      ...(account === undefined ? {} : { account }),
      label: row.label,
      window: row.window,
      percentRemaining: row.percentRemaining as number,
      atMs: nowMs,
    });
  });
  return notices;
}

/**
 * When each row's reset time was first seen. A provider that repeats a reset time already past
 * keeps the earlier observation, so the refill it reports later still counts as a reset.
 */
function resetSeenTimes(
  previous: Entry | undefined,
  rows: readonly LoginRow[],
  nowMs: number,
): Record<string, number> {
  const before = rowsBySlot(previous?.rows ?? []);
  const seen: Record<string, number> = {};
  for (const current of rows) {
    if (!current.row.resetsAt) continue;
    const slot = rowSlot(current);
    const earlier = previous?.resetSeenAtMs[slot];
    const sameReset = before.get(slot)?.row.resetsAt === current.row.resetsAt;
    seen[slot] = earlier !== undefined && sameReset ? earlier : nowMs;
  }
  return seen;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createQuotaStore(deps: QuotaStoreDeps): QuotaStore {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[opencode-quota] ${message}`));
  const timeouts = deps.timeouts ?? { readMs: READ_TIMEOUT_MS, fetchMs: FETCH_TIMEOUT_MS };
  const entries = new Map<string, Entry>();
  /**
   * By provider id, the last check of a login that can't be saved, as the file had it at the
   * start. It stands in for this process's own check of such a login until there is one.
   */
  const lastChecksFromFile = new Map<string, LastCheck>();
  /** A login change or settings recheck ended those waits, also before the file was read. */
  let fileWaitsEnded = false;
  const inFlight = new Map<string, Promise<void>>();
  /** Running fetches per cache identity (an old one may still run after a login change). */
  const fetching = new Map<string, number>();
  /** The last operation per session, or per credential source for callers without a session. */
  const views = new Map<string, Operation>();
  /** Includes a session whose first provider or identity read is still running. */
  const sessions = new Set<string>();
  const listeners = new Set<(snapshot: QuotaSnapshot) => void>();
  /** Running operations and background refreshes; `dispose` waits for them. */
  const tasks = new Set<Promise<unknown>>();
  /** Bumped on every login change; operations of an older generation are stale. */
  let generation = 0;
  let disposed = false;
  let loaded: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let writeAgain = false;
  /** The last write saved nothing (another process kept the file's lock, say). */
  let unsaved = false;
  /** Names this store in its snapshots, so a TUI can tell a restarted server apart. */
  const serverId = randomUUID();
  /** The last snapshot's revision; each next snapshot gets one more. */
  let revision = 0;
  /** The provider ids subscribers last heard of, per credential source. */
  const heardProviders = new Map<string, string>();

  function track<T>(promise: Promise<T>): Promise<T> {
    tasks.add(promise);
    promise
      .finally(() => {
        tasks.delete(promise);
      })
      .catch(() => {});
    return promise;
  }

  /** Runs one operation as a tracked task, from before its first read; none after dispose. */
  function start<T>(work: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new Error("the quota store is disposed"));
    return track(work());
  }

  function isCurrent(operation: Operation): boolean {
    return operation.generation === generation;
  }

  function adopt(saved: SavedState): void {
    for (const [key, entry] of saved.entries) {
      const ours = entries.get(key);
      if (!ours || (ours.checkedAtMs ?? 0) < (entry.checkedAtMs ?? 0)) {
        entries.set(key, { ...entry, persist: true, debug: [] });
      } else {
        ours.notices = joinNotices(ours.notices, entry.notices);
      }
    }
  }

  /** Ends the file's waits: those read already and those a first read still brings. */
  function endFileWaits(): void {
    fileWaitsEnded = true;
    lastChecksFromFile.clear();
  }

  /** `lastChecksFromFile` of a provider whose login can't be saved; none for one that can. */
  function fileLastCheck(providerId: string, where: ResolvedKey): LastCheck | undefined {
    return where.persist ? undefined : lastChecksFromFile.get(providerId);
  }

  function load(): Promise<void> {
    loaded ??= deps.file
      ? readSavedState(deps.file).then((saved) => {
          adopt(saved);
          if (fileWaitsEnded) return;
          for (const [providerId, lastCheck] of saved.lastChecks) {
            lastChecksFromFile.set(providerId, lastCheck);
          }
        })
      : Promise.resolve();
    return loaded;
  }

  async function writeFile(file: string): Promise<void> {
    const saved = new Map<string, SavedEntry>();
    for (const [
      key,
      { persist: keep, debug: _memoryOnly, exportPart: _alsoMemoryOnly, ...entry },
    ] of entries) {
      if (keep) saved.set(key, entry);
    }
    // Of a login that can't be saved, only when its provider was last checked.
    const lastChecks = new Map<string, LastCheck>();
    for (const entry of entries.values()) {
      const lastCheck = entry.persist ? undefined : lastCheckOf(entry);
      const other = lastChecks.get(entry.providerId);
      if (lastCheck && (!other || other.checkedAtMs < lastCheck.checkedAtMs)) {
        lastChecks.set(entry.providerId, lastCheck);
      }
    }
    try {
      const options = { now, noticeMaxAgeMs: RESET_NOTICE_KEEP_MS };
      adopt(await writeSavedState(file, { entries: saved, lastChecks }, options));
      unsaved = false;
    } catch (error) {
      unsaved = true;
      log(`could not save the quota snapshot: ${errorMessage(error)}`);
    }
  }

  /** Writes the file soon; writes asked for while one runs are joined into one more write. */
  function persist(): void {
    const file = deps.file;
    if (!file) return;
    if (writing) {
      writeAgain = true;
      return;
    }
    writing = writeFile(file).finally(() => {
      writing = undefined;
      if (writeAgain) {
        writeAgain = false;
        persist();
      }
    });
  }

  async function flush(): Promise<void> {
    while (writing) await writing;
  }

  /** Who `provider` is signed in as now; unknown (memory only) when that can't be read. */
  async function resolveKey(provider: StoreProvider, scope: string): Promise<ResolvedKey> {
    try {
      const message = `reading the ${provider.id} login timed out`;
      return resolvedKey(
        provider.id,
        await withTimeout(provider.identity(), timeouts.readMs, message),
      );
    } catch {
      return resolvedKey(provider.id, { key: `unknown\u001f${scope}`, persist: false });
    }
  }

  /** Starts an operation: loads the file once, reads the providers and who each one is. */
  async function prepare(model?: SessionModel, sessionID?: string): Promise<Operation> {
    if (sessionID) sessions.add(sessionID);
    const startedIn = generation;
    await load();
    if (sessionID && deps.sessionModel) {
      model = await withTimeout(
        deps.sessionModel(sessionID),
        timeouts.readMs,
        "reading the session model timed out",
      );
    }
    const message = "reading the quota providers timed out";
    const source = await withTimeout(deps.source(model), timeouts.readMs, message);
    const scope = source.scope === undefined ? "" : hashText(source.scope, 32);
    const keys = new Map<string, ResolvedKey>();
    await Promise.all(
      source.providers.map(async (provider) => {
        keys.set(provider.id, await resolveKey(provider, scope));
      }),
    );
    const operation = { generation: startedIn, source, keys, model, scope, sessionID };
    if (isCurrent(operation)) views.set(sessionID ? `session:${sessionID}` : scope, operation);
    // The rows read from the file, or a provider turned on or off, are news to subscribers.
    if (providerIdsOf(operation) !== heardProviders.get(scope)) emit(operation);
    return operation;
  }

  /** The snapshot an operation sees; a stale one shows no rows (whose they are is unknown). */
  function buildSnapshot(operation: Operation): QuotaSnapshot {
    const { model, sessionID } = operation;
    const nowMs = now();
    const current = isCurrent(operation);
    const resetNotices: ResetNotice[] = [];
    const providers = operation.source.providers.map((provider): ProviderSnapshot => {
      const key = current ? operation.keys.get(provider.id)?.key : undefined;
      const entry = key === undefined ? undefined : entries.get(key);
      for (const notice of entry?.notices ?? []) {
        if (nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS) resetNotices.push(notice);
      }
      return {
        providerId: provider.id,
        label: provider.label,
        rows: shownRows(entry?.rows ?? []),
        ...(entry?.okAtMs === undefined ? {} : { okAtMs: entry.okAtMs }),
        ...(entry?.checkedAtMs === undefined ? {} : { checkedAtMs: entry.checkedAtMs }),
        ...(entry?.error === undefined ? {} : { error: entry.error }),
        refreshing: key !== undefined && fetching.has(key),
        debug: entry?.debug ?? [],
        ...(entry?.exportPart === undefined ? {} : { exportPart: entry.exportPart }),
      };
    });
    revision += 1;
    const snapshot: QuotaSnapshot = {
      version: 6,
      ...(sessionID ? { sessionID } : {}),
      ...(operation.scope ? { sourceScope: operation.scope } : {}),
      providers,
      resetNotices,
      generatedAtMs: nowMs,
      serverId,
      revision,
    };
    const modelProviderIds = model ? providerIdsServing(operation, model) : undefined;
    if (model && modelProviderIds) {
      snapshot.currentModelProviderIds = modelProviderIds;
      const { rowPrefixesForModel } = operation.source;
      if (rowPrefixesForModel) snapshot.currentModelRowPrefixes = rowPrefixesForModel(model);
    }
    return snapshot;
  }

  /** The operation's providers that serve `model`; undefined when that can't be told. */
  function providerIdsServing(operation: Operation, model: SessionModel): string[] | undefined {
    const { providers, providerIdsForModel } = operation.source;
    if (!(model.id || model.providerID) || !providerIdsForModel) return undefined;
    const shown = new Set(providers.map((provider) => provider.id));
    return providerIdsForModel(model).filter((id) => shown.has(id));
  }

  function providerIdsOf(operation: Operation): string {
    return JSON.stringify(operation.source.providers.map((provider) => provider.id));
  }

  function emit(operation: Operation): void {
    if (listeners.size === 0 || !isCurrent(operation)) return;
    heardProviders.set(operation.scope, providerIdsOf(operation));
    const snapshot = buildSnapshot(operation);
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log(`a quota snapshot subscriber failed: ${errorMessage(error)}`);
      }
    }
  }

  function record(provider: StoreProvider, where: ResolvedKey, result: ProviderFetch): void {
    const nowMs = now();
    const previous = entries.get(where.key);
    const fresh = loginRows(result);
    const gotRows = fresh.length > 0;
    // An answer of nothing replaces the last rows, as an answer with rows does.
    const replacesRows = gotRows || (result.empty === true && !result.error);
    const error = result.error ?? (replacesRows ? undefined : ({ code: "no_data" } as const));
    // With an error, the logins that did not answer keep their last rows.
    const answered = new Set(fresh.map((row) => row.login));
    const kept =
      gotRows && result.error
        ? (previous?.rows ?? []).filter((row) => !answered.has(row.login))
        : [];
    const rows = replacesRows ? [...fresh, ...kept] : (previous?.rows ?? []);
    const found = gotRows && previous ? findResets(previous, rows, nowMs) : [];
    const notices = joinNotices(
      (previous?.notices ?? []).filter((notice) => nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS),
      found,
    );
    const okAtMs = replacesRows ? nowMs : previous?.okAtMs;
    // The check's own rows, numbered among the kept ones as the snapshot numbers them.
    const exportPart = result.buildExportPart?.({
      rows: shownRows(rows).slice(0, fresh.length),
      ...(error === undefined ? {} : { error }),
      checkedAtMs: nowMs,
    });
    entries.set(where.key, {
      providerId: provider.id,
      persist: where.persist,
      rows,
      ...(okAtMs === undefined ? {} : { okAtMs }),
      checkedAtMs: nowMs,
      ...(error === undefined ? {} : { error }),
      // Any error backs off, also when only one of several logins failed. Without an entry, a
      // login that can't be saved counts on from the file's last check.
      failures:
        error === undefined
          ? 0
          : (previous?.failures ?? fileLastCheck(provider.id, where)?.failures ?? 0) + 1,
      debug: result.debug,
      ...(exportPart === undefined ? {} : { exportPart }),
      notices,
      resetSeenAtMs: replacesRows
        ? resetSeenTimes(previous, rows, nowMs)
        : (previous?.resetSeenAtMs ?? {}),
    });
    if (!where.persist) lastChecksFromFile.delete(provider.id);
    persist();
  }

  async function fetchProvider(provider: StoreProvider, key: string): Promise<ProviderFetch> {
    fetching.set(key, (fetching.get(key) ?? 0) + 1);
    try {
      const message = `Request timeout after ${Math.round(timeouts.fetchMs / 1000)}s`;
      return await withTimeout(provider.fetch(), timeouts.fetchMs, message);
    } catch (error) {
      return { rows: [], error: classifyError(errorMessage(error), now()), debug: [] };
    } finally {
      const left = (fetching.get(key) ?? 1) - 1;
      if (left > 0) fetching.set(key, left);
      else fetching.delete(key);
    }
  }

  async function refreshProviderNow(
    operation: Operation,
    provider: StoreProvider,
    reason: RefreshReason,
  ): Promise<void> {
    const where = operation.keys.get(provider.id);
    if (!where) return;
    const minIntervalMs = provider.minIntervalMs ?? operation.source.minIntervalMs;
    // A login that can't be saved has no entry after a restart: the file's last check of its
    // provider waits instead, so a plugin reload asks no sooner than the last process would.
    const last = lastCheckOf(entries.get(where.key)) ?? fileLastCheck(provider.id, where);
    if (!isDue(last, reason, minIntervalMs, now())) return;
    const result = await fetchProvider(provider, where.key);
    // A fetch is stored only under the account it read. A login change (new generation) or
    // another account now (same generation) drops its answer.
    if (!isCurrent(operation)) return;
    const after = await resolveKey(provider, operation.scope);
    if (!isCurrent(operation)) return;
    if (after.key !== where.key) {
      operation.keys.set(provider.id, after);
      return;
    }
    record(provider, where, result);
    // Providers with the same identity share new rows across scopes; each view still reads
    // its own keys for providers whose credential source differs.
    for (const view of views.values()) {
      if (view.keys.get(provider.id)?.key === where.key) emit(view);
    }
  }

  function refreshProvider(
    operation: Operation,
    provider: StoreProvider,
    reason: RefreshReason,
  ): Promise<void> {
    // A stale operation never joins or starts a refresh: one of the new generation would join
    // its run, which fetches nothing.
    if (disposed || !isCurrent(operation)) return Promise.resolve();
    const key = operation.keys.get(provider.id)?.key;
    if (key === undefined) return Promise.resolve();
    const running = inFlight.get(key);
    if (running) return running;
    const run: Promise<void> = refreshProviderNow(operation, provider, reason).finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
    inFlight.set(key, run);
    return run;
  }

  /** The providers a refresh asks: all of them, `providerIds`, or those serving `model`. */
  function providersToRefresh(operation: Operation, options: RefreshOptions): StoreProvider[] {
    const { providers } = operation.source;
    if (options.onlyModelProviders) {
      const ids = options.model ? providerIdsServing(operation, options.model) : undefined;
      return providers.filter((provider) => ids?.includes(provider.id));
    }
    const { providerIds } = options;
    return providerIds
      ? providers.filter((provider) => providerIds.includes(provider.id))
      : providers;
  }

  async function runRefresh(operation: Operation, options: RefreshOptions): Promise<void> {
    const providers = providersToRefresh(operation, options);
    await Promise.all(
      providers.map((provider) => refreshProvider(operation, provider, options.reason)),
    );
  }

  /** An operation of the current generation: a login or settings change meanwhile reads again. */
  async function prepareCurrent(model?: SessionModel, sessionID?: string): Promise<Operation> {
    for (;;) {
      const operation = await prepare(model, sessionID);
      if (isCurrent(operation)) return operation;
    }
  }

  /**
   * Starts a new generation: running operations store and tell nothing more, and a new pass
   * reads the providers and logins, tells subscribers, then refreshes for `reason`.
   */
  function supersede(reason: RefreshReason, failure: string): void {
    generation += 1;
    inFlight.clear();
    const targets: Array<{ model?: SessionModel; sessionID?: string }> = views.size
      ? [...views.values()]
      : [{}];
    // Subscribers see the new providers and rows (or none) before any fetch, then fresh ones.
    start(async () => {
      await Promise.all(
        targets.map(async ({ model, sessionID }) => {
          const operation = await prepare(model, sessionID);
          emit(operation);
          await runRefresh(operation, { reason });
        }),
      );
    }).catch((error) => {
      log(`${failure}: ${errorMessage(error)}`);
    });
  }

  return {
    snapshot(options = {}) {
      return start(async () => {
        const operation = await prepareCurrent(options.model, options.sessionID);
        if (options.refresh !== false) {
          track(runRefresh(operation, { reason: "poll" })).catch((error) => {
            log(`background quota refresh failed: ${errorMessage(error)}`);
          });
        }
        return buildSnapshot(operation);
      });
    },

    refresh(options) {
      return start(async () => {
        const operation = await prepareCurrent(options.model, options.sessionID);
        await runRefresh(operation, { ...options, model: operation.model });
        await flush();
        // A login or settings change dropped what this pass fetched: the answer shows the
        // providers and rows of now, and the new pass's rows follow as events.
        const answering = isCurrent(operation)
          ? operation
          : await prepareCurrent(options.model, options.sessionID);
        return buildSnapshot(answering);
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    invalidateIdentity() {
      if (disposed) return;
      for (const [key, entry] of entries) {
        if (!entry.persist) entries.delete(key);
      }
      // The new login is checked at once, not after the wait of a login before it.
      endFileWaits();
      supersede("poll", "quota refresh after a login change failed");
    },

    settingsChanged({ recheck }) {
      if (disposed) return;
      if (!recheck) {
        supersede("poll", "quota refresh after a settings change failed");
        return;
      }
      for (const entry of entries.values()) entry.failures = 0;
      endFileWaits();
      // A manual refresh waits for no interval: every provider is checked again now.
      supersede("manual", "quota recheck after a settings change failed");
    },

    sessionModelChanged(sessionID) {
      if (disposed || !sessions.has(sessionID)) return;
      supersede("poll", "quota refresh after a session model change failed");
    },

    async dispose() {
      disposed = true;
      listeners.clear();
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await flush();
      // A write that saved nothing gets one more try; each write saves all the store keeps.
      if (unsaved) {
        persist();
        await flush();
      }
    },
  };
}
