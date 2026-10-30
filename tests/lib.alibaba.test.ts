import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type AlibabaTokenPlanSpawnRequest,
  alibabaCredentialHalves,
  clearAlibabaIdentityCacheForTests,
  ERROR_MESSAGES,
  isAlibabaTokenPlanSupportedPlatform,
  parseAlibabaCodingPlanUsageJson,
  parseAlibabaTokenPlanSeatsJson,
  parseAlibabaTokenPlanUsageJson,
  queryAlibabaTokenPlanQuota,
  queryAlibabaTokenPlanSeats,
  resolveAlibabaTokenPlanExecutable,
  resolveAlibabaIdentity,
  runAlibabaTokenPlanProcess,
} from "../src/lib/alibaba.js";

// The `bl` CLI contract, written out by hand so a changed production constant fails here.
const BL_COMMAND = "bl";
const BL_ARGS = ["usage", "token-plan", "--output", "json"];
const BL_SEAT_ARGS = [
  "token-plan",
  "list-seats",
  "--status",
  "NORMAL",
  "--query-assigned",
  "true",
  "--page-size",
  "100",
  "--output",
  "json",
];
const SEAT_PAGE_SIZE = 100;
const STDOUT_LIMIT_BYTES = 262_144;
const STDERR_LIMIT_BYTES = 16_384;
const KILL_GRACE_MS = 250;

// `bl`'s seat failure envelope: measured on 2.3.0 it arrives on stderr with an empty stdout and
// exit 3. Fed straight to the parser, since that branch also guards a stdout carrier.
const SEAT_ENVELOPE_HINT =
  "Set ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET, pass --access-key-id and --access-key-secret, or run `bl auth login --open-api`.";
/** The one message the report carries: the envelope's own sentence, then its hint. */
const SEAT_ENVELOPE_MESSAGE = `No OpenAPI AK/SK credentials found. ${SEAT_ENVELOPE_HINT}`;
const REAL_SEAT_ERROR_ENVELOPE = JSON.stringify({
  error: {
    code: 3,
    message: "No OpenAPI AK/SK credentials found.",
    hint: SEAT_ENVELOPE_HINT,
  },
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: vi.fn(fs.stat),
    realpath: vi.fn(fs.realpath),
    readFile: vi.fn(fs.readFile),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

const created: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(stat).mockReset();
  vi.mocked(realpath).mockReset();
  vi.mocked(readFile).mockReset();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alibaba-token-plan-"));
  created.push(dir);
  return dir;
}

async function writeUnixExecutable(
  directory: string,
  name: string,
  source: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, source, { encoding: "utf8", mode: 0o755 });
  return file;
}

async function mockExecutable(file = "/trusted/bin/bl", target = file): Promise<void> {
  const stats = await stat(process.execPath);
  vi.mocked(stat).mockImplementation(async (candidate) => {
    if (candidate === file || candidate === target) return stats;
    throw new Error("Executable does not exist");
  });
  vi.mocked(realpath).mockImplementation(async (candidate) =>
    candidate === file ? target : String(candidate),
  );
}

/** Fake win32 filesystem; `path.win32` keys keep these cases runnable on a POSIX runner too.
 * `links` maps a path to the real path a link or junction resolves it to. */
async function mockWin32Files(
  files: Record<string, string>,
  links: Record<string, string> = {},
): Promise<void> {
  const stats = await stat(process.execPath);
  vi.mocked(stat).mockImplementation(async (candidate) => {
    if (String(candidate) in files) return stats;
    throw new Error("File does not exist");
  });
  vi.mocked(realpath).mockImplementation(
    async (candidate) => links[String(candidate)] ?? String(candidate),
  );
  vi.mocked(readFile).mockImplementation(async (candidate) => {
    const contents = files[String(candidate)];
    if (contents === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return contents;
  });
}

function capturedSpawn(requests: AlibabaTokenPlanSpawnRequest[]) {
  return async (request: AlibabaTokenPlanSpawnRequest) => {
    requests.push(request);
    return {
      code: 0,
      stdout: Buffer.from(
        JSON.stringify({
          per1MonthPercentage: 0.25,
          per1MonthResetTime: 1_714_000_000_000,
        }),
      ),
      stderr: Buffer.alloc(0),
      timedOut: false,
      truncated: false,
    };
  };
}

function spawnRequest(
  file: string,
  overrides: Partial<AlibabaTokenPlanSpawnRequest> = {},
): AlibabaTokenPlanSpawnRequest {
  return {
    file,
    args: BL_ARGS,
    cwd: path.dirname(file),
    env: {
      PATH: `${path.dirname(file)}${path.delimiter}${path.dirname(process.execPath)}`,
    },
    timeoutMs: 5_000,
    stdoutLimitBytes: STDOUT_LIMIT_BYTES,
    stderrLimitBytes: STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    killGraceMs: KILL_GRACE_MS,
    ...overrides,
  };
}

/** The runtime every `bl` case shares, so only the spawn and the env a case proves are its own. */
function linuxRuntime(spawn: (request: AlibabaTokenPlanSpawnRequest) => Promise<unknown>) {
  return {
    platform: "linux" as const,
    pathEnv: "/trusted/bin",
    cwd: "/workspace",
    tmpdir: "/safe-tmp",
    homedir: "/safe-home",
    spawn: spawn as never,
  };
}

const SEAT_RESET_AT = 1_792_742_400_000;

/** The page envelope's items, plus the Total the paging loop compares against; nothing else is read. */
function seatEnvelope(items: unknown[], total?: number): string {
  return JSON.stringify({
    Success: true,
    Data: { Items: items, ...(total === undefined ? {} : { Total: total }) },
  });
}

/** A NORMAL seat of a 10-credit cycle, unless the case declares the equity it reads. */
function seatItem(
  name: string,
  equity: Record<string, unknown> = {
    CycleTotalValue: 10,
    CycleSurplusValue: 5,
    CycleEndTime: SEAT_RESET_AT,
  },
): Record<string, unknown> {
  return {
    Status: "NORMAL",
    AssignedStatus: "ASSIGNED",
    AccountEmail: "",
    AccountName: name,
    SpecType: "max",
    SeatId: `seat_${name}`,
    EquityList: [{ EquityType: "CREDITS", ...equity }],
  };
}

const INVALID_SCHEMA = {
  ok: false,
  error: {
    kind: "invalid_schema",
    message: ERROR_MESSAGES.invalid_schema,
  },
};

describe("alibaba token plan parser", () => {
  it.each([
    {
      // The CLI reports the fraction used, so half spent means 50% remaining.
      name: "the used fraction inverted into the percent remaining",
      payload: { per1MonthPercentage: 0.5 },
      expected: {
        ok: true,
        windows: [{ key: "per1Month", count: 1, unit: "Month", percentRemaining: 50 }],
      },
    },
    {
      name: "an epoch-ms reset as the right instant, not seconds",
      payload: { per1MonthPercentage: 0.2, per1MonthResetTime: 1_714_000_000_000 },
      expected: {
        ok: true,
        windows: [
          {
            key: "per1Month",
            count: 1,
            unit: "Month",
            percentRemaining: 80,
            resetTimeIso: new Date(1_714_000_000_000).toISOString(),
          },
        ],
      },
    },
    {
      name: "a percentage without a reset, without inventing one",
      payload: { per1MonthPercentage: 0 },
      expected: {
        ok: true,
        windows: [{ key: "per1Month", count: 1, unit: "Month", percentRemaining: 100 }],
      },
    },
    {
      name: "full exhaustion",
      payload: { per1MonthPercentage: 1, per1MonthResetTime: 1_714_600_000_000 },
      expected: {
        ok: true,
        windows: [
          {
            key: "per1Month",
            count: 1,
            unit: "Month",
            percentRemaining: 0,
            resetTimeIso: "2024-05-01T21:46:40.000Z",
          },
        ],
      },
    },
    {
      name: "unrounded precision until shared rendering",
      payload: { per1MonthPercentage: 0.123456789 },
      expected: {
        ok: true,
        windows: [
          {
            key: "per1Month",
            count: 1,
            unit: "Month",
            percentRemaining: 100 - 0.123456789 * 100,
          },
        ],
      },
    },
    {
      // Every window the API returned comes through, and the CLI says it read a ratio.
      name: "every window the reply carries, with the CLI's own flag",
      payload: { per5HourPercentage: 0.25, per1WeekPercentage: 0.1, hasQuotaData: true },
      expected: {
        ok: true,
        hasQuotaData: true,
        windows: [
          { key: "per5Hour", count: 5, unit: "Hour", percentRemaining: 75 },
          { key: "per1Week", count: 1, unit: "Week", percentRemaining: 90 },
        ],
      },
    },
    {
      // A reset without a ratio is a window without a ratio, not a broken reply.
      name: "a window without a ratio, kept with its reset",
      payload: { per1MonthResetTime: 1_714_000_000_000, hasQuotaData: false },
      expected: {
        ok: true,
        hasQuotaData: false,
        windows: [
          {
            key: "per1Month",
            count: 1,
            unit: "Month",
            resetTimeIso: new Date(1_714_000_000_000).toISOString(),
          },
        ],
      },
    },
  ])("parses $name", ({ payload, expected }) => {
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify(payload))).toEqual(expected);
  });

  it("treats an empty payload as a success without a window or a made-up row", () => {
    expect(parseAlibabaTokenPlanUsageJson("{}")).toEqual({ ok: true, windows: [] });
  });

  it.each([
    ["a percentage above 1", { per1MonthPercentage: 1.2 }],
    ["a negative percentage", { per1MonthPercentage: -0.1 }],
    ["a string percentage", { per1MonthPercentage: "0.2" }],
    ["a string reset", { per1MonthPercentage: 0.2, per1MonthResetTime: "1714000000000" }],
    ["a zero reset", { per1MonthPercentage: 0.2, per1MonthResetTime: 0 }],
    ["a negative reset", { per1MonthPercentage: 0.2, per1MonthResetTime: -1 }],
    ["a null (non-finite) reset", { per1MonthPercentage: 0.2, per1MonthResetTime: null }],
    ["a reset past 2100", { per1MonthPercentage: 0.2, per1MonthResetTime: 5_000_000_000_000 }],
    ["a non-object root", []],
    ["a flag that is not a boolean", { hasQuotaData: "yes" }],
  ])("rejects %s instead of dropping the window", (_name, payload) => {
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify(payload))).toEqual(INVALID_SCHEMA);
  });

  it("reads a reply with only the removed 5-hour window as that window", () => {
    expect(
      parseAlibabaTokenPlanUsageJson(
        JSON.stringify({ per5HourPercentage: 0.25, per5HourResetTime: 1_714_000_000_000 }),
      ),
    ).toEqual({
      ok: true,
      windows: [
        {
          key: "per5Hour",
          count: 5,
          unit: "Hour",
          percentRemaining: 75,
          resetTimeIso: new Date(1_714_000_000_000).toISOString(),
        },
      ],
    });
  });

  it("rejects invalid JSON", () => {
    expect(parseAlibabaTokenPlanUsageJson("{")).toEqual({
      ok: false,
      error: { kind: "invalid_json", message: ERROR_MESSAGES.invalid_json },
    });
  });
});

