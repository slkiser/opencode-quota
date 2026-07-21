import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConfigLoaderWorkspace,
  quotaConfigSource,
  quotaSidecarConfigSource,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
  type ConfigLoaderWorkspace,
} from "./helpers/config-loader-test-harness.js";
import { quotaProvider } from "./fixtures/quota-providers.js";

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

describe("quotaProviders global-only security", () => {
  let workspace: ConfigLoaderWorkspace;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("quota-providers-security-");
    runtimeDirs.value = workspace.runtimeDirs;
  });

  afterEach(() => workspace.cleanup());

  it("never executes workspace sidecar definitions", async () => {
    writeQuotaSidecarConfig(workspace.workspaceDir, {
      enableToast: false,
      quotaProviders: [quotaProvider({ id: "workspace-endpoint" })],
    });
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });
    expect(config.enableToast).toBe(false);
    expect(config.quotaProviders).toEqual([]);
    expect(meta.configIssues).toContainEqual({
      path: quotaSidecarConfigSource(workspace.workspaceDir),
      key: "quotaProviders",
      message: "allowed only in global OpenCode or global opencode-quota config",
    });
  });

  it("never executes workspace OpenCode quota definitions", async () => {
    writeQuotaToastConfig(workspace.workspaceDir, {
      quotaProviders: [quotaProvider({ id: "workspace-endpoint" })],
    });
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });
    expect(config.quotaProviders).toEqual([]);
    expect(meta.configIssues).toContainEqual({
      path: quotaConfigSource(workspace.workspaceDir),
      key: "quotaProviders",
      message: "allowed only in global OpenCode or global opencode-quota config",
    });
  });

  it("rejects SDK quotaProviders because file provenance is unknown", async () => {
    const meta = createLoadConfigMeta();
    const config = await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast: {
                  quotaProviders: [quotaProvider()],
                },
              },
            },
          }),
        },
      },
      meta,
      { configRootDir: workspace.workspaceDir },
    );
    expect(config.quotaProviders).toEqual([]);
    expect(meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "quotaProviders",
        message: "file provenance is required; define quotaProviders in global config",
      },
    ]);
  });

  it("accepts definitions only when their source is a trusted global file", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      quotaProviders: [
        quotaProvider({
          apiKeyEnv: "CUSTOM_ACCOUNTING_KEY",
        }),
      ],
    });
    const config = await loadConfig(undefined, undefined, {
      configRootDir: workspace.workspaceDir,
    });
    expect(config.quotaProviders[0]).toMatchObject({
      id: "provider-one",
      providerId: "provider-one",
      apiKeyEnv: "CUSTOM_ACCOUNTING_KEY",
    });
  });

  it("rejects old customSources in both trusted global and workspace files", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      customSources: [quotaProvider({ id: "old-global" })],
    });
    writeQuotaToastConfig(workspace.workspaceDir, {
      customSources: [quotaProvider({ id: "old-workspace" })],
    });
    const meta = createLoadConfigMeta();
    await loadConfig(undefined, meta, { configRootDir: workspace.workspaceDir });
    expect(meta.configIssues.filter((issue) => issue.key === "customSources")).toHaveLength(2);
  });
});
