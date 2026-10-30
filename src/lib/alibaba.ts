/** Alibaba Token Plan and Coding Plan quota from the official `bl` CLI. Console auth belongs to the
 * CLI: this module never installs `bl`, logs in, reads credential stores or uses a shell. */

import { type ChildProcess, spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ErrorFacts } from "../core/errors.js";
import { publicDetail } from "../core/redact.js";
import { asRecord, finiteNumber, nonEmptyString } from "./json-guards.js";

const ALIBABA_TOKEN_PLAN_COMMAND = "bl";
export const ALIBABA_TOKEN_PLAN_ARGS = ["usage", "token-plan", "--output", "json"] as const;
/** The server caps a page at 100 and answers a larger `--page-size` with COMMON-1004 (exit 1). */
const ALIBABA_TOKEN_PLAN_SEAT_PAGE_SIZE = 100;
/** The server filters by status; the parser still re-checks each item. */
const ALIBABA_TOKEN_PLAN_SEAT_ARGS = [
  "token-plan",
  "list-seats",
  "--status",
  "NORMAL",
  "--query-assigned",
  "true",
  "--page-size",
  String(ALIBABA_TOKEN_PLAN_SEAT_PAGE_SIZE),
  "--output",
  "json",
] as const;
const ALIBABA_TOKEN_PLAN_AUTH_STATUS_ARGS = ["auth", "status", "--output", "json"] as const;
/** A reply whose `Total` never arrives must not page forever. */
const ALIBABA_TOKEN_PLAN_SEAT_MAX_PAGES = 50;
/** Half the store's 60 s fetch timeout (`core/store.ts`), so a long seat list cannot lose the whole
 * provider read and every row it gathered. */
const ALIBABA_TOKEN_PLAN_SEAT_BUDGET_MS = 30_000;
const ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES = 256 * 1024;
const ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES = 16 * 1024;
const ALIBABA_TOKEN_PLAN_KILL_GRACE_MS = 250;
/** The CLI's own budget: a local program that has to start and answer, not a remote request. */
const ALIBABA_TOKEN_PLAN_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_EXIT_CODE = 3;
/** exit 3 auth, 5 timeout, 6 network: the `bl` CLI's own exit codes. */
const EXIT_CODE_ERROR_CODES: Readonly<Record<number, ErrorFacts["code"]>> = {
  [AUTH_EXIT_CODE]: "login_expired",
  5: "timeout",
  6: "network",
};
/** The CLI's own words are redacted and cut to the length every surface shows. */
const ALIBABA_TOKEN_PLAN_ERROR_MAX_LENGTH = 300;

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);
const MAX_RESET_TIME_MS = 4_102_444_800_000;
/** `bl.cmd` is probed because npm's shim wraps the package; there is no `bl.bat`, since cmd-shim
 * writes only `<name>`, `<name>.cmd` and `<name>.ps1`, so a `.bat` is some other installer's. */
const EXECUTABLE_NAMES = [ALIBABA_TOKEN_PLAN_COMMAND, "bl.cmd"];
/** Windows installs the CLI as `bl.exe`. No bare `bl`: CreateProcess appends `.exe` to a name with
 * no extension, so an extensionless file is never what Windows would run, and npm ships one. */
const WINDOWS_EXECUTABLE_NAMES = ["bl.exe", "bl.cmd"];
/** npm's global layout: the wrapped package sits in `node_modules` beside its shims. */
const SHIM_PACKAGE_NAME = "bailian-cli";
const SHIM_EXTENSION = ".cmd";
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

/** The units the CLI's field names use. */
export type AlibabaTokenPlanUnit = "Hour" | "Day" | "Week" | "Month";

/** One quota window the CLI reported: its own name (`per1Month`), its count and its unit. */
export type AlibabaTokenPlanWindow = {
  key: string;
  count: number;
  unit: AlibabaTokenPlanUnit;
  /** 0..100 of the window still left; absent when the CLI reported no usage ratio for it. */
  percentRemaining?: number;
  resetTimeIso?: string;
};

/** One `NORMAL` team seat; every field is optional in the CLI's reply, so each is guarded alone. */
export type AlibabaTokenPlanSeat = {
  name: string;
  /** `CycleSurplusValue`, full precision. */
  surplus?: number;
  total?: number;
  /** 0..100 of the cycle still left; only when the cycle granted a positive total. */
  percentRemaining?: number;
  used?: number;
  resetsAt?: string;
  startedAt?: string;
};

export type AlibabaTokenPlanSeatResult =
  | { ok: true; seats: AlibabaTokenPlanSeat[] }
  | AlibabaFailure;

export type AlibabaErrorKind =
  | "unsupported_platform"
  | "executable_not_found"
  | "shell_launcher_rejected"
  | "workspace_path_rejected"
  | "spawn_failed"
  | "timeout"
  | "output_truncated"
  | "nonzero_exit"
  | "not_authenticated"
  | "seat_not_authenticated"
  | "seat_command_failed"
  | "seat_invalid_schema"
  | "coding_plan_command_failed"
  | "coding_plan_invalid_schema"
  | "invalid_json"
  | "invalid_schema";

