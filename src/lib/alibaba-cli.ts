/**
 * Alibaba Cloud Model Studio CLI (`bl`) quota probing.
 *
 * Uses the official bailian-cli to read the real Token Plan Personal quota:
 *
 *   bl usage token-plan --output json [--console-region <r>] [--console-site <s>] --timeout 8
 *
 * The command prints a flat JSON object on stdout with a subset of:
 *   per5HourPercentage   number  fraction USED in [0,1] (may be absent while
 *                        the 5-hour limit promotion is unlimited)
 *   per5HourResetTime    number  epoch milliseconds
 *   per1WeekPercentage   number  fraction USED in [0,1]
 *   per1WeekResetTime    number  epoch milliseconds
 *
 * On failure the CLI exits non-zero (3 = auth, 5 = timeout, 6 = network) and
 * writes a JSON error envelope to stderr. Console credentials are owned by the
 * CLI itself (`bl auth login --console`); this module never reads or stores
 * them.
 */

import { type CliCommandResult, isCliCommandMissing, runCliCommand } from "./cli-invocation.js";

export const DEFAULT_ALIBABA_CLI_BINARY = "bl";
export const ALIBABA_CLI_RESULT_TTL_MS = 30_000;
const ALIBABA_CLI_VERSION_TIMEOUT_MS = 3_000;
const ALIBABA_CLI_USAGE_TIMEOUT_MS = 10_000;
const ALIBABA_CLI_REQUEST_TIMEOUT_SECONDS = 8;
const ALIBABA_CLI_AUTH_EXIT_CODE = 3;
const ALIBABA_CLI_TIMEOUT_EXIT_CODE = 5;
const ALIBABA_CLI_NETWORK_EXIT_CODE = 6;
// Plausibility guard for epoch-ms reset times (~year 2100).
const MAX_RESET_TIME_MS = 4_102_444_800_000;

export type AlibabaCliWindow = {
  percentUsed: number;
  resetTimeMs?: number;
};

export type AlibabaCliUsage = {
  per5Hour?: AlibabaCliWindow;
  per1Week?: AlibabaCliWindow;
};

export type AlibabaCliFailureReason =
  | "not_installed"
  | "not_authenticated"
  | "timeout"
  | "network"
  | "invalid_output"
  | "no_data"
  | "error";

export type AlibabaCliDiagnostics = {
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  consoleRegion?: string;
  consoleSite?: string;
  checkedCommands: string[];
  usage?: AlibabaCliUsage;
  failureReason?: AlibabaCliFailureReason;
  message?: string;
};

type AlibabaCliCacheEntry = {
  timestamp: number;
  value: AlibabaCliDiagnostics;
  inFlight?: Promise<AlibabaCliDiagnostics>;
};

const diagnosticsCache = new Map<string, AlibabaCliCacheEntry>();

export function resolveAlibabaCliBinaryPath(binaryPath?: string): string {
  const trimmed = binaryPath?.trim();
  return trimmed ? trimmed : DEFAULT_ALIBABA_CLI_BINARY;
}

export function buildBlCommandInvocation(binaryPath: string | undefined, args: string[]) {
  // Never bridge through cmd.exe: console options must remain literal arguments.
  return { file: resolveAlibabaCliBinaryPath(binaryPath), args: [...args], display: "bl" };
}

function parseVersion(output: string): string | undefined {
  const match = output
    .trim()
    .match(
      /^(?:(?:bl|bailian-cli|@alicloud\/bailian-cli)[/\s]+)?(\d{1,4}\.\d{1,4}\.\d{1,4})(?:$|\s)/,
    );
  return match?.[1];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseResetTime(value: unknown): number | undefined {
  const ms = finiteNumber(value);
  return ms !== undefined && ms > 0 && ms <= MAX_RESET_TIME_MS ? ms : undefined;
}

function parseWindow(
  payload: Record<string, unknown>,
  prefix: string,
): AlibabaCliWindow | undefined {
  const percentUsed = finiteNumber(payload[`${prefix}Percentage`]);
  if (percentUsed === undefined || percentUsed < 0 || percentUsed > 1) {
    return undefined;
  }
  const resetTimeMs = parseResetTime(payload[`${prefix}ResetTime`]);
  return resetTimeMs !== undefined ? { percentUsed, resetTimeMs } : { percentUsed };
}

/**
 * Parses `bl usage token-plan --output json` stdout. Returns the usage object
 * (possibly with no windows) or null when the payload is not a JSON object.
 */
export function parseBlTokenPlanUsageJson(text: string): AlibabaCliUsage | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const usage: AlibabaCliUsage = {};
  const per5Hour = parseWindow(record, "per5Hour");
  if (per5Hour) {
    usage.per5Hour = per5Hour;
  }
  const per1Week = parseWindow(record, "per1Week");
  if (per1Week) {
    usage.per1Week = per1Week;
  }
  return usage;
}

function isNotAuthenticated(result: CliCommandResult): boolean {
  if (result.code === ALIBABA_CLI_AUTH_EXIT_CODE) {
    return true;
  }
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    output.includes("no console access token found") || output.includes("auth login --console")
  );
}

