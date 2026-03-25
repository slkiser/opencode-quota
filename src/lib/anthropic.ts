/**
 * Anthropic Claude quota fetcher.
 *
 * Reads a Claude Code OAuth access token from local Claude credentials and
 * queries the Anthropic usage API to surface 5-hour and 7-day rate-limit
 * windows.
 *
 * Supported credential sources:
 *   1. ~/.claude/.credentials.json → claudeAiOauth.accessToken
 *   2. CLAUDE_CODE_OAUTH_TOKEN environment variable
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

// =============================================================================
// Types
// =============================================================================

export interface AnthropicQuotaWindow {
  /** Used percentage [0..100]. */
  used_percentage: number;
  /** ISO timestamp when this window resets. */
  resets_at: string;
}

export interface AnthropicUsageResponse {
  five_hour: AnthropicQuotaWindow;
  seven_day: AnthropicQuotaWindow;
}

export interface AnthropicQuotaResult {
  success: true;
  five_hour: { percentRemaining: number; resetTimeIso?: string };
  seven_day: { percentRemaining: number; resetTimeIso?: string };
}

export interface AnthropicQuotaError {
  success: false;
  error: string;
}

export type AnthropicResult = AnthropicQuotaResult | AnthropicQuotaError | null;

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

export interface ResolvedAnthropicCredentials {
  accessToken: string;
  expiresAt?: number;
  source: "file" | "env";
}

// =============================================================================
// Credential loading
// =============================================================================

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCredentialsFile(): ClaudeCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(content) as ClaudeCredentials;
  } catch {
    return null;
  }
}

export function resolveAnthropicCredentialsFromFile(
  credentials: ClaudeCredentials | null | undefined,
): ResolvedAnthropicCredentials | null {
  const fileToken = credentials?.claudeAiOauth?.accessToken?.trim();
  if (fileToken) {
    return {
      accessToken: fileToken,
      expiresAt: normalizeOptionalTimestamp(credentials?.claudeAiOauth?.expiresAt),
      source: "file",
    };
  }

  const envToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim();
  if (envToken) {
    return { accessToken: envToken, source: "env" };
  }

  return null;
}

export async function resolveAnthropicCredentials(): Promise<ResolvedAnthropicCredentials | null> {
  return resolveAnthropicCredentialsFromFile(readCredentialsFile());
}

export async function hasAnthropicCredentialsConfigured(): Promise<boolean> {
  return (await resolveAnthropicCredentials()) !== null;
}

// =============================================================================
// Quota fetch
// =============================================================================

function normalizeResetTimeIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function parseUsageResponse(data: unknown): AnthropicQuotaResult | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  const fiveHour = obj["five_hour"] as Record<string, unknown> | undefined;
  const sevenDay = obj["seven_day"] as Record<string, unknown> | undefined;

  if (!fiveHour || !sevenDay) return null;

  const fiveUsed = Number(fiveHour["used_percentage"] ?? fiveHour["usedPercentage"]);
  const sevenUsed = Number(sevenDay["used_percentage"] ?? sevenDay["usedPercentage"]);

  if (!Number.isFinite(fiveUsed) || !Number.isFinite(sevenUsed)) return null;

  return {
    success: true,
    five_hour: {
      percentRemaining: Math.max(0, Math.min(100, Math.round(100 - fiveUsed))),
      resetTimeIso: normalizeResetTimeIso(fiveHour["resets_at"] ?? fiveHour["resetsAt"]),
    },
    seven_day: {
      percentRemaining: Math.max(0, Math.min(100, Math.round(100 - sevenUsed))),
      resetTimeIso: normalizeResetTimeIso(sevenDay["resets_at"] ?? sevenDay["resetsAt"]),
    },
  };
}

/**
 * Query the Anthropic OAuth usage API for Claude rate-limit windows.
 *
 * Returns null when no credentials are found (provider not configured).
 * Returns an error result when credentials exist but the fetch fails.
 */
export async function queryAnthropicQuota(): Promise<AnthropicResult> {
  const resolved = await resolveAnthropicCredentials();

  if (!resolved) {
    return null;
  }

  if (resolved.expiresAt !== undefined && resolved.expiresAt <= Date.now()) {
    return {
      success: false,
      error: "Anthropic token expired; refresh ~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN",
    };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${resolved.accessToken}`,
        "anthropic-beta": ANTHROPIC_BETA_HEADER,
      },
    });
  } catch (err) {
    return {
      success: false,
      error: `Quota fetch failed: ${sanitizeDisplayText(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      success: false,
      error: "Invalid or expired token; refresh ~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN",
    };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    const detail = sanitizeDisplaySnippet(text, 120);
    return {
      success: false,
      error: detail
        ? `Anthropic API error ${response.status}: ${detail}`
        : `Anthropic API returned ${response.status}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      success: false,
      error: "Failed to parse Anthropic quota response",
    };
  }

  const result = parseUsageResponse(data);
  if (!result) {
    return {
      success: false,
      error: "Unexpected Anthropic quota response shape",
    };
  }

  return result;
}

export { CREDENTIALS_PATH, parseUsageResponse, readCredentialsFile };
