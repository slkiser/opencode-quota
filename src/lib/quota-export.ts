/**
 * The export file (version 3) for scripts and status bars, and `opencode-quota show --json`,
 * written from quota rows. Each check gives its provider's part of the file
 * (`exportProviderFromCheck`, from the check's rows as the snapshot shows them): the server
 * keeps that part, in memory only, next to the provider's snapshot, so the file shows the last
 * check, a failed one too. A provider without one (in the terminal command, or before its first
 * check since the server started) is written from its snapshot.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describeError } from "../core/errors.js";
import type { CheckForExport } from "../core/store.js";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot, QuotaWindow } from "../core/types.js";
import type { AccountResult } from "../providers/contract.js";
import { rowValueText } from "../view/format.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type {
  QuotaExport,
  QuotaExportEntry,
  QuotaExportError,
  QuotaExportProvider,
  QuotaExportSource,
} from "./quota-export-types.js";
import {
  MAINTAINED_LOCAL_ESTIMATE_IDS,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
} from "./quota-providers.js";

/** Max length for an exported provider error message after sanitization. */
const EXPORT_ERROR_MAX_LENGTH = 240;

const EXPORT_WINDOW_LABELS: Readonly<Record<QuotaWindow, string>> = {
  rpm: "RPM",
  hour: "Hourly",
  five_hour: "5h",
  session: "Session",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

/**
 * Resolves the export file path from a configured value.
 *
 * - Empty string → XDG cache default: `$XDG_CACHE_HOME/opencode/quota-export.json`
 * - Starts with `~/` → expands `~` to `homedir()`
 * - Starts with `~\` → expands `~` and treats backslashes as path separators
 * - Otherwise → returns as-is (caller is responsible for absolute paths)
 */
export function resolveExportPath(configured: string): string {
  if (configured === "") {
    return join(getOpencodeRuntimeDirs().cacheDir, "quota-export.json");
  }
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  if (configured.startsWith("~\\")) {
    return join(homedir(), ...configured.slice(2).split(/\\+/u));
  }
  return configured;
}

function unixSecondsFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function toExportError(error: { label: string; message: string }): QuotaExportError {
  return {
    label: sanitizeSingleLineDisplaySnippet(error.label, EXPORT_ERROR_MAX_LENGTH),
    message: sanitizeSingleLineDisplaySnippet(error.message, EXPORT_ERROR_MAX_LENGTH),
  };
}

/**
 * Each custom definition in its configured order, never its URL, key or format. Its account in
 * this check (the definition id is the account's login) gives its status: "error" when it gave
 * only errors, "ok" otherwise, and "unavailable" when it was not checked. A switched-off
 * definition is never checked: it says `enabled: false` instead.
 */
function customSourceStatuses(
  definitions: readonly QuotaProviderDefinition[],
  accounts: readonly AccountResult[],
): QuotaExportSource[] {
  return definitions
    .filter((source) => !(MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(source.id))
    .map((source): QuotaExportSource => {
      const identity = { id: source.id, providerId: source.providerId };
      if (source.enabled === false) return { ...identity, entryCount: 0, enabled: false };
      const account = accounts.find((candidate) => candidate.login === source.id);
      if (!account) return { ...identity, status: "unavailable", entryCount: 0 };
      const failed = account.rows.length === 0 && account.errors.length > 0;
      return { ...identity, status: failed ? "error" : "ok", entryCount: account.rows.length };
    });
}

/** One row as an export entry; provider text loses terminal escapes and control characters. */
function rowEntry(providerId: string, providerLabel: string, row: QuotaRow): QuotaExportEntry {
  const account = row.account ? ` (${row.account})` : "";
  const resetAt = unixSecondsFromIso(row.resetsAt);
  const base = {
    id: row.id,
    name: sanitizeSingleLineDisplaySnippet(
      `${providerLabel}${account} ${row.label}`,
      EXPORT_ERROR_MAX_LENGTH,
    ),
    ...(row.account
      ? { account: sanitizeSingleLineDisplaySnippet(row.account, EXPORT_ERROR_MAX_LENGTH) }
      : {}),
    resultType: row.type,
    acquisitionMethod: row.method,
    ownership:
      providerId === QUOTA_PROVIDERS_AGGREGATE_ID
        ? ("user_configured" as const)
        : ("maintained" as const),
    authority: row.authority,
    ...(row.window ? { window: EXPORT_WINDOW_LABELS[row.window] } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
  if (row.percentRemaining !== undefined) {
    return { ...base, renderType: "percent", percentRemaining: row.percentRemaining };
  }
  return {
    ...base,
    renderType: "value",
    value: sanitizeSingleLineDisplaySnippet(rowValueText(row), EXPORT_ERROR_MAX_LENGTH),
  };
}

/**
 * What a provider's part is written from: its rows and its error. Debug details stay in
 * /quota_status: they name files, logins and key sources that scripts don't need.
 */
type ExportedProvider = Pick<ProviderSnapshot, "providerId" | "label" | "rows" | "error">;

/**
 * A provider's part: "ok" or "partial" with its rows, "error" when it has no rows, and
 * "unavailable" when it is not set up. `answeredAtMs` is when the rows or the error came.
 */
function exportProvider(
  provider: ExportedProvider,
  answeredAtMs: number,
  nowMs: number,
): QuotaExportProvider {
  if (provider.error?.code === "not_configured" && provider.rows.length === 0) {
    return { status: "unavailable" };
  }
  const fetchedAt = Math.floor(answeredAtMs / 1000);
  const entries = provider.rows.map((row) => rowEntry(provider.providerId, provider.label, row));
  if (!provider.error) return { status: "ok", fetchedAt, entries };
  const error = sanitizeSingleLineDisplaySnippet(
    describeError(provider.error, provider.label, nowMs),
    EXPORT_ERROR_MAX_LENGTH,
  );
  if (entries.length === 0) return { status: "error", fetchedAt, error };
  return {
    status: "partial",
    fetchedAt,
    entries,
    errors: [toExportError({ label: provider.label, message: error })],
  };
}

/**
 * A provider's part of the export file from one check: this check's rows as the snapshot
 * shows them, or its error. The custom providers also list each definition, from this check's
 * `accounts`.
 */
export function exportProviderFromCheck(
  params: CheckForExport & {
    providerId: string;
    label: string;
    customDefinitions: readonly QuotaProviderDefinition[];
    accounts: readonly AccountResult[];
  },
): QuotaExportProvider {
  const { providerId, label, rows, error, checkedAtMs } = params;
  const part = exportProvider({ providerId, label, rows, error }, checkedAtMs, checkedAtMs);
  if (providerId !== QUOTA_PROVIDERS_AGGREGATE_ID) return part;
  return { ...part, sources: customSourceStatuses(params.customDefinitions, params.accounts) };
}

/** A provider's part written from its snapshot; "unavailable" until it first answered. */
function exportProviderFromSnapshot(
  provider: ProviderSnapshot,
  nowMs: number,
): QuotaExportProvider {
  const answeredAtMs = provider.okAtMs ?? provider.checkedAtMs;
  if (answeredAtMs === undefined) return { status: "unavailable" };
  return exportProvider(provider, answeredAtMs, nowMs);
}

/** Builds the export document from the quota snapshot; no provider is asked again. */
export function buildQuotaExportFromSnapshot(
  snapshot: QuotaSnapshot,
  nowMs: number = Date.now(),
): QuotaExport {
  const providers: Record<string, QuotaExportProvider> = {};
  const fetchedAtValues: number[] = [];
  for (const provider of snapshot.providers) {
    const part = provider.exportPart ?? exportProviderFromSnapshot(provider, nowMs);
    providers[provider.providerId] = part;
    if (part.status !== "unavailable") fetchedAtValues.push(part.fetchedAt);
  }
  const exportedAt = Math.floor(nowMs / 1000);
  return {
    version: 3,
    exportedAt,
    fromCache: true,
    cacheAgeSeconds: fetchedAtValues.length > 0 ? exportedAt - Math.min(...fetchedAtValues) : 0,
    providers,
  };
}

/**
 * Writes a `QuotaExport` document atomically to disk.
 *
 * Errors are re-thrown — callers are responsible for catching and logging them.
 */
export async function writeQuotaExport(
  exportData: QuotaExport,
  resolvedPath: string,
): Promise<void> {
  await writeJsonAtomic(resolvedPath, exportData, { trailingNewline: true });
}
