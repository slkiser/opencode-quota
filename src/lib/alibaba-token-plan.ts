/**
 * Alibaba Personal Token Plan quota from the official `bl` CLI, whose production invocation is
 * exactly:
 *   bl usage token-plan --output json          (console; the personal monthly window)
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
  unsupported_platform: "Alibaba Personal Token Plan is not supported on this platform.",
  executable_not_found: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
  shell_launcher_rejected:
    "Alibaba Personal Token Plan refused a shell launcher for bl. Install it with `npm install -g bailian-cli`, whose shim resolves to the package's node entry.",
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

function mapSpawnResult(result: AlibabaTokenPlanSpawnResult): AlibabaTokenPlanClosedResult {
  if (result.truncated) return fail("output_truncated");
  if (result.timedOut) return fail("timeout");
  if (result.spawnErrorCode === "ENOENT") return fail("executable_not_found");
  if (result.spawnErrorCode) return fail("spawn_failed");
  if (result.code === AUTH_EXIT_CODE) return fail("not_authenticated");
  if (result.code !== 0) return fail("nonzero_exit");
  return parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"));
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

/** The personal window `bl usage token-plan` reports, or why it could not be read. */
export async function queryAlibabaTokenPlanQuota(options: {
  requestTimeoutMs?: number;
  runtime: AlibabaTokenPlanRuntime;
}): Promise<AlibabaTokenPlanClosedResult> {
  const runtime = options.runtime;
  const platform = runtime.platform ?? process.platform;
  if (!isAlibabaTokenPlanSupportedPlatform(platform)) {
    return fail("unsupported_platform");
  }

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
  const request: AlibabaTokenPlanSpawnRequest = {
    file: resolved.file,
    args: resolved.args ?? ALIBABA_TOKEN_PLAN_ARGS,
    cwd: processCwd,
    env: envWithTrustedPath(
      runtime.env ?? process.env,
      listTrustedPathDirectories(paths, pathEnv, cwd, home),
      paths,
    ),
    timeoutMs: options.requestTimeoutMs ?? ALIBABA_TOKEN_PLAN_REQUEST_TIMEOUT_MS,
    stdoutLimitBytes: ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    killGraceMs: ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
  };
  const run = runtime.spawn ?? runAlibabaTokenPlanProcess;
  try {
    const result = await run(request);
    // The early exit stops the child once it has written a whole document, so there is no exit
    // code left to read: what it wrote is the answer, and the parser turns a failure envelope
    // inside it into the right kind.
    if (result.complete) return parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"));
    return mapSpawnResult(result);
  } catch {
    return fail("spawn_failed");
  }
}