describe("alibaba token plan executable resolution", () => {
  const NVM_BL = "/home/user/.nvm/versions/node/v22.0.0/lib/node_modules/bailian-cli/bin/bl";

  it("names the rejected shell launcher and its remedy in the error", async () => {
    await mockExecutable("/trusted/bin/bl.cmd");
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "linux",
        cwd: "/workspace",
        pathEnv: "/trusted/bin",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "shell_launcher_rejected",
        message: ERROR_MESSAGES.shell_launcher_rejected,
      },
    });
  });

  it.each([
    {
      // `.bat` is no longer probed: npm's cmd-shim never writes one, so a stray one is never run.
      name: "a bl.bat launcher, which is no longer probed and so counts as absent",
      file: "/trusted/bin/bl.bat",
      kind: "executable_not_found",
    },
    {
      name: "a symlink to a shell",
      file: "/trusted/bin/bl",
      target: "/bin/sh",
      kind: "shell_launcher_rejected",
    },
    { name: "no bl on PATH", file: "/elsewhere/bl", kind: "executable_not_found" },
    {
      name: "a bl in workspace bin/",
      file: "/trusted/bin/bl",
      target: "/workspace/bin/bl",
      kind: "workspace_path_rejected",
    },
    {
      name: "a bl in workspace ..bin/",
      file: "/trusted/bin/bl",
      target: "/workspace/..bin/bl",
      kind: "workspace_path_rejected",
    },
    {
      name: "a bl in a workspace sibling",
      file: "/trusted/bin/bl",
      target: "/workspace-sibling/..bin/bl",
      resolved: "/workspace-sibling/..bin/bl",
    },
    {
      name: "workspace bin/ as an absolute PATH entry",
      file: "/workspace/bin/bl",
      pathEnv: "/workspace/bin",
      kind: "executable_not_found",
    },
    {
      name: "workspace ..bin/ as an absolute PATH entry",
      file: "/workspace/..bin/bl",
      pathEnv: "/workspace/..bin",
      kind: "executable_not_found",
    },
    {
      name: "a bl under home for quota computed for home",
      file: "/trusted/bin/bl",
      target: NVM_BL,
      cwd: "/home/user",
      resolved: NVM_BL,
    },
    {
      name: "a bl in a project folder under home",
      file: "/trusted/bin/bl",
      target: "/home/user/project/node_modules/.bin/bl",
      cwd: "/home/user/project",
      kind: "workspace_path_rejected",
    },
  ])(
    "resolves $name",
    async ({ file, target, cwd = "/workspace", pathEnv = "/trusted/bin", kind, resolved }) => {
      await mockExecutable(file, target);
      expect(
        await resolveAlibabaTokenPlanExecutable({
          platform: "linux",
          cwd,
          homedir: "/home/user",
          pathEnv,
        }),
      ).toEqual(
        resolved
          ? { ok: true, file: resolved }
          : { ok: false, error: { kind, message: expect.any(String) } },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a real bl symlink to a .cmd launcher",
    async () => {
      const bin = await makeDir();
      await writeUnixExecutable(bin, "launcher.cmd", "@echo off\r\n");
      await symlink(path.join(bin, "launcher.cmd"), path.join(bin, "bl"));
      const resolved = await resolveAlibabaTokenPlanExecutable({
        pathEnv: bin,
        cwd: await makeDir(),
        platform: "darwin",
      });
      expect(resolved).toMatchObject({ ok: false, error: { kind: "shell_launcher_rejected" } });
    },
  );

  it("keeps the plain POSIX bl on the direct route, without a node indirection", async () => {
    const file = "/trusted/bin/bl";
    await mockExecutable(file);
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "linux",
        cwd: "/workspace",
        pathEnv: "/trusted/bin",
      }),
    ).toEqual({ ok: true, file });
  });

  it.each(["aix", "freebsd"] as const)("rejects %s instead of probing PATH", async (platform) => {
    const expected = { ok: false, error: { kind: "unsupported_platform" } };
    const params = { platform, cwd: "/workspace", pathEnv: "/usr/bin" };
    expect(await resolveAlibabaTokenPlanExecutable(params)).toMatchObject(expected);
    expect(await queryAlibabaTokenPlanQuota({ runtime: params })).toMatchObject(expected);
    expect(stat).not.toHaveBeenCalled();
  });
});

