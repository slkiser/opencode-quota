/**
 * Shared formatting utilities for quota display.
 *
 * These primitives are used by:
 * - format.ts (classic toast)
 * - toast-format-grouped.ts (grouped toast)
 * - quota-command-format.ts (/quota command)
 */

/**
 * Clamp a number to an integer within [min, max].
 */
export function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Pad string to width, truncating if too long, adding spaces on right if too short.
 */
export function padRight(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

/**
 * Pad string to width, truncating from start if too long, adding spaces on left if too short.
 */
export function padLeft(str: string, width: number): string {
  if (str.length >= width) return str.slice(str.length - width);
  return " ".repeat(width - str.length) + str;
}

/**
 * Render a progress bar of filled/empty blocks.
 */
export function bar(percentRemaining: number, width: number): string {
  const p = clampInt(percentRemaining, 0, 100);
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Format a token count with K/M suffix for compactness.
 *
 * Examples:
 * - 500 -> "500"
 * - 1500 -> "1.5K"
 * - 15000 -> "15K"
 * - 1500000 -> "1.5M"
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 10_000) {
    return `${(count / 1_000).toFixed(0)}K`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}

/**
 * Shorten model name for compact display.
 *
 * Removes common prefixes/suffixes before truncating with ellipsis.
 */
export function shortenModelName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  // Remove common prefixes/suffixes
  let s = name
    .replace(/^antigravity-/i, "")
    .replace(/-thinking$/i, "")
    .replace(/-preview$/i, "");
  if (s.length <= maxLen) return s;
  // Truncate with ellipsis
  return s.slice(0, maxLen - 1) + "\u2026";
}

export interface FormatResetCountdownOptions {
  /**
   * String to return when ISO timestamp is missing/undefined.
   * - Classic toast uses "-"
   * - Grouped toast uses ""
   */
  missing?: string;
}

/**
 * Format a reset countdown for toast display.
 *
 * Returns human-readable time like "2d 5h" or "3h 45m".
 * When reset time is in the past or invalid, returns "reset".
 */
export function formatResetCountdown(iso?: string, opts?: FormatResetCountdownOptions): string {
  if (!iso) return opts?.missing ?? "";
  const resetDate = new Date(iso);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "reset";

  const diffMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}
