import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigLoaderWorkspace,
  createConfigLoaderEnv,
  createConfigLoaderWorkspace,
  quotaConfigSource,
} from "./helpers/config-loader-test-harness.js";

const runtimeDirs = vi.hoisted(() => ({
  value: {
    dataDir: "",
    configDir: "",
    cacheDir: "",
    stateDir: "",
  },
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => runtimeDirs.value,
}));

import { createLoadConfigMeta, loadConfig } from "../src/lib/config.js";

describe("loadConfig layered precedence", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let workspace: ConfigLoaderWorkspace;
  let tempDir: string;
  let workspaceDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("opencode-quota-config-");
    tempDir = workspace.tempDir;
    workspaceDir = workspace.workspaceDir;
    xdgConfigHome = workspace.xdgConfigHome;

    runtimeDirs.value = workspace.runtimeDirs;

    process.env = {
      ...originalEnv,
      ...createConfigLoaderEnv(workspace),
    };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    workspace.cleanup();
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
    expect(meta.settingSources["layout.narrowAt"]).toBe(quotaConfigSource(workspaceDir));
    expect(meta.settingSources["layout.tinyAt"]).toBe(quotaConfigSource(workspaceDir));
  });

  it("preserves valid global telemetry when a workspace value is invalid", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            telemetry: { enabled: true },
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
            telemetry: { enabled: "yes" },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.telemetry).toEqual({ enabled: true });
    expect(meta.settingSources["telemetry.enabled"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.networkSettingSources).toEqual({});
  });

  it("merges maintainer announcements per field and ignores invalid workspace fields", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            maintainerAnnouncements: {
              enabled: false,
            },
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
            maintainerAnnouncements: {
              home: false,
            },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.maintainerAnnouncements).toEqual({
      enabled: false,
      home: false,
      homeFrequency: "daily",
    });
    expect(meta.settingSources["maintainerAnnouncements.enabled"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["maintainerAnnouncements.home"]).toBe(
      quotaConfigSource(workspaceDir),
    );
    expect(meta.networkSettingSources).toEqual({});
  });

  it("merges tuiSidebarPanel enabled per layer and ignores invalid workspace fields", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            tuiSidebarPanel: {
              enabled: false,
              opencodeGoPreferredWindow: "rolling",
            },
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
            tuiSidebarPanel: {
              enabled: "yes",
              opencodeGoPreferredWindow: "daily",
            },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.tuiSidebarPanel).toEqual({
      enabled: false,
      opencodeGoPreferredWindow: "rolling",
    });
    expect(meta.settingSources["tuiSidebarPanel.enabled"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["tuiSidebarPanel.opencodeGoPreferredWindow"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
  });

  it("merges tuiCompactStatus per field and ignores invalid workspace fields", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            tuiCompactStatus: {
              enabled: true,
              sessionPrompt: false,
              maxWidth: 80,
            },
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
            tuiCompactStatus: {
              homeBottom: false,
              maxWidth: 0,
            },
          },
        },
      }),
      "utf-8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.tuiCompactStatus).toEqual({
      enabled: true,
      homeBottom: false,
      sessionPrompt: false,
      maxWidth: 80,
    });
    expect(meta.settingSources["tuiCompactStatus.enabled"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["tuiCompactStatus.sessionPrompt"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["tuiCompactStatus.maxWidth"]).toBe(
      quotaConfigSource(join(xdgConfigHome, "opencode")),
    );
    expect(meta.settingSources["tuiCompactStatus.homeBottom"]).toBe(
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
    expect(cfg.cursorIncludedApiUsd).toBe(42);
    expect(cfg.cursorBillingCycleStartDay).toBe(7);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.layout).toEqual({ maxWidth: 64, narrowAt: 35, tinyAt: 32 });
    const globalQuotaConfigSource = quotaConfigSource(join(xdgConfigHome, "opencode"));
    expect(meta.settingSources.enabledProviders).toBe(globalQuotaConfigSource);
    expect(meta.settingSources.anthropicBinaryPath).toBe(globalQuotaConfigSource);
    expect(meta.settingSources.cursorIncludedApiUsd).toBe(globalQuotaConfigSource);
    expect(meta.settingSources.cursorBillingCycleStartDay).toBe(globalQuotaConfigSource);
    expect(meta.settingSources["pricingSnapshot.source"]).toBe(globalQuotaConfigSource);
    expect(meta.settingSources["pricingSnapshot.autoRefresh"]).toBe(globalQuotaConfigSource);
    expect(meta.settingSources.formatStyle).toBe(globalQuotaConfigSource);
    expect(meta.settingSources["layout.maxWidth"]).toBe(globalQuotaConfigSource);
    expect(meta.settingSources["layout.narrowAt"]).toBe(quotaConfigSource(workspaceDir));
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
