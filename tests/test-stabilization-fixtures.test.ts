import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assertFixtureContentsAreIsolated,
  assertFrozenFixtureFiles,
  buildFixtureChildEnv,
  buildVitePlusArgs,
  cleanupFixtureSandbox,
  FIXTURE_STRIP_ENV_VARS,
  FIXTURE_TEMP_PREFIX,
  FIXTURE_TEST_FILES,
  getFixturesUsage,
  parseFixturesArgs,
  prepareFixtureSandbox,
  resolveVitePlusExecutable,
  runFixtures,
} from "../scripts/test-stabilization-fixtures.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/test-stabilization-fixtures.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts?: Record<string, string>;
};

let tempDir: string | undefined;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDir = dir;
  return dir;
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function runScript(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
}

async function prefixDirs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(FIXTURE_TEMP_PREFIX));
}

async function waitForFile(filePath: string, expected?: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const contents = await readFile(filePath, "utf8");
      if (expected === undefined || contents === expected) return contents;
    } catch {
      // The child has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await readFile(filePath, "utf8");
}

function captureIo() {
  const logs: string[] = [];
  return {
    logs,
    stdout: {
      write(chunk: string) {
        logs.push(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        logs.push(chunk);
        return true;
      },
    },
  };
}

describe("test-stabilization-fixtures", () => {
  it("keeps a frozen fake-data file list and package command", () => {
    expect(FIXTURE_TEST_FILES).toEqual([
      "tests/lib.config-symlink-write.test.ts",
      "tests/lib.config-write-target.test.ts",
      "tests/lib.atomic-json.test.ts",
      "tests/lib.opencode-go.test.ts",
      "tests/providers.opencode-go.test.ts",
      "tests/providers.opencode-go.surfaces.test.ts",
      "tests/providers.synthetic.test.ts",
      "tests/providers.synthetic.surfaces.test.ts",
      "tests/lib.openrouter.test.ts",
      "tests/providers.openrouter.test.ts",
      "tests/providers.openrouter.surfaces.test.ts",
      "tests/lib.alibaba-token-plan.test.ts",
      "tests/providers.alibaba-token-plan.test.ts",
      "tests/lib.quota-status.test.ts",
      "tests/quota-render-data.test.ts",
      "tests/tui-runtime.test.ts",
      "tests/tui-prompt-bar-format.test.ts",
      "tests/lib.quota-export.test.ts",
      "tests/lib.quota-export.production-policy.test.ts",
      "tests/lib.api-key-provider-queries.test.ts",
      "tests/lib.provider-api-key-configs.test.ts",
      "tests/lib.api-key-resolver.test.ts",
      "tests/contribution-guidance.test.ts",
    ]);
    expect(pkg.scripts?.["test:stabilization:fixtures"]).toBe(
      "node scripts/test-stabilization-fixtures.mjs",
    );
    expect(pkg.scripts?.["test:stabilization:tui"]).toBe(
      "node scripts/test-stabilization-connected.mjs --tui",
    );
    expect(pkg.scripts?.["test:stabilization:tui:prompt-bar"]).toBe(
      "node scripts/test-stabilization-connected.mjs --tui --prompt-bar",
    );
    expect(pkg.scripts?.["test:stabilization:web"]).toBe(
      "node scripts/test-stabilization-connected.mjs --web",
    );
    expect(parseFixturesArgs(["--dry-run"])).toEqual({ dryRun: true, help: false });
    expect(getFixturesUsage()).toContain("bl executable");
    expect(FIXTURE_STRIP_ENV_VARS).toContain("OPENCODE_CONFIG");
    expect(FIXTURE_STRIP_ENV_VARS).toContain("OPENCODE_CONFIG_DIR");
    expect(FIXTURE_STRIP_ENV_VARS).toContain("OPENROUTER_API_KEY");
  });

  it("builds a no-shell Vite+ test command with the repo executable and fixed args", () => {
    const vitePlusCli = resolveVitePlusExecutable(repoRoot);
    expect(vitePlusCli).toBe(path.join(repoRoot, "node_modules", "vite-plus", "bin", "vp"));
    expect(buildVitePlusArgs()).toEqual(["test", "run", ...FIXTURE_TEST_FILES]);
    assertFrozenFixtureFiles([...FIXTURE_TEST_FILES]);
    expect(() => assertFrozenFixtureFiles(["tests/http.test.ts"])).toThrow(/allowlist/);
    expect(() => assertFrozenFixtureFiles([...FIXTURE_TEST_FILES, "tests/http.test.ts"])).toThrow(
      /allowlist/,
    );
  });

  it("rejects selected tests that would escape mocks into bl, a shell, or live HTTP", () => {
    const isolated: Record<string, string> = Object.fromEntries(
      FIXTURE_TEST_FILES.map((file) => [file, "describe('ok', () => {})\n"]),
    );
    expect(() => assertFixtureContentsAreIsolated(isolated)).not.toThrow();

    expect(() =>
      assertFixtureContentsAreIsolated({
        ...isolated,
        "tests/lib.alibaba-token-plan.test.ts": 'spawn("bl", ["usage"]);\n',
      }),
    ).toThrow(/real bl executable/);

    expect(() =>
      assertFixtureContentsAreIsolated({
        ...isolated,
        "tests/lib.openrouter.test.ts": "spawn(process.execPath, ['x'], { shell: true });\n",
      }),
    ).toThrow(/shell/);

    expect(() =>
      assertFixtureContentsAreIsolated({
        ...isolated,
        "tests/providers.openrouter.test.ts": 'await fetch("https://openrouter.ai/api/v1/key");\n',
      }),
    ).toThrow(/live OpenRouter/);

    expect(() =>
      assertFixtureContentsAreIsolated({
        ...isolated,
        extra: "ok",
      } as Record<string, string>),
    ).toThrow(/outside the frozen fake-data allowlist/);
  });

  it("prints help and dry-run without launching Vitest or creating a sandbox", async () => {
    const help = runScript(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("frozen fake-data");

    const root = await makeTemp("oq-fixtures-dry-");
    const io = captureIo();
    const code = await runFixtures(["--dry-run"], {
      stdout: io.stdout,
      stderr: io.stderr,
      tmpdir: root,
    });
    const output = io.logs.join("");
    expect(code).toBe(0);
    expect(output).toContain("no real credentials, network provider calls, or real bl executable");
    expect(output).toContain(process.execPath);
    expect(output).toContain(path.join(repoRoot, "node_modules", "vite-plus", "bin", "vp"));
    expect(output).toContain("tests/quota-render-data.test.ts");
    expect(output).toContain("Dry run");
    expect(output).not.toMatch(/\bshell\s+true\b/);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it("rejects unknown CLI arguments", () => {
    const result = runScript(["--network"]);
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("Unknown argument");
  });

  it("remaps HOME and XDG dirs into the sandbox and strips credential env vars", async () => {
    const root = await makeTemp("oq-fixtures-env-");
    const realHome = path.join(root, "real-home");
    await mkdir(realHome);
    await writeFile(path.join(realHome, "secret.txt"), "profile-secret\n", "utf8");
    const sandbox = await prepareFixtureSandbox({ tmpdir: root });
    tempDir = root;

    if (process.platform !== "win32") {
      expect((await lstat(sandbox.tempRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(sandbox.home)).mode & 0o777).toBe(0o700);
      expect((await lstat(sandbox.config)).mode & 0o777).toBe(0o700);
    }

    const childEnv = buildFixtureChildEnv(
      {
        HOME: realHome,
        USERPROFILE: realHome,
        XDG_CONFIG_HOME: path.join(realHome, ".config"),
        XDG_DATA_HOME: path.join(realHome, ".local", "share"),
        XDG_STATE_HOME: path.join(realHome, ".local", "state"),
        XDG_CACHE_HOME: path.join(realHome, ".cache"),
        APPDATA: path.join(realHome, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(realHome, "AppData", "Local"),
        OPENCODE_CONFIG: path.join(realHome, "opencode.json"),
        OPENCODE_CONFIG_DIR: path.join(realHome, ".config", "opencode"),
        OPENROUTER_API_KEY: "real-openrouter-secret",
        SYNTHETIC_API_KEY: "real-synthetic-secret",
        MIMO_USAGE_COOKIE: "real-mimo-cookie",
        CURSOR_ACP_HOME_DIR: realHome,
        PATH: "/usr/bin",
      },
      sandbox,
    );

    expect(childEnv.HOME).toBe(sandbox.home);
    expect(childEnv.USERPROFILE).toBe(sandbox.home);
    expect(childEnv.XDG_CONFIG_HOME).toBe(sandbox.config);
    expect(childEnv.XDG_DATA_HOME).toBe(sandbox.data);
    expect(childEnv.XDG_STATE_HOME).toBe(sandbox.state);
    expect(childEnv.XDG_CACHE_HOME).toBe(sandbox.cache);
    expect(childEnv.HOME).not.toBe(realHome);
    expect(childEnv.XDG_CONFIG_HOME).not.toBe(path.join(realHome, ".config"));
    expect(childEnv.OPENCODE_CONFIG).toBeUndefined();
    expect(childEnv.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
    expect(childEnv.SYNTHETIC_API_KEY).toBeUndefined();
    expect(childEnv.MIMO_USAGE_COOKIE).toBeUndefined();
    expect(childEnv.CURSOR_ACP_HOME_DIR).toBeUndefined();
    expect(childEnv.PATH).toBe("/usr/bin");

    await cleanupFixtureSandbox(sandbox.tempRoot, { tmpdir: root });
    await expect(lstat(sandbox.tempRoot)).rejects.toThrow();
    expect(await readFile(path.join(realHome, "secret.txt"), "utf8")).toBe("profile-secret\n");
  });

  it("spawns a child that cannot reach the real profile through HOME or XDG", async () => {
    const root = await makeTemp("oq-fixtures-child-");
    const realHome = path.join(root, "real-home");
    await mkdir(realHome);
    await writeFile(path.join(realHome, "secret.txt"), "profile-secret\n", "utf8");
    const sandbox = await prepareFixtureSandbox({ tmpdir: root });
    tempDir = root;

    const dumpPath = path.join(root, "dump.json");
    const childEnv = buildFixtureChildEnv(
      {
        ...process.env,
        HOME: realHome,
        USERPROFILE: realHome,
        XDG_CONFIG_HOME: path.join(realHome, ".config"),
        XDG_DATA_HOME: path.join(realHome, ".local", "share"),
        XDG_STATE_HOME: path.join(realHome, ".local", "state"),
        XDG_CACHE_HOME: path.join(realHome, ".cache"),
        OPENCODE_CONFIG: path.join(realHome, "opencode.json"),
        OPENCODE_CONFIG_DIR: path.join(realHome, ".config", "opencode"),
        OPENROUTER_API_KEY: "real-openrouter-secret",
        SYNTHETIC_API_KEY: "real-synthetic-secret",
      },
      sandbox,
    );

    const script = `
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
writeFileSync(process.argv[1], JSON.stringify({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  SYNTHETIC_API_KEY: process.env.SYNTHETIC_API_KEY,
  homedir: homedir(),
  homeSecretExists: existsSync(path.join(process.env.HOME ?? "", "secret.txt")),
}));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, dumpPath], {
      cwd: root,
      encoding: "utf8",
      env: childEnv,
    });
    expect(result.status).toBe(0);
    const dump = JSON.parse(await readFile(dumpPath, "utf8")) as {
      HOME: string;
      XDG_CONFIG_HOME: string;
      OPENCODE_CONFIG?: string;
      OPENCODE_CONFIG_DIR?: string;
      OPENROUTER_API_KEY?: string;
      SYNTHETIC_API_KEY?: string;
      homedir: string;
      homeSecretExists: boolean;
    };
    expect(dump.HOME).toBe(sandbox.home);
    expect(dump.homedir).toBe(sandbox.home);
    expect(dump.XDG_CONFIG_HOME).toBe(sandbox.config);
    expect(dump.HOME).not.toBe(realHome);
    expect(dump.OPENCODE_CONFIG).toBeUndefined();
    expect(dump.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(dump.OPENROUTER_API_KEY).toBeUndefined();
    expect(dump.SYNTHETIC_API_KEY).toBeUndefined();
    expect(dump.homeSecretExists).toBe(false);
    expect(await readFile(path.join(realHome, "secret.txt"), "utf8")).toBe("profile-secret\n");
  });

  it.runIf(process.platform !== "win32")(
    "keeps PATH so a fake executable still runs in the isolated env",
    async () => {
      const root = await makeTemp("oq-fixtures-bl-");
      const bin = path.join(root, "bin");
      await mkdir(bin);
      const fakeBl = path.join(bin, "bl");
      await writeFile(fakeBl, "#!/bin/sh\necho fake-bl-ok\n", "utf8");
      await chmod(fakeBl, 0o755);
      const sandbox = await prepareFixtureSandbox({ tmpdir: root });
      tempDir = root;
      const childEnv = buildFixtureChildEnv(
        {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          OPENROUTER_API_KEY: "must-not-leak",
        },
        sandbox,
      );
      const result = spawnSync("bl", [], { cwd: root, encoding: "utf8", env: childEnv });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("fake-bl-ok");
      expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
    },
  );

  it("creates a 0700 sandbox for Vitest, isolates the child env, and deletes it on success", async () => {
    const root = await makeTemp("oq-fixtures-run-");
    const realHome = path.join(root, "real-home");
    await mkdir(realHome);
    await writeFile(path.join(realHome, "secret.txt"), "profile-secret\n", "utf8");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedSandboxHome: string | undefined;
    const io = captureIo();
    const code = await runFixtures([], {
      stdout: io.stdout,
      stderr: io.stderr,
      tmpdir: root,
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: realHome,
        USERPROFILE: realHome,
        OPENCODE_CONFIG: path.join(realHome, "opencode.json"),
        OPENCODE_CONFIG_DIR: path.join(realHome, ".config", "opencode"),
        OPENROUTER_API_KEY: "real-openrouter-secret",
      },
      spawn(_command, _args, options) {
        capturedEnv = options?.env as NodeJS.ProcessEnv;
        capturedSandboxHome = capturedEnv.HOME;
        return spawn(process.execPath, ["-e", "process.exit(0)"], {
          cwd: options?.cwd,
          env: options?.env,
          stdio: "ignore",
          shell: false,
        });
      },
    });
    expect(code).toBe(0);
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.HOME).toBeDefined();
    expect(capturedEnv?.HOME).not.toBe(realHome);
    expect(capturedEnv?.HOME).toContain(FIXTURE_TEMP_PREFIX);
    expect(capturedEnv?.XDG_CONFIG_HOME).toContain(FIXTURE_TEMP_PREFIX);
    expect(capturedEnv?.XDG_DATA_HOME).toContain(FIXTURE_TEMP_PREFIX);
    expect(capturedEnv?.XDG_STATE_HOME).toContain(FIXTURE_TEMP_PREFIX);
    expect(capturedEnv?.XDG_CACHE_HOME).toContain(FIXTURE_TEMP_PREFIX);
    expect(capturedEnv?.OPENCODE_CONFIG).toBeUndefined();
    expect(capturedEnv?.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(capturedEnv?.OPENROUTER_API_KEY).toBeUndefined();
    expect(await prefixDirs(root)).toEqual([]);
    if (capturedSandboxHome) {
      await expect(lstat(capturedSandboxHome)).rejects.toThrow();
    }
    expect(await readFile(path.join(realHome, "secret.txt"), "utf8")).toBe("profile-secret\n");
  });

  it("deletes the sandbox when the child exits with an error", async () => {
    const root = await makeTemp("oq-fixtures-fail-");
    const io = captureIo();
    const code = await runFixtures([], {
      stdout: io.stdout,
      stderr: io.stderr,
      tmpdir: root,
      stdio: "ignore",
      spawn(_command, _args, options) {
        return spawn(process.execPath, ["-e", "process.exit(7)"], {
          cwd: options?.cwd,
          env: options?.env,
          stdio: "ignore",
          shell: false,
        });
      },
    });
    expect(code).toBe(7);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "forwards SIGTERM, waits for exit, then deletes the sandbox",
    async () => {
      const root = await makeTemp("oq-fixtures-sig-");
      const marker = path.join(root, "marker.txt");
      const signalSource = new EventEmitter();
      const io = captureIo();
      const running = runFixtures([], {
        stdout: io.stdout,
        stderr: io.stderr,
        tmpdir: root,
        stdio: "ignore",
        signalSource,
        spawn(_command, _args, options) {
          return spawn(
            process.execPath,
            [
              "-e",
              `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(marker)}, "started\\n");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(marker)}, "exited\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
            ],
            {
              cwd: options?.cwd,
              env: options?.env,
              stdio: "ignore",
              shell: false,
            },
          );
        },
      });
      expect(await waitForFile(marker, "started\n")).toBe("started\n");
      expect(await prefixDirs(root)).toHaveLength(1);
      signalSource.emit("SIGTERM");
      const code = await running;
      expect(await readFile(marker, "utf8")).toBe("exited\n");
      expect(code).toBe(128 + 15);
      expect(await prefixDirs(root)).toEqual([]);
    },
  );

  it("refuses to delete a path outside the expected fixture temp prefix", async () => {
    const root = await makeTemp("oq-fixtures-guard-");
    const keep = path.join(root, "keep.txt");
    await writeFile(keep, "keep\n", "utf8");
    await expect(cleanupFixtureSandbox(root, { tmpdir: root })).rejects.toThrow(
      /Refusing to delete/,
    );
    expect(await readFile(keep, "utf8")).toBe("keep\n");
  });
});
