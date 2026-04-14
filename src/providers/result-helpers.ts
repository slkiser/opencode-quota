import type {
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
): QuotaProviderResult {
  return { attempted: true, entries, errors };
}

export function attemptedErrorResult(label: string, message: string): QuotaProviderResult {
  return attemptedResult([], [{ label, message }]);
}