describe("alibaba token plan Windows resolution", () => {
  const W = path.win32;
  const TRUSTED_BIN = W.join("C:\\", "trusted", "bin");
  const WORKSPACE = W.join("C:\\", "workspace");
  const SAFE_TMP = W.join("C:\\", "safe-tmp");
  const HOME = W.join("C:\\", "home", "user");
  const LAUNCHER_ERROR = {
    ok: false,
    error: {
      kind: "shell_launcher_rejected",
      message: ERROR_MESSAGES.shell_launcher_rejected,
    },
  };

  // The npm shim layout: `<prefix>\bl.cmd` beside `<prefix>\node_modules\bailian-cli\`.
  const PACKAGE_ROOT = W.join(TRUSTED_BIN, "node_modules", "bailian-cli");
  const MANIFEST = W.join(PACKAGE_ROOT, "package.json");
  const ENTRY = W.join(PACKAGE_ROOT, "dist", "bailian.mjs");
  const SHIM = W.join(TRUSTED_BIN, "bl.cmd");
  const NODE = W.join(TRUSTED_BIN, "node.exe");
  const SHIM_ARGS = [ENTRY, ...BL_ARGS];

  function manifest(bin: unknown): string {
    return JSON.stringify({ name: "bailian-cli", version: "2.3.0", bin });
  }

  it("supports win32", () => {
    expect(isAlibabaTokenPlanSupportedPlatform("win32")).toBe(true);
  });

  it("accepts the native bl.exe a Windows install ships", async () => {
    const file = W.join(TRUSTED_BIN, "bl.exe");
    await mockExecutable(file);
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual({ ok: true, file });
  });

  it("refuses an extensionless bl, which Windows cannot execute", async () => {
    // Node appends .exe to a name with no extension and never tries the bare name, so probing
    // this file would only resolve a name the child process cannot start.
    await mockExecutable(W.join(TRUSTED_BIN, "bl"));
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toMatchObject({ ok: false, error: { kind: "executable_not_found" } });
  });

  it.each([
    {
      name: "a stray bl.bat, no longer probed",
      file: W.join(TRUSTED_BIN, "bl.bat"),
      kind: "executable_not_found",
    },
    {
      name: "a bl.exe linking to cmd.exe",
      file: W.join(TRUSTED_BIN, "bl.exe"),
      target: W.join("C:\\", "Windows", "System32", "cmd.exe"),
    },
  ])("still refuses $name instead of running it", async ({ file, target, kind }) => {
    await mockExecutable(file, target);
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual(kind ? { ok: false, error: { kind, message: expect.any(String) } } : LAUNCHER_ERROR);
  });

  it.each([
    {
      name: "an object naming bl",
      bin: { bailian: "dist/bailian.mjs", bl: "dist/bailian.mjs" },
    },
    { name: "an object naming only bl", bin: { bl: "dist/bailian.mjs" } },
    { name: "a plain string bin", bin: "dist/bailian.mjs" },
  ])("resolves the npm bl.cmd shim ($name) to the package entry through node", async ({ bin }) => {
    await mockWin32Files({
      [SHIM]: "npm shim text",
      [NODE]: "node",
      [MANIFEST]: manifest(bin),
      [ENTRY]: "cli",
    });
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual({ ok: true, file: NODE, args: [ENTRY] });
  });

  it("runs the resolved shim entry with the fixed argv, no shell, and ignored stdin", async () => {
    await mockWin32Files({
      [SHIM]: "npm shim text",
      [NODE]: "node",
      [MANIFEST]: manifest({ bl: "dist/bailian.mjs" }),
      [ENTRY]: "cli",
    });
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
        tmpdir: SAFE_TMP,
        spawn: capturedSpawn(requests),
      },
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.file).toBe(NODE);
    expect(requests[0]?.args).toEqual(SHIM_ARGS);
    expect(requests[0]?.shell).toBe(false);
    expect(requests[0]?.stdin).toBe("ignore");
    expect(requests[0]?.cwd).toBe(SAFE_TMP);
  });

  it.each([
    {
      name: "a manifest whose bin does not declare bl",
      files: { [MANIFEST]: manifest({ "bailian-cli": "dist/bailian.mjs" }) },
    },
    { name: "no manifest at all" },
    { name: "a manifest with no bin field", files: { [MANIFEST]: manifest(undefined) } },
    { name: "a manifest that names no entry", files: { [MANIFEST]: manifest({ bl: "  " }) } },
    {
      name: "an entry the package declares but does not ship",
      files: { [MANIFEST]: manifest({ bl: "dist/bailian.mjs" }) },
    },
    {
      // Without the containment guard, `..` in the manifest would adopt a program outside the pkg.
      name: "an entry that escapes the package root with `..`",
      files: {
        [MANIFEST]: manifest({ bl: "..\\..\\..\\..\\workspace\\evil.js" }),
        [W.join("C:\\", "workspace", "evil.js")]: "evil",
      },
    },
  ])("falls back to refusing the shim on $name", async ({ files }) => {
    await mockWin32Files({ [SHIM]: "npm shim text", [NODE]: "node", ...files });
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual(LAUNCHER_ERROR);
  });

  it.each([
    { name: "a node.exe that links into the project", link: NODE },
    { name: "a package entry reached through a junction into the project", link: ENTRY },
  ])("refuses the shim for $name", async ({ link }) => {
    await mockWin32Files(
      {
        [SHIM]: "npm shim text",
        [NODE]: "node",
        [MANIFEST]: manifest({ bl: "dist/bailian.mjs" }),
        [ENTRY]: "cli",
      },
      { [link]: W.join(WORKSPACE, "planted", W.basename(link)) },
    );
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual(LAUNCHER_ERROR);
  });

  it("refuses an entry inside the project when the cwd names the project through a junction", async () => {
    const alias = W.join("C:\\", "alias");
    await mockWin32Files(
      {
        [SHIM]: "npm shim text",
        [NODE]: "node",
        [MANIFEST]: manifest({ bl: "dist/bailian.mjs" }),
        [ENTRY]: "cli",
      },
      { [alias]: WORKSPACE, [ENTRY]: W.join(WORKSPACE, "evil.mjs") },
    );
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: alias,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual(LAUNCHER_ERROR);
  });

  it("refuses the shim when no node is on the trusted PATH", async () => {
    await mockWin32Files({
      [SHIM]: "npm shim text",
      [MANIFEST]: manifest({ bl: "dist/bailian.mjs" }),
      [ENTRY]: "cli",
    });
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual(LAUNCHER_ERROR);
  });

  it("refuses a malformed manifest without leaking any of it", async () => {
    const secret = "token=super-secret-manifest";
    await mockWin32Files({ [SHIM]: "npm shim text", [MANIFEST]: `{ ${secret}` });
    const result = await resolveAlibabaTokenPlanExecutable({
      platform: "win32",
      cwd: WORKSPACE,
      homedir: HOME,
      pathEnv: TRUSTED_BIN,
    });
    expect(result).toEqual(LAUNCHER_ERROR);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("still refuses a bl.exe whose realpath is a .bat launcher", async () => {
    const file = W.join(TRUSTED_BIN, "bl.exe");
    await mockExecutable(file, W.join(TRUSTED_BIN, "launcher.bat"));
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toEqual(LAUNCHER_ERROR);
  });

  it("reports a missing CLI when the folder holds neither executable nor launcher", async () => {
    await mockExecutable(W.join("C:\\", "elsewhere", "bl.exe"));
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toMatchObject({ ok: false, error: { kind: "executable_not_found" } });
  });

  it.each([
    {
      name: "the project folder",
      target: W.join(WORKSPACE, "bin", "bl.exe"),
      expected: { ok: false, error: { kind: "workspace_path_rejected" } },
    },
    {
      name: "a sibling of the project folder",
      target: W.join("C:\\", "workspace-sibling", "bl.exe"),
      expected: { ok: true, file: W.join("C:\\", "workspace-sibling", "bl.exe") },
    },
    {
      name: "another drive",
      target: W.join("D:\\", "bin", "bl.exe"),
      expected: { ok: true, file: W.join("D:\\", "bin", "bl.exe") },
    },
  ])("classifies a bl.exe realpath in $name by drive and folder", async ({ target, expected }) => {
    await mockExecutable(W.join(TRUSTED_BIN, "bl.exe"), target);
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toMatchObject(expected);
  });

  // NTFS reads names without case, so a folder reached as c:\WORKSPACE is still the project folder.
  it("refuses a project folder that differs from the cwd only in case", async () => {
    await mockExecutable(
      W.join(TRUSTED_BIN, "bl.exe"),
      W.join("c:\\", "WORKSPACE", "bin", "bl.exe"),
    );
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: TRUSTED_BIN,
      }),
    ).toMatchObject({ ok: false, error: { kind: "workspace_path_rejected" } });
  });

  it("runs bl.exe with a semicolon PATH of only the trusted absolute folders", async () => {
    const file = W.join(TRUSTED_BIN, "bl.exe");
    await mockExecutable(file);
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "win32",
        cwd: WORKSPACE,
        homedir: HOME,
        pathEnv: [W.join(WORKSPACE, "bin"), ".", "relative", TRUSTED_BIN, TRUSTED_BIN].join(";"),
        tmpdir: SAFE_TMP,
        env: { Path: W.join(WORKSPACE, "bin"), TEST_ENV: "preserved" },
        spawn: capturedSpawn(requests),
      },
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.file).toBe(file);
    expect(requests[0]?.cwd).toBe(SAFE_TMP);
    expect(requests[0]?.env).toEqual({ TEST_ENV: "preserved", PATH: TRUSTED_BIN });
  });
});

