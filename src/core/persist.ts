/**
 * The store's snapshot file: one JSON file with the last known rows, recent reset notices and
 * reset observation times of every provider and account. Several OpenCode processes share it:
 * every write holds a lock file next to it (`withFileLock`) while it re-reads the file, merges
 * what the others saved (the newer check wins) and replaces it, and writes in this process run
 * one at a time. No write runs without the lock: one that gets no lock within 2 s writes
 * nothing and fails (the store saves its state with its next write). A write reads the clock
 * only after it took the lock and read the file, so a check saved meanwhile is not taken for
 * one dated after now. Entries older than a week are dropped. A file that does not parse is
 * ignored; a bad entry or row is skipped on its own. Provider text is scrubbed and credentials
 * redacted again on read.
 * Each row is saved with its login (a hash), as the store numbers logins that share a name.
 * A provider whose login can't be saved keeps only its last check's times, by provider id.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import { type LockFence, withFileLock } from "../lib/file-lock.js";
import { isRecord } from "../lib/json-guards.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import { isQuotaErrorCode } from "./errors.js";
import { safeDetail } from "./redact.js";
import type { QuotaError, QuotaRow, ResetNotice } from "./types.js";
import { LABEL_MAX_CODE_POINTS, validateRows } from "./validate.js";
import { isQuotaWindow } from "./windows.js";

const FILE_VERSION = 2;

/** The snapshot file the server and the terminal command share. */
export function snapshotFilePath(): string {
  return join(getOpencodeRuntimeDirs().stateDir, "opencode-quota", "snapshot-v6.json");
}
const LOGIN_RE = /^[0-9a-f]{0,64}$/u;
const ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DETAIL_MAX_LENGTH = 300;
/** How long a write waits for another process's write before it gives up and writes nothing. */
const LOCK_WAIT_MS = 2_000;

/**
 * A row and the login it came from: a hash of the provider's source id, "" when the provider
 * has one login. The row's account is the login's own name, before the store numbers logins.
 */
export type LoginRow = { login: string; row: QuotaRow };

/** What the file keeps per provider and account, keyed `${providerId}|${identity hash}`. */
export type SavedEntry = {
  providerId: string;
  rows: LoginRow[];
  okAtMs?: number;
  checkedAtMs?: number;
  error?: QuotaError;
  /** Failed attempts in a row; drives the error backoff. */
  failures: number;
  /** Windows of this account that reset recently; they belong to it like its rows. */
  notices: ResetNotice[];
  /** Per row (see `rowSlot`): when its current reset time was first seen. */
  resetSeenAtMs: Record<string, number>;
};

/** When a provider was last checked, its failures in a row and the retry time it asked for. */
export type LastCheck = { checkedAtMs: number; failures: number; retryAtMs?: number };

export type SavedState = {
  entries: Map<string, SavedEntry>;
  /**
   * By provider id, the last check of a login that can't be saved (its rows stay in memory), so
   * a restarted store waits it out too. Nothing in it tells whose login it was.
   */
  lastChecks: Map<string, LastCheck>;
};

/** One row's slot: rows of two checks match by id, account and login. */
export function rowSlot({ login, row }: LoginRow): string {
  return `${row.id}\u001f${row.account ?? ""}\u001f${login}`;
}

function optionalTime(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseError(value: unknown): QuotaError | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { code, status, retryAtMs, tool, missing, detail } = value;
  if (!isQuotaErrorCode(code)) return null;
  const error: QuotaError = { code };
  if (Number.isInteger(status)) error.status = status as number;
  if (typeof retryAtMs === "number" && Number.isFinite(retryAtMs)) error.retryAtMs = retryAtMs;
  if (typeof tool === "string") error.tool = safeDetail(tool, 40);
  if (missing === true) error.missing = true;
  if (typeof detail === "string") error.detail = safeDetail(detail, DETAIL_MAX_LENGTH);
  return error;
}

