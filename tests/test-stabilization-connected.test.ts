import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  appendBoundedDiagnostic,
  applyQuotaSurfaceSettings,
  assertNoModelRequest,
  buildConnectedChildEnv,
  CAPTURED_PROCESS_STREAM_MAX_BYTES,
  CONNECTED_CREDENTIAL_WARNING,
  CONNECTED_TEMP_PREFIX,
  CONNECTED_WEB_COMMANDS,
  chooseConnectedWebModel,
  classifyWebDiagnostic,
  cleanupConnectedWorkspace,
  connectedLaunchArgs,
  createWebDiagnosticsFile,
  DIAGNOSTIC_REDACTED_BODY_MARKER,
  DIAGNOSTIC_REDACTED_CONFIG_MARKER,
  DIAGNOSTIC_REDACTED_HEADER_MARKER,
  DIAGNOSTIC_REDACTED_PRIVATE_MARKER,
  DIAGNOSTIC_TRUNCATED_MARKER,
  findOpenCodeExecutable,
  formatConnectedWebModelGuidance,
  formatWebDiagnostics,
  formatWebDiagnosticsPath,
  formatWebModelChoice,
  getConnectedUsage,
  OPENCODE_MODELS_ARGS,
  parseConnectedArgs,
  parseOpenCodeModelsOutput,
  pluginFileUrls,
  prepareConnectedWebModel,
  prepareConnectedWorkspace,
  readNewLogRecords,
  redactConnectedDiagnostics,
  resolveOpenCodeLogDirs,
  rewritePluginList,
  runCapturedProcess,
  runConnected,
  runProcess,
  sliceLogFromOffset,
  snapshotLogOffsets,
  WEB_DIAGNOSTIC_LOG_MAX_BYTES,
  WEB_DIAGNOSTIC_SOURCE_MAX_BYTES,
  WEB_DIAGNOSTIC_TOTAL_MAX_BYTES,
  WEB_FAILURE_HOOK_ENTRY_BUILD_INJECTION,
  WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK,
  WEB_FAILURE_POST_INJECTION_BUSY_272,
  WEB_FAILURE_UNKNOWN,
  writeWebDiagnosticsFile,
} from "../scripts/test-stabilization-connected.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/test-stabilization-connected.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "connected-config-secret-canary";

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

async function writeConfigTree(root: string) {
  const realMain = path.join(root, "real-opencode.jsonc");
  await writeFile(
    realMain,
    `{
  // companion plugins stay first
  "$schema": "https://opencode.ai/config.json",
  "model": "test-model",
  "plugin": [
    "opencode-gemini-auth",
    ["@slkiser/opencode-quota", { "enabled": true }],
    "opencode-agy-auth"
  ]
}
`,
    "utf8",
  );
  await symlink(realMain, path.join(root, "opencode.jsonc"));
  await writeFile(
    path.join(root, "tui.jsonc"),
    `{
  "plugin": ["@slkiser/opencode-quota"]
}
`,
    "utf8",
  );
  await mkdir(path.join(root, "opencode-quota"), { recursive: true });
  await writeFile(
    path.join(root, "opencode-quota", "quota-toast.jsonc"),
    `{
  "enabledProviders": "auto",
  "tuiSidebarPanel": {
    "opencodeGoPreferredWindow": "rolling"
  },
  "enableToast": false,
  "tuiCompactStatus": { "enabled": false },
  "tuiPromptBar": { "enabled": true }
}
`,
    "utf8",
  );
  await writeFile(path.join(root, "auth.json"), `${JSON.stringify({ token: SECRET })}\n`, "utf8");
}

async function writeJsonOnlyConfigTree(root: string) {
  await writeFile(
    path.join(root, "opencode.json"),
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "json-only-model",
      plugin: ["@slkiser/opencode-quota"],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "tui.json"),
    `${JSON.stringify({ plugin: ["@slkiser/opencode-quota"] })}\n`,
    "utf8",
  );
  await mkdir(path.join(root, "opencode-quota"), { recursive: true });
  await writeFile(
    path.join(root, "opencode-quota", "quota-toast.json"),
    `${JSON.stringify({ enableToast: false })}\n`,
    "utf8",
  );
}

function runScript(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

async function prefixDirs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(CONNECTED_TEMP_PREFIX));
}

