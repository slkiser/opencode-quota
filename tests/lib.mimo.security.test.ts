import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: mocks.readFile,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: mocks.getOpencodeRuntimeDirCandidates,
}));

const originalEnv = process.env;

describe("MiMo credential security boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MIMO_USAGE_COOKIE;
    mocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: ["/trusted/primary", "/trusted/fallback"],
    });
    mocks.readFile.mockImplementation(async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("checks only trusted user/global mimo.json candidates", async () => {
    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");

    await expect(resolveMimoConfig()).resolves.toEqual({ state: "none" });
    expect(mocks.readFile.mock.calls.map((call) => call[0])).toEqual([
      "/trusted/primary/opencode-quota/mimo.json",
      "/trusted/fallback/opencode-quota/mimo.json",
    ]);

    const checked = JSON.stringify(mocks.readFile.mock.calls);
    expect(checked).not.toContain("auth.json");
    expect(checked).not.toContain("opencode.json");
    expect(checked).not.toContain("opencode.db");
    expect(checked).not.toContain("cookies.sqlite");
    expect(checked).not.toContain(process.cwd());
  });

  it("does not inspect files when the higher-priority environment credential is invalid", async () => {
    process.env.MIMO_USAGE_COOKIE = "Cookie: userId=private-user";

    const { resolveMimoConfig } = await import("../src/lib/mimo-config.js");
    const result = await resolveMimoConfig();

    expect(result).toEqual({
      state: "invalid",
      source: "env:MIMO_USAGE_COOKIE",
      error: "Invalid cookie header",
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-user");
    expect(JSON.stringify(result)).not.toContain("userId");
  });
});
