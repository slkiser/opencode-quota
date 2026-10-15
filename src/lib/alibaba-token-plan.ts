/**
 * Alibaba Token Plan quota from the official `bl` CLI, whose production invocations are exactly:
 *   bl usage token-plan --output json                        (console; the personal monthly window)
 *   bl token-plan list-seats --status NORMAL --query-assigned true --page-size 100 --output json
 *                                                            (OpenAPI; team seats)
 * Console auth belongs to the CLI: this module never installs `bl`, logs in, reads credential
 * stores or uses a shell, and takes POSIX or win32 path semantics from the platform it targets.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { asRecord, finiteNumber, nonEmptyString } from "./json-guards.js";

const ALIBABA_TOKEN_PLAN_COMMAND = "bl";
const ALIBABA_TOKEN_PLAN_ARGS = ["usage", "token-plan", "--output", "json"] as const;
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

export type AlibabaTokenPlanWindow = {
  percentRemaining: number;
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
  /** `total - surplus`, floored at 0; only when both are reported. */
  used?: number;
  resetsAt?: string;
  startedAt?: string;
};

export type AlibabaTokenPlanSeatResult =
  | { ok: true; seats: AlibabaTokenPlanSeat[] }
  | AlibabaTokenPlanFailure;

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
  | "seat_not_authenticated"
  | "seat_command_failed"
  | "seat_invalid_schema"
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
      /** Set when `file` is `node`: `[entry, ...ALIBABA_TOKEN_PLAN_ARGS]`; callers slice that tail
       * off, so it must stay exactly `ALIBABA_TOKEN_PLAN_ARGS`. */
      args?: readonly string[];
    }
  | AlibabaTokenPlanFailure;

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
  unsupported_platform: "Alibaba Token Plan is not supported on this platform.",
  executable_not_found: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
  shell_launcher_rejected:
    "Alibaba Token Plan refused a shell launcher for bl. Install it with `npm install -g bailian-cli`, whose shim resolves to the package's node entry.",
  workspace_path_rejected: "Alibaba Token Plan ignored workspace and relative PATH entries.",
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
  invalid_json: "Alibaba Cloud CLI did not return valid JSON.",
  invalid_schema: "Alibaba Cloud CLI returned an invalid Alibaba Token Plan payload.",
};

/** A reply without a monthly percentage. `bl` renders that case as an unlimited limit, and a CLI
 * older than bailian-cli 2.2.0 produces it too, so the hint names the CLI's own wording. */
export const NO_WINDOW_HINT =
  "no monthly percentage in the reply; the limit may be unlimited — verify in the Bailian Token Plan console";

