import { homedir } from "os";
import { join } from "path";
import { interpretAccountingRow } from "./accounting-format.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import type {
  AccountingWindow,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
import type {
  QuotaExport,
  QuotaExportEntry,
  QuotaExportError,
  QuotaExportProvider,
  QuotaExportRawDetail,
  QuotaExportSource,
} from "./quota-export-types.js";
import { MAINTAINED_LOCAL_ESTIMATE_IDS } from "./quota-providers.js";
import type { QuotaRuntimeContext } from "./quota-runtime-context.js";
import { createQuotaProviderRuntimeContext } from "./quota-runtime-context.js";
import { readCachedProviderResult } from "./quota-state.js";

/** Max length for an exported provider error message after sanitization. */
const EXPORT_ERROR_MAX_LENGTH = 240;

const EXPORT_WINDOW_LABELS: Readonly<Record<AccountingWindow, string>> = {
  rpm: "RPM",
  hour: "Hourly",
  five_hour: "5h",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

/**
 * Builds the provider context used to read cached quota for export.
 *
 * The cache key is derived from these fields, so it MUST match the one the TUI
 * background writer used (`onlyCurrentModel: false`, no session). Otherwise a
 * user with `onlyCurrentModel: true` would compute a different key than the one
 * the cache was written under, turning every provider into "unavailable".
 *
 * Both export surfaces (CLI `show --json` and the TUI periodic writer) must go
 * through this helper so the cache-key contract lives in one place.
 */
export function createExportProviderContext(runtime: QuotaRuntimeContext): QuotaProviderContext {
  return createQuotaProviderRuntimeContext({
    ...runtime,
    config: {
      ...runtime.config,
      onlyCurrentModel: false,
      showSessionTokens: false,
    },
    session: {},
    configureTelemetry: false,
  });
}

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

/**
 * Maps a `QuotaToastEntry` to a `QuotaExportEntry`.
 */
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

function toExportRawDetail(detail: { key: string; value: string }): QuotaExportRawDetail {
  return {
    key: sanitizeSingleLineDisplaySnippet(detail.key, EXPORT_ERROR_MAX_LENGTH),
    value: sanitizeSingleLineDisplaySnippet(detail.value, EXPORT_ERROR_MAX_LENGTH),
  };
}

function getExportWindow(entry: QuotaToastEntry): string | undefined {
  if (entry.semantic) {
    return entry.semantic.metric.kind === "window"
      ? EXPORT_WINDOW_LABELS[entry.semantic.metric.window]
      : undefined;
  }

  // Legacy entries derive the window only from the explicit row label. The
  // entry name is human-readable display text and must not be parsed here.
  const windowKind = classifyQuotaWindowText(entry.label ?? "");
  return windowKind ? EXPORT_WINDOW_LABELS[windowKind] : undefined;
}

function toExportEntry(entry: QuotaToastEntry): QuotaExportEntry {
  const interpretation = interpretAccountingRow(entry, { booleanWording: "generic" });
  const window = getExportWindow(entry);
  const resetAt = unixSecondsFromIso(entry.resetTimeIso);
  const observedAt = unixSecondsFromIso(entry.accounting.observedAtIso);
  const base = {
    name: entry.name,
    resultType: entry.accounting.resultType,
    acquisitionMethod: entry.accounting.acquisitionMethod,
    ownership: entry.accounting.ownership,
    authority: entry.accounting.authority,
    ...(entry.accounting.sourceId ? { sourceId: entry.accounting.sourceId } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(window ? { window } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };

  if (interpretation.display.kind === "percent") {
    return {
      ...base,
      renderType: "percent",
      percentRemaining: interpretation.display.percentRemaining,
    };
  }
  return { ...base, renderType: "value", value: interpretation.display.text };
}

function buildQuotaProviderStatuses(params: {
  ctx: QuotaProviderContext;
  diagnostics?: QuotaProviderResult["diagnostics"];
}): QuotaExportSource[] {
  const diagnosticsBySource = new Map(
    (params.diagnostics ?? []).map((diagnostic) => [diagnostic.sourceId, diagnostic] as const),
  );

  return (params.ctx.config.quotaProviders ?? [])
    .filter((source) => !(MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(source.id))
    .map((source) => {
      const diagnostic = diagnosticsBySource.get(source.id);
      return {
        id: source.id,
        providerId: source.providerId,
        status: !diagnostic ? "unavailable" : diagnostic.outcome === "success" ? "ok" : "error",
        entryCount: diagnostic?.entryCount ?? 0,
      };
    });
}

/**
 * Builds a `QuotaExport` document by reading cached provider results.
 *
 * Providers are read in parallel from either identity-bound durable cache or
 * the same-runtime-owner latest snapshot retained for uncached/live-local providers.
 * No live network fetches are performed.
 */
export async function buildQuotaExport(params: {
  providers: QuotaProvider[];
  ctx: QuotaProviderContext;
  ttlMs: number;
  fromCache: boolean;
}): Promise<QuotaExport> {
  const reads = await Promise.all(
    params.providers.map((provider) =>
      readCachedProviderResult({
        provider,
        ctx: params.ctx,
        ttlMs: params.ttlMs,
      }).then((read) => ({ provider, read })),
    ),
  );

  const providers: Record<string, QuotaExportProvider> = {};
  const fetchedAtValues: number[] = [];

  for (const { provider, read } of reads) {
    const sources =
      provider.id === "quota-providers"
        ? buildQuotaProviderStatuses({
            ctx: params.ctx,
            ...(read.hit ? { diagnostics: read.result.diagnostics } : {}),
          })
        : undefined;
    const withSources = sources ? { sources } : {};

    if (!read.hit) {
      providers[provider.id] = { status: "unavailable", ...withSources };
      continue;
    }

    const withRawDetails = read.result.rawDetails?.length
      ? { rawDetails: read.result.rawDetails.map(toExportRawDetail) }
      : {};

    const fetchedAt = Math.floor(read.timestamp / 1000);

    if (read.result.entries.length > 0 && read.result.errors.length > 0) {
      providers[provider.id] = {
        status: "partial",
        fetchedAt,
        entries: read.result.entries.map(toExportEntry),
        errors: read.result.errors.map(toExportError),
        ...withSources,
        ...withRawDetails,
      };
      fetchedAtValues.push(fetchedAt);
      continue;
    }

    if (read.result.errors.length > 0 && read.result.entries.length === 0) {
      providers[provider.id] = {
        status: "error",
        fetchedAt,
        error: sanitizeSingleLineDisplaySnippet(
          read.result.errors[0].message,
          EXPORT_ERROR_MAX_LENGTH,
        ),
        ...withSources,
        ...withRawDetails,
      };
      fetchedAtValues.push(fetchedAt);
      continue;
    }

    const entries = read.result.entries.map(toExportEntry);
    providers[provider.id] = {
      status: "ok",
      fetchedAt,
      entries,
      ...withSources,
      ...withRawDetails,
    };
    fetchedAtValues.push(fetchedAt);
  }

  const cacheAgeSeconds =
    fetchedAtValues.length > 0 ? Math.floor(Date.now() / 1000) - Math.min(...fetchedAtValues) : 0;

  const exportedAt = Math.floor(Date.now() / 1000);

  return {
    version: 2,
    exportedAt,
    fromCache: params.fromCache,
    cacheAgeSeconds,
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
