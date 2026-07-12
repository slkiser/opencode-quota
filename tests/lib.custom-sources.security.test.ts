import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigLoaderWorkspace,
  quotaConfigSource,
  quotaSidecarConfigSource,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
  type ConfigLoaderWorkspace,
} from "./helpers/config-loader-test-harness.js";
import { customSource } from "./fixtures/custom-sources.js";

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

describe("custom sources config security boundary", () => {
  let workspace: ConfigLoaderWorkspace;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("opencode-quota-custom-source-security-");
    runtimeDirs.value = workspace.runtimeDirs;
  });

  afterEach(() => workspace.cleanup());

  it("rejects workspace sidecar customSources while retaining ordinary workspace settings", async () => {
    writeQuotaSidecarConfig(workspace.workspaceDir, {
      enabled: false,
      customSources: [
        customSource({
          url: "https://workspace-controlled.example/accounting",
          apiKeyEnv: "PRIVATE_API_KEY",
        }),
      ],
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { configRootDir: workspace.workspaceDir });

    expect(config.enabled).toBe(false);
    expect(config.customSources).toEqual([]);
    expect(meta.settingSources.customSources).toBeUndefined();
    expect(meta.configIssues).toEqual([
      {
        path: quotaSidecarConfigSource(workspace.workspaceDir),
        key: "customSources",
        message: `allowed only in canonical global config ${workspace.opencodeConfigDir}/opencode-quota/quota-toast.json`,
      },
    ]);
  });

  it("rejects customSources from global and workspace legacy OpenCode config", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      customSources: [customSource({ id: "global-legacy" })],
    });
    writeQuotaToastConfig(workspace.workspaceDir, {
      enableToast: false,
      customSources: [customSource({ id: "workspace-legacy" })],
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, { configRootDir: workspace.workspaceDir });

    expect(config.enableToast).toBe(false);
    expect(config.customSources).toEqual([]);
    expect(meta.configIssues).toEqual([
      {
        path: quotaConfigSource(workspace.opencodeConfigDir),
        key: "customSources",
        message: `allowed only in canonical global config ${workspace.opencodeConfigDir}/opencode-quota/quota-toast.json`,
      },
      {
        path: quotaConfigSource(workspace.workspaceDir),
        key: "customSources",
        message: `allowed only in canonical global config ${workspace.opencodeConfigDir}/opencode-quota/quota-toast.json`,
      },
    ]);
  });

  it("rejects SDK customSources without validating, copying, or discovering them", async () => {
    runtimeDirs.value = {
      dataDirs: [],
      configDirs: [],
      cacheDirs: [],
      stateDirs: [],
    };
    const sdkSource = customSource({
      url: "https://sdk.example/accounting",
      apiKeyEnv: "SDK_PRIVATE_KEY",
    });
    const meta = createLoadConfigMeta();
    const config = await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast: {
                  debug: true,
                  customSources: [sdkSource],
                },
              },
            },
          }),
        },
      },
      meta,
      { configRootDir: workspace.workspaceDir },
    );

    expect(config.debug).toBe(true);
    expect(config.customSources).toEqual([]);
    expect(config.customSources).not.toContain(sdkSource);
    expect(meta.settingSources.customSources).toBeUndefined();
    expect(meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "customSources",
        message: "allowed only in the canonical global opencode-quota/quota-toast.json",
      },
    ]);
  });

  it("stores only an explicit environment variable name and never an environment value", async () => {
    const secret = "must-not-appear-in-config-or-diagnostics";
    const previous = process.env.CUSTOM_ACCOUNTING_KEY;
    process.env.CUSTOM_ACCOUNTING_KEY = secret;
    try {
      writeQuotaSidecarConfig(workspace.opencodeConfigDir, {
        customSources: [
          customSource({
            apiKeyEnv: "CUSTOM_ACCOUNTING_KEY",
          }),
        ],
      });

      const meta = createLoadConfigMeta();
      const config = await loadConfig(undefined, meta, { configRootDir: workspace.workspaceDir });

      expect(config.customSources[0].apiKeyEnv).toBe("CUSTOM_ACCOUNTING_KEY");
      expect(JSON.stringify(config)).not.toContain(secret);
      expect(JSON.stringify(meta)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.CUSTOM_ACCOUNTING_KEY;
      else process.env.CUSTOM_ACCOUNTING_KEY = previous;
    }
  });
});