type AlibabaTokenPlanError = {
  kind: AlibabaErrorKind;
  message: string;
  facts?: ErrorFacts;
};

type AlibabaFailure = { ok: false; error: AlibabaTokenPlanError };

export type AlibabaTokenPlanClosedResult =
  | {
      ok: true;
      /** Every window the reply carried, in the order the CLI wrote them. */
      windows: AlibabaTokenPlanWindow[];
      /** The CLI's own flag: whether any window carried a usage ratio. Absent when the CLI is
       * older than bailian-cli 2.7.1 and sends no flag. */
      hasQuotaData?: boolean;
    }
  | AlibabaFailure;

/** One Coding Plan window: the requests used, the limit, the percent left and when it resets. */
export type AlibabaCodingPlanWindow = {
  used: number;
  limit: number;
  percentRemaining: number;
  resetTimeIso?: string;
};

export type AlibabaCodingPlanUsage = {
  fiveHour?: AlibabaCodingPlanWindow;
  weekly?: AlibabaCodingPlanWindow;
  monthly?: AlibabaCodingPlanWindow;
};

type AlibabaCodingPlanResult = { ok: true; usage?: AlibabaCodingPlanUsage } | AlibabaFailure;

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
  /** stdout held a whole document, so the exit code was never waited for. */
  complete?: true;
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
  spawnErrorCode?: string;
};

type AlibabaTokenPlanExecutableResolution =
  | {
      ok: true;
      file: string;
      /** Set when `file` is `node`: `[entry]`, the shim package's entry, run before the command's
       * own arguments. */
      args?: readonly string[];
    }
  | AlibabaFailure;

type AlibabaTokenPlanRuntime = {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  cwd: string;
  tmpdir?: string;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (request: AlibabaTokenPlanSpawnRequest) => Promise<AlibabaTokenPlanSpawnResult>;
};

export const ERROR_MESSAGES: Record<AlibabaErrorKind, string> = {
  unsupported_platform: "Alibaba Token Plan is not supported on this platform.",
  executable_not_found: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
  shell_launcher_rejected:
    "Refused a shell launcher for the Alibaba Cloud CLI (bl). Install it with `npm install -g bailian-cli`, with node on the same PATH.",
  workspace_path_rejected:
    "Ignored workspace and relative PATH entries for the Alibaba Cloud CLI (bl).",
  spawn_failed: "Could not start Alibaba Cloud CLI.",
  timeout: "Timed out while running the Alibaba Cloud CLI.",
  output_truncated: "Alibaba Cloud CLI output exceeded the bounded size limit.",
  nonzero_exit: "Could not read Alibaba Token Plan quota.",
  not_authenticated:
    "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
  seat_not_authenticated:
    "Alibaba Cloud API Key credentials are missing or expired for team seats; this requires login. Run `bl auth login --open-api`, or set ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET.",
  seat_command_failed: "Could not read Alibaba Token Plan team seats.",
  seat_invalid_schema: "Alibaba Cloud CLI returned an invalid team seat payload.",
  coding_plan_command_failed: "Could not read Alibaba Coding Plan quota.",
  coding_plan_invalid_schema: "Alibaba Cloud CLI returned an invalid Alibaba Coding Plan payload.",
  invalid_json: "Alibaba Cloud CLI did not return valid JSON.",
  invalid_schema: "Alibaba Cloud CLI returned an invalid Alibaba Token Plan payload.",
};

/** A reply without a usage ratio. The CLI says the limit may be unlimited, so the hint says so in
 * OpenCode Quota's own words. */
export const NO_QUOTA_DATA_HINT =
  "no quota data in the reply; the limit may be unlimited, so verify in the Bailian Token Plan console";

function fail(kind: AlibabaErrorKind): AlibabaFailure {
  return { ok: false, error: { kind, message: ERROR_MESSAGES[kind] } };
}

/** Chosen from the platform the check targets, not `process.platform`, so an override decides the
 * separators, the delimiter and whether comparisons are case-insensitive. */
function pathModuleFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function executableNamesFor(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? WINDOWS_EXECUTABLE_NAMES : EXECUTABLE_NAMES;
}

export function isAlibabaTokenPlanSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

/** `path.win32.relative` compares without case, matching NTFS, so `C:\Project` and `c:\project`
 * refuse an executor alike. */
