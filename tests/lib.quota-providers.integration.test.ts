import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigLoaderWorkspace,
  quotaConfigSource,
  quotaSidecarConfigSource,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
  type ConfigLoaderWorkspace,
} from "./helpers/config-loader-test-harness.js";
import {
  quotaProvider,
  VALID_QUOTA_PROVIDER_INPUTS,
  VALID_QUOTA_PROVIDERS,
} from "./fixtures/quota-providers.js";

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

describe("quotaProviders config integration", () => {
  let workspace: ConfigLoaderWorkspace;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("opencode-quota-providers-");
    runtimeDirs.value = workspace.runtimeDirs;
  });

  afterEach(() => workspace.cleanup());

  it("loads ordered definitions from global OpenCode experimental.quotaToast", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      quotaProviders: VALID_QUOTA_PROVIDER_INPUTS,
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });

    expect(config.quotaProviders).toEqual(VALID_QUOTA_PROVIDERS);
    expect(config.quotaProviders.map((definition) => definition.id)).toEqual([
      "openrouter-primary",
      "internal-accounting",
    ]);
    expect(meta.settingSources.quotaProviders).toBe(quotaConfigSource(workspace.opencodeConfigDir));
    expect(meta.networkSettingSources.quotaProviders).toBe(
      quotaConfigSource(workspace.opencodeConfigDir),
    );
    expect(meta.configIssues).toEqual([]);
  });

  it("also accepts the existing global opencode-quota config section", async () => {
    writeQuotaSidecarConfig(workspace.opencodeConfigDir, {
      quotaProviders: VALID_QUOTA_PROVIDER_INPUTS,
    });
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });
    expect(config.quotaProviders).toEqual(VALID_QUOTA_PROVIDERS);
    expect(meta.settingSources.quotaProviders).toBe(
      quotaSidecarConfigSource(workspace.opencodeConfigDir),
    );
  });

  it("atomically rejects invalid arrays with indexed diagnostics", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      enabled: false,
      quotaProviders: [
        quotaProvider({ id: "valid-provider" }),
        quotaProvider({
          id: "bad_provider",
          providerId: "provider-two",
          url: "file:///tmp/accounting",
        }),
      ],
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });

    expect(config.enabled).toBe(false);
    expect(config.quotaProviders).toEqual([]);
    expect(meta.settingSources.quotaProviders).toBeUndefined();
    expect(meta.configIssues.map((issue) => issue.key)).toEqual([
      "quotaProviders[1].id",
      "quotaProviders[1].url",
    ]);
  });

  it("deep-clones definitions across loads without mutating defaults", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      quotaProviders: VALID_QUOTA_PROVIDER_INPUTS,
    });

    const first = await loadConfig(undefined, undefined, {
      configRootDir: workspace.workspaceDir,
    });
    first.quotaProviders[0]!.label = "Changed";
    first.quotaProviders[0]!.modelIds![0] = "changed-model";

    const second = await loadConfig(undefined, undefined, {
      configRootDir: workspace.workspaceDir,
    });
    expect(second.quotaProviders).toEqual(VALID_QUOTA_PROVIDERS);
    expect(second.quotaProviders).not.toBe(first.quotaProviders);
    expect(second.quotaProviders[0]).not.toBe(first.quotaProviders[0]);
    expect(DEFAULT_CONFIG.quotaProviders).toEqual([]);
  });

  it("rejects workspace quotaProviders while retaining ordinary workspace settings", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      quotaProviders: [quotaProvider({ id: "global-provider" })],
    });
    writeQuotaToastConfig(workspace.workspaceDir, {
      enableToast: false,
      quotaProviders: [quotaProvider({ id: "workspace-provider" })],
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });

    expect(config.quotaProviders.map((definition) => definition.id)).toEqual(["global-provider"]);
    expect(config.enableToast).toBe(false);
    expect(meta.configIssues).toContainEqual({
      path: quotaConfigSource(workspace.workspaceDir),
      key: "quotaProviders",
      message: "allowed only in global OpenCode or global opencode-quota config",
    });
  });

  it("explicitly rejects customSources with no compatibility reader", async () => {
    writeQuotaToastConfig(workspace.opencodeConfigDir, {
      customSources: [quotaProvider()],
    });
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });
    expect(config.quotaProviders).toEqual([]);
    expect(meta.configIssues).toContainEqual({
      path: quotaConfigSource(workspace.opencodeConfigDir),
      key: "customSources",
      message: 'removed in v4; use the global-only "quotaProviders" property',
    });
  });
});
