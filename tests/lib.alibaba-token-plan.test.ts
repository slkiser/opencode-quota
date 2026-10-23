import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type AlibabaTokenPlanSpawnRequest,
  parseAlibabaTokenPlanUsageJson,
  queryAlibabaTokenPlanQuota,
  resolveAlibabaTokenPlanExecutable,
  runAlibabaTokenPlanProcess,
} from "../src/lib/alibaba-token-plan.js";

// The `bl` CLI contract, written out by hand so a changed production constant fails here.
const BL_COMMAND = "bl";
const BL_ARGS = ["usage", "token-plan", "--output", "json"];
const STDOUT_LIMIT_BYTES = 262_144;
const STDERR_LIMIT_BYTES = 16_384;
const KILL_GRACE_MS = 250;

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat), realpath: vi.fn(fs.realpath) };
});

const created: string[] = [];

afterEach(async () => {
  vi.mocked(stat).mockReset();
  vi.mocked(realpath).mockReset();
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

/** Fake filesystem: only `file` (resolving to `target`) exists. */
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

function capturedSpawn(requests: AlibabaTokenPlanSpawnRequest[]) {
  return async (request: AlibabaTokenPlanSpawnRequest) => {
    requests.push(request);
    return {
      code: 0,
      stdout: Buffer.from(
        JSON.stringify({
          per5HourPercentage: 0.25,
          per5HourResetTime: 1_714_000_000_000,
          per1WeekPercentage: 0.5,
          per1WeekResetTime: 1_714_600_000_000,
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

const INVALID_SCHEMA = {
  ok: false,
  error: {
    kind: "invalid_schema",
    message: "Alibaba Cloud CLI returned an invalid Personal Token Plan payload.",
  },
};

describe("alibaba token plan parser", () => {
  it.each([
    {
      name: "official used fractions and epoch-ms resets",
      payload: {
        per5HourPercentage: 0.2,
        per5HourResetTime: Date.parse("2024-04-24T22:13:20.000Z"),
        per1WeekPercentage: 0.8,
        per1WeekResetTime: Date.parse("2024-05-01T20:53:20.000Z"),
      },
      expected: {
        ok: true,
        fiveHour: { percentRemaining: 80, resetTimeIso: "2024-04-24T22:13:20.000Z" },
        weekly: { percentRemaining: 20, resetTimeIso: "2024-05-01T20:53:20.000Z" },
      },
    },
    {
      name: "one window without fabricating the missing one",
      payload: {
        per1WeekPercentage: 0.4,
        per1WeekResetTime: Date.parse("2024-05-01T20:53:20.000Z"),
      },
      expected: {
        ok: true,
        weekly: { percentRemaining: 60, resetTimeIso: "2024-05-01T20:53:20.000Z" },
      },
    },
    {
      name: "a percentage without a reset",
      payload: { per5HourPercentage: 0 },
      expected: { ok: true, fiveHour: { percentRemaining: 100 } },
    },
    {
      name: "full exhaustion and unused quota",
      payload: { per5HourPercentage: 1, per1WeekPercentage: 0 },
      expected: { ok: true, fiveHour: { percentRemaining: 0 }, weekly: { percentRemaining: 100 } },
    },
    {
      name: "unrounded precision until shared rendering",
      payload: { per5HourPercentage: 0.123456789 },
      expected: { ok: true, fiveHour: { percentRemaining: 100 - 0.123456789 * 100 } },
    },
  ])("parses $name", ({ payload, expected }) => {
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify(payload))).toEqual(expected);
  });

  it.each([
    ["a reset without a percentage", { per5HourResetTime: 1_714_000_000_000 }],
    [
      "a percentage above 1 next to a valid window",
      { per5HourPercentage: 1.2, per1WeekPercentage: 0.1, per1WeekResetTime: 1_714_600_000_000 },
    ],
    ["a string reset", { per5HourPercentage: 0.2, per5HourResetTime: "1714000000000" }],
    ["a zero reset", { per5HourPercentage: 0.2, per5HourResetTime: 0 }],
    ["a negative reset", { per5HourPercentage: 0.2, per5HourResetTime: -1 }],
    ["a null (non-finite) reset", { per5HourPercentage: 0.2, per5HourResetTime: null }],
    ["a reset past 2100", { per5HourPercentage: 0.2, per5HourResetTime: 5_000_000_000_000 }],
    ["a non-object root", []],
  ])("rejects %s instead of dropping the window", (_name, payload) => {
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify(payload))).toEqual(INVALID_SCHEMA);
  });

  it("rejects invalid JSON and a payload without windows", () => {
    expect(parseAlibabaTokenPlanUsageJson("{")).toEqual({
      ok: false,
      error: { kind: "invalid_json", message: "Alibaba Cloud CLI did not return valid JSON." },
    });
    expect(parseAlibabaTokenPlanUsageJson("{}")).toEqual({
      ok: false,
      error: {
        kind: "no_data",
        message: "Alibaba Personal Token Plan usage returned no quota windows.",
      },
    });
  });
});

describe("alibaba token plan executable resolution", () => {
  const NVM_BL = "/home/user/.nvm/versions/node/v22.0.0/lib/node_modules/bailian-cli/bin/bl";

  it("names the rejected shell launcher in its error", async () => {
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
        message: "Alibaba Personal Token Plan refused a shell launcher for bl.",
      },
    });
  });

  // PATH is /trusted/bin and quota is computed for /workspace unless a row says otherwise.
  it.each([
    { name: "a bl.bat launcher", file: "/trusted/bin/bl.bat", kind: "shell_launcher_rejected" },
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

  it.each(["aix", "win32"] as const)("rejects %s instead of probing PATH", async (platform) => {
    const expected = { ok: false, error: { kind: "unsupported_platform" } };
    const params = { platform, cwd: "/workspace", pathEnv: "/usr/bin" };
    expect(await resolveAlibabaTokenPlanExecutable(params)).toMatchObject(expected);
    expect(await queryAlibabaTokenPlanQuota({ runtime: params })).toMatchObject(expected);
    expect(stat).not.toHaveBeenCalled();
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
        message: "Timed out while running the Alibaba Cloud CLI.",
      },
    },
    {
      name: "an output overflow",
      run: { code: 0, truncated: true },
      error: {
        kind: "output_truncated",
        message: "Alibaba Cloud CLI output exceeded the bounded size limit.",
      },
    },
    {
      name: "exit 3 as missing console auth",
      run: { code: 3 },
      error: {
        kind: "not_authenticated",
        message:
          "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
      },
    },
    {
      name: "a generic nonzero exit separately from console auth",
      run: { code: 1 },
      error: { kind: "nonzero_exit", message: "Could not read Alibaba Personal Token Plan quota." },
    },
    {
      name: "a vanished executable",
      run: { code: null, spawnErrorCode: "ENOENT" },
      error: {
        kind: "executable_not_found",
        message: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
      },
    },
    {
      name: "another spawn error",
      run: { code: null, spawnErrorCode: "EACCES" },
      error: {
        kind: "spawn_failed",
        message: "Could not start Alibaba Cloud CLI.",
      },
    },
  ])("maps $name without leaking CLI output", async ({ run, error }) => {
    await mockExecutable();
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        pathEnv: "/trusted/bin",
        cwd: "/workspace",
        tmpdir: "/safe-tmp",
        homedir: "/safe-home",
        spawn: async () => ({
          stdout: Buffer.from("secret-stdout token=abc"),
          stderr: Buffer.from("secret-stderr no console access token found"),
          timedOut: false,
          truncated: false,
          ...run,
        }),
      },
    });
    expect(result).toEqual({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain("secret-");
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
    per5HourPercentage: 0.1,
    per5HourResetTime: 1714000000000,
    per1WeekPercentage: 0.3,
    per1WeekResetTime: 1714600000000
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
});