function isPathInside(paths: path.PlatformPath, parent: string, candidate: string): boolean {
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

/** The folders whose PATH entries and executables are not trusted: the project folder quota is
 * computed for, as given and with its links resolved, since a junction or symlink can name it under
 * another path. The home folder is not a project, so it gives none. */
async function untrustedProjectFolders(
  paths: path.PlatformPath,
  cwd: string,
  home: string | undefined,
): Promise<string[]> {
  const resolved = paths.resolve(cwd);
  if (resolved === paths.resolve(home ?? homedir())) return [];
  const real = await realpath(resolved).catch(() => resolved);
  return real === resolved ? [resolved] : [resolved, real];
}

function isInsideProject(
  paths: path.PlatformPath,
  projectFolders: readonly string[],
  candidate: string,
): boolean {
  return projectFolders.some((folder) => isPathInside(paths, folder, candidate));
}

function listTrustedPathDirectories(
  paths: path.PlatformPath,
  pathEnv: string | undefined,
  projectFolders: readonly string[],
): string[] {
  const trusted = new Set<string>();
  for (const rawEntry of (pathEnv ?? "").split(paths.delimiter)) {
    const entry = stripPathQuotes(rawEntry);
    if (!paths.isAbsolute(entry)) continue;
    const resolved = paths.resolve(entry);
    if (isInsideProject(paths, projectFolders, resolved)) continue;
    trusted.add(resolved);
  }
  return [...trusted];
}

function isShellLauncherPath(paths: path.PlatformPath, file: string): boolean {
  return (
    SHELL_LAUNCHER_EXTENSIONS.has(paths.extname(file).toLowerCase()) ||
    SHELL_LAUNCHER_NAMES.has(paths.basename(file).toLowerCase())
  );
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Read what an npm `bl.cmd` shim wraps instead of running it: the package manifest declares its
 * bin, so the `.cmd` text is never needed. Failures stay silent, since a parse error would leak
 * file contents. */
async function resolveNodeShim(
  paths: path.PlatformPath,
  shimFile: string,
  packageName: string,
  projectFolders: readonly string[],
): Promise<string | null> {
  const packageRoot = paths.join(paths.dirname(shimFile), "node_modules", packageName);
  const shimCommand = paths.basename(shimFile, paths.extname(shimFile)).toLowerCase();

  let contents: string;
  try {
    contents = await readFile(paths.join(packageRoot, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const manifest = asRecord(parsed);
  if (!manifest) return null;

  const bin = manifest.bin;
  let relative: string | undefined;
  if (typeof bin === "string") {
    // npm's string form: the shim we found is proof it installs the command. Accept it as written.
    relative = nonEmptyString(bin);
  } else {
    const binRecord = asRecord(bin);
    if (!binRecord || !Object.hasOwn(binRecord, shimCommand)) return null;
    relative = nonEmptyString(binRecord[shimCommand]);
  }
  if (!relative) return null;

  const entry = paths.join(packageRoot, relative);
  // A manifest can send its entry outside the package with `..`; keep it inside the package root.
  if (!isPathInside(paths, packageRoot, entry)) return null;
  if (!(await isRegularFile(entry))) return null;
  // The package folder may be a junction or the entry a link, so the file node runs is the real one.
  const real = await realpath(entry).catch(() => null);
  if (real === null || isInsideProject(paths, projectFolders, real)) return null;
  return real;
}

/** The node that runs a shim's entry: resolved as `bl` is, so `bl` and node come from one install.
 * No fallback to `process.execPath`: inside OpenCode that is OpenCode's own binary, not node. */
async function resolveNodeExecutable(
  paths: path.PlatformPath,
  trusted: readonly string[],
  projectFolders: readonly string[],
): Promise<string | null> {
  for (const directory of trusted) {
    const candidate = paths.join(directory, "node.exe");
    if (!(await isRegularFile(candidate))) continue;
    // Checked like `bl`: a trusted folder's node.exe can be a link into the project.
    const real = await realpath(candidate).catch(() => null);
    if (real === null || isInsideProject(paths, projectFolders, real)) return null;
    return real;
  }
  return null;
}

export async function resolveAlibabaTokenPlanExecutable(params: {
  pathEnv?: string;
  cwd: string;
  homedir?: string;
  platform?: NodeJS.Platform;
}): Promise<AlibabaTokenPlanExecutableResolution> {
  const platform = params.platform ?? process.platform;
  if (!isAlibabaTokenPlanSupportedPlatform(platform)) {
    return fail("unsupported_platform");
  }

  const paths = pathModuleFor(platform);
  const projectFolders = await untrustedProjectFolders(paths, params.cwd, params.homedir);
  const trusted = listTrustedPathDirectories(
    paths,
    params.pathEnv ?? process.env.PATH,
    projectFolders,
  );
  let sawShellLauncher = false;
  for (const directory of trusted) {
    for (const name of executableNamesFor(platform)) {
      const candidate = paths.join(directory, name);
      if (!(await isRegularFile(candidate))) continue;
      const resolved = await realpath(candidate).catch(() => candidate);
      if (isShellLauncherPath(paths, candidate) || isShellLauncherPath(paths, resolved)) {
        // npm's Windows `bl.cmd` is a shell launcher by extension but only forwards to the
        // package's node entry. Running node directly keeps the child the CLI (killable, with the
        // pipes) rather than cmd.exe or a shell.
        if (
          platform === "win32" &&
          paths.extname(candidate).toLowerCase() === SHIM_EXTENSION &&
          !SHELL_LAUNCHER_NAMES.has(paths.basename(resolved).toLowerCase()) &&
          !isInsideProject(paths, projectFolders, resolved)
        ) {
          const entry = await resolveNodeShim(paths, candidate, SHIM_PACKAGE_NAME, projectFolders);
          const node =
            entry === null ? null : await resolveNodeExecutable(paths, trusted, projectFolders);
          if (entry !== null && node !== null) return { ok: true, file: node, args: [entry] };
        }
        sawShellLauncher = true;
        continue;
      }
      if (isInsideProject(paths, projectFolders, resolved)) {
        return fail("workspace_path_rejected");
      }
      return { ok: true, file: resolved };
    }
  }
  return fail(sawShellLauncher ? "shell_launcher_rejected" : "executable_not_found");
}

/** Quota window fields look like per5HourPercentage / per1WeekResetTime / per1MonthPercentage. */
const WINDOW_FIELD_PATTERN = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;

/**
 * Every window the reply carries, in the order the CLI wrote them; a window without a usage
 * ratio keeps its place, only the ratio is missing.
 */
function parseWindows(payload: Record<string, unknown>): AlibabaTokenPlanWindow[] | "invalid" {
  const windows = new Map<string, AlibabaTokenPlanWindow>();
  for (const [field, value] of Object.entries(payload)) {
    const match = WINDOW_FIELD_PATTERN.exec(field);
    if (!match) continue;
    const [, count, unit, kind] = match;
    const key = `per${count}${unit}`;
    const window = windows.get(key) ?? {
      key,
      count: Number(count),
      unit: unit as AlibabaTokenPlanUnit,
    };
    if (kind === "Percentage") {
      const used = finiteNumber(value);
      if (used === undefined || used < 0 || used > 1) return "invalid";
      window.percentRemaining = 100 - used * 100;
    } else {
      const reset = finiteNumber(value);
      if (reset === undefined || reset <= 0 || reset > MAX_RESET_TIME_MS) return "invalid";
      window.resetTimeIso = new Date(reset).toISOString();
    }
    windows.set(key, window);
  }
  return [...windows.values()];
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
  const envelopeFailure = errorEnvelopeFailure(record, USAGE_SPAWN_KINDS);
  if (envelopeFailure) return envelopeFailure;

  const windows = parseWindows(record);
  if (windows === "invalid") return fail("invalid_schema");
  // The CLI's own flag says whether any window carried a usage ratio. A CLI older than
  // bailian-cli 2.7.1 sends no flag, and then the windows themselves say it.
  const hasQuotaData = record.hasQuotaData;
  if (hasQuotaData !== undefined && typeof hasQuotaData !== "boolean") {
    return fail("invalid_schema");
  }
  return {
    ok: true,
    windows,
    ...(hasQuotaData !== undefined ? { hasQuotaData } : {}),
  };
}

function requestCount(value: unknown): number | undefined {
  const count = finiteNumber(value);
  return count !== undefined && count >= 0 ? count : undefined;
}

/** `percentage` is not read: `bl` derives it from the two counts, and deriving it here keeps one
 * owner, so a row's percent can never disagree with its used and limit. A window without a positive
 * limit has no quota to show. */
function parseCodingPlanWindow(value: unknown): AlibabaCodingPlanWindow | undefined | "invalid" {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) return "invalid";
  const used = requestCount(record.usedQuota);
  const limit = requestCount(record.totalQuota);
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  const reset = finiteNumber(record.resetTime);
  const resetTimeIso =
    reset !== undefined && reset > 0 && reset <= MAX_RESET_TIME_MS
      ? new Date(reset).toISOString()
      : undefined;
  return {
    used,
    limit,
    // A used count above the limit is the console's own overrun, not a negative quota.
    percentRemaining: Math.min(100, Math.max(0, 100 - (used / limit) * 100)),
    ...(resetTimeIso !== undefined ? { resetTimeIso } : {}),
  };
}

/** `{ per5Hour, perWeek, perBillMonth }`. `{}` is the CLI's "this account has no Coding Plan" and
 * stays a silent absence; a window the plan does not cover has no quota and no row. */
export function parseAlibabaCodingPlanUsageJson(text: string): AlibabaCodingPlanResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  const record = asRecord(payload);
  if (!record) return fail("coding_plan_invalid_schema");
  const envelopeFailure = errorEnvelopeFailure(record, CODING_PLAN_SPAWN_KINDS);
  if (envelopeFailure) return envelopeFailure;

  const fiveHour = parseCodingPlanWindow(record.per5Hour);
  const weekly = parseCodingPlanWindow(record.perWeek);
  const monthly = parseCodingPlanWindow(record.perBillMonth);
  if (fiveHour === "invalid" || weekly === "invalid" || monthly === "invalid") {
    return fail("coding_plan_invalid_schema");
  }
  if (!fiveHour && !weekly && !monthly) return { ok: true };
  return {
    ok: true,
    usage: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
      ...(monthly ? { monthly } : {}),
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

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
 * Run the CLI without a shell or a Windows console window, with stdin ignored and stdout/stderr
 * capped. A timeout or an overflow sends SIGTERM to the process group, then SIGKILL after
 * `killGraceMs`.
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
        // OpenCode is a GUI process and `bl` is a console program, so without this every check
        // opens a window. A launcher that spawns node itself (bun's global shim) still opens one,
        // so the shim route resolves to node when it can.
        windowsHide: true,
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
      // `close` waits on the stdout pipe, which a killed child's grandchild may still hold, so a
      // timed-out check could never answer and the store's read timeout would key the rows under
      // `memory-`. Answer here once escalated: `timedOut` is set, so this reads as a timeout.
      killTimer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        finish(null);
      }, request.killGraceMs);
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

    function finish(code: number | null, spawnErrorCode?: string, complete = false): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (complete) {
        // Drop the pipes and unref the dying child, so it cannot keep the parent's event loop alive.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      } else {
        clearTimeout(killTimer);
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
        truncated,
        ...(complete ? { complete: true } : {}),
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);

    /** `bl` holds its HTTPS connection open after answering, so a whole document in the pipe ends the
     * wait without an exit code; a failure document is left to the parser, an incomplete one falls
     * through to the timeout. */
    function wholeDocument(): boolean {
      if (settled || timedOut || truncated) return false;
      const text = Buffer.concat(stdoutChunks).toString("utf8");
      if (!text.trim()) return false;
      try {
        JSON.parse(text);
      } catch {
        return false;
      }
      return true;
    }

    const collectStdout = collect(stdoutChunks, request.stdoutLimitBytes);
    child.stdout?.on("data", (chunk) => {
      collectStdout(chunk);
      if (wholeDocument()) {
        signalProcessGroup(child, "SIGKILL");
        finish(null, undefined, true);
      }
    });
    child.stderr?.on("data", collect(stderrChunks, request.stderrLimitBytes));
    child.on("error", (error) => finish(null, errorCode(error)));
    child.on("close", (code) => finish(code));
  });
}

