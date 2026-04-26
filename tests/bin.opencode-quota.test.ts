import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  runInitInstaller: vi.fn(),
  runCliShowCommand: vi.fn(),
}));

vi.mock("../src/lib/init-installer.js", () => ({
  runInitInstaller: commandMocks.runInitInstaller,
}));

vi.mock("../src/lib/cli-show.js", () => ({
  runCliShowCommand: commandMocks.runCliShowCommand,
}));

describe("opencode-quota bin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandMocks.runInitInstaller.mockResolvedValue(0);
    commandMocks.runCliShowCommand.mockResolvedValue(0);
  });

  it("dispatches init to the interactive installer", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["init"]);

    expect(code).toBe(0);
    expect(commandMocks.runInitInstaller).toHaveBeenCalledOnce();
    expect(commandMocks.runCliShowCommand).not.toHaveBeenCalled();
  });

  it("dispatches show to the quota CLI command", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["show"]);

    expect(code).toBe(0);
    expect(commandMocks.runCliShowCommand).toHaveBeenCalledWith({ argv: [] });
    expect(commandMocks.runInitInstaller).not.toHaveBeenCalled();
  });

  it("passes show provider args through to the quota CLI command", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["show", "--provider", "copilot"]);

    expect(code).toBe(0);
    expect(commandMocks.runCliShowCommand).toHaveBeenCalledWith({
      argv: ["--provider", "copilot"],
    });
  });

  it("prints help and exits zero for --help", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["--help"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota show"));
    log.mockRestore();
  });

  it("prints usage and exits non-zero for no args", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main([]);

    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota show"));
    log.mockRestore();
  });

  it("prints usage and exits non-zero for unknown commands", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["wat"]);

    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode-quota show"));
    log.mockRestore();
  });

  it("treats symlinked bin paths as direct CLI execution", async () => {
    const { cliShouldRunMain } = await import("../src/bin/opencode-quota.js");

    const modulePath = fileURLToPath(
      new URL("../src/bin/opencode-quota.ts", import.meta.url),
    );
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
});
