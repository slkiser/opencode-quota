/**
 * The store's snapshot file: one JSON file with the last known rows, recent reset notices and
 * reset observation times of every provider and account. Several OpenCode processes share it
 * without a lock: every write re-reads the file right before it and merges what the others
 * saved (the newer check wins), and writes in this process run one at a time. Entries older
 * than a week are dropped. A file that does not parse is ignored; a bad entry or row is
 * skipped on its own. Provider text is scrubbed and credentials redacted again on read.
 * Each row is saved with its login (a hash), as the store numbers logins that share a name.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import { isRecord } from "../lib/json-guards.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import { isQuotaErrorCode } from "./errors.js";
import { safeDebugValue, safeDetail } from "./redact.js";
import type { DebugDetail, QuotaError, QuotaRow, ResetNotice } from "./types.js";
import { validateRows } from "./validate.js";
import { isQuotaWindow } from "./windows.js";

const FILE_VERSION = 2;

/** The snapshot file the server and the terminal command share. */
export function snapshotFilePath(): string {
  return join(getOpencodeRuntimeDirs().stateDir, "opencode-quota", "snapshot-v6.json");
}
const LOGIN_RE = /^[0-9a-f]{0,64}$/u;
const ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DETAIL_MAX_LENGTH = 300;

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
  debug: DebugDetail[];
  /** Windows of this account that reset recently; they belong to it like its rows. */
  notices: ResetNotice[];
  /** Per row (see `rowSlot`): when its current reset time was first seen. */
  resetSeenAtMs: Record<string, number>;
};

export type SavedState = { entries: Map<string, SavedEntry> };

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

function parseDebug(value: unknown): DebugDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item.key === "string" && typeof item.value === "string"
      ? [
          {
            key: safeDetail(item.key, 64),
            value: safeDebugValue(item.key, item.value, DETAIL_MAX_LENGTH),
          },
        ]
      : [],
  );
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
    debug: parseDebug(value.debug),
    notices,
    resetSeenAtMs: parseSeenTimes(value.resetSeenAtMs),
  };
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
    ...(account === undefined ? {} : { account: safeDetail(account, 64) }),
    label: safeDetail(label, 64),
    window,
    percentRemaining,
    atMs,
  };
}

function emptyState(): SavedState {
  return { entries: new Map() };
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
  return { entries };
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
  options: { nowMs: number; noticeMaxAgeMs: number },
): Promise<SavedState> {
  const merged = await readSavedState(file);
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
    if (options.nowMs - (entry.checkedAtMs ?? 0) > ENTRY_MAX_AGE_MS) {
      merged.entries.delete(key);
      continue;
    }
    entry.notices = entry.notices.filter(
      (notice) => options.nowMs - notice.atMs <= options.noticeMaxAgeMs,
    );
  }
  await writeJsonAtomic(
    file,
    { version: FILE_VERSION, entries: Object.fromEntries(merged.entries) },
    { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 },
  );
  return merged;
}

/**
 * Merges `state` into the file (per entry the newer check wins; notices are joined by id),
 * drops entries not checked for a week and notices older than `noticeMaxAgeMs`, writes it
 * atomically (owner-only), and returns the merged state.
 */
export function writeSavedState(
  file: string,
  state: SavedState,
  options: { nowMs: number; noticeMaxAgeMs: number },
): Promise<SavedState> {
  // Writes of one process run one at a time, so each re-reads what the previous one wrote.
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const write = previous.then(() => mergeAndWrite(file, state, options));
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