describe("alibaba token plan process boundary", () => {
  it("invokes only the fixed argv, ignores stdin, and uses a non-workspace cwd", async () => {
    const workspace = "/workspace";
    const bin = "/trusted/bin";
    await mockExecutable();
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        cwd: workspace,
        pathEnv: `${workspace}/bin:.:${bin}`,
        tmpdir: "/safe-tmp",
        homedir: "/safe-home",
        env: { PATH: "/wrong/bin", TEST_ENV: "preserved" },
        spawn: capturedSpawn(requests),
      },
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toEqual(BL_ARGS);
    expect(requests[0]?.shell).toBe(false);
    expect(requests[0]?.stdin).toBe("ignore");
    expect(requests[0]?.file).toBe(`${bin}/${BL_COMMAND}`);
    expect(requests[0]?.cwd).toBe("/safe-tmp");
    expect(requests[0]?.env).toEqual({ PATH: bin, TEST_ENV: "preserved" });
    expect(requests[0]?.stdoutLimitBytes).toBe(STDOUT_LIMIT_BYTES);
    expect(requests[0]?.stderrLimitBytes).toBe(STDERR_LIMIT_BYTES);
    expect(requests[0]?.killGraceMs).toBe(KILL_GRACE_MS);
  });

  it.each([
    {
      name: "only absolute, deduplicated entries outside the workspace",
      cwd: "/workspace",
      bin: "/workspace-sibling/bin",
      pathEnv: [
        "/workspace",
        "/workspace/..bin",
        ".",
        "relative",
        "/workspace-sibling/bin",
        '"/workspace-sibling/bin"',
        "/",
      ].join(":"),
      expectedPath: "/workspace-sibling/bin:/",
    },
    {
      name: "entries under home when quota is computed for home",
      cwd: "/home/user",
      bin: "/home/user/.local/bin",
      pathEnv: [
        "/home/user/.local/bin",
        "/home/user/.nvm/versions/node/v22.0.0/bin",
        "relative",
        ".",
        "..",
        "/usr/bin",
      ].join(":"),
      expectedPath: "/home/user/.local/bin:/home/user/.nvm/versions/node/v22.0.0/bin:/usr/bin",
    },
    {
      name: "no entries inside a project folder under home",
      cwd: "/home/user/project",
      bin: "/home/user/.local/bin",
      pathEnv: "/home/user/project/node_modules/.bin:/home/user/.local/bin:/usr/bin",
      expectedPath: "/home/user/.local/bin:/usr/bin",
    },
  ])("runs bl with a PATH of $name", async ({ cwd, bin, pathEnv, expectedPath }) => {
    await mockExecutable(`${bin}/bl`);
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        cwd,
        homedir: "/home/user",
        pathEnv,
        tmpdir: "/safe-tmp",
        env: {},
        spawn: capturedSpawn(requests),
      },
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.file).toBe(`${bin}/${BL_COMMAND}`);
    expect(requests[0]?.env.PATH).toBe(expectedPath);
    expect(requests[0]?.cwd).toBe("/safe-tmp");
  });

  it("uses the injected environment PATH when pathEnv is omitted", async () => {
    await mockExecutable();
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const runtime = {
      platform: "darwin" as const,
      cwd: "/workspace",
      tmpdir: "/safe-tmp",
      env: { PATH: "/trusted/bin" },
      spawn: capturedSpawn(requests),
    };
    expect((await queryAlibabaTokenPlanQuota({ runtime })).ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.env.PATH).toBe("/trusted/bin");

    expect(
      await queryAlibabaTokenPlanQuota({ runtime: { ...runtime, pathEnv: "" } }),
    ).toMatchObject({ ok: false, error: { kind: "executable_not_found" } });
    expect(requests).toHaveLength(1);
  });

  it.each([
    {
      name: "a timeout",
      run: { code: null, timedOut: true },
      error: {
        kind: "timeout",
        message: ERROR_MESSAGES.timeout,
      },
    },
    {
      name: "an output overflow",
      run: { code: 0, truncated: true },
      error: {
        kind: "output_truncated",
        message: ERROR_MESSAGES.output_truncated,
      },
    },
    {
      name: "exit 3 as missing console auth",
      run: { code: 3 },
      error: {
        kind: "not_authenticated",
        message: ERROR_MESSAGES.not_authenticated,
      },
    },
    {
      name: "exit 3 with an empty stdout, the measured console-auth carrier",
      run: { code: 3, stdout: "" },
      error: {
        kind: "not_authenticated",
        message: ERROR_MESSAGES.not_authenticated,
      },
    },
    {
      name: "a failure envelope that arrived as a whole document, its own code naming console auth",
      run: {
        code: 0,
        complete: true,
        stdout: JSON.stringify({ error: { code: 3, message: "No console access token found." } }),
      },
      error: {
        kind: "not_authenticated",
        message: "No console access token found.",
        facts: { code: "login_expired" },
      },
    },
    {
      name: "a whole failure envelope plus exit 3, which is not a success",
      run: {
        code: 3,
        complete: true,
        stdout: JSON.stringify({ error: { code: 3, message: "No console access token found." } }),
      },
      error: {
        kind: "not_authenticated",
        message: "No console access token found.",
        facts: { code: "login_expired" },
      },
    },
    {
      name: "an overflow ahead of the whole document it already holds",
      run: {
        code: 0,
        complete: true,
        truncated: true,
        stdout: JSON.stringify({ per1MonthPercentage: 0.5 }),
      },
      error: {
        kind: "output_truncated",
        message: ERROR_MESSAGES.output_truncated,
      },
    },
    {
      name: "a generic nonzero exit separately from console auth",
      run: { code: 1 },
      error: { kind: "nonzero_exit", message: ERROR_MESSAGES.nonzero_exit },
    },
    {
      name: "a vanished executable",
      run: { code: null, spawnErrorCode: "ENOENT" },
      error: {
        kind: "executable_not_found",
        message: ERROR_MESSAGES.executable_not_found,
      },
    },
    {
      name: "another spawn error",
      run: { code: null, spawnErrorCode: "EACCES" },
      error: {
        kind: "spawn_failed",
        message: ERROR_MESSAGES.spawn_failed,
      },
    },
  ])("maps $name without leaking CLI output", async ({ run, error }) => {
    await mockExecutable();
    const result = await queryAlibabaTokenPlanQuota({
      runtime: linuxRuntime(async () => ({
        stdout: Buffer.from("secret-stdout token=abc"),
        stderr: Buffer.from("secret-stderr no console access token found"),
        timedOut: false,
        truncated: false,
        ...run,
      })),
    });
    expect(result).toEqual({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain("secret-");
  });

  it("reports a whole document as the answer, since no exit code is left to read", async () => {
    await mockExecutable();
    const result = await queryAlibabaTokenPlanQuota({
      runtime: linuxRuntime(async () => ({
        // The early exit stops the child on a whole document, so `code` stays null.
        code: null,
        complete: true,
        stdout: Buffer.from(
          JSON.stringify({ per1MonthPercentage: 0.034, per1MonthResetTime: 1792771200000 }),
        ),
        stderr: Buffer.from(""),
        timedOut: false,
        truncated: false,
      })),
    });
    expect(result).toEqual({
      ok: true,
      windows: [
        {
          key: "per1Month",
          count: 1,
          unit: "Month",
          percentRemaining: 96.6,
          resetTimeIso: "2026-10-23T16:00:00.000Z",
        },
      ],
    });
  });

  it.runIf(process.platform !== "win32")(
    "runs a real fake bl with ignored stdin and the fixed argument sequence",
    async () => {
      const bin = await makeDir();
      const seen = path.join(bin, "seen.json");
      await writeUnixExecutable(
        bin,
        "bl",
        `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
  process.stdout.write(JSON.stringify({
    per1MonthPercentage: 0.1,
    per1MonthResetTime: 1714000000000
  }));
});
`,
      );
      const workspace = await makeDir();
      const result = await queryAlibabaTokenPlanQuota({
        runtime: {
          cwd: workspace,
          pathEnv: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
          tmpdir: await makeDir(),
          env: {
            PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
            HOME: await makeDir(),
          },
        },
      });
      expect(result.ok).toBe(true);
      const seenPayload = JSON.parse(await readFile(seen, "utf8")) as {
        argv: string[];
        cwd: string;
        stdin: string;
      };
      expect(seenPayload.argv).toEqual(BL_ARGS);
      expect(seenPayload.stdin).toBe("");
      expect(seenPayload.cwd.startsWith(workspace)).toBe(false);
    },
  );

  it("runner hides the console window of the CLI on Windows", async () => {
    vi.mocked(spawn).mockClear();

    const result = await runAlibabaTokenPlanProcess(
      spawnRequest(process.execPath, { args: ["-e", ""], cwd: await makeDir() }),
    );

    expect(result.code).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  });

  it.runIf(process.platform !== "win32")(
    "runner kills a POSIX child process group after the 250ms grace",
    async () => {
      const bin = await makeDir();
      const termSeen = path.join(bin, "term.flag");
      const timeoutMs = 1_000;
      const started = Date.now();
      const result = await runAlibabaTokenPlanProcess(
        spawnRequest(process.execPath, {
          args: [
            "-e",
            `const fs = require("node:fs");
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(termSeen)}, "term");
});
spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 30000)"], {
  detached: false,
  stdio: "ignore",
});
setInterval(() => {}, 30000);
`,
          ],
          timeoutMs,
          cwd: await makeDir(),
        }),
      );
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(result.truncated).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs + KILL_GRACE_MS);
      expect(await readFile(termSeen, "utf8")).toBe("term");
    },
  );

  it("runner answers on a whole document instead of waiting for a child that will not exit", async () => {
    // `bl` writes its answer and then waits on an npm update check before exiting. A child that
    // answers and lingers must not hold the quota check open.
    const result = await runAlibabaTokenPlanProcess(
      spawnRequest(process.execPath, {
        args: [
          "-e",
          `process.stdout.write(JSON.stringify({ per1MonthPercentage: 0.5 }));
setInterval(() => {}, 30000);
`,
        ],
        timeoutMs: 30_000,
        cwd: process.cwd(),
      }),
    );
    expect(result.complete).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"))).toEqual({
      ok: true,
      windows: [{ key: "per1Month", count: 1, unit: "Month", percentRemaining: 50 }],
    });
  });

  it("runner answers on the kill escalation when nothing else can close the pipe", async () => {
    // The child leaves a grandchild holding the stdout it handed down, so `close` never comes.
    // Answering only from `close` would let the store's read timeout fire first, which keys the
    // rows under `memory-`; the grandchild also outlives the guard below.
    const grandchild = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 8000)"], {
  detached: true, stdio: ["ignore", "inherit", "inherit"],
}).unref();
setInterval(() => {}, 30000);
`;
    const answered = await Promise.race([
      runAlibabaTokenPlanProcess(
        spawnRequest(process.execPath, {
          args: ["-e", `process.on("SIGTERM", () => {});\n${grandchild}`],
          timeoutMs: 300,
          cwd: process.cwd(),
        }),
      ).then((result) => ({ result })),
      new Promise((resolve) => setTimeout(() => resolve({ result: undefined }), 3_000)),
    ]);
    expect(answered.result).toBeDefined();
    expect(answered.result?.timedOut).toBe(true);
    expect(answered.result?.code).toBeNull();
    expect(answered.result?.complete).toBeUndefined();
  });

  it("runner still waits for the exit code when no whole document arrives", async () => {
    const result = await runAlibabaTokenPlanProcess(
      spawnRequest(process.execPath, {
        args: ["-e", `process.stdout.write("not json"); process.exit(3);`],
        timeoutMs: 30_000,
        cwd: await makeDir(),
      }),
    );
    expect(result.complete).toBeUndefined();
    expect(result.code).toBe(3);
  });
  it.runIf(process.platform !== "win32").each(["stdout", "stderr"] as const)(
    "runner treats real %s overflow as truncated and stops the child",
    async (stream) => {
      const bin = await makeDir();
      const file = await writeUnixExecutable(
        bin,
        "bl",
        `#!/usr/bin/env node
