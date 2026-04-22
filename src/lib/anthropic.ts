/**
 * Anthropic Claude quota probing.
 *
 * Uses the local Claude CLI/runtime to detect install/auth state first. When
 * Claude auth is confirmed but local quota windows are missing, it falls back
 * to Claude OAuth credentials (macOS Keychain first, then the local credentials
 * file) and Anthropic's OAuth usage endpoint.
 */

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

const DEFAULT_CLAUDE_BINARY = "claude";
const CLAUDE_COMMAND_TIMEOUT_MS = 3_000;
const ANTHROPIC_DIAGNOSTICS_TTL_MS = 5_000;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_CREDENTIALS_SERVICE = "Claude Code-credentials";
const CLAUDE_NO_LOCAL_QUOTA_MESSAGE =
  "Claude CLI auth detected, but local quota windows were not exposed.";
const ANTHROPIC_NO_QUOTA_MESSAGE =
  "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.";

export interface AnthropicQuotaWindow {
  utilization?: number;
  used_percentage?: number;
  usedPercentage?: number;
  used_percent?: number;
  usedPercent?: number;
  percent_used?: number;
  percentUsed?: number;
  resets_at?: string;
  resetsAt?: string;
  reset_at?: string;
  resetAt?: string;
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
export type AnthropicAuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type AnthropicQuotaSource =
  | "claude-auth-status-json"
  | "claude-credentials-oauth-api"
  | "none";

export interface AnthropicDiagnostics {
  installed: boolean;
  version: string | null;
  authStatus: AnthropicAuthStatus;
  quotaSupported: boolean;
  quotaSource: AnthropicQuotaSource;
  checkedCommands: string[];
  message?: string;
  quota?: AnthropicQuotaResult;
}

export interface AnthropicProbeOptions {
  binaryPath?: string;
}

type ClaudeCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnErrorCode?: number | string;
  errorMessage?: string;
};

export type ClaudeCommandInvocation = {
  file: string;
  args: string[];
  display: string;
};

type AnthropicDiagnosticsCacheEntry = {
  timestamp: number;
  value: AnthropicDiagnostics | null;
  inFlight?: Promise<AnthropicDiagnostics>;
};

type AnthropicLocalDiagnostics = {
  installed: boolean;
  version: string | null;
  authStatus: AnthropicAuthStatus;
  checkedCommands: string[];
  message?: string;
  localQuota?: AnthropicQuotaResult;
};

type AnthropicLocalDiagnosticsCacheEntry = {
  timestamp: number;
  value: AnthropicLocalDiagnostics | null;
  inFlight?: Promise<AnthropicLocalDiagnostics>;
};

type ClaudeCredentialsAccess =
  | {
      state: "configured";
      accessToken: string;
    }
  | {
      state: "unavailable";
      detail?: string;
    };

type ClaudeCredentialSourceResult =
  | {
      state: "configured";
      accessToken: string;
    }
  | {
      state: "not-found";
      location: string;
    }
  | {
      state: "unavailable";
      detail: string;
    };

type AnthropicFallbackQuota =
  | {
      state: "success";
      quota: AnthropicQuotaResult;
    }
  | {
      state: "unavailable";
      detail?: string;
    };

type ParsedAuthProbe = {
  authStatus: AnthropicAuthStatus;
  message?: string;
  jsonPayload?: unknown;
  unsupportedCommand?: boolean;
};

const diagnosticsCache = new Map<string, AnthropicDiagnosticsCacheEntry>();
const localDiagnosticsCache = new Map<string, AnthropicLocalDiagnosticsCacheEntry>();

export function resolveAnthropicBinaryPath(binaryPath?: string): string {
  const trimmed = binaryPath?.trim();
  return trimmed ? trimmed : DEFAULT_CLAUDE_BINARY;
}

