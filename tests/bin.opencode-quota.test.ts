import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commandMocks = vi.hoisted(() => ({
  runCliShowCommand: vi.fn(),
  runCliStatusCommand: vi.fn(),
}));

vi.mock("../src/lib/cli-show.js", () => commandMocks);

describe("opencode-quota bin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandMocks.runCliShowCommand.mockResolvedValue(0);
    commandMocks.runCliStatusCommand.mockResolvedValue(0);
  });

  it("dispatches show to the quota CLI command", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["show"]);

    expect(code).toBe(0);
    expect(commandMocks.runCliShowCommand).toHaveBeenCalledWith({ argv: [] });
    expect(commandMocks.runCliStatusCommand).not.toHaveBeenCalled();
  });

  it("passes show provider args through to the quota CLI command", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["show", "--provider", "copilot"]);

    expect(code).toBe(0);
    expect(commandMocks.runCliShowCommand).toHaveBeenCalledWith({
      argv: ["--provider", "copilot"],
    });
  });

  it("dispatches status to the quota status CLI command", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["status"]);

    expect(code).toBe(0);
    expect(commandMocks.runCliStatusCommand).toHaveBeenCalledWith({ argv: [] });
    expect(commandMocks.runCliShowCommand).not.toHaveBeenCalled();
  });

  it("passes status provider args through to the status CLI command", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["status", "--provider", "copilot", "--json"]);

    expect(code).toBe(0);
    expect(commandMocks.runCliStatusCommand).toHaveBeenCalledWith({
      argv: ["--provider", "copilot", "--json"],
    });
  });

  it("prints help and exits zero for --help", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["--help"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota show"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota status"));
    const help = String(log.mock.calls[0]?.[0]);
    for (const removed of ["opencode-quota init", "opencode-quota update", "provider add"]) {
      expect(help).not.toContain(removed);
    }
    log.mockRestore();
  });

  it("prints usage and exits non-zero for no args", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main([]);

    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota status"));
    log.mockRestore();
  });

  it.each([
    ["an unknown command", ["wat"]],
    ["the removed init command", ["init"]],
    ["the removed update command", ["update", "--dry-run"]],
    ["the removed provider add command", ["provider", "add"]],
  ])("prints usage and exits non-zero for %s", async (_name, argv) => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(argv);

    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota status"));
    expect(commandMocks.runCliShowCommand).not.toHaveBeenCalled();
    expect(commandMocks.runCliStatusCommand).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("treats symlinked bin paths as direct CLI execution", async () => {
    const { cliShouldRunMain } = await import("../src/bin/opencode-quota.js");

    const modulePath = fileURLToPath(new URL("../src/bin/opencode-quota.ts", import.meta.url));
    const tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-bin-"));
    const symlinkPath = join(tempDir, "opencode-quota");

    try {
      symlinkSync(modulePath, symlinkPath);

      expect(cliShouldRunMain(symlinkPath, modulePath)).toBe(true);
      expect(cliShouldRunMain(join(tempDir, "other.js"), modulePath)).toBe(false);
      expect(cliShouldRunMain(undefined, modulePath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("hides only Node's experimental SQLite warning", async () => {
    const { hideSqliteExperimentalWarning } = await import("../src/bin/opencode-quota.js");
    const originalEmitWarning = process.emitWarning;
    const emitWarning = vi.fn();
    process.emitWarning = emitWarning as unknown as typeof process.emitWarning;
    try {
      hideSqliteExperimentalWarning();

      process.emitWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
      process.emitWarning("Some other feature is experimental", "ExperimentalWarning");
      process.emitWarning("SQLite is an experimental feature and might change at any time");

      expect(emitWarning.mock.calls).toEqual([
        ["Some other feature is experimental", "ExperimentalWarning"],
        ["SQLite is an experimental feature and might change at any time"],
      ]);
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  });

  // Run after `pnpm build`: loads node:sqlite in a real Node process.
  it("keeps the SQLite warning off stderr when the built CLI loads node:sqlite", () => {
    const bin = fileURLToPath(new URL("../dist/bin/opencode-quota.js", import.meta.url));
    expect(existsSync(bin)).toBe(true);
    const script = [
      `const { hideSqliteExperimentalWarning } = await import(${JSON.stringify(pathToFileURL(bin).href)});`,
      "hideSqliteExperimentalWarning();",
      'await import("node:sqlite");',
      'process.emitWarning("Some other feature is experimental", "ExperimentalWarning");',
    ].join("\n");

    const { status, stderr } = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    expect(status).toBe(0);
    expect(stderr).not.toContain("SQLite");
    expect(stderr).toContain("ExperimentalWarning: Some other feature is experimental");
  });
});
