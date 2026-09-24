import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALIBABA_TOKEN_PLAN_ARGS,
  ALIBABA_TOKEN_PLAN_COMMAND,
  ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
  ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
  ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
  type AlibabaTokenPlanSpawnRequest,
  listTrustedPathDirectories,
  parseAlibabaTokenPlanUsageJson,
  queryAlibabaTokenPlanQuota,
  resolveAlibabaTokenPlanExecutable,
  runAlibabaTokenPlanProcess,
} from "../src/lib/alibaba-token-plan.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat), realpath: vi.fn(fs.realpath) };
});

const created: string[] = [];

afterEach(async () => {
  vi.mocked(lstat).mockReset();
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
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, source, { encoding: "utf8", mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

async function mockExecutable(file = "/trusted/bin/bl", target = file): Promise<void> {
  const stats = await lstat(process.execPath);
  vi.mocked(lstat).mockImplementation(async (candidate) => {
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
    args: ALIBABA_TOKEN_PLAN_ARGS,
    cwd: path.dirname(file),
    env: {
      PATH: `${path.dirname(file)}${path.delimiter}${path.dirname(process.execPath)}`,
    },
    timeoutMs: 5_000,
    stdoutLimitBytes: ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    platform: process.platform,
    killGraceMs: ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
    ...overrides,
  };
}

describe("alibaba token plan parser", () => {
  it("converts official used fractions and epoch-ms resets", () => {
    const fiveHourReset = Date.parse("2024-04-24T22:13:20.000Z");
    const weeklyReset = Date.parse("2024-05-01T20:53:20.000Z");
    const result = parseAlibabaTokenPlanUsageJson(
      JSON.stringify({
        per5HourPercentage: 0.2,
        per5HourResetTime: fiveHourReset,
        per1WeekPercentage: 0.8,
        per1WeekResetTime: weeklyReset,
      }),
    );
    expect(result).toEqual({
      ok: true,
      fiveHour: {
        percentRemaining: 80,
        resetTimeIso: "2024-04-24T22:13:20.000Z",
      },
      weekly: {
        percentRemaining: 20,
        resetTimeIso: "2024-05-01T20:53:20.000Z",
      },
    });
  });

  it("keeps independently optional windows and does not fabricate the missing one", () => {
    const weeklyReset = Date.parse("2024-05-01T20:53:20.000Z");
    expect(
      parseAlibabaTokenPlanUsageJson(
        JSON.stringify({
          per1WeekPercentage: 0.4,
          per1WeekResetTime: weeklyReset,
        }),
      ),
    ).toEqual({
      ok: true,
      weekly: {
        percentRemaining: 60,
        resetTimeIso: "2024-05-01T20:53:20.000Z",
      },
    });
  });

  it("allows a present percentage without a reset and rejects a reset without a percentage", () => {
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify({ per5HourPercentage: 0 }))).toEqual({
      ok: true,
      fiveHour: { percentRemaining: 100 },
    });
    expect(
      parseAlibabaTokenPlanUsageJson(JSON.stringify({ per5HourResetTime: 1_714_000_000_000 })),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_schema",
        message: "Alibaba Cloud CLI returned an invalid Personal Token Plan payload.",
      },
    });
  });

  it("treats a present malformed field as invalid instead of dropping the window", () => {
    expect(
      parseAlibabaTokenPlanUsageJson(
        JSON.stringify({
          per5HourPercentage: 1.2,
          per1WeekPercentage: 0.1,
          per1WeekResetTime: 1_714_600_000_000,
        }),
      ).ok,
    ).toBe(false);
    expect(parseAlibabaTokenPlanUsageJson("{").ok).toBe(false);
    expect(parseAlibabaTokenPlanUsageJson("[]").ok).toBe(false);
  });

  it("does not fabricate an empty success when no windows are present", () => {
    expect(parseAlibabaTokenPlanUsageJson("{}")).toEqual({
      ok: false,
      error: {
        kind: "no_data",
        message: "Alibaba Personal Token Plan usage returned no quota windows.",
      },
    });
  });

  it("keeps used and remaining percent precision until shared rendering", () => {
    const used = 0.123456789;
    const remaining = 100 - used * 100;
    const result = parseAlibabaTokenPlanUsageJson(JSON.stringify({ per5HourPercentage: used }));
    expect(result).toEqual({
      ok: true,
      fiveHour: { percentRemaining: remaining },
    });
    expect(remaining).not.toBe(Math.round((1 - used) * 10000) / 100);
  });

  it("maps full exhaustion to 0 remaining and unused quota to 100 remaining", () => {
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify({ per5HourPercentage: 1 }))).toEqual({
      ok: true,
      fiveHour: { percentRemaining: 0 },
    });
    expect(parseAlibabaTokenPlanUsageJson(JSON.stringify({ per1WeekPercentage: 0 }))).toEqual({
      ok: true,
      weekly: { percentRemaining: 100 },
    });
  });

  it("rejects malformed reset timestamps instead of dropping the window", () => {
    const used = { per5HourPercentage: 0.2 };
    for (const reset of [
      "1714000000000",
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      5_000_000_000_000,
    ]) {
      expect(
        parseAlibabaTokenPlanUsageJson(JSON.stringify({ ...used, per5HourResetTime: reset })),
      ).toEqual({
        ok: false,
        error: {
          kind: "invalid_schema",
          message: "Alibaba Cloud CLI returned an invalid Personal Token Plan payload.",
        },
      });
    }
  });
});

