import { beforeEach, describe, expect, it, vi } from "vitest";

const installerMocks = vi.hoisted(() => ({
  runInitInstaller: vi.fn(),
}));

vi.mock("../src/lib/init-installer.js", () => ({
  runInitInstaller: installerMocks.runInitInstaller,
}));

describe("opencode-quota bin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installerMocks.runInitInstaller.mockResolvedValue(0);
  });

  it("dispatches init to the interactive installer", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");

    const code = await main(["init"]);

    expect(code).toBe(0);
    expect(installerMocks.runInitInstaller).toHaveBeenCalledOnce();
  });

  it("prints help and exits zero for --help", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["--help"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });

  it("prints usage and exits non-zero for no args", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main([]);

    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });

  it("prints usage and exits non-zero for unknown commands", async () => {
    const { main } = await import("../src/bin/opencode-quota.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["wat"]);

    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    log.mockRestore();
  });
});