function parseRows(providerId: string, value: unknown[]): LoginRow[] {
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.login !== "string" || !LOGIN_RE.test(item.login)) return [];
    const login = item.login;
    return validateRows(providerId, [item.row]).rows.map((row) => ({ login, row }));
  });
}

function parseSeenTimes(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (pair): pair is [string, number] => typeof pair[1] === "number" && Number.isFinite(pair[1]),
    ),
  );
}

function parseEntry(key: string, value: unknown): SavedEntry | undefined {
  if (!isRecord(value) || typeof value.providerId !== "string") return undefined;
  const { providerId } = value;
  if (!key.startsWith(`${providerId}|`) || !Array.isArray(value.rows)) return undefined;
  const okAtMs = optionalTime(value.okAtMs);
  const checkedAtMs = optionalTime(value.checkedAtMs);
  const error = parseError(value.error);
  if (okAtMs === null || checkedAtMs === null || error === null) return undefined;
  const failures =
    Number.isInteger(value.failures) && (value.failures as number) >= 0
      ? (value.failures as number)
      : 0;
  const notices = Array.isArray(value.notices)
    ? value.notices.flatMap((notice) => parseNotice(providerId, notice) ?? [])
    : [];
  return {
    providerId,
    rows: parseRows(providerId, value.rows),
    ...(okAtMs === undefined ? {} : { okAtMs }),
    ...(checkedAtMs === undefined ? {} : { checkedAtMs }),
    ...(error === undefined ? {} : { error }),
    failures,
    notices,
    resetSeenAtMs: parseSeenTimes(value.resetSeenAtMs),
  };
}

function parseLastCheck(value: unknown): LastCheck | undefined {
  if (!isRecord(value)) return undefined;
  const checkedAtMs = optionalTime(value.checkedAtMs);
  const retryAtMs = optionalTime(value.retryAtMs);
  if (checkedAtMs === undefined || checkedAtMs === null || retryAtMs === null) return undefined;
  if (!Number.isInteger(value.failures) || (value.failures as number) < 0) return undefined;
  return {
    checkedAtMs,
    failures: value.failures as number,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  };
}

/** A saved notice's label or account, scrubbed and cut to the row gate's code-point limit. */
function savedLabel(text: string): string {
  return Array.from(safeDetail(text, Number.POSITIVE_INFINITY))
    .slice(0, LABEL_MAX_CODE_POINTS)
    .join("");
}

function parseNotice(entryProviderId: string, value: unknown): ResetNotice | undefined {
  if (!isRecord(value)) return undefined;
  const { id, rowId, providerId, account, label, window, percentRemaining, atMs } = value;
  if (
    typeof id !== "string" ||
    typeof rowId !== "string" ||
    providerId !== entryProviderId ||
    (account !== undefined && typeof account !== "string") ||
    typeof label !== "string" ||
    !isQuotaWindow(window) ||
    typeof percentRemaining !== "number" ||
    !Number.isFinite(percentRemaining) ||
    typeof atMs !== "number" ||
    !Number.isFinite(atMs)
  ) {
    return undefined;
  }
  return {
    id,
    rowId,
    providerId: entryProviderId,
    ...(account === undefined ? {} : { account: savedLabel(account) }),
    label: savedLabel(label),
    window,
    percentRemaining,
    atMs,
  };
}

function emptyState(): SavedState {
  return { entries: new Map(), lastChecks: new Map() };
}

/** What the file holds now; empty when it is missing or does not parse. */
export async function readSavedState(file: string): Promise<SavedState> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return emptyState();
  }
  if (!isRecord(data) || data.version !== FILE_VERSION || !isRecord(data.entries)) {
    return emptyState();
  }
  const entries = new Map<string, SavedEntry>();
  for (const [key, value] of Object.entries(data.entries)) {
    const entry = parseEntry(key, value);
    if (entry) entries.set(key, entry);
  }
  const lastChecks = new Map<string, LastCheck>();
  const savedLastChecks = isRecord(data.lastChecks) ? data.lastChecks : {};
  for (const [providerId, value] of Object.entries(savedLastChecks)) {
    const lastCheck = parseLastCheck(value);
    if (lastCheck) lastChecks.set(providerId, lastCheck);
  }
  return { entries, lastChecks };
}

