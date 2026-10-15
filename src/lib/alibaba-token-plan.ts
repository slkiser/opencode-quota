/**
 * Alibaba Personal Token Plan quota from the official `bl` CLI.
 *
 * Production invocation is exactly:
 *   bl usage token-plan --output json
 *
 * Console authentication belongs to the CLI. This module never installs `bl`,
 * never runs login, never reads credential stores, and never uses a shell.
 * Only darwin and linux are supported, so all paths use POSIX semantics.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { REQUEST_TIMEOUT_MS } from "./http.js";
import { asRecord, finiteNumber } from "./json-guards.js";

const ALIBABA_TOKEN_PLAN_COMMAND = "bl";
const ALIBABA_TOKEN_PLAN_ARGS = ["usage", "token-plan", "--output", "json"] as const;
const ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES = 256 * 1024;
const ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES = 16 * 1024;
const ALIBABA_TOKEN_PLAN_KILL_GRACE_MS = 250;
const AUTH_EXIT_CODE = 3;

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
const MAX_RESET_TIME_MS = 4_102_444_800_000;
/** `bl.cmd` and `bl.bat` are probed only so a found launcher reports "shell launcher rejected". */
const EXECUTABLE_NAMES = [ALIBABA_TOKEN_PLAN_COMMAND, "bl.cmd", "bl.bat"];
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

type AlibabaTokenPlanErrorKind =
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
  | "invalid_schema";

type AlibabaTokenPlanError = {
  kind: AlibabaTokenPlanErrorKind;
  message: string;
};

type AlibabaTokenPlanFailure = { ok: false; error: AlibabaTokenPlanError };

export type AlibabaTokenPlanClosedResult =
  | {
      ok: true;
      monthly?: AlibabaTokenPlanWindow;
    }
  | AlibabaTokenPlanFailure;

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
  killGraceMs: number;
};

type AlibabaTokenPlanSpawnResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
  spawnErrorCode?: string;
};

type AlibabaTokenPlanExecutableResolution = { ok: true; file: string } | AlibabaTokenPlanFailure;

type AlibabaTokenPlanRuntime = {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  /** The project folder quota is computed for. */
  cwd: string;
  tmpdir?: string;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (request: AlibabaTokenPlanSpawnRequest) => Promise<AlibabaTokenPlanSpawnResult>;
};

export const ERROR_MESSAGES: Record<AlibabaTokenPlanErrorKind, string> = {
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
};

/** A reply without a monthly percentage. `bl` renders that case as an unlimited limit, and a CLI
 * older than bailian-cli 2.2.0 produces it too, so the hint names the CLI's own wording. */
export const NO_WINDOW_HINT =
  "no monthly percentage in the reply; the limit may be unlimited — verify in the Bailian Token Plan console";

function fail(kind: AlibabaTokenPlanErrorKind): AlibabaTokenPlanFailure {
  return { ok: false, error: { kind, message: ERROR_MESSAGES[kind] } };
}

export function isAlibabaTokenPlanSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
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

/**
 * The folder whose PATH entries and executables are not trusted: the project folder quota is
 * computed for. For OpenCode opened at the home folder, and for the terminal command, that is
 * the home folder. The home folder is not a project, so it gives none.
 */
function untrustedProjectFolder(cwd: string, home: string | undefined): string | null {
  const resolved = path.posix.resolve(cwd);
  return resolved === path.posix.resolve(home ?? homedir()) ? null : resolved;
}

/** Absolute PATH directories outside the project folder, deduplicated, in PATH order. */
function listTrustedPathDirectories(
  pathEnv: string | undefined,
  cwd: string,
  home: string | undefined,
): string[] {
  const projectFolder = untrustedProjectFolder(cwd, home);
  const trusted = new Set<string>();
  for (const rawEntry of (pathEnv ?? "").split(":")) {
    const entry = stripPathQuotes(rawEntry);
    if (!path.posix.isAbsolute(entry)) continue;
    const resolved = path.posix.resolve(entry);
    if (projectFolder !== null && isPathInside(projectFolder, resolved)) continue;
    trusted.add(resolved);
  }
  return [...trusted];
}

function isShellLauncherPath(file: string): boolean {
  return (
    SHELL_LAUNCHER_EXTENSIONS.has(path.posix.extname(file).toLowerCase()) ||
    SHELL_LAUNCHER_NAMES.has(path.posix.basename(file).toLowerCase())
  );
}

/** True for a regular file, following symlinks; false when missing or broken. */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function resolveAlibabaTokenPlanExecutable(params: {
  pathEnv?: string;
  cwd: string;
  homedir?: string;
  platform?: NodeJS.Platform;
}): Promise<AlibabaTokenPlanExecutableResolution> {
  if (!isAlibabaTokenPlanSupportedPlatform(params.platform)) {
    return fail("unsupported_platform");
  }

  const projectFolder = untrustedProjectFolder(params.cwd, params.homedir);
  const trusted = listTrustedPathDirectories(
    params.pathEnv ?? process.env.PATH,
    params.cwd,
    params.homedir,
  );
  let sawShellLauncher = false;
  for (const directory of trusted) {
    for (const name of EXECUTABLE_NAMES) {
      const candidate = path.posix.join(directory, name);
      if (!(await isRegularFile(candidate))) continue;
      const resolved = await realpath(candidate).catch(() => candidate);
      if (isShellLauncherPath(candidate) || isShellLauncherPath(resolved)) {
        sawShellLauncher = true;
        continue;
      }
      if (projectFolder !== null && isPathInside(projectFolder, resolved)) {
        return fail("workspace_path_rejected");
      }
      return { ok: true, file: resolved };
    }
  }
  return fail(sawShellLauncher ? "shell_launcher_rejected" : "executable_not_found");
}

