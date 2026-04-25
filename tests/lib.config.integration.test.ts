import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, normalize } from "path";

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

import { loadConfig } from "../src/lib/config.js";
import { getOpencodeRuntimeDirCandidates } from "../src/lib/opencode-runtime-paths.js";

describe("loadConfig integration runtime-path resolution", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  let tempDir: string;
  let workspaceDir: string;
  let nestedDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-config-integration-"));
    mockedHomeDir.value = tempDir;
    workspaceDir = join(tempDir, "workspace");
    nestedDir = join(workspaceDir, "packages", "feature");
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

  it("uses real runtime dirs as defaults and explicit cwd config as overrides", async () => {
    const env = {
      ...process.env,
      HOME: tempDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(tempDir, "xdg-data"),
      XDG_CACHE_HOME: join(tempDir, "xdg-cache"),
      XDG_STATE_HOME: join(tempDir, "xdg-state"),
      APPDATA: join(tempDir, "appdata", "roaming"),
      LOCALAPPDATA: join(tempDir, "appdata", "local"),
    } as NodeJS.ProcessEnv;
    const { configDirs } = getOpencodeRuntimeDirCandidates({ env, homeDir: tempDir });
    for (const dir of configDirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "opencode.json"),
        JSON.stringify({
          experimental: {
            quotaToast: {
              enabled: false,
              enabledProviders: ["openai"],
              showOnIdle: false,
              pricingSnapshot: { source: "bundled", autoRefresh: 30 },
            },
          },
        }),
        "utf8",
      );
    }

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["nano-gpt"],
            formatStyle: "allWindows",
            onlyCurrentModel: true,
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
            enabledProviders: ["chutes"],
          },
        },
      }),
      "utf8",
    );

    const meta = { source: "defaults" as const, paths: [] as string[], networkSettingSources: {} as Record<string, string> };
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(cfg.showOnIdle).toBe(false);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.onlyCurrentModel).toBe(true);

    expect(meta.source).toBe("files");
    expect(
      meta.paths.some((path) =>
        configDirs.includes(
          normalize(dirname(path.replace(/ \(experimental\.quotaToast\)$/, ""))),
        ),
      ),
    ).toBe(true);
    expect(meta.paths).toContain(join(workspaceDir, "opencode.json") + " (experimental.quotaToast)");
    expect(meta.paths).not.toContain(join(nestedDir, "opencode.json") + " (experimental.quotaToast)");
    expect(
      configDirs.some(
        (dir) =>
          meta.networkSettingSources.enabled ===
          join(dir, "opencode.json") + " (experimental.quotaToast)",
      ),
    ).toBe(true);
    expect(
      configDirs.some(
        (dir) =>
          meta.networkSettingSources.enabledProviders ===
          join(dir, "opencode.json") + " (experimental.quotaToast)",
      ),
    ).toBe(true);
    expect(
      configDirs.some(
        (dir) =>
          meta.networkSettingSources["pricingSnapshot.source"] ===
          join(dir, "opencode.json") + " (experimental.quotaToast)",
      ),
    ).toBe(true);
    expect(
      configDirs.some(
        (dir) =>
          meta.networkSettingSources["pricingSnapshot.autoRefresh"] ===
          join(dir, "opencode.json") + " (experimental.quotaToast)",
      ),
    ).toBe(true);
  });

  it("keeps global network-setting precedence while switching local config root", async () => {
    const env = {
      ...process.env,
      HOME: tempDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(tempDir, "xdg-data"),
      XDG_CACHE_HOME: join(tempDir, "xdg-cache"),
      XDG_STATE_HOME: join(tempDir, "xdg-state"),
      APPDATA: join(tempDir, "appdata", "roaming"),
      LOCALAPPDATA: join(tempDir, "appdata", "local"),
    } as NodeJS.ProcessEnv;
    const { configDirs } = getOpencodeRuntimeDirCandidates({ env, homeDir: tempDir });

    for (const dir of configDirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "opencode.json"),
        JSON.stringify({
          experimental: {
            quotaToast: {
              enabled: false,
              enabledProviders: ["openai"],
              minIntervalMs: 30_000,
            },
          },
        }),
        "utf8",
      );
    }

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            formatStyle: "allWindows",
            onlyCurrentModel: true,
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
            formatStyle: "singleWindow",
            onlyCurrentModel: false,
          },
        },
      }),
      "utf8",
    );

    const workspaceMeta = {
      source: "defaults" as const,
      paths: [] as string[],
      networkSettingSources: {} as Record<string, string>,
    };
    const workspaceCfg = await loadConfig(undefined, workspaceMeta, { configRootDir: workspaceDir });

    const nestedMeta = {
      source: "defaults" as const,
      paths: [] as string[],
      networkSettingSources: {} as Record<string, string>,
    };
    const nestedCfg = await loadConfig(undefined, nestedMeta, { configRootDir: nestedDir });

    expect(workspaceCfg.enabled).toBe(false);
    expect(nestedCfg.enabled).toBe(false);
    expect(workspaceCfg.enabledProviders).toEqual(["openai"]);
    expect(nestedCfg.enabledProviders).toEqual(["openai"]);

    expect(workspaceCfg.formatStyle).toBe("allWindows");
    expect(nestedCfg.formatStyle).toBe("singleWindow");
    expect(workspaceCfg.onlyCurrentModel).toBe(true);
    expect(nestedCfg.onlyCurrentModel).toBe(false);

    expect(workspaceMeta.paths).toContain(
      join(workspaceDir, "opencode.json") + " (experimental.quotaToast)",
    );
    expect(nestedMeta.paths).toContain(join(nestedDir, "opencode.json") + " (experimental.quotaToast)");

    expect(
      configDirs.some(
        (dir) =>
          workspaceMeta.networkSettingSources.enabled ===
            join(dir, "opencode.json") + " (experimental.quotaToast)" &&
          nestedMeta.networkSettingSources.enabled ===
            join(dir, "opencode.json") + " (experimental.quotaToast)",
      ),
    ).toBe(true);
  });
});
