import { homedir } from "os";
import { join } from "path";

import type { QuotaProvider, QuotaProviderContext, QuotaToastEntry } from "./entries.js";
import type {
  QuotaExport,
  QuotaExportEntry,
  QuotaExportProvider,
} from "./quota-export-types.js";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { readCachedProviderResult } from "./quota-state.js";
import { isValueEntry } from "./entries.js";
import { normalizeSingleWindowWindowLabel } from "./quota-render-data.js";

/**
 * Resolves the export file path from a configured value.
 *
 * - Empty string → XDG cache default: `$XDG_CACHE_HOME/opencode/quota-export.json`
 * - Starts with `~/` → expands `~` to `homedir()`
 * - Otherwise → returns as-is (caller is responsible for absolute paths)
 */
export function resolveExportPath(configured: string): string {
  if (configured === "") {
    return join(getOpencodeRuntimeDirs().cacheDir, "quota-export.json");
  }
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}

/**
 * Maps a `QuotaToastEntry` to a `QuotaExportEntry`.
 */
function toExportEntry(entry: QuotaToastEntry): QuotaExportEntry {
  const percentRemaining = isValueEntry(entry)
    ? undefined
    : entry.percentRemaining;

  const window =
    normalizeSingleWindowWindowLabel(entry.label) ??
    normalizeSingleWindowWindowLabel(entry.name) ??
    undefined;

  const resetAt = entry.resetTimeIso
    ? Math.floor(new Date(entry.resetTimeIso).getTime() / 1000)
    : undefined;

  return {
    name: entry.name,
    ...(window ? { window } : {}),
    ...(percentRemaining !== undefined ? { percentRemaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    unlimited: false,
  };
}

/**
 * Builds a `QuotaExport` document by reading cached provider results.
 *
 * All providers are read in parallel from the per-provider disk cache.
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
    if (!read.hit) {
      providers[provider.id] = { status: "unavailable" };
      continue;
    }

    const fetchedAt = Math.floor(read.timestamp / 1000);

    if (read.result.errors.length > 0 && read.result.entries.length === 0) {
      providers[provider.id] = {
        status: "error",
        fetchedAt,
        error: read.result.errors[0].message,
      };
      fetchedAtValues.push(fetchedAt);
      continue;
    }

    const entries = read.result.entries.map(toExportEntry);
    providers[provider.id] = {
      status: "ok",
      fetchedAt,
      entries,
    };
    fetchedAtValues.push(fetchedAt);
  }

  const cacheAgeSeconds =
    fetchedAtValues.length > 0
      ? Math.floor(Date.now() / 1000) - Math.min(...fetchedAtValues)
      : 0;

  const exportedAt = Math.floor(Date.now() / 1000);

  return {
    version: 1,
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