function formatCommandDisplayArg(value: string): string {
  const sanitized = sanitizeDisplayText(value);
  return /[\s"]/u.test(sanitized) ? JSON.stringify(sanitized) : sanitized;
}

function formatCommandDisplay(parts: string[]): string {
  return parts.map(formatCommandDisplayArg).join(" ");
}

function quoteWindowsCmdArg(value: string): string {
  const escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

export function buildClaudeCommandInvocation(
  binaryPath: string,
  args: string[],
  runtime: { platform?: NodeJS.Platform; comspec?: string } = {},
): ClaudeCommandInvocation {
  const resolvedBinaryPath = resolveAnthropicBinaryPath(binaryPath);
  const display = formatCommandDisplay([resolvedBinaryPath, ...args]);

  if ((runtime.platform ?? process.platform) === "win32") {
    return {
      file: runtime.comspec?.trim() || process.env["ComSpec"]?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", [resolvedBinaryPath, ...args].map(quoteWindowsCmdArg).join(" ")],
      display,
    };
  }

  return {
    file: resolvedBinaryPath,
    args: [...args],
    display,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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

function normalizeUsagePercent(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getWindowUsedPercent(window: Record<string, unknown>): number | undefined {
  const candidates = [
    window["utilization"],
    window["used_percentage"],
    window["usedPercentage"],
    window["used_percent"],
    window["usedPercent"],
    window["percent_used"],
    window["percentUsed"],
  ];

  for (const candidate of candidates) {
    const normalized = normalizeUsagePercent(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  return undefined;
}

function getWindowResetTimeIso(window: Record<string, unknown>): string | undefined {
  return normalizeResetTimeIso(
    window["resets_at"] ?? window["resetsAt"] ?? window["reset_at"] ?? window["resetAt"],
  );
}

function parseQuotaWindow(window: unknown): { percentRemaining: number; resetTimeIso?: string } | null {
  const record = asRecord(window);
  if (!record) {
    return null;
  }

  const used = getWindowUsedPercent(record);
  if (used === undefined) {
    return null;
  }

  return {
    percentRemaining: Math.max(0, Math.min(100, Math.round(100 - used))),
    resetTimeIso: getWindowResetTimeIso(record),
  };
}

function getUsageRoots(data: unknown): Record<string, unknown>[] {
  const root = asRecord(data);
  if (!root) {
    return [];
  }

  const candidates = [
    root,
    asRecord(root["quota"]),
    asRecord(root["usage"]),
    asRecord(root["rate_limits"]),
    asRecord(root["rateLimits"]),
    asRecord(root["oauth_usage"]),
    asRecord(root["oauthUsage"]),
  ];

  const seen = new Set<Record<string, unknown>>();
  const roots: Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    roots.push(candidate);
  }

  return roots;
}

function parseUsageResponse(data: unknown): AnthropicQuotaResult | null {
  for (const root of getUsageRoots(data)) {
    const fiveHour = parseQuotaWindow(root["five_hour"] ?? root["fiveHour"]);
    const sevenDay = parseQuotaWindow(root["seven_day"] ?? root["sevenDay"]);

    if (!fiveHour || !sevenDay) {
      continue;
    }

    return {
      success: true,
      five_hour: fiveHour,
      seven_day: sevenDay,
    };
  }

  return null;
}

function getClaudeCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

function getClaudeKeychainLocation(): string {
  return `macOS Keychain service ${sanitizeDisplayText(CLAUDE_CODE_CREDENTIALS_SERVICE)}`;
}

function getClaudeCredentialsNotFoundDetail(locations: string[]): string {
  if (locations.length === 0) {
    return "Claude OAuth credentials were not found.";
  }

  if (locations.length === 1) {
    return `Claude OAuth credentials not found in ${locations[0]}.`;
  }

  const [head, ...tail] = locations;
  return `Claude OAuth credentials not found in ${head} or ${tail.join(" or ")}.`;
}

function buildAnthropicNoQuotaDiagnosticsMessage(detail?: string): string {
  const normalizedDetail = detail?.trim();
  return normalizedDetail
    ? `${ANTHROPIC_NO_QUOTA_MESSAGE} ${normalizedDetail}`
    : ANTHROPIC_NO_QUOTA_MESSAGE;
}

function extractClaudeCredentialsAccessToken(data: unknown): string {
  const root = asRecord(data);
  if (!root) {
    return "";
  }

  for (const candidate of [
    asRecord(root["claudeAiOauth"]),
    asRecord(root["oauth"]),
    root,
  ]) {
    if (!candidate) {
      continue;
    }

    for (const key of ["accessToken", "access_token", "token"]) {
      const token = candidate[key];
      if (typeof token === "string" && token.trim()) {
        return token.trim();
      }
    }
  }

  return "";
}

function parseClaudeCredentialsAccessToken(
  content: string,
  options: { allowPlainText: boolean },
): { accessToken?: string; error?: string } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { error: "missing" };
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return options.allowPlainText ? { accessToken: trimmed } : { error: "missing" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const accessToken = extractClaudeCredentialsAccessToken(parsed);
    return accessToken ? { accessToken } : { error: "missing" };
  } catch (error) {
    return {
      error: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function runCredentialCommand(file: string, args: string[]): Promise<ClaudeCommandResult> {
  return await new Promise<ClaudeCommandResult>((resolve, reject) => {
    try {
      execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: CLAUDE_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
          const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");

          if (!error) {
            resolve({
              code: 0,
              stdout: stdoutText,
              stderr: stderrText,
              timedOut: false,
            });
            return;
          }

          const execError = error as Error & { code?: number | string; killed?: boolean };
          resolve({
            code: typeof execError.code === "number" ? execError.code : null,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: isTimedOutError(execError),
            spawnErrorCode: execError.code,
            errorMessage: execError.message,
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function readClaudeCredentialsAccessTokenFromMacOSKeychain(): Promise<ClaudeCredentialSourceResult | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const location = getClaudeKeychainLocation();
  const result = await runCredentialCommand("security", [
    "find-generic-password",
    "-s",
    CLAUDE_CODE_CREDENTIALS_SERVICE,
    "-w",
  ]);

  if (result.code !== 0) {
    return {
      state: "not-found",
      location,
    };
  }

  const parsed = parseClaudeCredentialsAccessToken(result.stdout, { allowPlainText: true });
  if (parsed.accessToken) {
    return {
      state: "configured",
      accessToken: parsed.accessToken,
    };
  }

  return {
    state: "unavailable",
    detail:
      parsed.error && parsed.error !== "missing"
        ? `Could not parse Claude OAuth credentials from ${location}: ${parsed.error}.`
        : `Claude OAuth access token missing in ${location}.`,
  };
}

async function readClaudeCredentialsAccessTokenFromFile(): Promise<ClaudeCredentialSourceResult> {
  const credentialsPath = getClaudeCredentialsPath();

  try {
    const content = await readFile(credentialsPath, "utf8");
    const parsed = parseClaudeCredentialsAccessToken(content, { allowPlainText: false });
    const accessToken = parsed.accessToken?.trim() ?? "";

    if (!accessToken) {
      return {
        state: "unavailable",
        detail:
          parsed.error && parsed.error !== "missing"
            ? `Could not parse Claude credentials file ${sanitizeDisplayText(credentialsPath)}: ${parsed.error}.`
            : `Claude OAuth access token missing in ${sanitizeDisplayText(credentialsPath)}.`,
      };
    }

    return {
      state: "configured",
      accessToken,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string | number }).code
        : undefined;

    if (code === "ENOENT") {
      return {
        state: "not-found",
        location: sanitizeDisplayText(credentialsPath),
      };
    }

    return {
      state: "unavailable",
      detail: `Could not read Claude credentials file: ${sanitizeDisplayText(
        error instanceof Error ? error.message : String(error),
      )}`,
    };
  }
}

async function readClaudeCredentialsAccessToken(): Promise<ClaudeCredentialsAccess> {
  const locationsChecked: string[] = [];
  const unavailableDetails: string[] = [];

  const keychainCredentials = await readClaudeCredentialsAccessTokenFromMacOSKeychain();
  if (keychainCredentials?.state === "configured") {
    return keychainCredentials;
  }
  if (keychainCredentials?.state === "unavailable") {
    unavailableDetails.push(keychainCredentials.detail);
  }
  if (keychainCredentials?.state === "not-found") {
    locationsChecked.push(keychainCredentials.location);
  }

  const fileCredentials = await readClaudeCredentialsAccessTokenFromFile();
  if (fileCredentials.state === "configured") {
    return fileCredentials;
  }
  if (fileCredentials.state === "unavailable") {
    unavailableDetails.push(fileCredentials.detail);
  }
  if (fileCredentials.state === "not-found") {
    locationsChecked.push(fileCredentials.location);
  }
  return {
    state: "unavailable",
    detail: unavailableDetails[0] ?? getClaudeCredentialsNotFoundDetail(locationsChecked),
  };
}

async function queryAnthropicQuotaFromOAuthAccessToken(
  accessToken: string,
): Promise<AnthropicFallbackQuota> {
  let response: Response;

  try {
    response = await fetchWithTimeout(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": ANTHROPIC_BETA_HEADER,
      },
    });
  } catch (error) {
    return {
      state: "unavailable",
      detail: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = sanitizeDisplaySnippet(await response.text(), 120);
    } catch {
      detail = "";
    }

    return {
      state: "unavailable",
      detail: detail
        ? `Anthropic API error ${response.status}: ${detail}`
        : `Anthropic API returned ${response.status}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      state: "unavailable",
      detail: "Failed to parse Anthropic quota response",
    };
  }

  const quota = parseUsageResponse(data);
  if (!quota) {
    return {
      state: "unavailable",
      detail: "Unexpected Anthropic quota response shape",
    };
  }

  return {
    state: "success",
    quota,
  };
}

function extractAuthBoolean(data: unknown): boolean | undefined {
  const record = asRecord(data);
  if (!record) {
    return undefined;
  }

  for (const candidate of [
    record["authenticated"],
    record["isAuthenticated"],
    record["loggedIn"],
  ]) {
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  const authRecord = asRecord(record["auth"]);
  if (authRecord) {
    for (const candidate of [authRecord["authenticated"], authRecord["loggedIn"]]) {
      if (typeof candidate === "boolean") {
        return candidate;
      }
    }
  }

  const status = record["status"];
  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    if (normalized === "authenticated") {
      return true;
    }
    if (normalized === "unauthenticated") {
      return false;
    }
  }

  return undefined;
}

function hasUnsupportedCommandText(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("unknown command") ||
    normalized.includes("unrecognized command") ||
    normalized.includes("unexpected argument")
  );
}

function hasUnauthenticatedText(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("not logged in") ||
    normalized.includes("login required") ||
    normalized.includes("authentication required") ||
    normalized.includes("run `claude login`") ||
    normalized.includes("run `claude auth login`") ||
    normalized.includes("run claude login") ||
    normalized.includes("run claude auth login")
  );
}

function detailFromCommandResult(result: ClaudeCommandResult): string | undefined {
  const detail = `${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.trim();
  return detail ? sanitizeDisplaySnippet(detail, 160) : undefined;
}

function parseVersion(output: string): string | null {
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}

function isCommandMissing(result: ClaudeCommandResult): boolean {
  if (result.spawnErrorCode === "ENOENT") {
    return true;
  }

  const output = `${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.toLowerCase();
  return (
    output.includes("command not found") ||
    output.includes("not recognized as an internal or external command") ||
    output.includes("no such file or directory")
  );
}

function isTimedOutError(error: Error & { code?: number | string; killed?: boolean }): boolean {
  return (
    error.code === "ETIMEDOUT" ||
    error.killed === true ||
    error.message.toLowerCase().includes("timed out")
  );
}

async function runClaudeCommand(invocation: ClaudeCommandInvocation): Promise<ClaudeCommandResult> {
  return await new Promise<ClaudeCommandResult>((resolve, reject) => {
    try {
      execFile(
        invocation.file,
        invocation.args,
        {
          encoding: "utf8",
          timeout: CLAUDE_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
          const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");

          if (!error) {
            resolve({
              code: 0,
              stdout: stdoutText,
              stderr: stderrText,
              timedOut: false,
            });
            return;
          }

          const execError = error as Error & { code?: number | string; killed?: boolean };
          resolve({
            code: typeof execError.code === "number" ? execError.code : null,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: isTimedOutError(execError),
            spawnErrorCode: execError.code,
            errorMessage: execError.message,
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function parseClaudeAuthStatusResult(result: ClaudeCommandResult): ParsedAuthProbe {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;

  if (hasUnsupportedCommandText(combinedOutput)) {
    return {
      authStatus: "unknown",
      unsupportedCommand: true,
      message:
        "Claude CLI authentication status JSON is unavailable in this version of Claude.",
    };
  }

  if (hasUnauthenticatedText(combinedOutput)) {
    return {
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const payload = JSON.parse(trimmed) as unknown;
      const auth = extractAuthBoolean(payload);

      if (auth === true) {
        return {
          authStatus: "authenticated",
          jsonPayload: payload,
        };
      }

      if (auth === false) {
        return {
          authStatus: "unauthenticated",
          message: "Claude is not authenticated. Run `claude auth login` and try again.",
          jsonPayload: payload,
        };
      }

      return {
        authStatus: "unknown",
        message: "Could not verify Claude authentication status from JSON output.",
        jsonPayload: payload,
      };
    } catch {
      // Fall through to exit-code-based handling.
    }
  }

  if (result.code === 0) {
    return { authStatus: "authenticated" };
  }

  if (result.timedOut) {
    return {
      authStatus: "unknown",
      message: "Timed out while running Claude CLI auth status.",
    };
  }

  const detail = detailFromCommandResult(result);
  return {
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

function mapLocalDiagnosticsToAnthropicDiagnostics(
  localDiagnostics: AnthropicLocalDiagnostics,
): AnthropicDiagnostics {
  if (localDiagnostics.localQuota) {
    return {
      installed: localDiagnostics.installed,
      version: localDiagnostics.version,
      authStatus: localDiagnostics.authStatus,
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: localDiagnostics.checkedCommands,
      quota: localDiagnostics.localQuota,
    };
  }

  const diagnostics: AnthropicDiagnostics = {
    installed: localDiagnostics.installed,
    version: localDiagnostics.version,
    authStatus: localDiagnostics.authStatus,
    quotaSupported: false,
    quotaSource: "none",
    checkedCommands: localDiagnostics.checkedCommands,
  };

  if (localDiagnostics.message) {
    diagnostics.message = localDiagnostics.message;
  }

  return diagnostics;
}

async function probeAnthropicLocalDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicLocalDiagnostics> {
  const binaryPath = resolveAnthropicBinaryPath(options.binaryPath);
  const checkedCommands: string[] = [];

  const versionCommand = buildClaudeCommandInvocation(binaryPath, ["--version"]);
  checkedCommands.push(versionCommand.display);
  const versionResult = await runClaudeCommand(versionCommand);
  if (isCommandMissing(versionResult)) {
    return {
      installed: false,
      version: null,
      authStatus: "unknown",
      checkedCommands,
      message: `Claude CLI (\`${sanitizeDisplayText(binaryPath)}\`) is not installed or not on PATH.`,
    };
  }

  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

  const authStatusJsonCommand = buildClaudeCommandInvocation(binaryPath, [
    "auth",
    "status",
    "--json",
  ]);
  checkedCommands.push(authStatusJsonCommand.display);
  const authJsonResult = await runClaudeCommand(authStatusJsonCommand);
  let parsedAuth = parseClaudeAuthStatusResult(authJsonResult);

  if (parsedAuth.unsupportedCommand) {
    const authStatusCommand = buildClaudeCommandInvocation(binaryPath, ["auth", "status"]);
    checkedCommands.push(authStatusCommand.display);
    parsedAuth = parseClaudeAuthStatusResult(await runClaudeCommand(authStatusCommand));
  }

  if (parsedAuth.authStatus !== "authenticated") {
    return {
      installed: true,
      version,
      authStatus: parsedAuth.authStatus,
      checkedCommands,
      message: parsedAuth.message,
    };
  }

  const quota = parsedAuth.jsonPayload ? parseUsageResponse(parsedAuth.jsonPayload) : null;
  if (quota) {
    return {
      installed: true,
      version,
      authStatus: "authenticated",
      checkedCommands,
      localQuota: quota,
    };
  }

  return {
    installed: true,
    version,
    authStatus: "authenticated",
    checkedCommands,
    message: CLAUDE_NO_LOCAL_QUOTA_MESSAGE,
  };
}

export function clearAnthropicDiagnosticsCacheForTests(): void {
  diagnosticsCache.clear();
  localDiagnosticsCache.clear();
}

async function getCachedAnthropicLocalDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicLocalDiagnostics> {
  const binaryPath = resolveAnthropicBinaryPath(options.binaryPath);
  const now = Date.now();
  const cached = localDiagnosticsCache.get(binaryPath) ?? {
    timestamp: 0,
    value: null,
  };

  if (
    cached.value &&
    cached.timestamp > 0 &&
    now - cached.timestamp < ANTHROPIC_DIAGNOSTICS_TTL_MS
  ) {
    return cached.value;
  }

  if (cached.inFlight) {
    return cached.inFlight;
  }

  const inFlight = probeAnthropicLocalDiagnostics({ binaryPath }).then((value) => {
    localDiagnosticsCache.set(binaryPath, {
      timestamp: Date.now(),
      value,
    });
    return value;
  });

  localDiagnosticsCache.set(binaryPath, {
    timestamp: cached.timestamp,
    value: cached.value,
    inFlight,
  });

  try {
    return await inFlight;
  } finally {
    const latest = localDiagnosticsCache.get(binaryPath);
    if (latest?.inFlight === inFlight) {
      localDiagnosticsCache.set(binaryPath, {
        timestamp: latest.timestamp,
        value: latest.value,
      });
    }
  }
}

export async function getAnthropicDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicDiagnostics> {
  const binaryPath = resolveAnthropicBinaryPath(options.binaryPath);
  const now = Date.now();
  const cached = diagnosticsCache.get(binaryPath) ?? {
    timestamp: 0,
    value: null,
  };

  if (
    cached.value &&
    cached.timestamp > 0 &&
    now - cached.timestamp < ANTHROPIC_DIAGNOSTICS_TTL_MS
  ) {
    return cached.value;
  }

  if (cached.inFlight) {
    return cached.inFlight;
  }

  const inFlight = (async () => {
    const localDiagnostics = await getCachedAnthropicLocalDiagnostics({ binaryPath });
    if (localDiagnostics.authStatus !== "authenticated" || localDiagnostics.localQuota) {
      return mapLocalDiagnosticsToAnthropicDiagnostics(localDiagnostics);
    }

    const credentials = await readClaudeCredentialsAccessToken();
    if (credentials.state !== "configured") {
      const diagnostics: AnthropicDiagnostics = {
        installed: localDiagnostics.installed,
        version: localDiagnostics.version,
        authStatus: localDiagnostics.authStatus,
        quotaSupported: false,
        quotaSource: "none",
        checkedCommands: localDiagnostics.checkedCommands,
        message: buildAnthropicNoQuotaDiagnosticsMessage(credentials.detail),
      };
      return diagnostics;
    }

    const fallbackQuota = await queryAnthropicQuotaFromOAuthAccessToken(credentials.accessToken);
    if (fallbackQuota.state !== "success") {
      const diagnostics: AnthropicDiagnostics = {
        installed: localDiagnostics.installed,
        version: localDiagnostics.version,
        authStatus: localDiagnostics.authStatus,
        quotaSupported: false,
        quotaSource: "none",
        checkedCommands: localDiagnostics.checkedCommands,
        message: buildAnthropicNoQuotaDiagnosticsMessage(fallbackQuota.detail),
      };
      return diagnostics;
    }

    const diagnostics: AnthropicDiagnostics = {
      installed: localDiagnostics.installed,
      version: localDiagnostics.version,
      authStatus: localDiagnostics.authStatus,
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      checkedCommands: localDiagnostics.checkedCommands,
      quota: fallbackQuota.quota,
    };
    return diagnostics;
  })().then((value) => {
    diagnosticsCache.set(binaryPath, {
      timestamp: Date.now(),
      value,
    });
    return value;
  });

  diagnosticsCache.set(binaryPath, {
    timestamp: cached.timestamp,
    value: cached.value,
    inFlight,
  });

  try {
    return await inFlight;
  } finally {
    const latest = diagnosticsCache.get(binaryPath);
    if (latest?.inFlight === inFlight) {
      diagnosticsCache.set(binaryPath, {
        timestamp: latest.timestamp,
        value: latest.value,
      });
    }
  }
}

export async function hasAnthropicCredentialsConfigured(
  options: AnthropicProbeOptions = {},
): Promise<boolean> {
  try {
    const diagnostics = await getCachedAnthropicLocalDiagnostics(options);
    return diagnostics.installed && diagnostics.authStatus === "authenticated";
  } catch {
    return false;
  }
}

export async function queryAnthropicQuota(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicResult> {
  try {
    const diagnostics = await getAnthropicDiagnostics(options);
    if (diagnostics.quotaSupported) {
      return diagnostics.quota ?? null;
    }

    if (diagnostics.authStatus === "authenticated" && diagnostics.message) {
      return {
        success: false,
        error: diagnostics.message,
      };
    }

    return null;
  } catch (err) {
    return {
      success: false,
      error: `Claude CLI probe failed: ${sanitizeDisplayText(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }
}

export { parseUsageResponse };
