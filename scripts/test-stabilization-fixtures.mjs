#!/usr/bin/env node
/**
 * Maintainer fake-data gate for the 4.x stabilization suites.
 *
 * This runner must not use real credentials, network provider calls, or the
 * real `bl` executable. It spawns this repo's Vite+ test CLI with a frozen file
 * list and no shell. Extra files or tests that would escape mocks are rejected.
 *
 * Before spawning Vitest, it creates a 0700 temp HOME/XDG sandbox, strips known
 * provider credential/session env vars and OPENCODE_CONFIG/OPENCODE_CONFIG_DIR,
 * then deletes the sandbox on success, error, or forwarded signals.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const FIXTURE_TEMP_PREFIX = "opencode-quota-fixtures-";
export const FORWARD_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

export const FIXTURE_STRIP_ENV_VARS = Object.freeze([
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_API_KEY",
  "OPENCODE_GO_AUTH_COOKIE",
  "OPENCODE_GO_WORKSPACE_ID",
  "OPENCODE_AGY_PROJECT_ID",
  "OPENCODE_GEMINI_PROJECT_ID",
  "OPENROUTER_API_KEY",
  "SYNTHETIC_API_KEY",
  "CHUTES_API_KEY",
  "DEEPSEEK_API_KEY",
  "KILO_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODE_API_KEY",
  "NANOGPT_API_KEY",
  "NANO_GPT_API_KEY",
  "OLLAMA_API_KEY",
  "ALIBABA_CODING_PLAN_API_KEY",
  "ALIBABA_API_KEY",
  "MINIMAX_CODING_PLAN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CHINA_CODING_PLAN_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_PLAN_API_KEY",
  "ZHIPU_API_KEY",
  "ZHIPU_CODING_PLAN_API_KEY",
  "MIMO_USAGE_COOKIE",
  "CURSOR_ACP_HOME_DIR",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
]);

export const FIXTURE_TEST_FILES = Object.freeze([
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

const ESCAPE_CHECKS = [
  {
    id: "real-bl-spawn",
    message: "would spawn the real bl executable",
    regex:
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?:ALIBABA_TOKEN_PLAN_COMMAND|["'`]bl["'`])/,
  },
  {
    id: "shell-true",
    message: "would run a shell, which can escape the frozen Vitest argv",
    regex: /\bshell\s*:\s*true\b/,
  },
  {
    id: "live-openrouter-fetch",
    message: "would make a live OpenRouter network call",
    regex: /\bfetch\s*\(\s*[`'"]https:\/\/openrouter\.ai/,
  },
  {
    id: "live-http-client",
    message: "would use a live HTTP client outside the mocked provider boundary",
    regex:
      /\b(?:from\s+["'](?:axios|got|undici|node-fetch)["']|require\(\s*["'](?:axios|got|undici|node-fetch)["']\))/,
  },
];

export function getFixturesUsage() {
  return `Usage:
  node scripts/test-stabilization-fixtures.mjs [--dry-run]
  node scripts/test-stabilization-fixtures.mjs --help

Runs the frozen fake-data Vitest set for config symlinks, config write targets,
atomic JSON, OpenCode Go, Synthetic empty responses/surfaces, OpenRouter
diagnostics/surfaces, Alibaba Token Plan process/provider, quota status, prompt
selection, prompt-bar identity, TUI runtime, quota export, API-key query/config, and contribution guidance.

Does not use real credentials, network provider calls, or the real bl executable.
Vitest runs in a 0700 temp HOME/XDG sandbox with known credential/session env vars
and OPENCODE_CONFIG/OPENCODE_CONFIG_DIR stripped.`;
}

export function parseFixturesArgs(argv) {
  const args = { dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${getFixturesUsage()}`);
  }
  return args;
}

export function resolveVitePlusExecutable(root = repoRoot) {
  const vitePlusCli = path.join(root, "node_modules", "vite-plus", "bin", "vp");
  if (!existsSync(vitePlusCli)) {
    throw new Error(`Vite+ CLI is missing: ${vitePlusCli}`);
  }
  return vitePlusCli;
}

export function buildVitePlusArgs(files = FIXTURE_TEST_FILES) {
  return ["test", "run", ...files];
}

export function assertFrozenFixtureFiles(files = FIXTURE_TEST_FILES) {
  if (files.length !== FIXTURE_TEST_FILES.length) {
    throw new Error("Fixture file list does not match the frozen fake-data allowlist.");
  }
  for (const [index, file] of files.entries()) {
    if (file !== FIXTURE_TEST_FILES[index]) {
      throw new Error(`Unexpected fixture test path: ${file}`);
    }
    if (path.isAbsolute(file) || file.includes("..") || file.includes("\\")) {
      throw new Error(`Fixture test path is not a repo-relative POSIX path: ${file}`);
    }
  }
}

export function assertFixtureContentsAreIsolated(contentsByFile) {
  for (const file of Object.keys(contentsByFile)) {
    if (!FIXTURE_TEST_FILES.includes(file)) {
      throw new Error(
        `Refusing to run a test file outside the frozen fake-data allowlist: ${file}`,
      );
    }
  }
  for (const file of FIXTURE_TEST_FILES) {
    const contents = contentsByFile[file];
    if (typeof contents !== "string") {
      throw new Error(`Missing fixture test contents: ${file}`);
    }
    for (const check of ESCAPE_CHECKS) {
      if (check.regex.test(contents)) {
        throw new Error(`${file} ${check.message}.`);
      }
    }
  }
}

export async function assertFixtureTestsAreIsolated(root = repoRoot, files = FIXTURE_TEST_FILES) {
  assertFrozenFixtureFiles(files);
  const contentsByFile = {};
  for (const file of files) {
    const fullPath = path.join(root, file);
    if (!existsSync(fullPath)) {
      throw new Error(`Frozen fixture test is missing: ${file}`);
    }
    contentsByFile[file] = await readFile(fullPath, "utf8");
  }
  assertFixtureContentsAreIsolated(contentsByFile);
  return {
    command: process.execPath,
    args: [resolveVitePlusExecutable(root), ...buildVitePlusArgs(files)],
    cwd: root,
    shell: false,
  };
}

function describeCommand(command) {
  return [command.command, ...command.args].join(" ");
}

function isStrictPathInside(inner, outer) {
  const base = outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`;
  return inner.startsWith(base);
}

export function isGuardedFixtureTempPath(
  resolvedTempRoot,
  resolvedTmpdir,
  prefix = FIXTURE_TEMP_PREFIX,
) {
  if (!resolvedTempRoot || !resolvedTmpdir) return false;
  if (resolvedTempRoot === resolvedTmpdir) return false;
  if (!isStrictPathInside(resolvedTempRoot, resolvedTmpdir)) return false;
  return path.basename(resolvedTempRoot).startsWith(prefix);
}

export async function prepareFixtureSandbox(options = {}) {
  const tmpdirBase = options.tmpdir ?? tmpdir();
  let tempRoot;
  try {
    tempRoot = await mkdtemp(path.join(tmpdirBase, FIXTURE_TEMP_PREFIX));
    await chmod(tempRoot, 0o700);
    const home = path.join(tempRoot, "home");
    const config = path.join(tempRoot, "config");
    const data = path.join(tempRoot, "data");
    const state = path.join(tempRoot, "state");
    const cache = path.join(tempRoot, "cache");
    for (const dir of [home, config, data, state, cache]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
    return { tempRoot, home, config, data, state, cache, tmpdir: tmpdirBase };
  } catch (error) {
    if (tempRoot) {
      await cleanupFixtureSandbox(tempRoot, { tmpdir: tmpdirBase }).catch(() => undefined);
    }
    throw error;
  }
}

export async function cleanupFixtureSandbox(tempRoot, options = {}) {
  if (!tempRoot) return;
  const tmpdirBase = options.tmpdir ?? tmpdir();
  let resolvedTempRoot;
  let resolvedTmpdir;
  try {
    resolvedTempRoot = await realpath(tempRoot);
    resolvedTmpdir = await realpath(tmpdirBase);
  } catch {
    return;
  }
  if (!isGuardedFixtureTempPath(resolvedTempRoot, resolvedTmpdir)) {
    throw new Error("Refusing to delete a path outside the expected fixture temp directory.");
  }
  await rm(resolvedTempRoot, { recursive: true, force: true });
}

export function buildFixtureChildEnv(env, sandbox) {
  const childEnv = { ...env };
  childEnv.HOME = sandbox.home;
  childEnv.USERPROFILE = sandbox.home;
  childEnv.XDG_CONFIG_HOME = sandbox.config;
  childEnv.XDG_DATA_HOME = sandbox.data;
  childEnv.XDG_STATE_HOME = sandbox.state;
  childEnv.XDG_CACHE_HOME = sandbox.cache;
  childEnv.APPDATA = sandbox.config;
  childEnv.LOCALAPPDATA = sandbox.cache;
  for (const key of FIXTURE_STRIP_ENV_VARS) {
    delete childEnv[key];
  }
  return childEnv;
}

export function signalExitCode(signal) {
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : 130;
}

function attachSignalForwarder(source, handler) {
  const attached = [];
  for (const signal of FORWARD_SIGNALS) {
    const onSignal = () => {
      handler(signal);
    };
    try {
      source.on(signal, onSignal);
      attached.push([signal, onSignal]);
    } catch {
      // Unsupported on this platform.
    }
  }
  return () => {
    for (const [signal, onSignal] of attached) {
      source.off(signal, onSignal);
    }
  };
}

function isChildAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function killChild(child, signal) {
  if (!isChildAlive(child)) return;
  try {
    child.kill(signal);
  } catch {
    try {
      child.kill();
    } catch {
      // already exited
    }
  }
}

export async function runFixtures(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let args;
  try {
    args = parseFixturesArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${getFixturesUsage()}\n`);
    return 0;
  }

  let command;
  try {
    command = await assertFixtureTestsAreIsolated(io.repoRoot ?? repoRoot);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stderr.write(
    "Fake-data invariant: no real credentials, network provider calls, or real bl executable.\n",
  );
  stderr.write(`${describeCommand(command)}\n`);
  if (args.dryRun) {
    stderr.write("Dry run: isolation check passed; Vitest was not launched.\n");
    return 0;
  }

  const tmpdirBase = io.tmpdir ?? tmpdir();
  const parentEnv = io.env ?? process.env;
  const spawnImpl = io.spawn ?? spawn;
  let sandbox;
  let cleaned = false;
  let activeChild = null;
  let interruptSignal = null;
  const cleanup = async () => {
    if (cleaned || !sandbox) return;
    cleaned = true;
    await cleanupFixtureSandbox(sandbox.tempRoot, { tmpdir: sandbox.tmpdir ?? tmpdirBase });
  };
  const onSignal = (signal) => {
    interruptSignal = signal;
    killChild(activeChild, signal);
  };
  const detachSignals = attachSignalForwarder(io.signalSource ?? process, onSignal);

  try {
    sandbox = await prepareFixtureSandbox({ tmpdir: tmpdirBase });
    if (interruptSignal) {
      await cleanup();
      return signalExitCode(interruptSignal);
    }
    const childEnv = buildFixtureChildEnv(parentEnv, sandbox);
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(command.command, command.args, {
          cwd: command.cwd,
          env: childEnv,
          stdio: io.stdio ?? "inherit",
          shell: false,
        });
      } catch (error) {
        cleanup()
          .catch(() => undefined)
          .finally(() => {
            stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            resolve(1);
          });
        return;
      }
      activeChild = child;
      child.on("error", (error) => {
        activeChild = null;
        stderr.write(`${error.message}\n`);
        cleanup()
          .catch(() => undefined)
          .finally(() => resolve(1));
      });
      child.on("close", (code, signal) => {
        activeChild = null;
        cleanup()
          .catch(() => undefined)
          .finally(() => {
            if (interruptSignal) {
              resolve(signalExitCode(interruptSignal));
              return;
            }
            resolve(code ?? (signal ? 1 : 0));
          });
      });
    });
  } catch (error) {
    await cleanup();
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    detachSignals();
    await cleanup();
  }
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const code = await runFixtures(process.argv.slice(2));
  process.exit(code);
}
