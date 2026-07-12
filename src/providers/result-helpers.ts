import type {
  AccountingMetadata,
  QuotaProviderPresentation,
  QuotaProviderResult,
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

export function attemptedErrorResult(label: string, message: string): QuotaProviderResult {
  return attemptedResult([], [{ label, message }]);
}

export function mapNullableProviderResult<TSuccess extends { success: true }>(
  result: TSuccess | { success: false; error: string } | null,
  params: {
    errorLabel: string;
    onSuccess: (result: TSuccess) => QuotaProviderResult;
  },
): QuotaProviderResult {
  if (!result) {
    return notAttemptedResult();
  }

  if (!result.success) {
    return attemptedErrorResult(params.errorLabel, result.error);
  }

  return params.onSuccess(result);
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