async function writeFakeWebHarness(root: string) {
  const source = path.join(root, "source");
  const bin = path.join(root, "bin");
  const fakeRepo = path.join(root, "repo");
  const recordFile = path.join(root, "opencode-records.jsonl");
  const buildRecordFile = path.join(root, "build-record.json");
  const startedFile = path.join(root, "opencode-started.txt");
  await mkdir(source, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(fakeRepo, "dist"), { recursive: true });
  await writeFile(
    path.join(source, "opencode.jsonc"),
    `{
  // keep this comment and plugin order
  "model": "stale/provider-model",
  "plugin": ["companion-before", "@slkiser/opencode-quota", "companion-after"]
}
`,
    "utf8",
  );
  await writeFile(path.join(fakeRepo, "dist", "index.js"), "export {};\n", "utf8");
  const fakePnpm = path.join(fakeRepo, "fake-pnpm.cjs");
  await writeFile(
    fakePnpm,
    `require("node:fs").writeFileSync(process.env.FAKE_BUILD_RECORD_FILE, JSON.stringify(process.argv.slice(2)));\n`,
    "utf8",
  );
  // Use a native executable rather than a shebang or .cmd shim, which spawn cannot
  // launch without a shell on Windows. The preload runs only for this copied Node.
  const fakeOpenCode = path.join(bin, process.platform === "win32" ? "opencode.exe" : "opencode");
  await copyFile(process.execPath, fakeOpenCode);
  const fakeOpenCodePreload = path.join(root, "fake-opencode.mjs");
  await writeFile(
    fakeOpenCodePreload,
    `import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
if (realpathSync(process.execPath) === realpathSync(${JSON.stringify(fakeOpenCode)})) {
// Node resolves its first argument as a script path before running --import.
const args = [path.relative(process.cwd(), process.argv[1]), ...process.argv.slice(2)];
appendFileSync(process.env.FAKE_RECORD_FILE, JSON.stringify({
  args,
  configDir: process.env.OPENCODE_CONFIG_DIR ?? null,
  configFile: process.env.OPENCODE_CONFIG ?? null,
  cwd: process.cwd(),
  configContents: readFileSync(process.env.OPENCODE_CONFIG_DIR + "/opencode.jsonc", "utf8"),
}) + "\\n");
if (args[0] === "models") {
  if (process.env.FAKE_MODELS_HANG === "1") {
    writeFileSync(process.env.FAKE_STARTED_FILE, "models\\n");
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    process.on("SIGHUP", () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else {
    process.stdout.write(process.env.FAKE_MODELS_OUTPUT ?? "");
    process.stderr.write(process.env.FAKE_MODELS_STDERR ?? "");
    process.exit(Number(process.env.FAKE_MODELS_EXIT ?? "0"));
  }
} else if (args[0] === "web") {
  writeFileSync(process.env.FAKE_STARTED_FILE, "web\\n");
  process.stdout.write(process.env.FAKE_WEB_STDOUT ?? "");
  process.stderr.write(process.env.FAKE_WEB_STDERR ?? "");
  if (process.env.FAKE_WEB_HANG === "1") {
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    process.on("SIGHUP", () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else {
    process.exit(Number(process.env.FAKE_WEB_EXIT ?? "0"));
  }
} else {
  process.exit(64);
}
}
`,
    "utf8",
  );
  if (process.platform !== "win32") {
    await chmod(fakeOpenCode, 0o755);
  }
  return {
    source,
    bin,
    fakeRepo,
    fakeOpenCode,
    recordFile,
    buildRecordFile,
    startedFile,
    env: {
      ...process.env,
      // Always run the fake build, even when pnpm test supplies npm_execpath.
      npm_execpath: fakePnpm,
      NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(fakeOpenCodePreload).href)}`,
      FAKE_BUILD_RECORD_FILE: buildRecordFile,
      OPENCODE_CONFIG_DIR: source,
      OPENCODE_CONFIG: path.join(source, "must-not-reach-child.json"),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_RECORD_FILE: recordFile,
      FAKE_STARTED_FILE: startedFile,
    },
  };
}

async function readFakeRecords(filePath: string) {
  const content = await readFile(filePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFile(filePath: string, expected: string) {
  for (let index = 0; index < 200; index += 1) {
    try {
      if ((await readFile(filePath, "utf8")) === expected) return;
    } catch {
      // The fake executable has not reached the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function captureOutput(chunks: string[]) {
  return {
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

describe("test-stabilization-connected", () => {
  it("parses TUI, web, prompt-bar, dry-run, and help flags", () => {
    expect(parseConnectedArgs(["--help"])).toEqual({
      mode: null,
      promptBar: false,
      dryRun: false,
      help: true,
    });
    expect(parseConnectedArgs(["--tui", "--prompt-bar", "--dry-run"])).toEqual({
      mode: "tui",
      promptBar: true,
      dryRun: true,
      help: false,
    });
    expect(parseConnectedArgs(["--web"])).toMatchObject({ mode: "web", promptBar: false });
    expect(connectedLaunchArgs("web")).toEqual(["web"]);
    expect(connectedLaunchArgs("tui")).toEqual([]);
    expect(() => parseConnectedArgs([])).toThrow(/Specify --tui or --web/);
    expect(() => parseConnectedArgs(["--tui", "--web"])).toThrow(/only one/);
    expect(() => parseConnectedArgs(["--web", "--prompt-bar"])).toThrow(/only valid with --tui/);
    expect(getConnectedUsage()).toContain("--tui");
    expect(getConnectedUsage()).toMatch(/fixed 12-cell bar/i);
    expect(getConnectedUsage()).toMatch(/placement\/clipping/i);
  });

  it("rewrites only quota plugin entries and preserves companion order", () => {
    const url = "file:///tmp/dist/index.js";
    expect(
      rewritePluginList(
        ["opencode-gemini-auth", "@slkiser/opencode-quota", "opencode-agy-auth"],
        url,
      ),
    ).toEqual(["opencode-gemini-auth", url, "opencode-agy-auth"]);
    expect(rewritePluginList([["@slkiser/opencode-quota", { enabled: true }]], url)).toEqual([
      [url, { enabled: true }],
    ]);
    expect(rewritePluginList(["opencode-agy-auth"], url)).toEqual(["opencode-agy-auth", url]);
  });

  it("enables sidebar, toast, and compact without dropping unrelated quota settings", () => {
    const config = applyQuotaSurfaceSettings(
      {
        enabledProviders: "auto",
        tuiSidebarPanel: { opencodeGoPreferredWindow: "rolling" },
        enableToast: false,
      },
      { promptBarEnabled: false },
    );
    expect(config).toMatchObject({
      enabledProviders: "auto",
      enableToast: true,
      tuiSidebarPanel: { enabled: true, opencodeGoPreferredWindow: "rolling" },
      tuiCompactStatus: { enabled: true },
      tuiPromptBar: { enabled: false },
    });
  });

  it("strips OPENCODE_CONFIG from the child environment", () => {
    expect(
      buildConnectedChildEnv(
        {
          OPENCODE_CONFIG: "/real/opencode.json",
          OPENCODE_CONFIG_DIR: "/real/config",
          PATH: "/bin",
        },
        "/tmp/isolated-config",
      ),
    ).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/isolated-config",
      PATH: "/bin",
    });
  });

  it("copies through a symlink, rewrites the temp files, and leaves the real config unchanged", async () => {
    const root = await makeTemp("oq-connected-src-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeConfigTree(source);
    const originalMain = await readFile(path.join(source, "real-opencode.jsonc"), "utf8");
    const originalAuth = await readFile(path.join(source, "auth.json"), "utf8");

    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      tmpdir: root,
    });
    tempDir = root;

    const copiedMainStat = await lstat(workspace.mainPath);
    expect(copiedMainStat.isSymbolicLink()).toBe(false);
    expect(await realpath(workspace.mainPath)).not.toBe(
      await realpath(path.join(source, "real-opencode.jsonc")),
    );

    const copiedMain = await readFile(workspace.mainPath, "utf8");
    const urls = pluginFileUrls(repoRoot);
    expect(copiedMain).toContain("// companion plugins stay first");
    expect(copiedMain).toContain("opencode-gemini-auth");
    expect(copiedMain).toContain("opencode-agy-auth");
    expect(copiedMain).toContain(urls.server);
    expect(copiedMain).not.toContain("@slkiser/opencode-quota");
    expect(copiedMain).toContain('"model": "test-model"');

    const copiedTui = await readFile(workspace.tuiPath, "utf8");
    expect(copiedTui).toContain(urls.tui);

    const copiedQuota = JSON.parse(await readFile(workspace.quotaPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(copiedQuota).toMatchObject({
      enabledProviders: "auto",
      enableToast: true,
      tuiSidebarPanel: { enabled: true, opencodeGoPreferredWindow: "rolling" },
      tuiCompactStatus: { enabled: true },
      tuiPromptBar: { enabled: false },
    });

    expect(await readFile(path.join(source, "real-opencode.jsonc"), "utf8")).toBe(originalMain);
    expect(await readFile(path.join(source, "auth.json"), "utf8")).toBe(originalAuth);
    expect(await readFile(path.join(workspace.configDir, "auth.json"), "utf8")).toContain(SECRET);

    if (process.platform !== "win32") {
      expect((await lstat(workspace.tempRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(workspace.configDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(workspace.projectDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(workspace.configDir, "auth.json"))).mode & 0o777).toBe(0o600);
      expect((await lstat(workspace.mainPath)).mode & 0o777).toBe(0o600);
    }

    const tempRoot = workspace.tempRoot;
    await cleanupConnectedWorkspace(tempRoot, { tmpdir: root });
    await expect(lstat(tempRoot)).rejects.toThrow();
    expect(await readFile(path.join(source, "real-opencode.jsonc"), "utf8")).toBe(originalMain);
  });

  it("follows a symlinked config root with stat and still requires a directory", async () => {
    const root = await makeTemp("oq-connected-link-");
    const realSource = path.join(root, "real-source");
    const linkedSource = path.join(root, "linked-source");
    await mkdir(realSource);
    await writeConfigTree(realSource);
    await symlink(realSource, linkedSource);

    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: linkedSource,
      repoRoot,
      promptBarEnabled: false,
      tmpdir: root,
    });
    tempDir = root;

    expect(path.basename(workspace.mainPath)).toBe("opencode.jsonc");
    expect((await lstat(workspace.mainPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(workspace.mainPath, "utf8")).toContain("test-model");
    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: path.join(root, "missing-link"),
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/config directory is missing/);
    const fileSource = path.join(root, "file-source");
    await writeFile(fileSource, "{}\n", "utf8");
    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: fileSource,
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/config directory is missing/);
  });

  it("rewrites JSON-only configs without requiring jsonc files", async () => {
    const root = await makeTemp("oq-connected-json-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeJsonOnlyConfigTree(source);

    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      tmpdir: root,
    });
    tempDir = root;

    expect(workspace.mainPath).toBe(path.join(workspace.configDir, "opencode.json"));
    expect(workspace.tuiPath).toBe(path.join(workspace.configDir, "tui.json"));
    expect(workspace.quotaPath).toBe(
      path.join(workspace.configDir, "opencode-quota", "quota-toast.json"),
    );
    const urls = pluginFileUrls(repoRoot);
    expect(await readFile(workspace.mainPath, "utf8")).toContain(urls.server);
    expect(await readFile(workspace.tuiPath, "utf8")).toContain(urls.tui);
  });

  it("rejects a config directory that is missing the main OpenCode config", async () => {
    const root = await makeTemp("oq-connected-missing-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "auth.json"),
      `${JSON.stringify({ token: SECRET })}\n`,
      "utf8",
    );

    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: source,
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/missing opencode\.json or opencode\.jsonc/);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it("creates a TUI config for TUI runs and leaves it absent for web when missing", async () => {
    const root = await makeTemp("oq-connected-tui-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "opencode.jsonc"),
      `${JSON.stringify({ plugin: ["@slkiser/opencode-quota"] })}\n`,
      "utf8",
    );

    const tuiWorkspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      ensureTuiConfig: true,
      tmpdir: root,
    });
    expect(tuiWorkspace.tuiPath).toBe(path.join(tuiWorkspace.configDir, "tui.jsonc"));
    expect(await readFile(tuiWorkspace.tuiPath, "utf8")).toContain(pluginFileUrls(repoRoot).tui);
    await cleanupConnectedWorkspace(tuiWorkspace.tempRoot, { tmpdir: root });

    const webWorkspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    tempDir = root;
    expect(webWorkspace.tuiPath).toBeNull();
    await expect(lstat(path.join(webWorkspace.configDir, "tui.jsonc"))).rejects.toThrow();
    await expect(lstat(path.join(webWorkspace.configDir, "tui.json"))).rejects.toThrow();
  });

  it("deletes the temp workspace if copy or transform fails", async () => {
    const root = await makeTemp("oq-connected-fail-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "opencode.jsonc"), "not-json {\n", "utf8");

    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: source,
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/Failed to parse copied opencode\.jsonc/);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it("refuses to delete a path outside the expected temp prefix", async () => {
    const root = await makeTemp("oq-connected-guard-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "keep.txt"), "keep\n", "utf8");
    const tmp = path.join(root, "tmp");
    await mkdir(tmp);

    await expect(cleanupConnectedWorkspace(source, { tmpdir: tmp })).rejects.toThrow(
      /Refusing to delete/,
    );
    expect(await readFile(path.join(source, "keep.txt"), "utf8")).toBe("keep\n");

    const decoy = path.join(tmp, `${CONNECTED_TEMP_PREFIX}decoy`);
    await symlink(source, decoy);
    await expect(cleanupConnectedWorkspace(decoy, { tmpdir: tmp })).rejects.toThrow(
      /Refusing to delete/,
    );
    expect(await readFile(path.join(source, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("forwards SIGTERM to the child, waits for exit, then cleanup can run", async () => {
    if (process.platform === "win32") return;
    const root = await makeTemp("oq-connected-sig-");
    const childScript = path.join(root, "child.mjs");
    const marker = path.join(root, "marker.txt");
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "started\\n");
process.on("SIGTERM", () => {
  writeFileSync(process.argv[2], "exited\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const signalSource = new EventEmitter();
    const events: string[] = [];
    const running = runProcess(process.execPath, [childScript, marker], {
      cwd: root,
      stdio: "ignore",
      signalSource,
    }).then((result: { code: number | null; signal: NodeJS.Signals | null }) => {
      events.push("child-exit");
      return result;
    });

    for (let i = 0; i < 100; i++) {
      try {
        if ((await readFile(marker, "utf8")) === "started\n") break;
      } catch {
        // The child has not created the marker yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readFile(marker, "utf8")).toBe("started\n");
    signalSource.emit("SIGTERM");
    const result = await running;
    events.push("cleanup");
    expect(await readFile(marker, "utf8")).toBe("exited\n");
    expect(result.code).toBe(0);
    expect(events).toEqual(["child-exit", "cleanup"]);
  });

  it("escalates an ignored SIGTERM to SIGKILL after the grace period, then cleanup can run", async () => {
    if (process.platform === "win32") return;
    const root = await makeTemp("oq-connected-kill-");
    const childScript = path.join(root, "ignore.mjs");
    const marker = path.join(root, "marker.txt");
    const pidsFile = path.join(root, "pids.json");
    const grandchildSource =
      "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); process.on('SIGHUP', () => {}); setInterval(() => {}, 1000);";
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {
  writeFileSync(process.argv[2], "ignored\\n");
});
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {
  detached: false,
  stdio: "ignore",
});
writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
writeFileSync(process.argv[2], "started\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const signalSource = new EventEmitter();
    const events: string[] = [];
    const graceMs = 80;
    const running = runProcess(process.execPath, [childScript, marker, pidsFile], {
      cwd: root,
      stdio: "ignore",
      signalSource,
      signalGraceMs: graceMs,
    }).then((result: { code: number | null; signal: NodeJS.Signals | null }) => {
      events.push("child-exit");
      return result;
    });

    for (let i = 0; i < 100; i++) {
      try {
        if ((await readFile(marker, "utf8")) === "started\n") break;
      } catch {
        // The child has not created the marker yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readFile(marker, "utf8")).toBe("started\n");
    const pids = JSON.parse(await readFile(pidsFile, "utf8")) as {
      parent: number;
      grandchild: number;
    };
    const signaledAt = Date.now();
    signalSource.emit("SIGTERM");
    const result = await running;
    const elapsed = Date.now() - signaledAt;
    events.push("cleanup");
    expect(await readFile(marker, "utf8")).toBe("ignored\n");
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(graceMs);
    expect(elapsed).toBeLessThan(graceMs + 2000);
    expect(events).toEqual(["child-exit", "cleanup"]);
    expect(() => process.kill(pids.parent, 0)).toThrow();
    expect(() => process.kill(pids.grandchild, 0)).toThrow();
  });

  it("prints help without requiring config or OpenCode", async () => {
    const logs: string[] = [];
    const code = await runConnected(["--help"], {
      stdout: {
        write(chunk: string) {
          logs.push(chunk);
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      env: { PATH: "" },
    });
    expect(code).toBe(0);
    expect(logs.join("")).toContain("--tui");
    expect(logs.join("")).not.toContain(SECRET);
  });

  it("fails dry-run clearly when config or OpenCode is missing", () => {
    const missingConfig = runScript(["--dry-run", "--tui"], {
      ...process.env,
      OPENCODE_CONFIG_DIR: path.join(tmpdir(), "missing-opencode-config-dir"),
      PATH: "",
    });
    expect(missingConfig.status).toBe(1);
    expect(`${missingConfig.stdout}${missingConfig.stderr}`).toMatch(
      /config directory is missing/i,
    );
    expect(`${missingConfig.stdout}${missingConfig.stderr}`).not.toContain(SECRET);
  });

  it("dry-run warns about real credentials and does not print copied secrets", async () => {
    const root = await makeTemp("oq-connected-dry-");
    const source = path.join(root, "source");
    const bin = path.join(root, "bin");
    await mkdir(source);
    await mkdir(bin);
    await writeConfigTree(source);
    const opencodePath = path.join(bin, process.platform === "win32" ? "opencode.cmd" : "opencode");
    await writeFile(opencodePath, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") await chmod(opencodePath, 0o755);

    expect(findOpenCodeExecutable({ PATH: bin })).toBe(opencodePath);

    const result = runScript(["--dry-run", "--tui"], {
      ...process.env,
      OPENCODE_CONFIG_DIR: source,
      PATH: bin,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain(CONNECTED_CREDENTIAL_WARNING);
    expect(output).toContain("Dry run");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("test-model");
    expect(output).not.toContain("companion plugins stay first");

    const web = runScript(["--dry-run", "--web"], {
      ...process.env,
      OPENCODE_CONFIG_DIR: source,
      PATH: bin,
    });
    const webOutput = `${web.stdout}${web.stderr}`;
    expect(web.status).toBe(0);
    expect(webOutput).toContain("Mode: web");
    expect(webOutput).not.toContain(SECRET);
  });

  it("keeps a valid temp model and never sends a model request", async () => {
    const root = await makeTemp("oq-connected-valid-model-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "opencode.jsonc"),
      `{
  "model": "github-copilot/gpt-4.1",
  "plugin": ["opencode-gemini-auth", "@slkiser/opencode-quota", "opencode-agy-auth"]
}
`,
      "utf8",
    );
    const originalMain = await readFile(path.join(source, "opencode.jsonc"), "utf8");
    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    tempDir = root;
    const spawned: string[][] = [];
    const result = await prepareConnectedWebModel({
      opencodeBin: "opencode",
      configDir: workspace.configDir,
      projectDir: workspace.projectDir,
      env: { PATH: "/bin" },
      mainPath: workspace.mainPath,
      async runCaptured(_command: string, args: string[]) {
        spawned.push(args);
        return {
          code: 0,
          signal: null,
          stdout: "openai/gpt-5\ngithub-copilot/gpt-4.1\n",
          stderr: "",
        };
      },
    });
    expect(spawned).toEqual([OPENCODE_MODELS_ARGS]);
    expect(result).toMatchObject({
      ok: true,
      reason: "valid-model",
      originalModel: "github-copilot/gpt-4.1",
      temporaryModel: "github-copilot/gpt-4.1",
      replaced: false,
    });
    expect(result.spawnedArgs).toEqual(["models"]);
    expect(result.spawnedArgs).not.toContain("run");
    expect(await readFile(path.join(source, "opencode.jsonc"), "utf8")).toBe(originalMain);
    expect(await readFile(workspace.mainPath, "utf8")).toContain(
      '"model": "github-copilot/gpt-4.1"',
    );
    expect(formatWebModelChoice(result)).toContain("Copied default model: github-copilot/gpt-4.1");
    expect(formatWebModelChoice(result)).toContain("Temporary Web model: github-copilot/gpt-4.1");
  });

  it("rewrites only the temp copy when the default model is stale", async () => {
    const root = await makeTemp("oq-connected-stale-model-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "opencode.jsonc"),
      `{
  "model": "github-copilot/claude-sonnet-4.6",
  "plugin": ["opencode-gemini-auth", "@slkiser/opencode-quota", "opencode-agy-auth"]
}
`,
      "utf8",
    );
    const originalMain = await readFile(path.join(source, "opencode.jsonc"), "utf8");
    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    tempDir = root;
    const result = await prepareConnectedWebModel({
      opencodeBin: "opencode",
      configDir: workspace.configDir,
      projectDir: workspace.projectDir,
      env: { PATH: "/bin" },
      mainPath: workspace.mainPath,
      async runCaptured(_command: string, args: string[]) {
        expect(args).toEqual(["models"]);
        expect(args).not.toContain("run");
        return {
          code: 0,
          signal: null,
          stdout: "openai/gpt-5\ngithub-copilot/gpt-4o\ngithub-copilot/gpt-4.1\n",
          stderr: "",
        };
      },
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "stale-model",
      originalModel: "github-copilot/claude-sonnet-4.6",
      temporaryModel: "github-copilot/gpt-4.1",
      replaced: true,
    });
    expect(
      chooseConnectedWebModel("github-copilot/claude-sonnet-4.6", [
        "openai/gpt-5",
        "github-copilot/gpt-4o",
        "github-copilot/gpt-4.1",
      ]).model,
    ).toBe("github-copilot/gpt-4.1");
    expect(await readFile(path.join(source, "opencode.jsonc"), "utf8")).toBe(originalMain);
    const copied = await readFile(workspace.mainPath, "utf8");
    expect(copied).toContain('"model": "github-copilot/gpt-4.1"');
    expect(copied).not.toContain("claude-sonnet-4.6");
    expect(copied).toContain("opencode-gemini-auth");
    expect(copied).toContain("opencode-agy-auth");
    expect(formatWebModelChoice(result)).toContain(
      "Copied default model: github-copilot/claude-sonnet-4.6",
    );
    expect(formatWebModelChoice(result)).toContain("Temporary Web model: github-copilot/gpt-4.1");
  });

  it("fails before launch when the catalog is empty and leaves the real config unchanged", async () => {
    const root = await makeTemp("oq-connected-empty-catalog-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeConfigTree(source);
    const originalMain = await readFile(path.join(source, "real-opencode.jsonc"), "utf8");
    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    tempDir = root;
    const result = await prepareConnectedWebModel({
      opencodeBin: "opencode",
      configDir: workspace.configDir,
      projectDir: workspace.projectDir,
      env: { PATH: "/bin" },
      mainPath: workspace.mainPath,
      async runCaptured() {
        return { code: 0, signal: null, stdout: "No models available\n", stderr: "" };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty-catalog");
    expect(result.replaced).toBe(false);
    expect(result.guidance).toContain("/quota");
    expect(result.guidance).toContain("/quota_status");
    expect(result.guidance).toContain("Click the model name");
    expect(result.guidance).toContain("The real OpenCode config was not edited.");
    expect(await readFile(path.join(source, "real-opencode.jsonc"), "utf8")).toBe(originalMain);
    expect(await readFile(workspace.mainPath, "utf8")).toContain('"model": "test-model"');
  });

  it("fails before launch when opencode models fails and does not send a model request", async () => {
    const root = await makeTemp("oq-connected-models-fail-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeConfigTree(source);
    const originalMain = await readFile(path.join(source, "real-opencode.jsonc"), "utf8");
    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    tempDir = root;
    const result = await prepareConnectedWebModel({
      opencodeBin: "opencode",
      configDir: workspace.configDir,
      projectDir: workspace.projectDir,
      env: { PATH: "/bin" },
      mainPath: workspace.mainPath,
      async runCaptured(_command: string, args: string[]) {
        expect(args).toEqual(["models"]);
        expect(args).not.toContain("run");
        return {
          code: 1,
          signal: null,
          stdout: "",
          stderr: "models failed token=super-secret-token",
        };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("models-command-failed");
    expect(result.spawnedArgs).toEqual(OPENCODE_MODELS_ARGS);
    expect(result.guidance).toContain("/quota");
    expect(result.guidance).toContain("/quota_status");
    expect(result.guidance).not.toContain("super-secret-token");
    expect(result.guidance).toContain("[REDACTED]");
    expect(await readFile(path.join(source, "real-opencode.jsonc"), "utf8")).toBe(originalMain);
    expect(() => assertNoModelRequest(["run", "prompt"])).toThrow(/model request/);
    expect(assertNoModelRequest(["models"])).toEqual(["models"]);
  });

  it("bounds and conservatively redacts diagnostic sources", async () => {
    const redacted = redactConnectedDiagnostics(
      [
        "Authorization: Bearer abc.def",
        "Cookie: session=browser-secret",
        "api_key=sk-live-123",
        "token=super-secret-token",
        '{"access_token":"xyz","authorization":"Bearer abc"}',
        'request body: {"prompt":"private request"}',
        'response body: {"choices":[{"text":"private reply"}]}',
        'serialized config: {"plugin":["private-plugin"],"token":"hidden"}',
        "request body:",
        "{",
        '  "prompt": "multiline-request"',
        "}",
        '"config": {',
        '  "private": "multiline-config"',
        "}",
        '"headers": {',
        '  "X-Custom": "multiline-header"',
        "}",
        "private content=private-message",
        "-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----",
      ].join("\n"),
    );
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain(DIAGNOSTIC_REDACTED_HEADER_MARKER);
    expect(redacted).toContain(DIAGNOSTIC_REDACTED_BODY_MARKER);
    expect(redacted).toContain(DIAGNOSTIC_REDACTED_CONFIG_MARKER);
    expect(redacted).toContain(DIAGNOSTIC_REDACTED_PRIVATE_MARKER);
    for (const secret of [
      "abc.def",
      "browser-secret",
      "sk-live-123",
      "super-secret-token",
      "private request",
      "private reply",
      "private-plugin",
      "multiline-request",
      "multiline-config",
      "multiline-header",
      "private-message",
      "private-key",
    ]) {
      expect(redacted).not.toContain(secret);
    }

    const huge = "x".repeat(WEB_DIAGNOSTIC_TOTAL_MAX_BYTES * 2);
    const formatted = formatWebDiagnostics({ runner: huge, server: huge, log: huge });
    expect(Buffer.byteLength(formatted)).toBeLessThanOrEqual(WEB_DIAGNOSTIC_TOTAL_MAX_BYTES);
    expect(formatted).toContain(DIAGNOSTIC_TRUNCATED_MARKER.trim());
    expect(
      Buffer.byteLength(appendBoundedDiagnostic("", huge, WEB_DIAGNOSTIC_SOURCE_MAX_BYTES)),
    ).toBeLessThanOrEqual(WEB_DIAGNOSTIC_SOURCE_MAX_BYTES);
    expect(
      Buffer.byteLength(
        appendBoundedDiagnostic("", "é".repeat(WEB_DIAGNOSTIC_SOURCE_MAX_BYTES), 101),
      ),
    ).toBeLessThanOrEqual(101);

    const captured = await runCapturedProcess(
      process.execPath,
      ["-e", `process.stdout.write("x".repeat(${CAPTURED_PROCESS_STREAM_MAX_BYTES * 2}))`],
      { cwd: repoRoot, env: process.env },
    );
    expect(Buffer.byteLength(captured.stdout)).toBeLessThanOrEqual(
      CAPTURED_PROCESS_STREAM_MAX_BYTES,
    );
    expect(captured.stdout).toContain(DIAGNOSTIC_TRUNCATED_MARKER.trim());
  });

  it("redacts adversarial multiline bodies, header objects, and quoted secrets in retained files", async () => {
    const root = await makeTemp("oq-connected-adversarial-redaction-");
    tempDir = root;
    const diagnostics = await createWebDiagnosticsFile({ tmpdir: root });
    const requestSecret = "plain request secret with spaces";
    const responseSecret = "plain response secret with spaces";
    const headerSecret = "header secret after a quoted } brace";
    const passwordSecret = "single quoted password with spaces";
    const content = formatWebDiagnostics({
      runner: `request body:\n${requestSecret}\nrequest continuation`,
      server: `response body:\n${responseSecret}\nresponse continuation`,
      log: [
        "headers={",
        '  "X-Decoy": "quoted } brace",',
        `  "X-Private": "${headerSecret}"`,
        "}",
        `password='${passwordSecret}'`,
      ].join("\n"),
    });
    await writeWebDiagnosticsFile(diagnostics.filePath, content);

    const retained = await readFile(diagnostics.filePath, "utf8");
    expect(retained).toContain(DIAGNOSTIC_REDACTED_BODY_MARKER);
    expect(retained).toContain(DIAGNOSTIC_REDACTED_HEADER_MARKER);
    expect(retained).toContain("password='[REDACTED]'");
    for (const secret of [requestSecret, responseSecret, headerSecret, passwordSecret]) {
      expect(retained).not.toContain(secret);
    }
  });

  it("redacts prefixed blocks, quoted body keys, and escaped passwords in retained files", async () => {
    const root = await makeTemp("oq-connected-prefixed-redaction-");
    tempDir = root;
    const diagnostics = await createWebDiagnosticsFile({ tmpdir: root });
    const content = formatWebDiagnostics({
      runner: [
        "2026-09-22T12:34:56Z INFO headers={",
        '  "X-Private": "prefixed-header-secret"',
        "}",
        "level=debug config={",
        '  "private": "prefixed-config-secret"',
        "}",
        "runner-after-blocks",
      ].join("\n"),
      server: [
        '{"response body":{',
        '  "text": "quoted-body-secret"',
        "}}",
        "server-after-body",
      ].join("\n"),
      log: [
        String.raw`password="double-prefix\"double-tail"`,
        String.raw`password='single-prefix\'single-tail'`,
        "log-after-passwords",
      ].join("\n"),
    });
    await writeWebDiagnosticsFile(diagnostics.filePath, content);
    const retained = await readFile(diagnostics.filePath, "utf8");
    for (const secret of [
      "prefixed-header-secret",
      "prefixed-config-secret",
      "quoted-body-secret",
      "double-prefix",
      "double-tail",
      "single-prefix",
      "single-tail",
    ]) {
      expect(retained).not.toContain(secret);
    }
    for (const marker of [
      DIAGNOSTIC_REDACTED_HEADER_MARKER,
      DIAGNOSTIC_REDACTED_CONFIG_MARKER,
      DIAGNOSTIC_REDACTED_BODY_MARKER,
      'password="[REDACTED]"',
      "password='[REDACTED]'",
      "runner-after-blocks",
      "server-after-body",
      "log-after-passwords",
    ]) {
      expect(retained).toContain(marker);
    }
  });

  it("slices OpenCode log records from the starting offset", async () => {
    const prefix = "historical-log-line\n";
    const next = "ProviderModelNotFoundError: Model not found: github-copilot/claude-sonnet-4.6\n";
    expect(sliceLogFromOffset(`${prefix}${next}`, Buffer.byteLength(prefix))).toBe(next);
    expect(sliceLogFromOffset(`${prefix}${next}`, Buffer.byteLength(`${prefix}${next}`))).toBe("");

    const root = await makeTemp("oq-connected-log-slice-");
    const logDir = path.join(root, "log");
    await mkdir(logDir);
    const logFile = path.join(logDir, "opencode.log");
    await writeFile(logFile, prefix, "utf8");
    const offsets = await snapshotLogOffsets([logDir]);
    await writeFile(logFile, `${prefix}${next}`, "utf8");
    await writeFile(
      logFile,
      `${prefix}${next}${"x".repeat(WEB_DIAGNOSTIC_LOG_MAX_BYTES * 2)}`,
      "utf8",
    );
    const sliced = await readNewLogRecords([logDir], offsets);
    expect(sliced).toContain(next.trim());
    expect(sliced).not.toContain("historical-log-line");
    expect(Buffer.byteLength(sliced)).toBeLessThanOrEqual(WEB_DIAGNOSTIC_LOG_MAX_BYTES);
    expect(sliced).toContain(DIAGNOSTIC_TRUNCATED_MARKER.trim());
  });

  it("keeps each decoded log slice within 65,536 bytes at a split UTF-8 character", async () => {
    const root = await makeTemp("oq-connected-log-utf8-cap-");
    tempDir = root;
    const logDir = path.join(root, "log");
    await mkdir(logDir);
    const logFile = path.join(logDir, "multibyte.log");
    const contentLimit =
      WEB_DIAGNOSTIC_SOURCE_MAX_BYTES - Buffer.byteLength(DIAGNOSTIC_TRUNCATED_MARKER);
    await writeFile(
      logFile,
      `${"x".repeat(contentLimit - 1)}é${"z".repeat(WEB_DIAGNOSTIC_SOURCE_MAX_BYTES)}`,
      "utf8",
    );

    const records = await readNewLogRecords([logDir], new Map());
    const heading = "=== multibyte.log ===\n";
    expect(records.startsWith(heading)).toBe(true);
    const decodedSlice = records.slice(heading.length, -1);
    expect(Buffer.byteLength(decodedSlice)).toBeLessThanOrEqual(WEB_DIAGNOSTIC_SOURCE_MAX_BYTES);
    expect(decodedSlice).toContain(DIAGNOSTIC_TRUNCATED_MARKER.trim());
  });

  it("resolves injectable Linux and macOS OpenCode log paths", () => {
    expect(resolveOpenCodeLogDirs({}, "/home/tester", "linux")).toEqual([
      "/home/tester/.local/share/opencode/log",
    ]);
    expect(resolveOpenCodeLogDirs({ XDG_DATA_HOME: "/xdg" }, "/home/tester", "linux")).toEqual([
      "/xdg/opencode/log",
    ]);
    expect(resolveOpenCodeLogDirs({}, "/Users/tester", "darwin")).toEqual([
      "/Users/tester/Library/Application Support/opencode/log",
    ]);
    expect(resolveOpenCodeLogDirs({ XDG_DATA_HOME: "/custom" }, "/Users/tester", "darwin")).toEqual(
      ["/custom/opencode/log", "/Users/tester/Library/Application Support/opencode/log"],
    );
  });

  it("resolves injectable Windows OpenCode log paths on any host", () => {
    expect(resolveOpenCodeLogDirs({}, String.raw`C:\Users\tester`, "win32")).toEqual([
      String.raw`C:\Users\tester\.local\share\opencode\log`,
    ]);
    expect(
      resolveOpenCodeLogDirs(
        { XDG_DATA_HOME: " D:/data/../xdg/ " },
        String.raw`C:\Users\tester`,
        "win32",
      ),
    ).toEqual([String.raw`D:\xdg\opencode\log`]);
  });

  it.each([
    ["linux", "/home/tester", "/home/tester/.local/share/opencode/log"],
    ["darwin", "/Users/tester", "/Users/tester/Library/Application Support/opencode/log"],
    ["win32", String.raw`C:\Users\tester`, String.raw`C:\Users\tester\.local\share\opencode\log`],
  ])("uses the %s fallback for blank XDG_DATA_HOME on any host", (platform, home, expected) => {
    expect(resolveOpenCodeLogDirs({ XDG_DATA_HOME: "   " }, home, platform)).toEqual([expected]);
  });

  it("deduplicates normalized macOS XDG and Application Support log paths", () => {
    expect(
      resolveOpenCodeLogDirs(
        { XDG_DATA_HOME: " /Users/tester/Library/../Library/Application Support/ " },
        "/Users/tester",
        "darwin",
      ),
    ).toEqual(["/Users/tester/Library/Application Support/opencode/log"]);
  });

  it("deletes the temp workspace while retaining only sanitized diagnostics", async () => {
    const root = await makeTemp("oq-connected-diag-cleanup-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeConfigTree(source);
    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    const diagnostics = await createWebDiagnosticsFile({ tmpdir: root });
    const content = formatWebDiagnostics({
      originalModel: "github-copilot/claude-sonnet-4.6",
      temporaryModel: "github-copilot/gpt-4.1",
      runner: `token=${SECRET}\nplugin initialized\n`,
      server: "Authorization: Bearer abc.def\n",
      log: "ProviderModelNotFoundError: Model not found: github-copilot/claude-sonnet-4.6\n",
    });
    await writeWebDiagnosticsFile(diagnostics.filePath, content);
    const tempRoot = workspace.tempRoot;
    await cleanupConnectedWorkspace(tempRoot, { tmpdir: root });
    await expect(lstat(tempRoot)).rejects.toThrow();
    expect(await readFile(diagnostics.filePath, "utf8")).toContain(
      WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK,
    );
    expect(await readFile(diagnostics.filePath, "utf8")).not.toContain(SECRET);
    expect(await readFile(diagnostics.filePath, "utf8")).not.toContain("abc.def");
    expect(formatWebDiagnosticsPath(diagnostics.filePath)).toContain(diagnostics.filePath);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it("does not reinterpret malformed structured catalog output as plain model IDs", () => {
    for (const text of [
      '"p/model',
      '"p/model" trailing',
      'warning: cached catalog unavailable\n"p/model',
      '"p/model\nopenai/gpt-5',
      '{"id":"openai/gpt-5"',
      '[{"id":"openai/gpt-5"}',
    ]) {
      expect(parseOpenCodeModelsOutput(text)).toEqual([]);
    }
    expect(parseOpenCodeModelsOutput('[{"id":"openai/gpt-5"}] trailing')).toEqual([]);
    expect(
      parseOpenCodeModelsOutput("warning: cached catalog unavailable\nopenai/gpt-5\n"),
    ).toMatchObject([{ id: "openai/gpt-5", usability: "usable", source: "plain" }]);
  });

  it("retains catalog usability metadata and fails closed for aliases or unknown entries", () => {
    const plain = parseOpenCodeModelsOutput(
      "warning: cache is stale\ngithub-copilot/gpt-4.1\nhttps://example.com/x\n",
    );
    expect(plain).toMatchObject([
      { id: "github-copilot/gpt-4.1", usability: "usable", source: "plain" },
    ]);
    expect(
      parseOpenCodeModelsOutput(
        "openai/ready status=ready\nopenai/alias alias\nopenai/disabled disabled\nopenai/unknown tier=premium\n",
      ).map((model) => [model.id, model.usability]),
    ).toEqual([
      ["openai/ready", "usable"],
      ["openai/alias", "rejected"],
      ["openai/disabled", "rejected"],
      ["openai/unknown", "unknown"],
    ]);

    const structured = parseOpenCodeModelsOutput(
      `warning: using cached provider metadata
${JSON.stringify({
  models: [
    { providerID: "openai", id: "gpt-5", available: true, context: 400000 },
    { providerID: "openai", id: "gpt-alias", available: true, aliasOf: "gpt-5" },
    { providerID: "openai", id: "gpt-hidden", available: true, hidden: true },
    { providerID: "openai", id: "gpt-offline", status: "unavailable" },
    { providerID: "openai", id: "gpt-unknown", context: 128000 },
    { providerID: "openai", id: "gpt-conflict", status: "active", availability: "unavailable" },
    { providerID: "openai", id: "gpt-disabled-active", status: "active", disabled: true },
    { providerID: "openai", id: "gpt-hidden-active", status: "active", hidden: true },
    { providerID: "openai", id: "gpt-alias-active", status: "active", alias: true },
    { providerID: "openai", id: "gpt-ambiguous", status: "active", availability: "sometimes" },
    { providerID: "github-copilot", id: "gpt-4.1", status: "ready" },
  ],
})}`,
    );
    expect(structured.map((model) => [model.id, model.usability])).toEqual([
      ["openai/gpt-5", "usable"],
      ["openai/gpt-alias", "rejected"],
      ["openai/gpt-hidden", "rejected"],
      ["openai/gpt-offline", "rejected"],
      ["openai/gpt-unknown", "unknown"],
      ["openai/gpt-conflict", "rejected"],
      ["openai/gpt-disabled-active", "rejected"],
      ["openai/gpt-hidden-active", "rejected"],
      ["openai/gpt-alias-active", "rejected"],
      ["openai/gpt-ambiguous", "unknown"],
      ["github-copilot/gpt-4.1", "usable"],
    ]);
    expect((structured[0]?.metadata as { context?: number } | undefined)?.context).toBe(400000);
    expect(chooseConnectedWebModel("openai/stale", structured)).toEqual({
      status: "replace",
      model: "openai/gpt-5",
    });
    expect(
      chooseConnectedWebModel(
        "openai/stale",
        structured.filter((model) => model.usability !== "usable"),
      ),
    ).toEqual({ status: "empty-catalog", model: null });
    expect(
      chooseConnectedWebModel("openai/stale", ["z/model", "a/model", "openai/z", "openai/a"]),
    ).toEqual({ status: "replace", model: "openai/a" });
  });

  it("requires affirmative assignments for both output and busy evidence", () => {
    for (const output of [
      "raw output injected",
      "injected raw output",
      "quota output ready",
      "quota output rendered",
      "quota output written",
      "slash command output complete",
    ]) {
      for (const busy of ["session busy", "session is busy", "session-busy"]) {
        for (const assignment of ["=false", ": false", "=0", "=unknown", '="false"']) {
          expect(
            classifyWebDiagnostic(`command.execute.before\n${output}${assignment}\n${busy}`),
          ).toBe(WEB_FAILURE_UNKNOWN);
          expect(
            classifyWebDiagnostic(`command.execute.before\n${output}\n${busy}${assignment}`),
          ).toBe(WEB_FAILURE_UNKNOWN);
        }
        expect(classifyWebDiagnostic(`command.execute.before\n${output}=true\n${busy}=true`)).toBe(
          WEB_FAILURE_POST_INJECTION_BUSY_272,
        );
        expect(classifyWebDiagnostic(`command.execute.before\n${output}\nnot ${busy}`)).toBe(
          WEB_FAILURE_UNKNOWN,
        );
      }
    }
  });

  it("prints click/select guidance and requires ordered positive diagnostic evidence", () => {
    const guidance = formatConnectedWebModelGuidance({
      originalModel: "github-copilot/claude-sonnet-4.6",
      catalog: ["github-copilot/gpt-4.1", "openai/gpt-5"],
      reason: "empty-catalog",
    });
    expect(guidance).toContain(CONNECTED_WEB_COMMANDS[0]);
    expect(guidance).toContain(CONNECTED_WEB_COMMANDS[1]);
    expect(guidance).toContain("Click the model name in the OpenCode Web session header");
    expect(guidance).toContain("github-copilot/gpt-4.1");
    expect(getConnectedUsage()).toContain("opencode models");
    expect(getConnectedUsage()).toMatch(/bounded, sanitized diagnostics/i);
    expect(chooseConnectedWebModel("gpt-4.1", ["github-copilot/gpt-4.1", "openai/gpt-5"])).toEqual({
      status: "replace",
      model: "github-copilot/gpt-4.1",
    });
    expect(
      classifyWebDiagnostic(
        "plugin initialized\nProviderModelNotFoundError: Model not found: github-copilot/claude-sonnet-4.6",
      ),
    ).toBe(WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK);
    expect(
      classifyWebDiagnostic(
        "ProviderModelNotFoundError\ncommand.execute.before\nFailed to send command",
      ),
    ).toBe(WEB_FAILURE_UNKNOWN);
    expect(classifyWebDiagnostic("command.execute.before\nFailed to inject raw output")).toBe(
      WEB_FAILURE_HOOK_ENTRY_BUILD_INJECTION,
    );
    expect(
      classifyWebDiagnostic(
        "command.execute.before\nquota output rendered\nFailed to send command: network disconnected",
      ),
    ).toBe(WEB_FAILURE_UNKNOWN);
    expect(
      classifyWebDiagnostic("command.execute.before\nnot raw output injected\nsession is busy"),
    ).toBe(WEB_FAILURE_UNKNOWN);
    expect(
      classifyWebDiagnostic(
        "command.execute.before\nquota output rendered\nFailed to send command: session is busy",
      ),
    ).toBe(WEB_FAILURE_POST_INJECTION_BUSY_272);
    expect(classifyWebDiagnostic("session is busy")).toBe(WEB_FAILURE_UNKNOWN);
    expect(
      formatWebDiagnostics({
        runner: "ProviderModelNotFoundError",
        server: "command.execute.before\nFailed to send command",
      }),
    ).toContain(`Failure class: ${WEB_FAILURE_UNKNOWN}`);
  });

  it.each([
    {
      label: "empty catalog",
      env: { FAKE_MODELS_OUTPUT: "No models available\n" },
    },
    {
      label: "failed catalog command",
      env: {
        FAKE_MODELS_EXIT: "1",
        FAKE_MODELS_STDERR: "Authorization: Bearer catalog-secret\n",
      },
    },
  ])("uses a fake executable to stop before Web launch for $label", async ({ env }) => {
    if (process.platform === "win32") return;
    const root = await makeTemp("oq-connected-web-catalog-e2e-");
    const harness = await writeFakeWebHarness(root);
    const originalConfig = await readFile(path.join(harness.source, "opencode.jsonc"), "utf8");
    const output: string[] = [];
    const code = await runConnected(["--web"], {
      repoRoot: harness.fakeRepo,
      tmpdir: root,
      env: { ...harness.env, ...env },
      stdout: captureOutput(output),
      stderr: captureOutput(output),
    });
    expect(code).toBe(1);
    expect((await readFakeRecords(harness.recordFile)).map((record) => record.args)).toEqual([
      ["models"],
    ]);
    expect(output.join("")).toContain("refused to launch");
    expect(output.join("")).not.toContain("catalog-secret");
    expect(await readFile(path.join(harness.source, "opencode.jsonc"), "utf8")).toBe(
      originalConfig,
    );
    expect(await prefixDirs(root)).toEqual([]);
  });

  it.each([undefined, process.execPath])(
    "runs fake Web with isolated env and preserves exit after a diagnostic retry (inherited npm_execpath: %s)",
    async (npmExecPath) => {
      // An existing non-pnpm path makes accidental inheritance fail even in focused runs.
      vi.stubEnv("npm_execpath", npmExecPath);
      const root = await makeTemp("oq-connected-web-run-e2e with spaces-");
      const harness = await writeFakeWebHarness(root);
      const originalConfig = await readFile(path.join(harness.source, "opencode.jsonc"), "utf8");
      const output: string[] = [];
      let writes = 0;
      const code = await runConnected(["--web"], {
        repoRoot: harness.fakeRepo,
        tmpdir: root,
        env: {
          ...harness.env,
          FAKE_MODELS_OUTPUT: "provider/model\n",
          FAKE_WEB_EXIT: "7",
          FAKE_WEB_STDOUT: 'response body: {"private":"reply"}\n',
          FAKE_WEB_STDERR: "Cookie: session=browser-secret\n",
        },
        stdout: captureOutput(output),
        stderr: captureOutput(output),
        async writeWebDiagnosticsFile(filePath: string, content: string) {
          writes += 1;
          if (writes === 1) throw new Error("injected diagnostic write failure");
          return writeWebDiagnosticsFile(filePath, content);
        },
      });
      expect(code).toBe(7);
      expect(JSON.parse(await readFile(harness.buildRecordFile, "utf8"))).toEqual(["run", "build"]);
      expect(writes).toBe(2);
      const records = await readFakeRecords(harness.recordFile);
      expect(records.map((record) => record.args)).toEqual([["models"], ["web"]]);
      expect(records[0]?.configDir).toBe(records[1]?.configDir);
      expect(records[0]?.configFile).toBeNull();
      expect(records[1]?.configFile).toBeNull();
      expect(records[0]?.cwd).toBe(records[1]?.cwd);
      expect(records[1]?.configContents).toContain("// keep this comment and plugin order");
      expect(records[1]?.configContents).toMatch(
        /companion-before[\s\S]+dist\/index\.js[\s\S]+companion-after/,
      );
      expect(records[1]?.configContents).toContain('"model": "provider/model"');
      await expect(lstat(String(records[0]?.configDir))).rejects.toThrow();
      expect(await readFile(path.join(harness.source, "opencode.jsonc"), "utf8")).toBe(
        originalConfig,
      );
      expect(await prefixDirs(root)).toEqual([]);

      const combined = output.join("");
      expect(combined).toContain("injected diagnostic write failure");
      const pathMatches = [
        ...combined.matchAll(/Web diagnostics \(sanitized, this run only\): (.+)/g),
      ];
      expect(pathMatches).toHaveLength(1);
      const diagnosticPath = pathMatches[0]?.[1]?.trim();
      expect(diagnosticPath).toBeTruthy();
      expect(diagnosticPath).not.toContain(String(records[0]?.configDir));
      const diagnostic = await readFile(diagnosticPath as string, "utf8");
      expect(diagnostic).toContain(DIAGNOSTIC_REDACTED_BODY_MARKER);
      expect(diagnostic).toContain(DIAGNOSTIC_REDACTED_HEADER_MARKER);
      expect(diagnostic).not.toContain("browser-secret");
      expect(diagnostic).not.toContain('"private":"reply"');
      if (process.platform !== "win32") {
        expect((await lstat(path.dirname(diagnosticPath as string))).mode & 0o777).toBe(0o700);
        expect((await lstat(diagnosticPath as string)).mode & 0o777).toBe(0o600);
      }
    },
    30_000,
  );

  it("preserves the original preflight signal after escalation and prints no catalog guidance", async () => {
    if (process.platform === "win32") return;
    const root = await makeTemp("oq-connected-web-signal-e2e-");
    const harness = await writeFakeWebHarness(root);
    const output: string[] = [];
    const signalSource = new EventEmitter();
    const running = runConnected(["--web"], {
      repoRoot: harness.fakeRepo,
      tmpdir: root,
      signalGraceMs: 60,
      signalSource,
      env: { ...harness.env, FAKE_MODELS_HANG: "1" },
      stdout: captureOutput(output),
      stderr: captureOutput(output),
    });
    await waitForFile(harness.startedFile, "models\n");
    signalSource.emit("SIGTERM");
    expect(await running).toBe(143);
    expect((await readFakeRecords(harness.recordFile)).map((record) => record.args)).toEqual([
      ["models"],
    ]);
    expect(output.join("")).not.toContain("Connected Web preflight refused to launch");
    expect(await prefixDirs(root)).toEqual([]);
  });
});
