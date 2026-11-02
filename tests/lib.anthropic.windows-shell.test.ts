import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildClaudeCommandInvocation } from "../src/lib/anthropic.js";

/** What the Claude CLI probe does with an invocation, minus the parsing of its output. */
function run(binaryPath: string, args: string[]): Promise<string> {
  const invocation = buildClaudeCommandInvocation(binaryPath, args);
  return new Promise((resolve, reject) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        encoding: "utf8",
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

// The other Anthropic tests mock child_process, so only a real cmd.exe can catch a quoting mistake.
describe.runIf(process.platform === "win32")("Claude commands through a real cmd.exe", () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A `.cmd` shim, like the one an npm install of Claude Code puts on PATH. */
  async function shim(name: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "quota-claude-"));
    const file = join(dir, name);
    // `%~1` drops the quotes cmd.exe leaves around each argument, as a real claude.exe would.
    await writeFile(file, "@echo off\r\necho 2.1.0 (Claude Code) %~1 %~2 %~3\r\n");
    return file;
  }

  it("runs a .cmd shim at a path with a space", async () => {
    const file = await shim("claude shim.cmd");

    await expect(run(file, ["auth", "status", "--json"])).resolves.toBe(
      "2.1.0 (Claude Code) auth status --json",
    );
  });

  it("runs the bare command name found on PATH", async () => {
    await shim("claude.cmd");
    vi.stubEnv("PATH", `${dir};${process.env["PATH"] ?? ""}`);

    await expect(run("claude", ["--version"])).resolves.toBe("2.1.0 (Claude Code) --version");
  });
});
