import { readFile } from "fs/promises";

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  QuotaProviderPresentation,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";

export function notAttemptedResult(): QuotaProviderResult {
  return { attempted: false, entries: [], errors: [] };
}

export function attemptedResult(
  entries: QuotaToastEntry[],
  errors: QuotaToastError[] = [],
  presentation?: QuotaProviderPresentation,
): QuotaProviderResult {
  return {
    attempted: true,
    entries,
    errors,
    ...(presentation ? { presentation } : {}),
  };
}

export function attemptedErrorResult(
  label: string,
  message: string,
  options: { retryable?: boolean } = {},
): QuotaProviderResult {
  return attemptedResult(
    [],
    [{ label, message, ...(options.retryable === true ? { retryable: true } : {}) }],
  );
}

export function statusDetailsFromRecord(
  values: Readonly<Record<string, string | undefined>>,
): QuotaProviderStatusDetail[] {
  return Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value }],
  );
}

export function configStatusDetails(diagnostics: {
  state: string;
  source: string | null;
  checkedPaths: readonly string[];
  missing?: string | null;
  error?: string | null;
}): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    config_state: diagnostics.state,
    config_source: diagnostics.source ?? "(none)",
    config_missing: diagnostics.missing ?? undefined,
    config_error: diagnostics.error ?? undefined,
    config_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
  });
}

export function simpleApiKeyStatusDetails(diagnostics: {
  configured: boolean;
  source: string | null;
  checkedPaths: readonly string[];
  credentialDatabasePaths: readonly string[];
}): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    api_key_configured: diagnostics.configured ? "true" : "false",
    api_key_source: diagnostics.source ?? "(none)",
    api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    api_key_credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
  });
}

export function apiKeyStatusDetails(diagnostics: {
  state: string;
  source: string | null;
  checkedPaths: readonly string[];
  credentialDatabasePaths: readonly string[];
  error?: string;
}): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    auth_state: diagnostics.state,
    api_key_configured: diagnostics.state === "configured" ? "true" : "false",
    api_key_source: diagnostics.source ?? "(none)",
    api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    api_key_credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    auth_error: diagnostics.error ? sanitizeDisplayText(diagnostics.error) : undefined,
  });
}

export function withStatusDetails(
  result: QuotaProviderResult,
  statusDetails: readonly QuotaProviderStatusDetail[],
): QuotaProviderResult {
  return {
    ...result,
    statusDetails: statusDetails.map((detail) => ({ ...detail })),
  };
}

export async function inspectGeneratedCounterFile(
  path: string,
  expectedVersion: number,
): Promise<{
  exists: boolean;
  health: "missing" | "healthy" | "malformed" | "version_mismatch";
  version: number | null;
  lastUpdatedAt: number | null;
}> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const version = typeof record?.version === "number" ? record.version : null;
    const updatedAt =
      typeof record?.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : null;
    return {
      exists: true,
      health:
        !record || version === null || updatedAt === null
          ? "malformed"
          : version === expectedVersion
            ? "healthy"
            : "version_mismatch",
      version,
      lastUpdatedAt: updatedAt,
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: unknown }).code) === "ENOENT"
    ) {
      return { exists: false, health: "missing", version: null, lastUpdatedAt: null };
    }
    return { exists: true, health: "malformed", version: null, lastUpdatedAt: null };
  }
}

export function mapNullableProviderResult<
  TResult extends { success: true } | { success: false; error: string; retryable?: boolean } | null,
>(
  result: TResult,
  params: {
    errorLabel: string;
    onSuccess: (result: Extract<TResult, { success: true }>) => QuotaProviderResult;
  },
): QuotaProviderResult {
  if (!result) {
    return notAttemptedResult();
  }

  if (!result.success) {
    return attemptedErrorResult(params.errorLabel, result.error, { retryable: result.retryable });
  }

  return params.onSuccess(result as Extract<TResult, { success: true }>);
}

export function groupedPercentWindowEntries(params: {
  group: string;
  accounting: AccountingMetadata;
  windows: Array<{
    window?: {
      percentRemaining: number;
      resetTimeIso?: string;
    };
    suffix: string;
    label: string;
  }>;
  fallbackWhenEmpty?: boolean;
}): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];

  for (const { window, suffix, label } of params.windows) {
    if (!window) continue;

    entries.push({
      accounting: { ...params.accounting },
      name: `${params.group} ${suffix}`,
      group: params.group,
      label,
      percentRemaining: window.percentRemaining,
      resetTimeIso: window.resetTimeIso,
    });
  }

  if (entries.length === 0 && params.fallbackWhenEmpty !== false) {
    entries.push({
      accounting: { ...params.accounting },
      name: params.group,
      percentRemaining: 0,
    });
  }

  return entries;
}
