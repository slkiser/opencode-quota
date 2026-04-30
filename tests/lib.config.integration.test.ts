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

import { createLoadConfigMeta, loadConfig } from "../src/lib/config.js";
import { getOpencodeRuntimeDirCandidates } from "../src/lib/opencode-runtime-paths.js";

function quotaConfigSource(dir: string): string {
  return join(dir, "opencode-quota", "quota-toast.json") + " (opencode-quota/quota-toast.json)";
}

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

  it("uses real runtime dirs as defaults and explicit cwd config as workspace overrides", async () => {
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

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.enabled).toBe(true);
    expect(cfg.enabledProviders).toEqual(["nanogpt"]);
    expect(cfg.showOnIdle).toBe(false);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.onlyCurrentModel).toBe(true);

    expect(meta.source).toBe("files");
    expect(meta.paths.some((path) => configDirs.some((dir) => path === quotaConfigSource(dir)))).toBe(
      true,
    );
    expect(meta.paths).toContain(quotaConfigSource(workspaceDir));
    expect(meta.paths).not.toContain(quotaConfigSource(nestedDir));
    expect(meta.workspaceConfigPaths).toEqual([quotaConfigSource(workspaceDir)]);
    expect(
      meta.globalConfigPaths.some((path) =>
        configDirs.some((dir) => path === quotaConfigSource(dir)),
      ),
    ).toBe(true);
    expect(meta.settingSources.enabled).toBe(
      quotaConfigSource(workspaceDir),
    );
    expect(meta.settingSources.enabledProviders).toBe(
      quotaConfigSource(workspaceDir),
    );
    expect(
      configDirs.some(
        (dir) =>
          meta.settingSources["pricingSnapshot.source"] ===
          quotaConfigSource(dir),
      ),
    ).toBe(true);
    expect(
      configDirs.some(
        (dir) =>
          meta.settingSources["pricingSnapshot.autoRefresh"] ===
          quotaConfigSource(dir),
      ),
    ).toBe(true);
  });

  it("treats an overlapping configRootDir as the workspace layer instead of a duplicate global path", async () => {
    const overlappingRoot = join(xdgConfigHome, "opencode");

    writeFileSync(
      join(overlappingRoot, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
            minIntervalMs: 12_345,
          },
        },
      }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: overlappingRoot });

    expect(cfg.enabled).toBe(false);
    expect(cfg.minIntervalMs).toBe(12_345);
    expect(meta.globalConfigPaths).toEqual([]);
    expect(meta.workspaceConfigPaths).toEqual([quotaConfigSource(overlappingRoot)]);
    expect(meta.paths).toEqual(meta.workspaceConfigPaths);
    expect(meta.settingSources.enabled).toBe(
      quotaConfigSource(overlappingRoot),
    );
    expect(meta.settingSources.minIntervalMs).toBe(
      quotaConfigSource(overlappingRoot),
    );
  });

  it("uses the provided configRootDir to pick the workspace override layer over shared global defaults", async () => {
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
            enabledProviders: ["nano-gpt"],
            minIntervalMs: 1_000,
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
            enabledProviders: ["chutes"],
            minIntervalMs: 2_000,
            formatStyle: "singleWindow",
            onlyCurrentModel: false,
          },
        },
      }),
      "utf8",
    );

    const workspaceMeta = createLoadConfigMeta();
    const workspaceCfg = await loadConfig(undefined, workspaceMeta, { configRootDir: workspaceDir });

    const nestedMeta = createLoadConfigMeta();
    const nestedCfg = await loadConfig(undefined, nestedMeta, { configRootDir: nestedDir });

    expect(workspaceCfg.enabled).toBe(true);
    expect(nestedCfg.enabled).toBe(true);
    expect(workspaceCfg.enabledProviders).toEqual(["nanogpt"]);
    expect(nestedCfg.enabledProviders).toEqual(["chutes"]);
    expect(workspaceCfg.minIntervalMs).toBe(1_000);
    expect(nestedCfg.minIntervalMs).toBe(2_000);

    expect(workspaceCfg.formatStyle).toBe("allWindows");
    expect(nestedCfg.formatStyle).toBe("singleWindow");
    expect(workspaceCfg.onlyCurrentModel).toBe(true);
    expect(nestedCfg.onlyCurrentModel).toBe(false);

    expect(workspaceMeta.workspaceConfigPaths).toEqual([quotaConfigSource(workspaceDir)]);
    expect(nestedMeta.workspaceConfigPaths).toEqual([quotaConfigSource(nestedDir)]);
    expect(
      configDirs.some(
        (dir) =>
          workspaceMeta.globalConfigPaths.includes(quotaConfigSource(dir)) &&
          nestedMeta.globalConfigPaths.includes(quotaConfigSource(dir)),
      ),
    ).toBe(true);
    expect(workspaceMeta.settingSources.enabled).toBe(
      quotaConfigSource(workspaceDir),
    );
    expect(nestedMeta.settingSources.enabled).toBe(
      quotaConfigSource(nestedDir),
    );
    expect(workspaceMeta.settingSources.minIntervalMs).toBe(
      quotaConfigSource(workspaceDir),
    );
    expect(nestedMeta.settingSources.minIntervalMs).toBe(
      quotaConfigSource(nestedDir),
    );
  });
});
