/**
 * Shared display sanitization for user-visible output.
 *
 * Strips ANSI escape sequences and other control characters so that
 * remote/provider error text cannot inject terminal control codes into
 * toasts or transcript output.
 */

// Remove terminal escape sequences (CSI/OSC/DCS/APC/PM/SOS) and other control
// characters except newline/tab so provider text cannot inject terminal actions.
// eslint-disable-next-line no-control-regex
const DISPLAY_ESCAPE_SEQUENCE_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x1B\u0007]*(?:\u0007|\x1B\\)|P[\s\S]*?\x1B\\|_[\s\S]*?\x1B\\|\^[\s\S]*?\x1B\\|X[\s\S]*?\x1B\\|[@-_])/g;
// eslint-disable-next-line no-control-regex
const DISPLAY_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function sanitizeDisplayText(text: string): string {
  return text.replace(DISPLAY_ESCAPE_SEQUENCE_RE, "").replace(DISPLAY_CONTROL_RE, "");
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
