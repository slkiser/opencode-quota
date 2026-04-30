import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const runtimeDirs = vi.hoisted(() => ({
  value: {
    dataDirs: [] as string[],
    configDirs: [] as string[],
    cacheDirs: [] as string[],
    stateDirs: [] as string[],
  },
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => runtimeDirs.value,
}));

import { createLoadConfigMeta, loadConfig } from "../src/lib/config.js";

function quotaConfigSource(dir: string): string {
  return join(dir, "opencode-quota", "quota-toast.json") + " (opencode-quota/quota-toast.json)";
}

describe("loadConfig layered precedence", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;
  let workspaceDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-config-"));
    workspaceDir = join(tempDir, "workspace");
    xdgConfigHome = join(tempDir, "xdg-config");

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });

    runtimeDirs.value = {
      dataDirs: [join(tempDir, "xdg-data", "opencode")],
      configDirs: [join(xdgConfigHome, "opencode")],
      cacheDirs: [join(tempDir, "xdg-cache", "opencode")],
      stateDirs: [join(tempDir, "xdg-state", "opencode")],
    };

    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(tempDir, "xdg-data"),
      XDG_CACHE_HOME: join(tempDir, "xdg-cache"),
      XDG_STATE_HOME: join(tempDir, "xdg-state"),
    };
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lets workspace ordinary settings override global defaults while file-backed config still blocks sdk fallback", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
            enabledProviders: ["openai"],
            showOnIdle: false,
            showOnQuestion: false,
            showOnCompact: false,
            showOnBothFail: false,
            minIntervalMs: 600000,
            pricingSnapshot: { source: "bundled", autoRefresh: 30 },
            formatStyle: "singleWindow",
            percentDisplayMode: "remaining",
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["chutes"],
            showOnIdle: true,
            showOnQuestion: true,
            showOnCompact: true,
            showOnBothFail: true,
            minIntervalMs: 1000,
            pricingSnapshot: { source: "runtime", autoRefresh: 1 },
            formatStyle: "allWindows",
            percentDisplayMode: "used",
            onlyCurrentModel: true,
          },
        },
      }),
      "utf-8",
    );

    const cfg = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                enabled: false,
                enabledProviders: ["zai"],
                formatStyle: "singleWindow",
                percentDisplayMode: "remaining",
              },
            },
          },
        }),
      },
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.enabledProviders).toEqual(["chutes"]);
    expect(cfg.showOnIdle).toBe(true);
    expect(cfg.showOnQuestion).toBe(true);
    expect(cfg.showOnCompact).toBe(true);
    expect(cfg.showOnBothFail).toBe(true);
    expect(cfg.minIntervalMs).toBe(1000);
    expect(cfg.pricingSnapshot).toEqual({ source: "runtime", autoRefresh: 1 });
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.percentDisplayMode).toBe("used");
    expect(cfg.onlyCurrentModel).toBe(true);
  });

  it("supports file loading with an explicit cwd override and records layered provenance", async () => {
    const altWorkspaceDir = join(tempDir, "alt-workspace");
    mkdirSync(altWorkspaceDir, { recursive: true });

    writeFileSync(
      join(altWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["nano-gpt"],
            formatStyle: "allWindows",
            percentDisplayMode: "used",
            onlyCurrentModel: true,
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: altWorkspaceDir });

    expect(cfg.enabledProviders).toEqual(["nanogpt"]);
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.percentDisplayMode).toBe("used");
    expect(cfg.onlyCurrentModel).toBe(true);
    expect(meta.source).toBe("files");
    expect(meta.globalConfigPaths).toEqual([]);
    expect(meta.workspaceConfigPaths).toEqual([quotaConfigSource(altWorkspaceDir)]);
    expect(meta.paths).toEqual(meta.workspaceConfigPaths);
    expect(meta.settingSources).toEqual({
      enabledProviders: quotaConfigSource(altWorkspaceDir),
      formatStyle: quotaConfigSource(altWorkspaceDir),
      percentDisplayMode: quotaConfigSource(altWorkspaceDir),
      onlyCurrentModel: quotaConfigSource(altWorkspaceDir),
    });
    expect(meta.networkSettingSources).toEqual({
      enabledProviders: quotaConfigSource(altWorkspaceDir),
    });
  });

  it("merges pricingSnapshot per field so global and workspace sources can coexist", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            pricingSnapshot: { source: "bundled" },
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            pricingSnapshot: { autoRefresh: 2 },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 2 });
    expect(meta.settingSources["pricingSnapshot.source"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["pricingSnapshot.autoRefresh"]).toBe(
      quotaConfigSource(workspaceDir),
    );
  });

  it("merges layout per field so global and workspace sources can coexist", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            layout: { maxWidth: 72, narrowAt: 40 },
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            layout: { narrowAt: 36, tinyAt: 24 },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.layout).toEqual({ maxWidth: 72, narrowAt: 36, tinyAt: 24 });
    expect(meta.settingSources["layout.maxWidth"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["layout.narrowAt"]).toBe(
      quotaConfigSource(workspaceDir),
    );
    expect(meta.settingSources["layout.tinyAt"]).toBe(
      quotaConfigSource(workspaceDir),
    );
  });

  it("preserves the previous valid layer when workspace values are invalid", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["openai"],
            anthropicBinaryPath: "/usr/local/bin/claude",
            googleModels: ["CLAUDE", "G3PRO"],
            cursorIncludedApiUsd: 42,
            cursorBillingCycleStartDay: 7,
            pricingSnapshot: { source: "bundled", autoRefresh: 30 },
            formatStyle: "allWindows",
            layout: { maxWidth: 64, narrowAt: 40 },
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["not-a-provider"],
            anthropicBinaryPath: "   ",
            googleModels: [],
            cursorIncludedApiUsd: 0,
            cursorBillingCycleStartDay: 31,
            pricingSnapshot: { source: "remote", autoRefresh: 0 },
            formatStyle: "bad-style",
            layout: { maxWidth: -1, narrowAt: 35 },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(cfg.anthropicBinaryPath).toBe("/usr/local/bin/claude");
    expect(cfg.googleModels).toEqual(["CLAUDE", "G3PRO"]);
    expect(cfg.cursorIncludedApiUsd).toBe(42);
    expect(cfg.cursorBillingCycleStartDay).toBe(7);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.layout).toEqual({ maxWidth: 64, narrowAt: 35, tinyAt: 32 });
    const globalQuotaConfigSource = quotaConfigSource(join(xdgConfigHome, "opencode"));
    expect(meta.settingSources.enabledProviders).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources.anthropicBinaryPath).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources.googleModels).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources.cursorIncludedApiUsd).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources.cursorBillingCycleStartDay).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources["pricingSnapshot.source"]).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources["pricingSnapshot.autoRefresh"]).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources.formatStyle).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources["layout.maxWidth"]).toBe(
      globalQuotaConfigSource,
    );
    expect(meta.settingSources["layout.narrowAt"]).toBe(
      quotaConfigSource(workspaceDir),
    );
  });

  it("accepts legacy toastStyle in file-backed config and still prefers formatStyle when present", async () => {
    const legacyWorkspaceDir = join(tempDir, "legacy-workspace");
    mkdirSync(legacyWorkspaceDir, { recursive: true });

    writeFileSync(
      join(legacyWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            toastStyle: "grouped",
          },
        },
      }),
      "utf-8",
    );

    let cfg = await loadConfig(undefined, undefined, { cwd: legacyWorkspaceDir });
    expect(cfg.formatStyle).toBe("allWindows");

    writeFileSync(
      join(legacyWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            toastStyle: "classic",
            formatStyle: "allWindows",
          },
        },
      }),
      "utf-8",
    );

    cfg = await loadConfig(undefined, undefined, { cwd: legacyWorkspaceDir });
    expect(cfg.formatStyle).toBe("allWindows");
  });

  it("lets a workspace legacy toastStyle override a global canonical formatStyle", async () => {
    const mixedWorkspaceDir = join(tempDir, "mixed-style-workspace");
    mkdirSync(mixedWorkspaceDir, { recursive: true });

    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            formatStyle: "allWindows",
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(mixedWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            toastStyle: "classic",
          },
        },
      }),
      "utf-8",
    );

    const cfg = await loadConfig(undefined, undefined, { cwd: mixedWorkspaceDir });
    expect(cfg.formatStyle).toBe("singleWindow");
  });
});
