/**
 * Alibaba Personal Token Plan quota from the official `bl` CLI.
 *
 * Production invocation is exactly:
 *   bl usage token-plan --output json
 *
 * Console authentication belongs to the CLI. This module never installs `bl`,
 * never runs login, never reads credential stores, and never uses a shell.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { REQUEST_TIMEOUT_MS } from "./types.js";

export const ALIBABA_TOKEN_PLAN_COMMAND = "bl";
export const ALIBABA_TOKEN_PLAN_ARGS = ["usage", "token-plan", "--output", "json"] as const;
export const ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES = 256 * 1024;
export const ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES = 16 * 1024;
export const ALIBABA_TOKEN_PLAN_KILL_GRACE_MS = 250;
export const ALIBABA_TOKEN_PLAN_AUTH_EXIT_CODE = 3;

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
const MAX_RESET_TIME_MS = 4_102_444_800_000;
const SHELL_LAUNCHER_NAMES = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "command.com",
  "cscript.exe",
  "csh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "tcsh",
  "wscript.exe",
  "zsh",
]);
const SHELL_LAUNCHER_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".cmd",
  ".com",
  ".fish",
  ".ps1",
  ".sh",
  ".zsh",
]);

export type AlibabaTokenPlanWindow = {
  percentRemaining: number;
  resetTimeIso?: string;
};

export type AlibabaTokenPlanErrorKind =
  | "unsupported_platform"
  | "executable_not_found"
  | "shell_launcher_rejected"
  | "workspace_path_rejected"
  | "spawn_failed"
  | "timeout"
  | "output_truncated"
  | "nonzero_exit"
  | "not_authenticated"
  | "invalid_json"
  | "invalid_schema"
  | "no_data";

export type AlibabaTokenPlanError = {
  kind: AlibabaTokenPlanErrorKind;
  message: string;
  retryable?: boolean;
};

export type AlibabaTokenPlanClosedResult =
  | {
      ok: true;
      fiveHour?: AlibabaTokenPlanWindow;
      weekly?: AlibabaTokenPlanWindow;
    }
  | {
      ok: false;
      error: AlibabaTokenPlanError;
    };

export type AlibabaTokenPlanSpawnRequest = {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  stdin: "ignore";
  shell: false;
  platform: NodeJS.Platform;
  killGraceMs: number;
};

export type AlibabaTokenPlanSpawnResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
  spawnErrorCode?: string;
};

export type AlibabaTokenPlanExecutableResolution =
  | { ok: true; file: string }
  | { ok: false; error: AlibabaTokenPlanError };

export type AlibabaTokenPlanRuntime = {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  cwd?: string;
  tmpdir?: string;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (request: AlibabaTokenPlanSpawnRequest) => Promise<AlibabaTokenPlanSpawnResult>;
};

const ERROR_MESSAGES: Record<AlibabaTokenPlanErrorKind, string> = {
  unsupported_platform: "Alibaba Personal Token Plan is not supported on this platform.",
  executable_not_found: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
  shell_launcher_rejected: "Alibaba Personal Token Plan refused a shell launcher for bl.",
  workspace_path_rejected:
    "Alibaba Personal Token Plan ignored workspace and relative PATH entries.",
  spawn_failed: "Could not start Alibaba Cloud CLI.",
  timeout: "Timed out while running the Alibaba Cloud CLI.",
  output_truncated: "Alibaba Cloud CLI output exceeded the bounded size limit.",
  nonzero_exit: "Could not read Alibaba Personal Token Plan quota.",
  not_authenticated:
    "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
  invalid_json: "Alibaba Cloud CLI did not return valid JSON.",
  invalid_schema: "Alibaba Cloud CLI returned an invalid Personal Token Plan payload.",
  no_data: "Alibaba Personal Token Plan usage returned no quota windows.",
};

function fail(
  kind: AlibabaTokenPlanErrorKind,
  retryable?: boolean,
): Extract<AlibabaTokenPlanClosedResult, { ok: false }> {
  return {
    ok: false,
    error: {
      kind,
      message: ERROR_MESSAGES[kind],
      ...(retryable ? { retryable: true } : {}),
    },
  };
}

function executableResolutionError(
  kind: AlibabaTokenPlanErrorKind,
): Extract<AlibabaTokenPlanExecutableResolution, { ok: false }> {
  return {
    ok: false,
    error: {
      kind,
      message: ERROR_MESSAGES[kind],
    },
  };
}

export function isAlibabaTokenPlanSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

function runtimePath(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isPathInside(parent: string, candidate: string, paths: typeof path.posix): boolean {
  const relative = paths.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

function stripPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function listTrustedPathDirectories(params: {
  pathEnv: string | undefined;
  cwd: string;
  platform: NodeJS.Platform;
}): string[] {
  const paths = runtimePath(params.platform);
  const delimiter = paths.delimiter;
  const cwd = paths.resolve(params.cwd);
  const trusted: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of (params.pathEnv ?? "").split(delimiter)) {
    const entry = stripPathQuotes(rawEntry);
    if (!entry || entry === "." || entry === "..") continue;
    if (!paths.isAbsolute(entry)) continue;

    const resolved = paths.resolve(entry);
    if (isPathInside(cwd, resolved, paths)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    trusted.push(resolved);
  }

  return trusted;
}

function isShellLauncherPath(file: string): boolean {
  const extension = path.posix.extname(file).toLowerCase();
  if (SHELL_LAUNCHER_EXTENSIONS.has(extension)) return true;
  return SHELL_LAUNCHER_NAMES.has(path.posix.basename(file).toLowerCase());
}

function candidateExecutableNames(): readonly string[] {
  return [ALIBABA_TOKEN_PLAN_COMMAND, "bl.cmd", "bl.bat"];
}

async function fileLooksLikeExecutable(file: string): Promise<boolean> {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) {
      const target = await realpath(file);
      const targetStats = await lstat(target);
      return targetStats.isFile() || targetStats.isSymbolicLink();
    }
    return stats.isFile();
  } catch {
    return false;
  }
}

export async function resolveAlibabaTokenPlanExecutable(params: {
  pathEnv?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}): Promise<AlibabaTokenPlanExecutableResolution> {
  const platform = params.platform ?? process.platform;
  if (!isAlibabaTokenPlanSupportedPlatform(platform)) {
    return executableResolutionError("unsupported_platform");
  }

  const paths = runtimePath(platform);
  const cwd = paths.resolve(params.cwd ?? process.cwd());
  const trusted = listTrustedPathDirectories({
    pathEnv: params.pathEnv ?? process.env.PATH,
    cwd,
    platform,
  });
  if (trusted.length === 0) {
    return executableResolutionError("executable_not_found");
  }

  let sawShellLauncher = false;
  for (const directory of trusted) {
    for (const name of candidateExecutableNames()) {
      const candidate = paths.join(directory, name);
      if (!(await fileLooksLikeExecutable(candidate))) continue;
      if (isShellLauncherPath(candidate)) {
        sawShellLauncher = true;
        continue;
      }

      let resolved = candidate;
      try {
        resolved = await realpath(candidate);
      } catch {
        resolved = candidate;
      }
      if (isShellLauncherPath(resolved)) {
        sawShellLauncher = true;
        continue;
      }
      if (isPathInside(cwd, resolved, paths)) {
        return executableResolutionError("workspace_path_rejected");
      }
      return { ok: true, file: resolved };
    }
  }

  if (sawShellLauncher) {
    return executableResolutionError("shell_launcher_rejected");
  }
  return executableResolutionError("executable_not_found");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function usedFractionToPercentRemaining(used: number): number {
  return 100 - used * 100;
}

function parseResetTimeIso(value: unknown): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_RESET_TIME_MS
  ) {
    return "invalid";
  }
  const iso = new Date(value).toISOString();
  if (iso === "Invalid Date") return "invalid";
  return iso;
}

function parseWindow(
  payload: Record<string, unknown>,
  prefix: "per5Hour" | "per1Week",
): AlibabaTokenPlanWindow | undefined | "invalid" {
  const percentageKey = `${prefix}Percentage`;
  const resetKey = `${prefix}ResetTime`;
  const percentagePresent = hasOwn(payload, percentageKey);
  const resetPresent = hasOwn(payload, resetKey);
  if (!percentagePresent && !resetPresent) return undefined;
  if (!percentagePresent) return "invalid";

  const used = payload[percentageKey];
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) {
    return "invalid";
  }
  if (!resetPresent) {
    return { percentRemaining: usedFractionToPercentRemaining(used) };
  }
  const resetTimeIso = parseResetTimeIso(payload[resetKey]);
  if (resetTimeIso === "invalid") return "invalid";
  return {
    percentRemaining: usedFractionToPercentRemaining(used),
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };
}

export function parseAlibabaTokenPlanUsageJson(text: string): AlibabaTokenPlanClosedResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  const record = asRecord(payload);
  if (!record) return fail("invalid_schema");

  const fiveHour = parseWindow(record, "per5Hour");
  if (fiveHour === "invalid") return fail("invalid_schema");
  const weekly = parseWindow(record, "per1Week");
  if (weekly === "invalid") return fail("invalid_schema");
  if (!fiveHour && !weekly) return fail("no_data");

  return {
    ok: true,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

function resolveNonWorkspaceCwd(params: {
  cwd: string;
  tmpdir: string;
  homedir: string;
  platform: NodeJS.Platform;
}): string {
  const paths = runtimePath(params.platform);
  const workspace = paths.resolve(params.cwd);
  for (const candidate of [
    params.tmpdir,
    params.homedir,
    params.platform === "win32" ? "C:\\" : "/",
  ]) {
    const resolved = paths.resolve(candidate);
    if (!isPathInside(workspace, resolved, paths)) return resolved;
  }
  return params.platform === "win32" ? "C:\\" : "/";
}

function trustedPathEnv(params: {
  trustedDirectories: readonly string[];
  platform: NodeJS.Platform;
}): string {
  return params.trustedDirectories.join(runtimePath(params.platform).delimiter);
}

function takeBoundedChunk(
  chunks: Buffer[],
  currentSize: number,
  chunk: Buffer,
  limit: number,
): { size: number; overflowed: boolean } {
  const remaining = limit - currentSize;
  if (remaining <= 0) return { size: currentSize, overflowed: true };
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { size: currentSize + chunk.length, overflowed: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { size: limit, overflowed: true };
}

function signalProcessGroup(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  if (platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
}

export async function runAlibabaTokenPlanProcess(
  request: AlibabaTokenPlanSpawnRequest,
): Promise<AlibabaTokenPlanSpawnResult> {
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        argv0: request.file,
        shell: false,
        windowsHide: true,
        detached: request.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const spawnErrorCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
        spawnErrorCode,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let truncated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let escalated = false;

    function clearKillTimer(): void {
      if (killTimer === undefined) return;
      clearTimeout(killTimer);
      killTimer = undefined;
    }

    function escalate(): void {
      if (!escalated) {
        escalated = true;
        signalProcessGroup(child, request.platform, "SIGTERM");
      }
      clearKillTimer();
      killTimer = setTimeout(() => {
        killTimer = undefined;
        signalProcessGroup(child, request.platform, "SIGKILL");
      }, request.killGraceMs);
    }

    function onStdoutData(chunk: Buffer | string): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = takeBoundedChunk(stdoutChunks, stdoutSize, buf, request.stdoutLimitBytes);
      stdoutSize = next.size;
      if (next.overflowed && !truncated) {
        truncated = true;
        escalate();
      }
    }

    function onStderrData(chunk: Buffer | string): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = takeBoundedChunk(stderrChunks, stderrSize, buf, request.stderrLimitBytes);
      stderrSize = next.size;
      if (next.overflowed && !truncated) {
        truncated = true;
        escalate();
      }
    }

    function spawnErrorCodeFrom(error: unknown): string | undefined {
      return error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    }

    function removeListeners(): void {
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    }

    function finish(code: number | null, spawnErrorCode?: string): void {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      clearKillTimer();
      removeListeners();
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
        truncated,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    }

    function onError(error: Error): void {
      finish(null, spawnErrorCodeFrom(error));
    }

    function onClose(code: number | null): void {
      finish(code);
    }

    timeout = setTimeout(() => {
      timedOut = true;
      escalate();
    }, request.timeoutMs);

    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

function mapSpawnFailure(result: AlibabaTokenPlanSpawnResult): AlibabaTokenPlanClosedResult {
  if (result.truncated) return fail("output_truncated");
  if (result.timedOut) return fail("timeout", true);
  if (result.spawnErrorCode === "ENOENT") return fail("executable_not_found");
  if (result.spawnErrorCode) return fail("spawn_failed", true);
  if (result.code === ALIBABA_TOKEN_PLAN_AUTH_EXIT_CODE) return fail("not_authenticated");
  if (result.code !== 0) return fail("nonzero_exit");
  return parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"));
}

export async function queryAlibabaTokenPlanQuota(
  options: { requestTimeoutMs?: number; runtime?: AlibabaTokenPlanRuntime } = {},
): Promise<AlibabaTokenPlanClosedResult> {
  const runtime = options.runtime ?? {};
  const platform = runtime.platform ?? process.platform;
  if (!isAlibabaTokenPlanSupportedPlatform(platform)) {
    return fail("unsupported_platform");
  }

  const cwd = runtimePath(platform).resolve(runtime.cwd ?? process.cwd());
  const pathEnv = runtime.pathEnv ?? runtime.env?.PATH ?? process.env.PATH;
  const resolved = await resolveAlibabaTokenPlanExecutable({
    pathEnv,
    cwd,
    platform,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const trustedDirectories = listTrustedPathDirectories({ pathEnv, cwd, platform });
  const processCwd = resolveNonWorkspaceCwd({
    cwd,
    tmpdir: runtime.tmpdir ?? tmpdir(),
    homedir: runtime.homedir ?? homedir(),
    platform,
  });
  const env: NodeJS.ProcessEnv = {
    ...(runtime.env ?? process.env),
    PATH: trustedPathEnv({ trustedDirectories, platform }),
    // bl's debounced npmjs version check (versionCheckStage) stalls each spawn; this is its
    // only supported skip knob.
    NO_UPDATE_NOTIFIER: "1",
  };
  const request: AlibabaTokenPlanSpawnRequest = {
    file: resolved.file,
    args: ALIBABA_TOKEN_PLAN_ARGS,
    cwd: processCwd,
    env,
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    stdoutLimitBytes: ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    platform,
    killGraceMs: ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
  };
  const run = runtime.spawn ?? runAlibabaTokenPlanProcess;
  try {
    return mapSpawnFailure(await run(request));
  } catch {
    return fail("spawn_failed", true);
  }
}
