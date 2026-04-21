/**
 * Shared display sanitization for user-visible output.
 *
 * Strips ANSI escape sequences and other control characters so that
 * remote/provider error text cannot inject terminal control codes into
 * toasts or transcript output.
 */

import type { QuotaRenderData } from "./quota-render-data.js";
import type {
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
  SessionTokensData,
} from "./entries.js";
import { isValueEntry } from "./entries.js";

// Remove ANSI escape sequences and other control characters except newline/tab.
// eslint-disable-next-line no-control-regex
const DISPLAY_CONTROL_RE = /\x1B\[[0-9;]*[A-Za-z]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeDisplayText(text: string): string {
  return text.replace(DISPLAY_CONTROL_RE, "");
}

export function sanitizeSingleLineDisplayText(text: string): string {
  return sanitizeDisplayText(text).replace(/\s+/gu, " ").trim();
}

export function sanitizeDisplaySnippet(text: string, maxLength: number): string {
  return sanitizeDisplayText(text).slice(0, maxLength);
}

export function sanitizeSingleLineDisplaySnippet(text: string, maxLength: number): string {
  return sanitizeSingleLineDisplayText(text).slice(0, maxLength);
}

export function sanitizeOptionalDisplayText(value?: string): string | undefined {
  return typeof value === "string" ? sanitizeDisplayText(value) : undefined;
}

export function sanitizeQuotaToastEntry(entry: QuotaToastEntry): QuotaToastEntry {
  if (isValueEntry(entry)) {
    return {
      ...entry,
      name: sanitizeDisplayText(entry.name),
      value: sanitizeDisplayText(entry.value),
      group: sanitizeOptionalDisplayText(entry.group),
      label: sanitizeOptionalDisplayText(entry.label),
      right: sanitizeOptionalDisplayText(entry.right),
      resetTimeIso: sanitizeOptionalDisplayText(entry.resetTimeIso),
    };
  }

  return {
    ...entry,
    name: sanitizeDisplayText(entry.name),
    group: sanitizeOptionalDisplayText(entry.group),
    label: sanitizeOptionalDisplayText(entry.label),
    right: sanitizeOptionalDisplayText(entry.right),
    resetTimeIso: sanitizeOptionalDisplayText(entry.resetTimeIso),
  };
}

export function sanitizeQuotaToastError(error: QuotaToastError): QuotaToastError {
  return {
    label: sanitizeDisplayText(error.label),
    message: sanitizeDisplayText(error.message),
  };
}

export function sanitizeQuotaProviderResult(result: QuotaProviderResult): QuotaProviderResult {
  return {
    attempted: result.attempted,
    entries: result.entries.map(sanitizeQuotaToastEntry),
    errors: result.errors.map(sanitizeQuotaToastError),
  };
}

export function sanitizeSessionTokensData(
  data?: SessionTokensData,
): SessionTokensData | undefined {
  if (!data) return undefined;

  return {
    ...data,
    models: data.models.map((model) => ({
      ...model,
      modelID: sanitizeDisplayText(model.modelID),
    })),
  };
}

export function sanitizeQuotaRenderData(data: QuotaRenderData): QuotaRenderData {
  return {
    entries: data.entries.map(sanitizeQuotaToastEntry),
    errors: data.errors.map(sanitizeQuotaToastError),
    sessionTokens: sanitizeSessionTokensData(data.sessionTokens),
  };
}