/** Each file's last write in this process (never rejects); the next write waits for it. */
const writeQueues = new Map<string, Promise<void>>();

export function joinNotices(
  first: readonly ResetNotice[],
  second: readonly ResetNotice[],
): ResetNotice[] {
  const byId = new Map(first.map((notice) => [notice.id, notice]));
  for (const notice of second) byId.set(notice.id, notice);
  return [...byId.values()];
}

async function mergeAndWrite(
  file: string,
  state: SavedState,
  options: { now: () => number; noticeMaxAgeMs: number },
  fence: LockFence,
): Promise<SavedState> {
  const merged = await readSavedState(file);
  // After the read, so a check another process saved while this one waited is not after now.
  const nowMs = options.now();
  for (const [key, entry] of state.entries) {
    const other = merged.entries.get(key);
    if (!other) {
      merged.entries.set(key, entry);
    } else if ((other.checkedAtMs ?? 0) <= (entry.checkedAtMs ?? 0)) {
      merged.entries.set(key, { ...entry, notices: joinNotices(other.notices, entry.notices) });
    } else {
      merged.entries.set(key, { ...other, notices: joinNotices(entry.notices, other.notices) });
    }
  }
  for (const [key, entry] of merged.entries) {
    if (nowMs - (entry.checkedAtMs ?? 0) > ENTRY_MAX_AGE_MS) {
      merged.entries.delete(key);
      continue;
    }
    entry.notices = entry.notices.filter((notice) => nowMs - notice.atMs <= options.noticeMaxAgeMs);
  }
  // A last check dated after now (the clock went back) would be due at once yet win every
  // merge: it goes, so a check made since replaces it.
  for (const [providerId, lastCheck] of merged.lastChecks) {
    if (lastCheck.checkedAtMs > nowMs) merged.lastChecks.delete(providerId);
  }
  for (const [providerId, lastCheck] of state.lastChecks) {
    const other = merged.lastChecks.get(providerId);
    if (!other || other.checkedAtMs <= lastCheck.checkedAtMs) {
      merged.lastChecks.set(providerId, lastCheck);
    }
  }
  for (const [providerId, lastCheck] of merged.lastChecks) {
    if (nowMs - lastCheck.checkedAtMs > ENTRY_MAX_AGE_MS) {
      merged.lastChecks.delete(providerId);
    }
  }
  await writeJsonAtomic(
    file,
    {
      version: FILE_VERSION,
      entries: Object.fromEntries(merged.entries),
      lastChecks: Object.fromEntries(merged.lastChecks),
    },
    { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600, beforeCommit: fence },
  );
  return merged;
}

/**
 * Merges `state` into the file (per entry and per last check the newer check wins; notices are
 * joined by id), drops entries and last checks older than a week, saved last checks dated after
 * now and notices older than `noticeMaxAgeMs`, writes it atomically (owner-only), and returns
 * the merged state. It holds the file's lock throughout and reads `now` under it; when another
 * process keeps the lock 2 s, it writes nothing and rejects.
 */
export function writeSavedState(
  file: string,
  state: SavedState,
  options: { now: () => number; noticeMaxAgeMs: number },
): Promise<SavedState> {
  const lock = `${file}.lock`;
  // Writes of one process run one at a time, so each re-reads what the previous one wrote.
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const write = previous.then(() =>
    withFileLock(lock, (fence) => mergeAndWrite(file, state, options, fence), {
      waitMs: LOCK_WAIT_MS,
      busyMessage: `another process holds ${lock}; nothing was saved`,
    }),
  );
  const settled = write.then(
    () => {},
    () => {},
  );
  writeQueues.set(file, settled);
  void settled.then(() => {
    if (writeQueues.get(file) === settled) writeQueues.delete(file);
  });
  return write;
}