/** How a finished child maps to a failure. The commands differ only in kind: exit 3 names a
 * different credential each time. */
function mapSpawnResult(
  result: AlibabaTokenPlanSpawnResult,
  kinds: { auth: AlibabaErrorKind; nonzero: AlibabaErrorKind },
): AlibabaFailure | null {
  if (result.truncated) return fail("output_truncated");
  // A child stopped on a whole document leaves `code` null, which `!== 0` would fail every time.
  if (result.complete) return null;
  if (result.timedOut) return fail("timeout");
  if (result.spawnErrorCode === "ENOENT") return fail("executable_not_found");
  if (result.spawnErrorCode) return fail("spawn_failed");
  // The CLI writes its failure envelope to stderr, so the words that say what to do are only there.
  if (result.code === AUTH_EXIT_CODE) {
    return stderrEnvelopeFailure(result.stderr, kinds.auth) ?? fail(kinds.auth);
  }
  if (result.code !== 0) {
    return stderrEnvelopeFailure(result.stderr, kinds.nonzero) ?? fail(kinds.nonzero);
  }
  return null;
}

export const USAGE_SPAWN_KINDS = {
  auth: "not_authenticated",
  nonzero: "nonzero_exit",
} as const satisfies { auth: AlibabaErrorKind; nonzero: AlibabaErrorKind };