function buildUsageArgs(consoleRegion?: string, consoleSite?: string): string[] {
  const args = [
    "usage",
    "token-plan",
    "--output",
    "json",
    "--timeout",
    String(ALIBABA_CLI_REQUEST_TIMEOUT_SECONDS),
  ];
  const region = consoleRegion?.trim();
  if (region) {
    args.push("--console-region", region);
  }
  const site = consoleSite?.trim();
  if (site) {
    args.push("--console-site", site);
  }
  return args;
}

async function runProbe(params: {
  binaryPath?: string;
  consoleRegion?: string;
  consoleSite?: string;
}): Promise<AlibabaCliDiagnostics> {
  const checkedCommands: string[] = [];
  const base = {
    consoleRegion: /^[a-z0-9-]{1,64}$/.test(params.consoleRegion ?? "")
      ? params.consoleRegion
      : undefined,
    consoleSite: ["international", "domestic"].includes(params.consoleSite ?? "")
      ? params.consoleSite
      : undefined,
    checkedCommands,
  };

  const versionCommand = buildBlCommandInvocation(params.binaryPath, ["--version"]);
  checkedCommands.push("bl --version");
  const versionResult = await runCliCommand(versionCommand, {
    timeoutMs: ALIBABA_CLI_VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });

  if (isCliCommandMissing(versionResult)) {
    return {
      ...base,
      installed: false,
      failureReason: "not_installed",
      message: "Alibaba Cloud CLI is unavailable. Install with `npm install -g bailian-cli`.",
    };
  }

  const installed = { ...base, installed: true, version: parseVersion(versionResult.stdout) };

  if (versionResult.timedOut || versionResult.code !== 0) {
    return {
      ...installed,
      failureReason: versionResult.timedOut ? "timeout" : "error",
      message: "Alibaba Cloud CLI version check failed.",
    };
  }

  const usageCommand = buildBlCommandInvocation(
    params.binaryPath,
    buildUsageArgs(params.consoleRegion, params.consoleSite),
  );
  checkedCommands.push("bl usage token-plan --output json");
  const usageResult = await runCliCommand(usageCommand, {
    timeoutMs: ALIBABA_CLI_USAGE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });

  if (usageResult.timedOut || usageResult.code === ALIBABA_CLI_TIMEOUT_EXIT_CODE) {
    return {
      ...installed,
      failureReason: "timeout",
      message: "Timed out while running `bl usage token-plan`.",
    };
  }

  if (usageResult.code === ALIBABA_CLI_NETWORK_EXIT_CODE) {
    return {
      ...installed,
      failureReason: "network",
      message: "Network error while running `bl usage token-plan`.",
    };
  }

  if (isNotAuthenticated(usageResult)) {
    return {
      ...installed,
      authenticated: false,
      failureReason: "not_authenticated",
      message:
        "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
    };
  }

  if (usageResult.code !== 0) {
    return {
      ...installed,
      failureReason: "error",
      message: "Could not read Alibaba Token Plan quota.",
    };
  }

  const usage = parseBlTokenPlanUsageJson(usageResult.stdout);
  if (usage === null) {
    return {
      ...installed,
      failureReason: "invalid_output",
      message: "Could not parse `bl usage token-plan` JSON output.",
    };
  }

  if (!usage.per5Hour && !usage.per1Week) {
    return {
      ...installed,
      authenticated: true,
      failureReason: "no_data",
      message: "Alibaba Token Plan usage returned no quota windows.",
    };
  }

  return { ...installed, authenticated: true, usage };
}

function cacheKey(params: {
  binaryPath?: string;
  consoleRegion?: string;
  consoleSite?: string;
}): string {
  return JSON.stringify([
    resolveAlibabaCliBinaryPath(params.binaryPath),
    params.consoleRegion?.trim() ?? "",
    params.consoleSite?.trim() ?? "",
  ]);
}

/**
 * Probes the Alibaba Cloud Model Studio CLI with a short-lived result cache
 * (30s TTL) and in-flight de-duplication so bursty quota surfaces share a
 * single subprocess. Failures are cached too; never throws.
 */
export async function probeAlibabaCliUsage(
  params: {
    binaryPath?: string;
    consoleRegion?: string;
    consoleSite?: string;
    maxAgeMs?: number;
  } = {},
): Promise<AlibabaCliDiagnostics> {
  const maxAgeMs = params.maxAgeMs ?? ALIBABA_CLI_RESULT_TTL_MS;
  const key = cacheKey(params);
  const cached = diagnosticsCache.get(key);
  const now = Date.now();
  if (cached?.inFlight) return await cached.inFlight;
  if (cached && now - cached.timestamp < maxAgeMs) {
    return cached.value;
  }

  const inFlight = (async () => {
    try {
      return await runProbe(params);
    } catch {
      return {
        installed: false,
        checkedCommands: [],
        failureReason: "error" as const,
        message: "Could not run Alibaba Cloud CLI.",
      } satisfies AlibabaCliDiagnostics;
    }
  })();

  diagnosticsCache.set(key, {
    timestamp: now,
    value: { installed: false, checkedCommands: [], failureReason: "error" },
    inFlight,
  });

  const value = await inFlight;
  diagnosticsCache.set(key, { timestamp: Date.now(), value });
  return value;
}

export function clearAlibabaCliCacheForTests(): void {
  diagnosticsCache.clear();
}