function fail(kind: AlibabaTokenPlanErrorKind): AlibabaTokenPlanFailure {
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

/**
 * The folder whose PATH entries and executables are not trusted: the project folder quota is
 * computed for. For OpenCode opened at the home folder, and for the terminal command, that is
 * the home folder. The home folder is not a project, so it gives none.
 */
function untrustedProjectFolder(
  paths: path.PlatformPath,
  cwd: string,
  home: string | undefined,
): string | null {
  const resolved = paths.resolve(cwd);
  return resolved === paths.resolve(home ?? homedir()) ? null : resolved;
}

/** Absolute PATH directories outside the project folder, deduplicated, in PATH order. */
function listTrustedPathDirectories(
  paths: path.PlatformPath,
  pathEnv: string | undefined,
  cwd: string,
  home: string | undefined,
): string[] {
  const projectFolder = untrustedProjectFolder(paths, cwd, home);
  const trusted = new Set<string>();
  for (const rawEntry of (pathEnv ?? "").split(paths.delimiter)) {
    const entry = stripPathQuotes(rawEntry);
    if (!paths.isAbsolute(entry)) continue;
    const resolved = paths.resolve(entry);
    if (projectFolder !== null && isPathInside(paths, projectFolder, resolved)) continue;
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

/** True for a regular file, following symlinks; false when missing or broken. */
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
    // Only a package that declares this shim's own command may be adopted.
    if (!binRecord || !Object.hasOwn(binRecord, shimCommand)) return null;
    relative = nonEmptyString(binRecord[shimCommand]);
  }
  if (!relative) return null;

  const entry = paths.join(packageRoot, relative);
  return (await isRegularFile(entry)) ? entry : null;
}

/** The node that runs a shim's entry: resolved as `bl` is, so `bl` and node come from one install. */
async function resolveNodeExecutable(
  paths: path.PlatformPath,
  platform: NodeJS.Platform,
  trusted: readonly string[],
): Promise<string> {
  const name = platform === "win32" ? "node.exe" : "node";
  for (const directory of trusted) {
    const candidate = paths.join(directory, name);
    if (await isRegularFile(candidate)) return candidate;
  }
  return process.execPath;
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
  const projectFolder = untrustedProjectFolder(paths, params.cwd, params.homedir);
  const trusted = listTrustedPathDirectories(
    paths,
    params.pathEnv ?? process.env.PATH,
    params.cwd,
    params.homedir,
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
          !(projectFolder !== null && isPathInside(paths, projectFolder, resolved))
        ) {
          const entry = await resolveNodeShim(paths, candidate, SHIM_PACKAGE_NAME);
          if (entry !== null) {
            return {
              ok: true,
              file: await resolveNodeExecutable(paths, platform, trusted),
              args: [entry, ...ALIBABA_TOKEN_PLAN_ARGS],
            };
          }
        }
        sawShellLauncher = true;
        continue;
      }
      if (projectFolder !== null && isPathInside(paths, projectFolder, resolved)) {
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

/** A timeout or an overflow stops the process group: SIGTERM, then SIGKILL after `killGraceMs`. */
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
      clearTimeout(killTimer);
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

    /**
     * `bl` keeps running after it has answered: it waits on an npm update check it fires once a
     * day, against a registry with no mirror, and only then exits. The answer is already in the
     * pipe, so a whole document ends the wait. Exit-code failures still need the real code, and
     * a document that never completes falls through to the timeout.
     */
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
        // The CLI keeps its own socket open after it has answered, so it is killed outright.
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
  kinds: { auth: AlibabaTokenPlanErrorKind; nonzero: AlibabaTokenPlanErrorKind },
): AlibabaTokenPlanFailure | null {
  if (result.truncated) return fail("output_truncated");
  // A child stopped on a whole document leaves `code` null, which `!== 0` would fail every time.
  if (result.complete) return null;
  if (result.timedOut) return fail("timeout");
  if (result.spawnErrorCode === "ENOENT") return fail("executable_not_found");
  if (result.spawnErrorCode) return fail("spawn_failed");
  if (result.code === AUTH_EXIT_CODE) return fail(kinds.auth);
  if (result.code !== 0) return fail(kinds.nonzero);
  return null;
}

export const USAGE_SPAWN_KINDS = {
  auth: "not_authenticated",
  nonzero: "nonzero_exit",
} as const satisfies { auth: AlibabaTokenPlanErrorKind; nonzero: AlibabaTokenPlanErrorKind };

const SEAT_SPAWN_KINDS = {
  auth: "seat_not_authenticated",
  nonzero: "seat_command_failed",
} as const satisfies { auth: AlibabaTokenPlanErrorKind; nonzero: AlibabaTokenPlanErrorKind };

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

/** One page: the parsed seats, the raw item count, and the reply's own `Total`. */
type AlibabaTokenPlanSeatPage =
  | { ok: true; seats: AlibabaTokenPlanSeat[]; itemCount: number; total?: number }
  | AlibabaTokenPlanFailure;

/** The seat command's reply `{ Success, Data: { Items, PageNo, PageSize, Total } }`. `Total` counts
 * every status, so the loop compares the raw item count against it. */
function parseAlibabaTokenPlanSeatPage(text: string): AlibabaTokenPlanSeatPage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
  const record = asRecord(payload);
  if (!record) return fail("seat_invalid_schema");
  if (asRecord(record.error)) return fail("seat_not_authenticated");
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

/** Everything needed to spawn `bl`: the executable, its argv prefix, a cwd outside the project and
 * the trusted-PATH environment. Callers append their own command to `prefixArgs`. */
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
): Promise<AlibabaTokenPlanInvocation | AlibabaTokenPlanFailure> {
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
  const resolvedArgs = resolved.args ?? [];
  return {
    ok: true,
    file: resolved.file,
    // The shim route appends the personal fixed arguments; drop them for this caller's own command.
    prefixArgs: resolvedArgs.slice(0, resolvedArgs.length - ALIBABA_TOKEN_PLAN_ARGS.length),
    cwd: processCwd,
    env: envWithTrustedPath(
      runtime.env ?? process.env,
      listTrustedPathDirectories(paths, pathEnv, cwd, home),
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

/** The personal window `bl usage token-plan` reports, or why it could not be read. */
export async function queryAlibabaTokenPlanQuota(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaTokenPlanClosedResult> {
  const timeoutMs = options.requestTimeoutMs ?? ALIBABA_TOKEN_PLAN_REQUEST_TIMEOUT_MS;
  const invocation = await resolveAlibabaTokenPlanInvocation(options.runtime);
  if (!invocation.ok) return invocation;
  try {
    const result = await invocation.spawn(
      spawnRequestFor(invocation, ALIBABA_TOKEN_PLAN_ARGS, timeoutMs),
    );
    const failure = mapSpawnResult(result, USAGE_SPAWN_KINDS);
    return failure ?? parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"));
  } catch {
    return fail("spawn_failed");
  }
}

function seatArgsForPage(pageNo: number): readonly string[] {
  return pageNo === 1
    ? ALIBABA_TOKEN_PLAN_SEAT_ARGS
    : [...ALIBABA_TOKEN_PLAN_SEAT_ARGS, "--page-no", String(pageNo)];
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
          spawnRequestFor(invocation, seatArgsForPage(pageNo), Math.min(timeoutMs, remaining)),
        ),
      );
    } catch {
      return fail("spawn_failed");
    }
    if (!page.ok) return page;
    seats.push(...page.seats);
    itemCount += page.itemCount;
    const more =
      page.total === undefined
        ? page.itemCount >= ALIBABA_TOKEN_PLAN_SEAT_PAGE_SIZE
        : itemCount < page.total;
    if (!more) break;
  }
  return { ok: true, seats };
}