describe("alibaba token plan PATH trust", () => {
  it.each([
    {
      platform: "linux" as const,
      cwd: "/workspace",
      bin: "/workspace-sibling/bin",
      delimiter: ":",
    },
    {
      platform: "win32" as const,
      cwd: "C:\\workspace",
      bin: "C:\\workspace-sibling\\bin",
      delimiter: ";",
    },
  ])("uses $platform PATH semantics independently of the host", ({
    platform,
    cwd,
    bin,
    delimiter,
  }) => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const parent = paths.dirname(cwd);
    expect(
      listTrustedPathDirectories({
        platform,
        cwd,
        pathEnv: [cwd, paths.join(cwd, "..bin"), ".", "relative", bin, bin, parent].join(delimiter),
      }),
    ).toEqual([bin, parent]);
  });

  it.each(["cmd", "bat"])("classifies bl.%s as a rejected shell launcher", async (extension) => {
    await mockExecutable(`/trusted/bin/bl.${extension}`);
    const result = await resolveAlibabaTokenPlanExecutable({
      platform: "linux",
      cwd: "/workspace",
      pathEnv: "/trusted/bin",
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "shell_launcher_rejected",
        message: "Alibaba Personal Token Plan refused a shell launcher for bl.",
      },
    });
  });

  it("reports missing executables when no launcher exists", async () => {
    await mockExecutable("/elsewhere/bl");
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "linux",
        cwd: "/workspace",
        pathEnv: "/trusted/bin",
      }),
    ).toMatchObject({ ok: false, error: { kind: "executable_not_found" } });
  });

  it.each([
    "bin",
    "..bin",
  ])("rejects a trusted PATH executable resolving into workspace %s/bl", async (directory) => {
    await mockExecutable("/trusted/bin/bl", `/workspace/${directory}/bl`);
    const result = await resolveAlibabaTokenPlanExecutable({
      platform: "linux",
      cwd: "/workspace",
      pathEnv: "/trusted/bin",
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "workspace_path_rejected" } });
  });

  it("accepts a trusted PATH executable resolving into an external workspace sibling", async () => {
    const target = "/workspace-sibling/..bin/bl";
    await mockExecutable("/trusted/bin/bl", target);
    expect(
      await resolveAlibabaTokenPlanExecutable({
        platform: "linux",
        cwd: "/workspace",
        pathEnv: "/trusted/bin",
      }),
    ).toEqual({ ok: true, file: target });
  });

  it("keeps only absolute PATH directories outside the workspace", async () => {
    const workspace = await makeDir();
    const trusted = await makeDir();
    const relative = "bin";
    const dirs = listTrustedPathDirectories({
      pathEnv: [
        trusted,
        relative,
        ".",
        workspace,
        path.join(workspace, "node_modules", ".bin"),
      ].join(path.delimiter),
      cwd: workspace,
      platform: process.platform,
    });
    expect(dirs).toEqual([trusted]);
  });

  it.each([
    "bin",
    "..bin",
  ])("rejects workspace %s/bl even when PATH points at it with an absolute path", async (directory) => {
    const workspace = "/workspace";
    const workspaceBin = `/workspace/${directory}`;
    await mockExecutable(`${workspaceBin}/bl`);
    const resolved = await resolveAlibabaTokenPlanExecutable({
      pathEnv: workspaceBin,
      cwd: workspace,
      platform: "darwin",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected rejection");
    expect(resolved.error.kind).toBe("executable_not_found");
  });

  it("rejects unsupported platforms instead of probing PATH", async () => {
    const resolved = await resolveAlibabaTokenPlanExecutable({
      pathEnv: "/usr/bin",
      cwd: await makeDir(),
      platform: "aix",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected rejection");
    expect(resolved.error.kind).toBe("unsupported_platform");
    const queried = await queryAlibabaTokenPlanQuota({
      runtime: { platform: "aix", cwd: await makeDir(), pathEnv: "/usr/bin" },
    });
    expect(queried.ok).toBe(false);
    if (queried.ok) throw new Error("expected rejection");
    expect(queried.error.kind).toBe("unsupported_platform");
  });

  it("rejects native win32 instead of probing PATH", async () => {
    const bin = await makeDir();
    await writeUnixExecutable(bin, "bl.exe", "#!/bin/sh\nexit 0\n");
    const resolved = await resolveAlibabaTokenPlanExecutable({
      pathEnv: bin,
      cwd: await makeDir(),
      platform: "win32",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected rejection");
    expect(resolved.error.kind).toBe("unsupported_platform");

    const queried = await queryAlibabaTokenPlanQuota({
      runtime: { platform: "win32", cwd: await makeDir(), pathEnv: bin },
    });
    expect(queried.ok).toBe(false);
    if (queried.ok) throw new Error("expected rejection");
    expect(queried.error.kind).toBe("unsupported_platform");
  });

  it.runIf(process.platform !== "win32")(
    "rejects .cmd and .bat launchers on supported platforms",
    async () => {
      const bin = await makeDir();
      const { symlink } = await import("node:fs/promises");
      await writeUnixExecutable(bin, "launcher.cmd", "@echo off\r\n");
      await writeUnixExecutable(bin, "launcher.bat", "@echo off\r\n");
      await symlink(path.join(bin, "launcher.cmd"), path.join(bin, "bl"));
      const cmd = await resolveAlibabaTokenPlanExecutable({
        pathEnv: bin,
        cwd: await makeDir(),
        platform: "linux",
      });
      expect(cmd.ok).toBe(false);
      if (cmd.ok) throw new Error("expected rejection");
      expect(cmd.error.kind).toBe("shell_launcher_rejected");

      await rm(path.join(bin, "bl"));
      await symlink(path.join(bin, "launcher.bat"), path.join(bin, "bl"));
      const bat = await resolveAlibabaTokenPlanExecutable({
        pathEnv: bin,
        cwd: await makeDir(),
        platform: "darwin",
      });
      expect(bat.ok).toBe(false);
      if (bat.ok) throw new Error("expected rejection");
      expect(bat.error.kind).toBe("shell_launcher_rejected");
    },
  );

  it("rejects shell launchers instead of bridging through them", async () => {
    const bin = "/trusted/bin";
    await mockExecutable(`${bin}/bl`, "/bin/sh");
    const resolved = await resolveAlibabaTokenPlanExecutable({
      pathEnv: bin,
      cwd: "/workspace",
      platform: "darwin",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected rejection");
    expect(resolved.error.kind).toBe("shell_launcher_rejected");
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
    expect(requests[0]?.args).toEqual([...ALIBABA_TOKEN_PLAN_ARGS]);
    expect(requests[0]?.shell).toBe(false);
    expect(requests[0]?.stdin).toBe("ignore");
    expect(requests[0]?.file).toBe(`${bin}/${ALIBABA_TOKEN_PLAN_COMMAND}`);
    expect(requests[0]?.cwd).toBe("/safe-tmp");
    expect(requests[0]?.platform).toBe("linux");
    expect(requests[0]?.env).toEqual({ PATH: bin, TEST_ENV: "preserved" });
    expect(requests[0]?.stdoutLimitBytes).toBe(ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES);
    expect(requests[0]?.stderrLimitBytes).toBe(ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES);
    expect(requests[0]?.killGraceMs).toBe(ALIBABA_TOKEN_PLAN_KILL_GRACE_MS);
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
    expect(requests[0]?.platform).toBe("darwin");
    expect(requests[0]?.env.PATH).toBe("/trusted/bin");

    expect(
      await queryAlibabaTokenPlanQuota({ runtime: { ...runtime, pathEnv: "" } }),
    ).toMatchObject({ ok: false, error: { kind: "executable_not_found" } });
    expect(requests).toHaveLength(1);
  });

  it("maps timeout and overflow without leaking stdout or stderr", async () => {
    const bin = "/trusted/bin";
    await mockExecutable();
    const timedOut = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        pathEnv: bin,
        cwd: "/workspace",
        tmpdir: "/safe-tmp",
        homedir: "/safe-home",
        spawn: async () => ({
          code: null,
          stdout: Buffer.from("secret-stdout"),
          stderr: Buffer.from("secret-stderr"),
          timedOut: true,
          truncated: false,
        }),
      },
    });
    expect(timedOut).toEqual({
      ok: false,
      error: {
        kind: "timeout",
        message: "Timed out while running the Alibaba Cloud CLI.",
        retryable: true,
      },
    });
    expect(JSON.stringify(timedOut)).not.toContain("secret-");

    const truncated = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        pathEnv: bin,
        cwd: "/workspace",
        tmpdir: "/safe-tmp",
        homedir: "/safe-home",
        spawn: async () => ({
          code: 0,
          stdout: Buffer.from("secret-stdout"),
          stderr: Buffer.from("secret-stderr"),
          timedOut: false,
          truncated: true,
        }),
      },
    });
    expect(truncated.ok).toBe(false);
    if (truncated.ok) throw new Error("expected failure");
    expect(truncated.error.kind).toBe("output_truncated");
    expect(JSON.stringify(truncated)).not.toContain("secret-");
  });

  it("treats exit 3 as missing console auth without exposing CLI output", async () => {
    const bin = "/trusted/bin";
    await mockExecutable();
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        pathEnv: bin,
        cwd: "/workspace",
        tmpdir: "/safe-tmp",
        homedir: "/safe-home",
        spawn: async () => ({
          code: 3,
          stdout: Buffer.from("token=abc"),
          stderr: Buffer.from("no console access token found"),
          timedOut: false,
          truncated: false,
        }),
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "not_authenticated",
        message:
          "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("token=abc");
    expect(JSON.stringify(result)).not.toContain("no console access token found");
  });

  it("categorizes a generic nonzero exit separately from console auth failure", async () => {
    const bin = "/trusted/bin";
    await mockExecutable();
    const result = await queryAlibabaTokenPlanQuota({
      runtime: {
        platform: "linux",
        pathEnv: bin,
        cwd: "/workspace",
        tmpdir: "/safe-tmp",
        homedir: "/safe-home",
        spawn: async () => ({
          code: 1,
          stdout: Buffer.from("token=abc"),
          stderr: Buffer.from("usage failed"),
          timedOut: false,
          truncated: false,
        }),
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "nonzero_exit",
        message: "Could not read Alibaba Personal Token Plan quota.",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).not.toBe("not_authenticated");
    expect(JSON.stringify(result)).not.toContain("token=abc");
    expect(JSON.stringify(result)).not.toContain("usage failed");
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
      const seenPayload = JSON.parse(
        await (await import("node:fs/promises")).readFile(seen, "utf8"),
      ) as {
        argv: string[];
        cwd: string;
        stdin: string;
      };
      expect(seenPayload.argv).toEqual([...ALIBABA_TOKEN_PLAN_ARGS]);
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
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs + ALIBABA_TOKEN_PLAN_KILL_GRACE_MS);
      expect(await (await import("node:fs/promises")).readFile(termSeen, "utf8")).toBe("term");
    },
  );

  it.runIf(process.platform !== "win32")(
    "runner treats real stdout overflow as truncated and stops the child",
    async () => {
      const bin = await makeDir();
      const file = await writeUnixExecutable(
        bin,
        "bl",
        `#!/usr/bin/env node
process.stdout.write("x".repeat(128));
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
      expect(result.stdout.length).toBe(32);
      expect(result.stdout.toString("utf8")).toBe("x".repeat(32));
    },
  );

  it.runIf(process.platform !== "win32")(
    "runner treats real stderr overflow as truncated and stops the child",
    async () => {
      const bin = await makeDir();
      const file = await writeUnixExecutable(
        bin,
        "bl",
        `#!/usr/bin/env node
process.stderr.write("e".repeat(128));
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
      expect(result.stderr.length).toBe(32);
      expect(result.stderr.toString("utf8")).toBe("e".repeat(32));
    },
  );
});
