import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createConfigLoaderWorkspace,
  createEmptyRuntimeDirCandidates,
  quotaSidecarConfigSource,
  type ConfigLoaderWorkspace,
} from "./helpers/config-loader-test-harness.js";

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
import { DEFAULT_CONFIG } from "../src/lib/types.js";

describe("loadConfig", () => {
  let workspace: ConfigLoaderWorkspace;
  let isolatedCwd: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    workspace = createConfigLoaderWorkspace("opencode-quota-config-sdk-");
    isolatedCwd = workspace.workspaceDir;
    runtimeDirs.value = createEmptyRuntimeDirCandidates();
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    workspace.cleanup();
  });

  async function loadSdkConfig(
    quotaToast: Record<string, unknown>,
    meta = createLoadConfigMeta(),
  ) {
    const config = await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast,
              },
            },
          }),
        },
      },
      meta,
      { cwd: isolatedCwd },
    );

    return { config, meta };
  }

  it("defaults maintainer announcements config and accepts validated nested overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.maintainerAnnouncements).toEqual(DEFAULT_CONFIG.maintainerAnnouncements);
    expect(defaults.config.maintainerAnnouncements).not.toBe(DEFAULT_CONFIG.maintainerAnnouncements);

    const explicit = await loadSdkConfig({
      maintainerAnnouncements: {
        enabled: false,
        home: false,
      },
    });
    expect(explicit.config.maintainerAnnouncements).toEqual({
      enabled: false,
      home: false,
    });
    expect(explicit.meta.settingSources).toEqual({
      "maintainerAnnouncements.enabled": "client.config.get",
      "maintainerAnnouncements.home": "client.config.get",
    });
    expect(explicit.meta.networkSettingSources).toEqual({});

    const partialInvalid = await loadSdkConfig({
      maintainerAnnouncements: {
        enabled: true,
        home: "no",
      },
    });
    expect(partialInvalid.config.maintainerAnnouncements).toEqual({
      ...DEFAULT_CONFIG.maintainerAnnouncements,
      enabled: true,
    });
    expect(partialInvalid.meta.settingSources).toEqual({
      "maintainerAnnouncements.enabled": "client.config.get",
    });

    const invalidNested = await loadSdkConfig({ maintainerAnnouncements: false });
    expect(invalidNested.config.maintainerAnnouncements).toEqual(
      DEFAULT_CONFIG.maintainerAnnouncements,
    );
    expect(invalidNested.meta.settingSources).toEqual({});
  });

  it("defaults TUI sidebar panel config and accepts validated nested overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.tuiSidebarPanel).toEqual(DEFAULT_CONFIG.tuiSidebarPanel);
    expect(defaults.config.tuiSidebarPanel).not.toBe(DEFAULT_CONFIG.tuiSidebarPanel);

    const explicit = await loadSdkConfig({
      tuiSidebarPanel: {
        enabled: false,
      },
    });
    expect(explicit.config.tuiSidebarPanel).toEqual({ enabled: false });
    expect(explicit.meta.settingSources).toEqual({
      "tuiSidebarPanel.enabled": "client.config.get",
    });
    expect(explicit.meta.networkSettingSources).toEqual({});

    const partialInvalid = await loadSdkConfig({
      tuiSidebarPanel: {
        enabled: "no",
      },
    });
    expect(partialInvalid.config.tuiSidebarPanel).toEqual(DEFAULT_CONFIG.tuiSidebarPanel);
    expect(partialInvalid.meta.settingSources).toEqual({});

    const invalidNested = await loadSdkConfig({ tuiSidebarPanel: true });
    expect(invalidNested.config.tuiSidebarPanel).toEqual(DEFAULT_CONFIG.tuiSidebarPanel);
    expect(invalidNested.meta.settingSources).toEqual({});

    const withFormatStyle = await loadSdkConfig({
      tuiSidebarPanel: {
        formatStyle: "allWindows",
      },
    });
    expect(withFormatStyle.config.tuiSidebarPanel).toEqual({
      ...DEFAULT_CONFIG.tuiSidebarPanel,
      formatStyle: "allWindows",
    });
    expect(withFormatStyle.meta.settingSources).toEqual({
      "tuiSidebarPanel.formatStyle": "client.config.get",
    });

    const withInvalidFormatStyle = await loadSdkConfig({
      tuiSidebarPanel: {
        formatStyle: "invalid-style",
      },
    });
    expect(withInvalidFormatStyle.config.tuiSidebarPanel).toEqual(DEFAULT_CONFIG.tuiSidebarPanel);
    expect(withInvalidFormatStyle.meta.settingSources).toEqual({});

    const withLegacyToastStyle = await loadSdkConfig({
      tuiSidebarPanel: {
        toastStyle: "allWindows",
      },
    });
    expect(withLegacyToastStyle.config.tuiSidebarPanel).toEqual(DEFAULT_CONFIG.tuiSidebarPanel);
    expect(withLegacyToastStyle.meta.settingSources).toEqual({});
  });

  it("defaults tuiCompactStatus and accepts validated nested overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.tuiCompactStatus).toEqual(DEFAULT_CONFIG.tuiCompactStatus);
    expect(defaults.config.tuiCompactStatus).not.toBe(DEFAULT_CONFIG.tuiCompactStatus);

    const explicit = await loadSdkConfig({
      tuiCompactStatus: {
        enabled: true,
        homeBottom: false,
        sessionPrompt: false,
        suppressWhenNativeProviderQuota: false,
        maxWidth: 72,
      },
    });
    expect(explicit.config.tuiCompactStatus).toEqual({
      enabled: true,
      homeBottom: false,
      sessionPrompt: false,
      suppressWhenNativeProviderQuota: false,
      maxWidth: 72,
    });
    expect(explicit.meta.settingSources).toEqual({
      "tuiCompactStatus.enabled": "client.config.get",
      "tuiCompactStatus.homeBottom": "client.config.get",
      "tuiCompactStatus.sessionPrompt": "client.config.get",
      "tuiCompactStatus.suppressWhenNativeProviderQuota": "client.config.get",
      "tuiCompactStatus.maxWidth": "client.config.get",
    });
    expect(explicit.meta.networkSettingSources).toEqual({});

    const partialInvalid = await loadSdkConfig({
      tuiCompactStatus: {
        enabled: true,
        homeBottom: "no",
        sessionPrompt: null,
        suppressWhenNativeProviderQuota: 0,
        maxWidth: -1,
      },
    });
    expect(partialInvalid.config.tuiCompactStatus).toEqual({
      ...DEFAULT_CONFIG.tuiCompactStatus,
      enabled: true,
    });
    expect(partialInvalid.meta.settingSources).toEqual({
      "tuiCompactStatus.enabled": "client.config.get",
    });

    const invalidNested = await loadSdkConfig({ tuiCompactStatus: "enabled" });
    expect(invalidNested.config.tuiCompactStatus).toEqual(DEFAULT_CONFIG.tuiCompactStatus);
    expect(invalidNested.meta.settingSources).toEqual({});

    const withFormatStyle = await loadSdkConfig({
      tuiCompactStatus: {
        enabled: true,
        formatStyle: "singleWindow",
      },
    });
    expect(withFormatStyle.config.tuiCompactStatus).toEqual({
      ...DEFAULT_CONFIG.tuiCompactStatus,
      enabled: true,
      formatStyle: "singleWindow",
    });
    expect(withFormatStyle.meta.settingSources).toEqual({
      "tuiCompactStatus.enabled": "client.config.get",
      "tuiCompactStatus.formatStyle": "client.config.get",
    });

    const withInvalidCompactFormatStyle = await loadSdkConfig({
      tuiCompactStatus: {
        formatStyle: 42,
      },
    });
    expect(withInvalidCompactFormatStyle.config.tuiCompactStatus).toEqual(
      DEFAULT_CONFIG.tuiCompactStatus,
    );
    expect(withInvalidCompactFormatStyle.meta.settingSources).toEqual({});

    const withLegacyCompactToastStyle = await loadSdkConfig({
      tuiCompactStatus: {
        toastStyle: "allWindows",
      },
    });
    expect(withLegacyCompactToastStyle.config.tuiCompactStatus).toEqual(
      DEFAULT_CONFIG.tuiCompactStatus,
    );
    expect(withLegacyCompactToastStyle.meta.settingSources).toEqual({});
  });

  it("deep-clones default config when no config source exists", async () => {
    const meta = createLoadConfigMeta();
    const first = await loadConfig(undefined, meta, { cwd: isolatedCwd });
    first.tuiSidebarPanel.enabled = false;
    first.tuiCompactStatus.enabled = true;
    first.tuiCompactStatus.maxWidth = 1;
    first.maintainerAnnouncements.enabled = false;
    first.maintainerAnnouncements.home = false;

    const second = await loadConfig(undefined, undefined, { cwd: isolatedCwd });
    expect(second.tuiSidebarPanel).toEqual(DEFAULT_CONFIG.tuiSidebarPanel);
    expect(second.tuiCompactStatus).toEqual(DEFAULT_CONFIG.tuiCompactStatus);
    expect(DEFAULT_CONFIG.tuiSidebarPanel).toEqual({ enabled: true });
    expect(DEFAULT_CONFIG.tuiCompactStatus).toEqual({
      enabled: false,
      homeBottom: true,
      sessionPrompt: true,
      suppressWhenNativeProviderQuota: true,
      maxWidth: 96,
    });
    expect(second.maintainerAnnouncements).toEqual(DEFAULT_CONFIG.maintainerAnnouncements);
    expect(DEFAULT_CONFIG.maintainerAnnouncements).toEqual({
      enabled: true,
      home: true,
    });
  });

  it("defaults requestTimeoutMs to 5000 and accepts positive finite overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.requestTimeoutMs).toBe(5000);

    const explicit = await loadSdkConfig({ requestTimeoutMs: 12000 });
    expect(explicit.config.requestTimeoutMs).toBe(12000);
    expect(explicit.meta.settingSources).toEqual({
      requestTimeoutMs: "client.config.get",
    });

    for (const requestTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, "12000"]) {
      const invalid = await loadSdkConfig({ requestTimeoutMs });
      expect(invalid.config.requestTimeoutMs).toBe(5000);
      expect(invalid.meta.settingSources).not.toHaveProperty("requestTimeoutMs");
    }
  });

  it("defaults alibabaCodingPlanTier to lite and accepts explicit overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.alibabaCodingPlanTier).toBe("lite");

    const explicit = await loadSdkConfig({ alibabaCodingPlanTier: "pro" });
    expect(explicit.config.alibabaCodingPlanTier).toBe("pro");
  });

  it("normalizes cursor config fields without coercing invalid values", async () => {
    const defaults = await loadSdkConfig({
      cursorPlan: "bad-plan",
      cursorIncludedApiUsd: -5,
      cursorBillingCycleStartDay: 31,
    });
    expect(defaults.config.cursorPlan).toBe("none");
    expect(defaults.config.cursorIncludedApiUsd).toBeUndefined();
    expect(defaults.config.cursorBillingCycleStartDay).toBeUndefined();

    const explicit = await loadSdkConfig({
      cursorPlan: "pro-plus",
      cursorIncludedApiUsd: 42,
      cursorBillingCycleStartDay: 7,
    });
    expect(explicit.config.cursorPlan).toBe("pro-plus");
    expect(explicit.config.cursorIncludedApiUsd).toBe(42);
    expect(explicit.config.cursorBillingCycleStartDay).toBe(7);
  });

  it("defaults OpenCode Go windows and accepts valid explicit windows", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.opencodeGoWindows).toEqual(["rolling", "weekly", "monthly"]);

    const explicit = await loadSdkConfig({ opencodeGoWindows: ["monthly", "rolling"] });
    expect(explicit.config.opencodeGoWindows).toEqual(["monthly", "rolling"]);
    expect(explicit.meta.settingSources).toEqual({
      opencodeGoWindows: "client.config.get",
    });
    expect(explicit.meta.networkSettingSources).toEqual({});
  });

  it("resolves relative OPENCODE_CONFIG_DIR against cwd for file loading", async () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    mkdirSync(join(isolatedCwd, ".opencode"), { recursive: true });
    writeFileSync(
      join(isolatedCwd, ".opencode", "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: false } } }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { cwd: isolatedCwd });

    expect(config.enabled).toBe(false);
    expect(meta.paths).toContain(
      `${join(isolatedCwd, ".opencode", "opencode.json")} (experimental.quotaToast)`,
    );
  });

  it("ignores invalid OpenCode Go windows without recording a setting source", async () => {
    const invalidValues: unknown[] = [[], ["rolling", "daily"], ["weekly", 5], "weekly"];

    for (const opencodeGoWindows of invalidValues) {
      const { config, meta } = await loadSdkConfig({ opencodeGoWindows });
      expect(config.opencodeGoWindows).toEqual(["rolling", "weekly", "monthly"]);
      expect(meta.settingSources).not.toHaveProperty("opencodeGoWindows");
      expect(meta.networkSettingSources).toEqual({});
    }
  });

  it("records legacy OpenCode Go windows setting source when sidecar is absent", async () => {
    const workspaceConfigPath = join(isolatedCwd, "opencode.json");
    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            opencodeGoWindows: ["weekly", "monthly"],
          },
        },
      }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { cwd: isolatedCwd });

    expect(config.opencodeGoWindows).toEqual(["weekly", "monthly"]);
    expect(meta.source).toBe("files");
    expect(meta.settingSources).toEqual({
      opencodeGoWindows: `${workspaceConfigPath} (experimental.quotaToast)`,
    });
    expect(existsSync(join(isolatedCwd, "opencode-quota", "quota-toast.json"))).toBe(false);
    expect(meta.networkSettingSources).toEqual({});
  });

  it("falls back to legacy experimental.quotaToast without migrating on load", async () => {
    const workspaceConfigPath = join(isolatedCwd, "opencode.json");
    const quotaConfigPath = join(isolatedCwd, "opencode-quota", "quota-toast.json");
    mkdirSync(join(isolatedCwd, "opencode-quota"), { recursive: true });
    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["openai"],
            formatStyle: "allWindows",
            pricingSnapshot: { source: "bundled" },
          },
        },
      }),
      "utf8",
    );

    const firstMeta = createLoadConfigMeta();
    const firstConfig = await loadConfig(undefined, firstMeta, { cwd: isolatedCwd });

    expect(firstConfig.enabledProviders).toEqual(["openai"]);
    expect(firstConfig.formatStyle).toBe("allWindows");
    expect(firstConfig.pricingSnapshot.source).toBe("bundled");
    expect(existsSync(quotaConfigPath)).toBe(false);
    expect(firstMeta.settingSources.enabledProviders).toBe(
      `${workspaceConfigPath} (experimental.quotaToast)`,
    );
    expect(firstMeta.paths).toEqual([
      `${workspaceConfigPath} (experimental.quotaToast)`,
    ]);
  });

  it("prefers plugin-owned quota settings over legacy experimental.quotaToast", async () => {
    const workspaceConfigPath = join(isolatedCwd, "opencode.json");
    const quotaConfigPath = join(isolatedCwd, "opencode-quota", "quota-toast.json");
    mkdirSync(join(isolatedCwd, "opencode-quota"), { recursive: true });
    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["openai"],
            formatStyle: "singleWindow",
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      quotaConfigPath,
      JSON.stringify({
        enabledProviders: ["nano-gpt"],
        formatStyle: "allWindows",
      }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { cwd: isolatedCwd });

    expect(config.enabledProviders).toEqual(["nanogpt"]);
    expect(config.formatStyle).toBe("allWindows");
    expect(meta.settingSources).toMatchObject({
      enabledProviders: quotaSidecarConfigSource(isolatedCwd),
      formatStyle: quotaSidecarConfigSource(isolatedCwd),
    });
  });

  it("does not fall through to legacy or sdk config when sidecar exists but is invalid", async () => {
    const workspaceConfigPath = join(isolatedCwd, "opencode.json");
    const quotaConfigPath = join(isolatedCwd, "opencode-quota", "quota-toast.json");
    const quotaConfigSource = quotaSidecarConfigSource(isolatedCwd);
    mkdirSync(join(isolatedCwd, "opencode-quota"), { recursive: true });
    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
            enabledProviders: ["openai"],
            formatStyle: "allWindows",
          },
        },
      }),
      "utf8",
    );
    writeFileSync(quotaConfigPath, "[]", "utf8");

    const meta = createLoadConfigMeta();
    const config = await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast: {
                  enabled: false,
                  enabledProviders: ["nano-gpt"],
                  formatStyle: "allWindows",
                },
              },
            },
          }),
        },
      },
      meta,
      { cwd: isolatedCwd },
    );

    expect(config.enabled).toBe(true);
    expect(config.enabledProviders).toBe("auto");
    expect(config.formatStyle).toBe("singleWindow");
    expect(meta.source).toBe("files");
    expect(meta.paths).toEqual([quotaConfigSource]);
    expect(meta.settingSources).toEqual({});
    expect(meta.configIssues).toEqual([
      {
        path: quotaConfigSource,
        key: "$root",
        message: "expected readable JSON object",
      },
    ]);
  });

  it("falls back to split legacy json/jsonc settings using validated layer semantics", async () => {
    const jsonPath = join(isolatedCwd, "opencode.json");
    const jsoncPath = join(isolatedCwd, "opencode.jsonc");
    const quotaConfigPath = join(isolatedCwd, "opencode-quota", "quota-toast.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["openai"],
            pricingSnapshot: { source: "bundled" },
            layout: { maxWidth: 64 },
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      jsoncPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["not-a-provider"],
            pricingSnapshot: { autoRefresh: 2 },
            layout: { narrowAt: 36 },
          },
        },
      }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { cwd: isolatedCwd });

    expect(config.enabledProviders).toEqual(["openai"]);
    expect(config.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 2 });
    expect(config.layout).toEqual({ maxWidth: 64, narrowAt: 36, tinyAt: 32 });
    expect(existsSync(quotaConfigPath)).toBe(false);
    expect(meta.paths).toEqual([
      `${jsonPath} (experimental.quotaToast)`,
      `${jsoncPath} (experimental.quotaToast)`,
    ]);
    expect(meta.settingSources.enabledProviders).toBe(
      `${jsonPath} (experimental.quotaToast)`,
    );
    expect(meta.configIssues).toEqual([
      {
        path: `${jsoncPath} (experimental.quotaToast)`,
        key: "enabledProviders",
        message: "unknown provider id(s): not-a-provider",
      },
    ]);
  });

  it("defaults pricingSnapshot config and accepts valid overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.pricingSnapshot.source).toBe("auto");
    expect(defaults.config.pricingSnapshot.autoRefresh).toBe(7);

    const bundled = await loadSdkConfig({
      pricingSnapshot: { source: "bundled", autoRefresh: 7 },
    });
    expect(bundled.config.pricingSnapshot.source).toBe("bundled");
    expect(bundled.config.pricingSnapshot.autoRefresh).toBe(7);

    const runtime = await loadSdkConfig({
      pricingSnapshot: { source: "runtime", autoRefresh: 2 },
    });
    expect(runtime.config.pricingSnapshot.source).toBe("runtime");
    expect(runtime.config.pricingSnapshot.autoRefresh).toBe(2);

    const invalid = await loadSdkConfig({
      pricingSnapshot: { source: "remote", autoRefresh: 0 },
    });
    expect(invalid.config.pricingSnapshot.source).toBe("auto");
    expect(invalid.config.pricingSnapshot.autoRefresh).toBe(7);
  });

  it("reads formatStyle and falls back to legacy toastStyle when needed", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.formatStyle).toBe("singleWindow");

    const explicit = await loadSdkConfig({ formatStyle: "allWindows" });
    expect(explicit.config.formatStyle).toBe("allWindows");

    const alias = await loadSdkConfig({ formatStyle: "grouped" });
    expect(alias.config.formatStyle).toBe("allWindows");

    const legacyOnly = await loadSdkConfig({ toastStyle: "grouped" });
    expect(legacyOnly.config.formatStyle).toBe("allWindows");

    const both = await loadSdkConfig({
      formatStyle: "singleWindow",
      toastStyle: "grouped",
    });
    expect(both.config.formatStyle).toBe("singleWindow");
  });

  it("defaults percentDisplayMode to remaining and accepts valid overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.percentDisplayMode).toBe("remaining");

    const explicit = await loadSdkConfig({ percentDisplayMode: "used" });
    expect(explicit.config.percentDisplayMode).toBe("used");

    const invalid = await loadSdkConfig({ percentDisplayMode: "backwards" });
    expect(invalid.config.percentDisplayMode).toBe("remaining");
  });

  it("defaults anthropicBinaryPath and trims explicit overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.config.anthropicBinaryPath).toBe("claude");

    const explicit = await loadSdkConfig({
      anthropicBinaryPath: "  /Applications/Claude Code.app/Contents/MacOS/claude  ",
    });
    expect(explicit.config.anthropicBinaryPath).toBe(
      "/Applications/Claude Code.app/Contents/MacOS/claude",
    );
  });

  it("normalizes enabled provider aliases to canonical ids", async () => {
    const cfg = await loadSdkConfig({
      enabledProviders: ["nano-gpt", "nanogpt", "open-cursor", "gemini-cli", "minimax-cn"],
    });

    expect(cfg.config.enabledProviders).toEqual([
      "nanogpt",
      "cursor",
      "google-gemini-cli",
      "minimax-china-coding-plan",
    ]);
  });

  it("reports unknown enabled provider ids and does not fall back to auto", async () => {
    const cfg = await loadSdkConfig({
      enabledProviders: ["opnai", "gemini-cli", "not-a-provider"],
    });

    expect(cfg.config.enabledProviders).toEqual(["google-gemini-cli"]);
    expect(cfg.meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "enabledProviders",
        message: "unknown provider id(s): opnai, not-a-provider",
      },
    ]);

    const allInvalid = await loadSdkConfig({ enabledProviders: ["opnai"] });
    expect(allInvalid.config.enabledProviders).toEqual([]);
    expect(allInvalid.meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "enabledProviders",
        message: "unknown provider id(s): opnai",
      },
    ]);
  });

  it("keeps sdk fallback disabled once any file-backed experimental.quotaToast exists, even if it is invalid", async () => {
    const workspaceConfigPath = join(isolatedCwd, "opencode.json");
    const { writeFileSync } = await import("fs");

    writeFileSync(
      workspaceConfigPath,
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["not-a-provider"],
            pricingSnapshot: { source: "remote", autoRefresh: 0 },
          },
        },
      }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const config = await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast: {
                  enabled: false,
                  enabledProviders: ["openai"],
                  formatStyle: "allWindows",
                },
              },
            },
          }),
        },
      },
      meta,
      { cwd: isolatedCwd },
    );

    expect(config.enabled).toBe(true);
    expect(config.enabledProviders).toEqual([]);
    expect(config.formatStyle).toBe("singleWindow");
    expect(meta.source).toBe("files");
    const quotaConfigPath = join(isolatedCwd, "opencode-quota", "quota-toast.json");
    const quotaConfigSource = workspaceConfigPath + " (experimental.quotaToast)";
    expect(existsSync(quotaConfigPath)).toBe(false);
    expect(meta.paths).toEqual([quotaConfigSource]);
    expect(meta.workspaceConfigPaths).toEqual(meta.paths);
    expect(meta.globalConfigPaths).toEqual([]);
    expect(meta.settingSources).toEqual({
      enabledProviders: quotaConfigSource,
    });
    expect(meta.configIssues).toEqual([
      {
        path: workspaceConfigPath + " (experimental.quotaToast)",
        key: "enabledProviders",
        message: "unknown provider id(s): not-a-provider",
      },
    ]);
  });

  it("records sdk fallback provenance only for explicitly applied valid settings", async () => {
    const { config, meta } = await loadSdkConfig({
      enableToast: false,
      enabledProviders: ["nano-gpt"],
      pricingSnapshot: { source: "remote", autoRefresh: 2 },
      layout: { tinyAt: 28, maxWidth: 0 },
      googleModels: [],
      toastStyle: "grouped",
    });

    expect(config.enableToast).toBe(false);
    expect(config.enabledProviders).toEqual(["nanogpt"]);
    expect(config.formatStyle).toBe("allWindows");
    expect(config.pricingSnapshot).toEqual({ source: "auto", autoRefresh: 2 });
    expect(config.layout).toEqual({ maxWidth: 50, narrowAt: 42, tinyAt: 28 });

    expect(meta.source).toBe("sdk");
    expect(meta.paths).toEqual(["client.config.get"]);
    expect(meta.globalConfigPaths).toEqual([]);
    expect(meta.workspaceConfigPaths).toEqual([]);
    expect(meta.settingSources).toEqual({
      enableToast: "client.config.get",
      enabledProviders: "client.config.get",
      formatStyle: "client.config.get",
      "pricingSnapshot.autoRefresh": "client.config.get",
      "layout.tinyAt": "client.config.get",
    });
    expect(meta.settingSources).not.toHaveProperty("pricingSnapshot.source");
    expect(meta.settingSources).not.toHaveProperty("googleModels");
    expect(meta.networkSettingSources).toEqual({
      enabledProviders: "client.config.get",
      "pricingSnapshot.autoRefresh": "client.config.get",
    });
  });
});