process.${stream}.write("x".repeat(128));
setInterval(() => {}, 30000);
`,
      );
      const result = await runAlibabaTokenPlanProcess(
        spawnRequest(file, {
          cwd: await makeDir(),
          stdoutLimitBytes: 32,
          stderrLimitBytes: 32,
          timeoutMs: 5_000,
        }),
      );
      expect(result.truncated).toBe(true);
      expect(result[stream].toString("utf8")).toBe("x".repeat(32));
    },
  );

  it("runner adds the limit up across chunks, so many small writes overflow too", async () => {
    // Each write is far under the limit, so only a cumulative size detects the overflow: a counter
    // rebuilt per `data` event restarts at 0. `process.execPath` keeps it real on every platform.
    const script = `
const { setTimeout: delay } = require("node:timers/promises");
(async () => {
  for (let i = 0; i < 32; i += 1) {
    process.stdout.write("x".repeat(32));
    await delay(5);
  }
  setInterval(() => {}, 30000);
})();
`;
    const result = await runAlibabaTokenPlanProcess(
      spawnRequest(process.execPath, {
        args: ["-e", script],
        cwd: await makeDir(),
        stdoutLimitBytes: 256,
        timeoutMs: 5_000,
      }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(256);
  });
});

describe("alibaba token plan seat parser", () => {
  const RESET_AT = SEAT_RESET_AT;
  const RESET_ISO = new Date(RESET_AT).toISOString();
  const CYCLE_START_AT = 1_790_150_400_000;
  const CYCLE_START_ISO = new Date(CYCLE_START_AT).toISOString();
  /** The seat envelope's own words, kept for the user, with the exit code as the fact. */
  const SEAT_ENVELOPE_ERROR = {
    ok: false,
    error: {
      kind: "seat_not_authenticated",
      message: SEAT_ENVELOPE_MESSAGE,
      facts: { code: "login_expired" },
    },
  };
  const INVALID_SEAT_SCHEMA = {
    ok: false,
    error: {
      kind: "seat_invalid_schema",
      message: ERROR_MESSAGES.seat_invalid_schema,
    },
  };

  it("parses the real success envelope, keeping only NORMAL seats", () => {
    const payload = {
      Success: true,
      Data: {
        Items: [
          {
            Status: "RELEASE",
            AssignedStatus: "UNASSIGNED",
            EquityList: [{ EquityType: "CREDITS" }],
            EndTime: 1790150400000,
            SpecType: "pro",
            StartTime: 1782201600000,
            InstanceCode: "subs-ef7defa40ni48OZD",
          },
          {
            Status: "NORMAL",
            AssignedStatus: "ASSIGNED",
            AccountId: "acc_d78137618e404af3a60c766868c98233",
            EquityList: [
              {
                CycleStartTime: CYCLE_START_AT,
                CycleVersion: 9626,
                EquityType: "CREDITS",
                CycleTotalValue: 250000,
                CycleInstanceId: "1005775283",
                CycleSurplusValue: 170166.41186,
                CycleEndTime: RESET_AT,
              },
            ],
            EndTime: 1821686400000,
            SpecType: "max",
            StartTime: 1790150400000,
            AccountEmail: "",
            InstanceCode: "subs-ede0e5baTv5q8Zky",
            SeatId: "seat_81c7eba6a53f485ab20921415a27f1b1",
            AccountName: "team-lead",
          },
        ],
        PageNo: 1,
        PageSize: 10,
        Total: 4,
      },
    };
    expect(parseAlibabaTokenPlanSeatsJson(JSON.stringify(payload))).toEqual({
      ok: true,
      seats: [
        {
          name: "team-lead",
          total: 250000,
          surplus: 170166.41186,
          percentRemaining: (170166.41186 / 250000) * 100,
          used: 250000 - 170166.41186,
          resetsAt: RESET_ISO,
          startedAt: CYCLE_START_ISO,
        },
      ],
    });
  });

  it("reads the real error envelope as the seat credentials failure, with its own words", () => {
    const result = parseAlibabaTokenPlanSeatsJson(REAL_SEAT_ERROR_ENVELOPE);
    expect(result).toEqual(SEAT_ENVELOPE_ERROR);
  });

  it("falls back to our own sentence when the envelope carries no words", () => {
    expect(parseAlibabaTokenPlanSeatsJson(JSON.stringify({ error: { code: 3 } }))).toEqual({
      ok: false,
      error: {
        kind: "seat_not_authenticated",
        message: ERROR_MESSAGES.seat_not_authenticated,
        facts: { code: "login_expired" },
      },
    });
  });

  it("redacts the envelope's own words to one line and to length", () => {
    const result = parseAlibabaTokenPlanSeatsJson(
      JSON.stringify({
        error: {
          code: 1,
          message: `first line\nsecond line for ops@example.com ${"x".repeat(400)}`,
        },
      }),
    );
    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.error.message;
    expect(message).toContain("first line");
    expect(message).toContain("second line");
    expect(message).toContain("[email]");
    expect(message).not.toContain("ops@example.com");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it("treats a reply without Items or Total as no seats, not a failure", () => {
    expect(parseAlibabaTokenPlanSeatsJson(JSON.stringify({ Success: true, Data: {} }))).toEqual({
      ok: true,
      seats: [],
    });
  });

  it("ignores a RELEASE seat, whose EquityList carries no Cycle fields", () => {
    const release = {
      Status: "RELEASE",
      AssignedStatus: "UNASSIGNED",
      EquityList: [{ EquityType: "CREDITS" }],
      AccountName: "gone",
    };
    expect(parseAlibabaTokenPlanSeatsJson(seatEnvelope([release], 1))).toEqual({
      ok: true,
      seats: [],
    });
  });

  it("drops a NORMAL seat with no account name, which cannot be keyed", () => {
    const nameless = {
      Status: "NORMAL",
      AccountName: "",
      EquityList: [{ EquityType: "CREDITS", CycleTotalValue: 10, CycleSurplusValue: 5 }],
    };
    expect(parseAlibabaTokenPlanSeatsJson(seatEnvelope([nameless], 1))).toEqual({
      ok: true,
      seats: [],
    });
  });

  it("keeps a NORMAL seat whose cycle total is 0, without a percentage", () => {
    const payload = seatEnvelope(
      [seatItem("zero", { CycleTotalValue: 0, CycleSurplusValue: 0, CycleEndTime: RESET_AT })],
      1,
    );
    expect(parseAlibabaTokenPlanSeatsJson(payload)).toEqual({
      ok: true,
      seats: [{ name: "zero", total: 0, surplus: 0, used: 0, resetsAt: RESET_ISO }],
    });
  });

  it("clamps the percent when the surplus is greater than the total", () => {
    const payload = seatEnvelope(
      [seatItem("over", { CycleTotalValue: 100, CycleSurplusValue: 250, CycleEndTime: RESET_AT })],
      1,
    );
    expect(parseAlibabaTokenPlanSeatsJson(payload)).toEqual({
      ok: true,
      seats: [
        {
          name: "over",
          total: 100,
          surplus: 250,
          percentRemaining: 100,
          used: 0,
          resetsAt: RESET_ISO,
        },
      ],
    });
  });

  it.each([
    ["null", null],
    ["a string", "1792742400000"],
    ["a value past 2100", 5_000_000_000_000],
    ["zero", 0],
  ])(
    "leaves out resetsAt for a %s CycleEndTime, keeping the rest of the seat",
    (_name, endTime) => {
      const payload = seatEnvelope(
        [
          seatItem("bad-end", {
            CycleTotalValue: 100,
            CycleSurplusValue: 50,
            CycleEndTime: endTime,
          }),
        ],
        1,
      );
      expect(parseAlibabaTokenPlanSeatsJson(payload)).toEqual({
        ok: true,
        seats: [{ name: "bad-end", total: 100, surplus: 50, percentRemaining: 50, used: 50 }],
      });
    },
  );

  it("keeps a NORMAL seat whose CycleSurplusValue is missing, without a percentage", () => {
    const payload = seatEnvelope(
      [seatItem("no-surplus", { CycleTotalValue: 250000, CycleEndTime: RESET_AT })],
      1,
    );
    expect(parseAlibabaTokenPlanSeatsJson(payload)).toEqual({
      ok: true,
      seats: [{ name: "no-surplus", total: 250000, resetsAt: RESET_ISO }],
    });
  });

  it.each([
    [
      "invalid JSON",
      "{",
      {
        ok: false,
        error: { kind: "invalid_json", message: ERROR_MESSAGES.invalid_json },
      },
    ],
    ["a non-object root", "[]", INVALID_SEAT_SCHEMA],
    ["no Data object", JSON.stringify({ Success: true }), INVALID_SEAT_SCHEMA],
    ["a non-object Data", JSON.stringify({ Success: true, Data: [] }), INVALID_SEAT_SCHEMA],
  ])("rejects %s", (_name, text, expected) => {
    expect(parseAlibabaTokenPlanSeatsJson(text)).toEqual(expected);
  });
});

describe("alibaba token plan seat process boundary", () => {
  function pageSpawn(pages: string[]) {
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const spawn = async (request: AlibabaTokenPlanSpawnRequest) => {
      requests.push(request);
      return {
        code: 0,
        stdout: Buffer.from(pages[requests.length - 1] ?? "{}"),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
      };
    };
    return { requests, spawn };
  }

  it("runs the seat command with the fixed argv, the caps, and no shell or stdin", async () => {
    await mockExecutable();
    const { requests, spawn } = pageSpawn([seatEnvelope([seatItem("team-lead")], 1)]);
    const result = await queryAlibabaTokenPlanSeats({
      requestTimeoutMs: 4_321,
      runtime: {
        ...linuxRuntime(spawn),
        env: { PATH: "/wrong/bin", TEST_ENV: "preserved" },
      },
    });
    expect(result).toEqual({
      ok: true,
      seats: [
        {
          name: "team-lead",
          total: 10,
          surplus: 5,
          percentRemaining: 50,
          used: 5,
          resetsAt: new Date(SEAT_RESET_AT).toISOString(),
        },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.file).toBe("/trusted/bin/bl");
    expect(requests[0]?.args).toEqual(BL_SEAT_ARGS);
    expect(requests[0]?.shell).toBe(false);
    expect(requests[0]?.stdin).toBe("ignore");
    expect(requests[0]?.cwd).toBe("/safe-tmp");
    expect(requests[0]?.env).toEqual({ PATH: "/trusted/bin", TEST_ENV: "preserved" });
    expect(requests[0]?.timeoutMs).toBe(4_321);
    expect(requests[0]?.stdoutLimitBytes).toBe(STDOUT_LIMIT_BYTES);
    expect(requests[0]?.stderrLimitBytes).toBe(STDERR_LIMIT_BYTES);
    expect(requests[0]?.killGraceMs).toBe(KILL_GRACE_MS);
  });

  it("gives the CLI its own budget when the caller sets none", async () => {
    await mockExecutable();
    const { requests, spawn } = pageSpawn([seatEnvelope([seatItem("a")], 1)]);
    await queryAlibabaTokenPlanSeats({
      runtime: linuxRuntime(spawn),
    });
    // A local program that has to start and answer is not a remote request.
    expect(requests[0]?.timeoutMs).toBe(10_000);
  });

  it("asks for the next page with `--page-no` while Total exceeds the items collected", async () => {
    await mockExecutable();
    const first = Array.from({ length: SEAT_PAGE_SIZE }, (_, index) => seatItem(`seat${index}`));
    const { requests, spawn } = pageSpawn([
      seatEnvelope(first, SEAT_PAGE_SIZE + 1),
      seatEnvelope([seatItem("last")], SEAT_PAGE_SIZE + 1),
    ]);
    const result = await queryAlibabaTokenPlanSeats({
      runtime: linuxRuntime(spawn),
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.args).toEqual(BL_SEAT_ARGS);
    expect(requests[1]?.args).toEqual([...BL_SEAT_ARGS, "--page-no", "2"]);
  });

  it("stops after one short page when the reply carries no Total", async () => {
    await mockExecutable();
    const { requests, spawn } = pageSpawn([seatEnvelope([seatItem("a"), seatItem("b")])]);
    const result = await queryAlibabaTokenPlanSeats({
      runtime: linuxRuntime(spawn),
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("stops paging when a page adds no items, instead of chasing Total to MAX_PAGES", async () => {
    await mockExecutable();
    const full = Array.from({ length: SEAT_PAGE_SIZE }, (_, index) => seatItem(`seat${index}`));
    const { requests, spawn } = pageSpawn([seatEnvelope(full, 1000), seatEnvelope([], 1000)]);
    const result = await queryAlibabaTokenPlanSeats({
      runtime: linuxRuntime(spawn),
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("reports a failure when seats remain after the last page it may read", async () => {
    await mockExecutable();
    const full = Array.from({ length: SEAT_PAGE_SIZE }, (_, index) => seatItem(`seat${index}`));
    const total = 50 * SEAT_PAGE_SIZE + 1;
    const { requests, spawn } = pageSpawn(
      Array.from({ length: 50 }, () => seatEnvelope(full, total)),
    );
    const result = await queryAlibabaTokenPlanSeats({
      runtime: linuxRuntime(spawn),
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "seat_command_failed", message: ERROR_MESSAGES.seat_command_failed },
    });
    expect(requests).toHaveLength(50);
  });

  it("gives up when its whole time budget is spent, rather than report a short list", async () => {
    await mockExecutable();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const full = Array.from({ length: SEAT_PAGE_SIZE }, (_, index) => seatItem(`seat${index}`));
    const { requests, spawn: page } = pageSpawn([
      seatEnvelope(full, 1000),
      seatEnvelope(full, 1000),
    ]);
    const spawn = async (request: AlibabaTokenPlanSpawnRequest) => {
      const answered = await page(request);
      // Each page eats the whole budget, as 50 slow pages would; only a shared deadline stops it.
      vi.setSystemTime(60_000);
      return answered;
    };
    const result = await queryAlibabaTokenPlanSeats({
      requestTimeoutMs: 5_000,
      runtime: linuxRuntime(spawn),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("timeout");
    expect(requests).toHaveLength(1);
  });

  it.each([
    {
      name: "exit 3 as the seat credentials failure, not the personal one",
      run: { code: 3 },
      error: { kind: "seat_not_authenticated", message: ERROR_MESSAGES.seat_not_authenticated },
    },
    {
      name: "exit 3 with the envelope on stderr and an empty stdout, as measured",
      run: { code: 3, stdout: "", stderr: REAL_SEAT_ERROR_ENVELOPE },
      error: {
        kind: "seat_not_authenticated",
        message: SEAT_ENVELOPE_MESSAGE,
        facts: { code: "login_expired" },
      },
    },
  ])(
    "maps $name, keeping a stderr that is not the CLI's envelope out of the report",
    async ({ run, error }) => {
      await mockExecutable();
      const result = await queryAlibabaTokenPlanSeats({
        runtime: linuxRuntime(async () => ({
          stdout: Buffer.from("secret-stdout token=abc"),
          stderr: Buffer.from("secret-stderr no console access token found"),
          timedOut: false,
          truncated: false,
          ...run,
        })),
      });
      expect(result).toEqual({ ok: false, error });
      expect(JSON.stringify(result)).not.toContain("secret-");
    },
  );

  it("keeps a stderr that is not the CLI's own envelope out of the report", async () => {
    await mockExecutable();
    const result = await queryAlibabaTokenPlanSeats({
      runtime: linuxRuntime(async () => ({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("the console session was refused by the gateway"),
        timedOut: false,
        truncated: false,
      })),
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "seat_command_failed", message: ERROR_MESSAGES.seat_command_failed },
    });
    expect(JSON.stringify(result)).not.toContain("refused by the gateway");
  });

  it("rejects an unsupported platform for seats too, without spawning", async () => {
    const result = await queryAlibabaTokenPlanSeats({
      runtime: { platform: "aix", cwd: "/workspace", pathEnv: "/usr/bin" },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported_platform" } });
    expect(stat).not.toHaveBeenCalled();
  });
});
describe("alibaba token plan credential markers", () => {
  const AUTH_STATUS_ARGS = ["auth", "status", "--output", "json"];
  const CONSOLE_MASKED = "aa11...bb22";
  const API_KEY_MASKED = "sk-i...nvenT";
  const ACCESS_KEY_ID = "LTAI...0abc";
  const MARKERS = {
    consoleMasked: CONSOLE_MASKED,
    apiKeyMasked: API_KEY_MASKED,
    openapiAccessKeyId: ACCESS_KEY_ID,
  };
  /** The measured TTL the lib reuses a read for; a change here must change the lib too. */
  const IDENTITY_TTL_MS = 60_000;
  const ROTATED_CONSOLE_MASKED = "cc33...dd44";
  const AUTH_STATUS = JSON.stringify({
    authenticated: true,
    config: "token-plan",
    api_key: { source: "config", masked: API_KEY_MASKED },
    console: { source: "config", masked: CONSOLE_MASKED, region: "cn-beijing", site: "domestic" },
    openapi: { source: "env", access_key_id: ACCESS_KEY_ID, access_key_secret: "inve...nted" },
  });

  function statusSpawn(
    stdout: string,
    run: Partial<{
      code: number | null;
      timedOut: boolean;
      truncated: boolean;
      spawnErrorCode: string;
    }> = {},
  ) {
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    const spawn = async (request: AlibabaTokenPlanSpawnRequest) => {
      requests.push(request);
      return {
        code: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
        ...run,
      };
    };
    return { requests, spawn };
  }

  function runtime(spawn: (request: AlibabaTokenPlanSpawnRequest) => Promise<unknown>) {
    // The injected PATH must lose to `pathEnv`, so a case here proves that override once more.
    return { ...linuxRuntime(spawn), env: { PATH: "/wrong/bin", TEST_ENV: "preserved" } };
  }

  beforeEach(() => {
    clearAlibabaIdentityCacheForTests();
  });

  afterEach(() => {
    clearAlibabaIdentityCacheForTests();
    vi.useRealTimers();
  });

  it("reads every credential marker through the same bounded invocation machinery", async () => {
    await mockExecutable();
    const { requests, spawn } = statusSpawn(AUTH_STATUS);

    await expect(
      resolveAlibabaIdentity({ requestTimeoutMs: 4_321, runtime: runtime(spawn) }),
    ).resolves.toEqual(MARKERS);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.file).toBe("/trusted/bin/bl");
    expect(requests[0]?.args).toEqual(AUTH_STATUS_ARGS);
    expect(requests[0]?.shell).toBe(false);
    expect(requests[0]?.stdin).toBe("ignore");
    expect(requests[0]?.cwd).toBe("/safe-tmp");
    expect(requests[0]?.timeoutMs).toBe(4_321);
    expect(requests[0]?.stdoutLimitBytes).toBe(STDOUT_LIMIT_BYTES);
    expect(requests[0]?.stderrLimitBytes).toBe(STDERR_LIMIT_BYTES);
    expect(requests[0]?.killGraceMs).toBe(KILL_GRACE_MS);
    expect(requests[0]?.env).toEqual({ PATH: "/trusted/bin", TEST_ENV: "preserved" });
  });

  it("reuses one read within the TTL, then reads `bl` again once it expires", async () => {
    await mockExecutable();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { requests, spawn } = statusSpawn(AUTH_STATUS);
    const rt = runtime(spawn);

    await expect(resolveAlibabaIdentity({ runtime: rt })).resolves.toEqual(MARKERS);
    await expect(resolveAlibabaIdentity({ runtime: rt })).resolves.toEqual(MARKERS);
    expect(requests).toHaveLength(1);

    vi.setSystemTime(1_000_000 + IDENTITY_TTL_MS - 1);
    await resolveAlibabaIdentity({ runtime: rt });
    expect(requests).toHaveLength(1);

    vi.setSystemTime(1_000_000 + IDENTITY_TTL_MS);
    await resolveAlibabaIdentity({ runtime: rt });
    expect(requests).toHaveLength(2);
  });

  it("joins a caller that arrives mid-read to that one read instead of spawning again", async () => {
    await mockExecutable();
    const requests: AlibabaTokenPlanSpawnRequest[] = [];
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async (request: AlibabaTokenPlanSpawnRequest) => {
      requests.push(request);
      await inFlight;
      return {
        code: 0,
        stdout: Buffer.from(AUTH_STATUS),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
      };
    });
    const rt = runtime(spawn);

    // Both callers are in before the read settles, as `store.ts`'s two provider ids are.
    const first = resolveAlibabaIdentity({ runtime: rt });
    const second = resolveAlibabaIdentity({ runtime: rt });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([MARKERS, MARKERS]);
    expect(requests).toHaveLength(1);
  });

  it("does not leave a failed read cached, so a later caller reads again", async () => {
    await mockExecutable();
    await expect(
      resolveAlibabaIdentity({
        runtime: { platform: "linux", cwd: undefined, pathEnv: "/trusted/bin" } as never,
      }),
    ).rejects.toThrow();

    const { requests, spawn } = statusSpawn(AUTH_STATUS);
    await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toEqual(MARKERS);
    expect(requests).toHaveLength(1);
  });

  it("keeps the first account within the TTL, so a rotation inside it is seen only after expiry", async () => {
    await mockExecutable();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const first = statusSpawn(AUTH_STATUS);
    await resolveAlibabaIdentity({ runtime: runtime(first.spawn) });

    // The console account rotates inside `bl`; a read now would report the new one.
    const rotated = statusSpawn(
      JSON.stringify({
        api_key: { masked: API_KEY_MASKED },
        console: { masked: ROTATED_CONSOLE_MASKED },
        openapi: { access_key_id: ACCESS_KEY_ID },
      }),
    );
    const rotatedRuntime = runtime(rotated.spawn);

    await expect(resolveAlibabaIdentity({ runtime: rotatedRuntime })).resolves.toEqual(MARKERS);
    expect(rotated.requests).toHaveLength(0);

    vi.setSystemTime(2_000_000 + IDENTITY_TTL_MS);
    await expect(resolveAlibabaIdentity({ runtime: rotatedRuntime })).resolves.toMatchObject({
      consoleMasked: ROTATED_CONSOLE_MASKED,
    });
    expect(rotated.requests).toHaveLength(1);
  });

  it("clears the reuse on the test seam, so the next call reads `bl` again", async () => {
    await mockExecutable();
    const { requests, spawn } = statusSpawn(AUTH_STATUS);
    const rt = runtime(spawn);

    await expect(resolveAlibabaIdentity({ runtime: rt })).resolves.toEqual(MARKERS);
    clearAlibabaIdentityCacheForTests();
    await expect(resolveAlibabaIdentity({ runtime: rt })).resolves.toEqual(MARKERS);
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["a reply with no console object", { authenticated: true }],
    ["a console without masked", { console: { source: "config" } }],
    ["an empty masked", { console: { masked: "   " } }],
    ["a non-string masked", { console: { masked: 42 } }],
  ])("reads %s as a reply naming no credential, not a failed read", async (_name, payload) => {
    await mockExecutable();
    const { spawn } = statusSpawn(JSON.stringify(payload));
    await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toEqual({
      consoleMasked: null,
      apiKeyMasked: null,
      openapiAccessKeyId: null,
    });
  });

  it.each([
    ["a non-object root", []],
    ["a failure envelope", { error: { code: 3, message: "not signed in" } }],
  ])("falls back to a failed read for %s", async (_name, payload) => {
    await mockExecutable();
    const { spawn } = statusSpawn(JSON.stringify(payload));
    await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toBeNull();
  });

  it.each([
    ["a reply with no api_key or openapi block", { console: { masked: CONSOLE_MASKED } }],
    [
      "a non-string api_key.masked",
      { console: { masked: CONSOLE_MASKED }, api_key: { masked: 7 } },
    ],
    ["an empty openapi.access_key_id", { console: { masked: CONSOLE_MASKED }, openapi: {} }],
  ])("records absent credentials as null for %s, never an empty string", async (_name, payload) => {
    await mockExecutable();
    const { spawn } = statusSpawn(JSON.stringify(payload));
    await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toEqual({
      consoleMasked: CONSOLE_MASKED,
      apiKeyMasked: null,
      openapiAccessKeyId: null,
    });
  });

  it.each([
    [
      // The population that most needs a slot, and the one the console was never signed in for.
      "an AK/SK-only account",
      { authenticated: true, openapi: { source: "env", access_key_id: ACCESS_KEY_ID } },
      { consoleMasked: null, apiKeyMasked: null, openapiAccessKeyId: ACCESS_KEY_ID },
    ],
    [
      "a model-API-key-only account",
      { authenticated: true, api_key: { masked: API_KEY_MASKED } },
      { consoleMasked: null, apiKeyMasked: API_KEY_MASKED, openapiAccessKeyId: null },
    ],
  ])(
    "derives an identity from whichever markers %s has, requiring no one of them",
    async (_name, payload, expected) => {
      await mockExecutable();
      const { spawn } = statusSpawn(JSON.stringify(payload));
      await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toEqual(expected);
    },
  );

  it.each([
    [
      "the half a user never set up is left out, so nothing backs off on it",
      { consoleMasked: null, apiKeyMasked: null, openapiAccessKeyId: ACCESS_KEY_ID },
      { console: false, openapi: true },
    ],
    [
      "a console-only account has the personal half alone",
      { consoleMasked: CONSOLE_MASKED, apiKeyMasked: null, openapiAccessKeyId: null },
      { console: true, openapi: false },
    ],
    ["a fully configured account has both", MARKERS, { console: true, openapi: true }],
    [
      "a model-API-key-only account reports neither, since neither command's credential is set up",
      { consoleMasked: null, apiKeyMasked: API_KEY_MASKED, openapiAccessKeyId: null },
      { console: false, openapi: false },
    ],
    [
      "a reply naming no credential leaves both out, since neither was set up",
      { consoleMasked: null, apiKeyMasked: null, openapiAccessKeyId: null },
      { console: false, openapi: false },
    ],
    [
      "a read that failed keeps both, since absence cannot be told from failure",
      null,
      { console: true, openapi: true },
    ],
  ])("%s", (_name, markers, expected) => {
    expect(alibabaCredentialHalves(markers)).toEqual(expected);
  });

  it.each([
    ["not JSON", "not json", {}],
    ["an empty reply", "", {}],
    ["a nonzero exit", "", { code: 1 }],
    ["a timeout", "", { code: null, timedOut: true }],
    ["an output overflow", "", { code: 0, truncated: true }],
    ["a vanished executable", "", { code: null, spawnErrorCode: "ENOENT" }],
  ])("falls back to no identity for %s, without throwing", async (_name, stdout, run) => {
    await mockExecutable();
    const { spawn } = statusSpawn(stdout, run);
    await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toBeNull();
  });

  it("falls back to no identity when the spawn itself throws", async () => {
    await mockExecutable();
    const spawn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(resolveAlibabaIdentity({ runtime: runtime(spawn) })).resolves.toBeNull();
  });

  it("falls back to no identity when the CLI cannot be resolved", async () => {
    await expect(
      resolveAlibabaIdentity({
        runtime: { platform: "aix", cwd: "/workspace", pathEnv: "/usr/bin" },
      }),
    ).resolves.toBeNull();
  });

  it("never surfaces a marker value in the user-facing error messages", () => {
    const messages = Object.values(ERROR_MESSAGES).join("\n");
    for (const raw of ["aa11...bb22", "sk-i...nvenT", "LTAI...0abc"]) {
      expect(messages).not.toContain(raw);
    }
    expect(messages).not.toContain("masked");
  });
});

describe("parseAlibabaCodingPlanUsageJson", () => {
  const FIVE_HOUR = 1_786_000_000_000;
  const WEEKLY = 1_786_100_000_000;
  const MONTHLY = 1_786_200_000_000;

  it("reads the three windows and inverts each window's used fraction", () => {
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({
        instanceType: "pro",
        per5Hour: { usedQuota: 38, totalQuota: 100, resetTime: FIVE_HOUR },
        perWeek: { usedQuota: 500, totalQuota: 1000, resetTime: WEEKLY },
        perBillMonth: { usedQuota: 950, totalQuota: 1000, resetTime: MONTHLY },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      usage: {
        fiveHour: {
          used: 38,
          limit: 100,
          percentRemaining: 62,
          resetTimeIso: new Date(FIVE_HOUR).toISOString(),
        },
        weekly: {
          used: 500,
          limit: 1000,
          percentRemaining: 50,
          resetTimeIso: new Date(WEEKLY).toISOString(),
        },
        monthly: {
          used: 950,
          limit: 1000,
          percentRemaining: 5,
          resetTimeIso: new Date(MONTHLY).toISOString(),
        },
      },
    });
  });

  it("derives the percentage from the counts, never from a percentage field that disagrees", () => {
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({
        instanceType: "lite",
        per5Hour: { usedQuota: 25, totalQuota: 100, percentage: 0.9 },
      }),
    );

    expect(parsed.ok && parsed.usage?.fiveHour?.percentRemaining).toBe(75);
  });

  it("keeps a window whose used count passed its limit at zero, not below it", () => {
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({
        instanceType: "pro",
        per5Hour: { usedQuota: 120, totalQuota: 100 },
      }),
    );

    expect(parsed.ok && parsed.usage?.fiveHour?.percentRemaining).toBe(0);
  });

  it("leaves out a window whose total is 0, which is no subscription for it", () => {
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({
        instanceType: "pro",
        perWeek: { usedQuota: 0, totalQuota: 0, resetTime: WEEKLY },
      }),
    );

    expect(parsed).toEqual({ ok: true });
  });

  it("leaves out a window whose count is not a number", () => {
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({
        instanceType: "pro",
        per5Hour: { usedQuota: "38", totalQuota: 100, resetTime: FIVE_HOUR },
      }),
    );

    expect(parsed).toEqual({ ok: true });
  });

  it("leaves out a window the reply does not carry", () => {
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({ instanceType: "lite", perBillMonth: { usedQuota: 1, totalQuota: 4 } }),
    );

    expect(parsed).toEqual({
      ok: true,
      usage: { monthly: { used: 1, limit: 4, percentRemaining: 75 } },
    });
  });

  it("reads {} as no Coding Plan subscription, silently", () => {
    expect(parseAlibabaCodingPlanUsageJson("{}")).toEqual({ ok: true });
  });

  it.each([
    ["a window that is not an object", { instanceType: "pro", perWeek: "500" }],
    ["a reply that is not an object", []],
  ])("rejects %s", (_name, reply) => {
    expect(parseAlibabaCodingPlanUsageJson(JSON.stringify(reply))).toMatchObject({
      ok: false,
      error: { kind: "coding_plan_invalid_schema" },
    });
  });

  it("does not parse invalid JSON", () => {
    expect(parseAlibabaCodingPlanUsageJson("{")).toMatchObject({
      ok: false,
      error: { kind: "invalid_json" },
    });
  });

  it("keeps the CLI's own words and exit code from a failure envelope", () => {
    expect(
      parseAlibabaCodingPlanUsageJson(
        JSON.stringify({ error: { code: 3, message: "the session token was refused" } }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "not_authenticated",
        message: "the session token was refused",
        facts: { code: "login_expired" },
      },
    });
  });
});