/** The used fraction 0..1 and an optional epoch-ms reset. A reset alone is invalid; neither present
 * means the plan may be unlimited. */
function parseWindow(
  payload: Record<string, unknown>,
): AlibabaTokenPlanWindow | undefined | "invalid" {
  const resetPresent = Object.hasOwn(payload, "per1MonthResetTime");
  if (!Object.hasOwn(payload, "per1MonthPercentage")) return resetPresent ? "invalid" : undefined;

  const used = finiteNumber(payload.per1MonthPercentage);
  if (used === undefined || used < 0 || used > 1) return "invalid";
  const percentRemaining = 100 - used * 100;
  if (!resetPresent) return { percentRemaining };

  const reset = finiteNumber(payload.per1MonthResetTime);
  if (reset === undefined || reset <= 0 || reset > MAX_RESET_TIME_MS) return "invalid";
  return { percentRemaining, resetTimeIso: new Date(reset).toISOString() };
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

  const monthly = parseWindow(record);
  if (monthly === "invalid") return fail("invalid_schema");
  // No window is a valid reply: the CLI itself says the limit may be unlimited.
  return { ok: true, ...(monthly ? { monthly } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Signal the child's whole process group, falling back to the child alone. */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
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

/**
 * Run the CLI without a shell, with stdin ignored and stdout/stderr capped. A timeout or an
 * overflow sends SIGTERM to the process group, then SIGKILL after `killGraceMs`.
 */
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
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
        spawnErrorCode: errorCode(error),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let truncated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    function stop(): void {
      if (killTimer !== undefined) return;
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), request.killGraceMs);
    }

    function collect(chunks: Buffer[], limit: number): (chunk: Buffer) => void {
      let size = 0;
      return (chunk) => {
        const room = limit - size;
        if (room > 0 && chunk.length <= room) {
          chunks.push(chunk);
          size += chunk.length;
          return;
        }
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = limit;
        if (!truncated) {
          truncated = true;
          stop();
        }
      };
    }

    function finish(code: number | null, spawnErrorCode?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
        truncated,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);

    child.stdout?.on("data", collect(stdoutChunks, request.stdoutLimitBytes));
    child.stderr?.on("data", collect(stderrChunks, request.stderrLimitBytes));
    child.on("error", (error) => finish(null, errorCode(error)));
    child.on("close", (code) => finish(code));
  });
}

function mapSpawnResult(result: AlibabaTokenPlanSpawnResult): AlibabaTokenPlanClosedResult {
  if (result.truncated) return fail("output_truncated");
  if (result.timedOut) return fail("timeout");
  if (result.spawnErrorCode === "ENOENT") return fail("executable_not_found");
  if (result.spawnErrorCode) return fail("spawn_failed");
  if (result.code === AUTH_EXIT_CODE) return fail("not_authenticated");
  if (result.code !== 0) return fail("nonzero_exit");
  return parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"));
}

export async function queryAlibabaTokenPlanQuota(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaTokenPlanClosedResult> {
  const runtime = options.runtime;
  const platform = runtime.platform ?? process.platform;
  if (!isAlibabaTokenPlanSupportedPlatform(platform)) {
    return fail("unsupported_platform");
  }

  const cwd = path.posix.resolve(runtime.cwd);
  const home = runtime.homedir ?? homedir();
  const pathEnv = runtime.pathEnv ?? runtime.env?.PATH ?? process.env.PATH;
  const resolved = await resolveAlibabaTokenPlanExecutable({
    pathEnv,
    cwd,
    homedir: home,
    platform,
  });
  if (!resolved.ok) return resolved;

  // Run outside the project folder so the CLI never picks up project files.
  const processCwd =
    [runtime.tmpdir ?? tmpdir(), home]
      .map((candidate) => path.posix.resolve(candidate))
      .find((candidate) => !isPathInside(cwd, candidate)) ?? "/";
  const request: AlibabaTokenPlanSpawnRequest = {
    file: resolved.file,
    args: ALIBABA_TOKEN_PLAN_ARGS,
    cwd: processCwd,
    env: {
      ...(runtime.env ?? process.env),
      PATH: listTrustedPathDirectories(pathEnv, cwd, home).join(":"),
    },
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    stdoutLimitBytes: ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    killGraceMs: ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
  };
  const run = runtime.spawn ?? runAlibabaTokenPlanProcess;
  try {
    return mapSpawnResult(await run(request));
  } catch {
    return fail("spawn_failed");
  }
}