const SEAT_SPAWN_KINDS = {
  auth: "seat_not_authenticated",
  nonzero: "seat_command_failed",
} as const satisfies { auth: AlibabaErrorKind; nonzero: AlibabaErrorKind };

/** The Coding Plan reads the same console session as the personal plan, so exit 3 means the same. */
export const CODING_PLAN_SPAWN_KINDS = {
  auth: "not_authenticated",
  nonzero: "coding_plan_command_failed",
} as const satisfies { auth: AlibabaErrorKind; nonzero: AlibabaErrorKind };

/** One `NORMAL` team seat, or undefined for a `RELEASE` seat or one that cannot be keyed. A
 * `RELEASE` seat counts toward `Data.Total` but carries no `Cycle*` field, so `Status` is read
 * before `EquityList`. */
function parseSeat(value: unknown): AlibabaTokenPlanSeat | undefined {
  const record = asRecord(value);
  if (!record || record.Status !== "NORMAL") return undefined;
  const name = nonEmptyString(record.AccountName);
  if (!name) return undefined;

  const equity = Array.isArray(record.EquityList) ? asRecord(record.EquityList[0]) : null;
  const total = equity ? finiteNumber(equity.CycleTotalValue) : undefined;
  const surplus = equity ? finiteNumber(equity.CycleSurplusValue) : undefined;
  const percentRemaining =
    total !== undefined && total > 0 && surplus !== undefined
      ? Math.min(100, Math.max(0, (surplus / total) * 100))
      : undefined;
  // Computed beside the percentage so the two cannot drift; the floor keeps a surplus above the
  // total from reporting negative spend.
  const used =
    total !== undefined && surplus !== undefined ? Math.max(0, total - surplus) : undefined;
  const endTime = equity ? finiteNumber(equity.CycleEndTime) : undefined;
  const resetsAt =
    endTime !== undefined && endTime > 0 && endTime <= MAX_RESET_TIME_MS
      ? new Date(endTime).toISOString()
      : undefined;
  // A seat's cycle is not a calendar month, so the row's pace needs when the window began.
  const startTime = equity ? finiteNumber(equity.CycleStartTime) : undefined;
  const startedAt =
    startTime !== undefined && startTime > 0 && startTime < MAX_RESET_TIME_MS
      ? new Date(startTime).toISOString()
      : undefined;

  return {
    name,
    ...(surplus !== undefined ? { surplus } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(percentRemaining !== undefined ? { percentRemaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

type AlibabaTokenPlanSeatPage =
  | { ok: true; seats: AlibabaTokenPlanSeat[]; itemCount: number; total?: number }
  | AlibabaFailure;

/** `bl`'s failure envelope `{ error: { code, message, hint } }` inside a successful reply. Its
 * `code` is the CLI's exit code, the only signal trusted for the kind. */
function errorEnvelopeFailure(
  record: Record<string, unknown>,
  kinds: { auth: AlibabaErrorKind; nonzero: AlibabaErrorKind },
): AlibabaFailure | null {
  const envelope = asRecord(record.error);
  if (!envelope) return null;
  const kind = finiteNumber(envelope.code) === AUTH_EXIT_CODE ? kinds.auth : kinds.nonzero;
  return envelopeFailure(envelope, kind);
}

/** The CLI's own words, kept because they say what to do; redacted and cut, since they are the
 * server's to write. */
function envelopeFailure(
  envelope: Record<string, unknown>,
  kind: AlibabaErrorKind,
): AlibabaFailure {
  const said = publicDetail(
    [nonEmptyString(envelope.message), nonEmptyString(envelope.hint)].filter(Boolean).join(" "),
    ALIBABA_TOKEN_PLAN_ERROR_MAX_LENGTH,
  );
  const exitCode = finiteNumber(envelope.code);
  return {
    ok: false,
    error: {
      kind,
      message: said || ERROR_MESSAGES[kind],
      ...(exitCode === undefined
        ? {}
        : { facts: { code: EXIT_CODE_ERROR_CODES[exitCode] ?? "provider_error" } }),
    },
  };
}

/** The envelope where it really arrives: on stderr with an empty stdout, on the exit code it carries. */
function stderrEnvelopeFailure(stderr: Buffer, kind: AlibabaErrorKind): AlibabaFailure | null {
  const text = stderr.toString("utf8").trim();
  if (!text) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(payload);
  const envelope = record ? asRecord(record.error) : undefined;
  return envelope ? envelopeFailure(envelope, kind) : null;
}

function parseAlibabaTokenPlanSeatPage(text: string): AlibabaTokenPlanSeatPage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  const record = asRecord(payload);
  if (!record) return fail("seat_invalid_schema");
  const seatFailure = errorEnvelopeFailure(record, SEAT_SPAWN_KINDS);
  if (seatFailure) return seatFailure;
  const data = asRecord(record.Data);
  if (!data) return fail("seat_invalid_schema");
  const items = Array.isArray(data.Items) ? data.Items : [];
  const total = finiteNumber(data.Total);
  return {
    ok: true,
    seats: items.flatMap((item) => {
      const seat = parseSeat(item);
      return seat ? [seat] : [];
    }),
    itemCount: items.length,
    ...(total !== undefined ? { total } : {}),
  };
}

export function parseAlibabaTokenPlanSeatsJson(text: string): AlibabaTokenPlanSeatResult {
  const page = parseAlibabaTokenPlanSeatPage(text);
  return page.ok ? { ok: true, seats: page.seats } : page;
}

function mapSeatSpawnResult(result: AlibabaTokenPlanSpawnResult): AlibabaTokenPlanSeatPage {
  return (
    mapSpawnResult(result, SEAT_SPAWN_KINDS) ??
    parseAlibabaTokenPlanSeatPage(result.stdout.toString("utf8"))
  );
}

/** The child gets exactly one PATH: the filtered list. Windows reads environment names without case
 * and a parent can carry both `Path` and `PATH`, so every case variant is dropped first. */
function envWithTrustedPath(
  env: NodeJS.ProcessEnv,
  trusted: readonly string[],
  paths: path.PlatformPath,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === "path") continue;
    result[name] = value;
  }
  result.PATH = trusted.join(paths.delimiter);
  return result;
}

type AlibabaTokenPlanInvocation = {
  ok: true;
  file: string;
  prefixArgs: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: (request: AlibabaTokenPlanSpawnRequest) => Promise<AlibabaTokenPlanSpawnResult>;
};

async function resolveAlibabaTokenPlanInvocation(
  runtime: AlibabaTokenPlanRuntime,
): Promise<AlibabaTokenPlanInvocation | AlibabaFailure> {
  const platform = runtime.platform ?? process.platform;
  if (!isAlibabaTokenPlanSupportedPlatform(platform)) return fail("unsupported_platform");

  const paths = pathModuleFor(platform);
  const cwd = paths.resolve(runtime.cwd);
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
      .map((candidate) => paths.resolve(candidate))
      .find((candidate) => !isPathInside(paths, cwd, candidate)) ?? paths.parse(cwd).root;
  return {
    ok: true,
    file: resolved.file,
    prefixArgs: resolved.args ?? [],
    cwd: processCwd,
    env: envWithTrustedPath(
      runtime.env ?? process.env,
      listTrustedPathDirectories(paths, pathEnv, await untrustedProjectFolders(paths, cwd, home)),
      paths,
    ),
    spawn: runtime.spawn ?? runAlibabaTokenPlanProcess,
  };
}

function spawnRequestFor(
  invocation: AlibabaTokenPlanInvocation,
  args: readonly string[],
  timeoutMs: number,
): AlibabaTokenPlanSpawnRequest {
  return {
    file: invocation.file,
    args: [...invocation.prefixArgs, ...args],
    cwd: invocation.cwd,
    env: invocation.env,
    timeoutMs,
    stdoutLimitBytes: ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    killGraceMs: ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
  };
}

/** The kinds a command's own failures report: exit 3 names the credential that command needs. */
export type AlibabaSpawnKinds = { auth: AlibabaErrorKind; nonzero: AlibabaErrorKind };

type AlibabaReply = { ok: true; text: string } | AlibabaFailure;

/** A failure envelope inside a successful stdout is left to the command's own parser. */
export async function queryAlibabaReply(options: {
  args: readonly string[];
  kinds: AlibabaSpawnKinds;
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaReply> {
  const timeoutMs = options.requestTimeoutMs ?? ALIBABA_TOKEN_PLAN_REQUEST_TIMEOUT_MS;
  const invocation = await resolveAlibabaTokenPlanInvocation(options.runtime);
  if (!invocation.ok) return invocation;
  try {
    const result = await invocation.spawn(spawnRequestFor(invocation, options.args, timeoutMs));
    const failure = mapSpawnResult(result, options.kinds);
    return failure ?? { ok: true, text: result.stdout.toString("utf8") };
  } catch {
    return fail("spawn_failed");
  }
}

export async function queryAlibabaTokenPlanQuota(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaTokenPlanClosedResult> {
  const reply = await queryAlibabaReply({
    args: ALIBABA_TOKEN_PLAN_ARGS,
    kinds: USAGE_SPAWN_KINDS,
    requestTimeoutMs: options.requestTimeoutMs,
    runtime: options.runtime,
  });
  return reply.ok ? parseAlibabaTokenPlanUsageJson(reply.text) : reply;
}

/** The masked credential markers `bl auth status` reports, each `null` when absent so it cannot
 * collide with a present credential. `bl` already masks them; they never reach a user, log or
 * export. */
export type AlibabaCredentialMarkers = {
  consoleMasked: string | null;
  apiKeyMasked: string | null;
  openapiAccessKeyId: string | null;
};

/** `null` is a read that failed; a reply naming no credential is markers that are all `null`. With
 * no marker there is nothing to key an account on, so the caller keeps those rows in memory only. */
function parseAlibabaCredentialMarkers(text: string): AlibabaCredentialMarkers | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(payload);
  // A failure envelope says nothing about which credentials are set up.
  if (!record || asRecord(record.error)) return null;
  const consoleRecord = asRecord(record.console);
  const apiKeyRecord = asRecord(record.api_key);
  const openapiRecord = asRecord(record.openapi);
  const markers: AlibabaCredentialMarkers = {
    consoleMasked: (consoleRecord ? nonEmptyString(consoleRecord.masked) : undefined) ?? null,
    apiKeyMasked: (apiKeyRecord ? nonEmptyString(apiKeyRecord.masked) : undefined) ?? null,
    openapiAccessKeyId:
      (openapiRecord ? nonEmptyString(openapiRecord.access_key_id) : undefined) ?? null,
  };
  return markers;
}

/** A half whose credential block is absent was never set up, so it is left out entirely: no rows,
 * no errors, no backoff. A block `bl` reports is a set-up session, expired or not, so its failure is
 * real; a failed read reports both halves, since absence cannot be told from failure there. */
export function alibabaCredentialHalves(markers: AlibabaCredentialMarkers | null): {
  console: boolean;
  openapi: boolean;
} {
  if (markers === null) return { console: true, openapi: true };
  return {
    console: markers.consoleMasked !== null,
    openapi: markers.openapiAccessKeyId !== null,
  };
}

const ALIBABA_TOKEN_PLAN_IDENTITY_TTL_MS = 60_000;

/** The read in flight, or the last markers read with when it started. The promise is held, not its
 * value, so a caller arriving mid-read joins that read instead of spawning its own. */
let consoleIdentityCache: {
  timestamp: number;
  value: Promise<AlibabaCredentialMarkers | null>;
  inFlight: boolean;
} | null = null;

/** The markers `bl auth status` reports, read through the same machinery as the quota commands. One
 * read is reused for ALIBABA_TOKEN_PLAN_IDENTITY_TTL_MS and a mid-flight caller joins it. A `fresh`
 * caller joins nothing and starts its own read: a fetch reads its markers after its commands, so an
 * earlier read cannot hide a switch made while they ran, and the store's re-check reuses them. */
export async function resolveAlibabaIdentity(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
  fresh?: boolean;
}): Promise<AlibabaCredentialMarkers | null> {
  const cached = consoleIdentityCache;
  if (
    cached !== null &&
    !options.fresh &&
    (cached.inFlight || Date.now() - cached.timestamp < ALIBABA_TOKEN_PLAN_IDENTITY_TTL_MS)
  ) {
    return await cached.value;
  }
  const reading = loadConsoleIdentity(options);
  const entry = { timestamp: Date.now(), value: reading, inFlight: true };
  consoleIdentityCache = entry;
  try {
    return await reading;
  } catch (error) {
    // A rejected read must not stay cached, or every later caller inherits the failure.
    if (consoleIdentityCache === entry) consoleIdentityCache = null;
    throw error;
  } finally {
    entry.inFlight = false;
  }
}

export function clearAlibabaIdentityCacheForTests(): void {
  consoleIdentityCache = null;
}

async function loadConsoleIdentity(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaCredentialMarkers | null> {
  const timeoutMs = options.requestTimeoutMs ?? ALIBABA_TOKEN_PLAN_REQUEST_TIMEOUT_MS;
  const invocation = await resolveAlibabaTokenPlanInvocation(options.runtime);
  if (!invocation.ok) return null;
  try {
    const result = await invocation.spawn(
      spawnRequestFor(invocation, ALIBABA_TOKEN_PLAN_AUTH_STATUS_ARGS, timeoutMs),
    );
    // Only whether the spawn failed matters here; the kind is a quota command's wording.
    if (mapSpawnResult(result, USAGE_SPAWN_KINDS)) return null;
    return parseAlibabaCredentialMarkers(result.stdout.toString("utf8"));
  } catch {
    return null;
  }
}

function seatArgsForPage(base: readonly string[], pageNo: number): readonly string[] {
  return pageNo === 1 ? base : [...base, "--page-no", String(pageNo)];
}

/** The team seats, one page at a time. `Total` counts every status, so the loop compares the raw
 * item count against it; a reply without `Total` stops on a short page. */
export async function queryAlibabaTokenPlanSeats(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaTokenPlanSeatResult> {
  const timeoutMs = options.requestTimeoutMs ?? ALIBABA_TOKEN_PLAN_REQUEST_TIMEOUT_MS;
  const invocation = await resolveAlibabaTokenPlanInvocation(options.runtime);
  if (!invocation.ok) return invocation;

  const seats: AlibabaTokenPlanSeat[] = [];
  let itemCount = 0;
  let more = true;
  // One deadline for the loop: a per-page timeout cannot bound 50 pages, and overrunning the store's
  // budget discards the whole provider fetch, the personal row included.
  const deadline = Date.now() + ALIBABA_TOKEN_PLAN_SEAT_BUDGET_MS;
  for (let pageNo = 1; pageNo <= ALIBABA_TOKEN_PLAN_SEAT_MAX_PAGES; pageNo += 1) {
    // The budget is the whole loop's, so a page gets what is left. A list cut short cannot be told from
    // a whole one, so the seats are reported as failed rather than as a roster quietly missing seats.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail("timeout");
    let page: AlibabaTokenPlanSeatPage;
    try {
      page = mapSeatSpawnResult(
        await invocation.spawn(
          spawnRequestFor(
            invocation,
            seatArgsForPage(ALIBABA_TOKEN_PLAN_SEAT_ARGS, pageNo),
            Math.min(timeoutMs, remaining),
          ),
        ),
      );
    } catch {
      return fail("spawn_failed");
    }
    if (!page.ok) return page;
    seats.push(...page.seats);
    itemCount += page.itemCount;
    // A page that adds no items can never reach Total, and 50 timeouts would exhaust the store's budget.
    more =
      page.itemCount > 0 &&
      (page.total === undefined
        ? page.itemCount >= ALIBABA_TOKEN_PLAN_SEAT_PAGE_SIZE
        : itemCount < page.total);
    if (!more) break;
  }
  // Pages still left at the cap: a roster missing seats is reported as failed, like a timeout.
  if (more) return fail("seat_command_failed");
  return { ok: true, seats };
}
