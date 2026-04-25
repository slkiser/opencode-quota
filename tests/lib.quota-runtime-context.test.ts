import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mockedHomeDir = vi.hoisted(() => ({
  value: "",
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => mockedHomeDir.value || actual.homedir(),
  };
});

import {
  resolveQuotaRuntimeContext,
  type QuotaRuntimeClient,
} from "../src/lib/quota-runtime-context.js";
import { resolveRuntimeContextRoots } from "../src/lib/config-file-utils.js";

describe("quota runtime context", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  let tempDir: string;
  let worktreeDir: string;
  let nestedDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-runtime-context-"));
    mockedHomeDir.value = tempDir;
    worktreeDir = join(tempDir, "worktree");
    nestedDir = join(worktreeDir, "packages", "feature");
    xdgConfigHome = join(tempDir, "xdg-config");

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });

    process.env = {
      ...originalEnv,
      HOME: tempDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(tempDir, "xdg-data"),
      XDG_CACHE_HOME: join(tempDir, "xdg-cache"),
      XDG_STATE_HOME: join(tempDir, "xdg-state"),
      APPDATA: join(tempDir, "appdata", "roaming"),
      LOCALAPPDATA: join(tempDir, "appdata", "local"),
    };
    process.chdir(nestedDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    mockedHomeDir.value = "";
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createClient(): QuotaRuntimeClient {
    return {
      config: {
        get: vi.fn().mockResolvedValue({ data: {} }),
        providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "copilot" }] } }),
      },
    } as unknown as QuotaRuntimeClient;
  }

  it("keeps workspace-root and config-root selection separate", () => {
    expect(
      resolveRuntimeContextRoots({
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        configRoot: nestedDir,
        fallbackDirectory: nestedDir,
      }),
    ).toEqual({
      workspaceRoot: worktreeDir,
      configRoot: nestedDir,
    });
  });

  it("loads config from the resolved shared config root", async () => {
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
          },
        },
      }),
      "utf8",
    );

    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
          },
        },
      }),
      "utf8",
    );

    const runtime = await resolveQuotaRuntimeContext({
      client: createClient(),
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
      providers: [],
    });

    expect(runtime.roots).toEqual({
      workspaceRoot: worktreeDir,
      configRoot: worktreeDir,
    });
    expect(runtime.config.enabled).toBe(false);
    expect(runtime.configMeta.source).toBe("files");
    expect(runtime.configMeta.paths).toContain(
      join(worktreeDir, "opencode.json") + " (experimental.quotaToast)",
    );
    expect(runtime.configMeta.paths).not.toContain(
      join(nestedDir, "opencode.json") + " (experimental.quotaToast)",
    );
  });

  it("resolves session meta only when the shared config requests it", async () => {
    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            onlyCurrentModel: true,
          },
        },
      }),
      "utf8",
    );

    const resolveSessionMeta = vi.fn().mockResolvedValue({
      providerID: "copilot",
      modelID: "gpt-4.1",
    });

    const runtime = await resolveQuotaRuntimeContext({
      client: createClient(),
      roots: {
        workspaceRoot: worktreeDir,
        configRoot: nestedDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
      sessionID: "session-1",
      resolveSessionMeta,
      includeSessionMeta: (config) => config.onlyCurrentModel,
      providers: [],
    });

    expect(resolveSessionMeta).toHaveBeenCalledWith("session-1");
    expect(runtime.roots).toEqual({
      workspaceRoot: worktreeDir,
      configRoot: nestedDir,
    });
    expect(runtime.session.sessionMeta).toEqual({
      providerID: "copilot",
      modelID: "gpt-4.1",
    });
  });
});
