import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigLoaderWorkspace,
  quotaSidecarConfigSource,
  writeQuotaSidecarConfig,
  type ConfigLoaderWorkspace,
} from "./helpers/config-loader-test-harness.js";
import { customSource, VALID_CUSTOM_SOURCES } from "./fixtures/custom-sources.js";

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

describe("custom sources config integration", () => {
  let workspace: ConfigLoaderWorkspace;
  let alternateConfigDir: string;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("opencode-quota-custom-sources-");
    alternateConfigDir = `${workspace.tempDir}/alternate-config/opencode`;
    runtimeDirs.value = {
      ...workspace.runtimeDirs,
      configDirs: [workspace.opencodeConfigDir, alternateConfigDir],
    };
  });

  afterEach(() => workspace.cleanup());

  it("loads ordered sources only from the canonical global sidecar and records provenance", async () => {
    writeQuotaSidecarConfig(workspace.opencodeConfigDir, {
      customSources: VALID_CUSTOM_SOURCES,
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });

    expect(config.customSources).toEqual(VALID_CUSTOM_SOURCES);
    expect(config.customSources.map((source) => source.id)).toEqual([
      "openrouter-primary",
      "internal-accounting",
    ]);
    expect(meta.settingSources.customSources).toBe(
      quotaSidecarConfigSource(workspace.opencodeConfigDir),
    );
    expect(meta.networkSettingSources.customSources).toBe(
      quotaSidecarConfigSource(workspace.opencodeConfigDir),
    );
    expect(meta.configIssues).toEqual([]);
  });

  it("atomically rejects an invalid array and reports deterministic indexed diagnostics", async () => {
    writeQuotaSidecarConfig(workspace.opencodeConfigDir, {
      enabled: false,
      customSources: [
        customSource({ id: "valid-source" }),
        customSource({
          id: "bad_source",
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
    expect(config.customSources).toEqual([]);
    expect(meta.settingSources.customSources).toBeUndefined();
    expect(meta.configIssues).toEqual([
      {
        path: quotaSidecarConfigSource(workspace.opencodeConfigDir),
        key: "customSources[1].id",
        message: "expected 1-64 ASCII characters matching ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      },
      {
        path: quotaSidecarConfigSource(workspace.opencodeConfigDir),
        key: "customSources[1].url",
        message: "expected an absolute HTTP(S) URL",
      },
    ]);
  });

  it("deep-clones custom sources across loads and never mutates defaults", async () => {
    writeQuotaSidecarConfig(workspace.opencodeConfigDir, {
      customSources: VALID_CUSTOM_SOURCES,
    });

    const first = await loadConfig(undefined, undefined, {
      configRootDir: workspace.workspaceDir,
    });
    first.customSources[0].label = "Changed";
    first.customSources[0].modelIds![0] = "changed/model";

    const second = await loadConfig(undefined, undefined, {
      configRootDir: workspace.workspaceDir,
    });
    expect(second.customSources).toEqual(VALID_CUSTOM_SOURCES);
    expect(second.customSources).not.toBe(first.customSources);
    expect(second.customSources[0]).not.toBe(first.customSources[0]);
    expect(second.customSources[0].modelIds).not.toBe(first.customSources[0].modelIds);
    expect(DEFAULT_CONFIG.customSources).toEqual([]);
  });

  it("ignores alternate global customSources and rejects workspace overrides", async () => {
    writeQuotaSidecarConfig(workspace.opencodeConfigDir, {
      customSources: [customSource({ id: "canonical" })],
    });
    writeQuotaSidecarConfig(alternateConfigDir, {
      enabled: false,
      customSources: [customSource({ id: "alternate" })],
    });
    writeQuotaSidecarConfig(workspace.workspaceDir, {
      enableToast: false,
      customSources: [customSource({ id: "workspace" })],
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceDir,
    });

    expect(config.customSources.map((source) => source.id)).toEqual(["canonical"]);
    expect(config.enabled).toBe(false);
    expect(config.enableToast).toBe(false);
    expect(meta.configIssues.filter((issue) => issue.key === "customSources")).toEqual([
      {
        path: quotaSidecarConfigSource(workspace.workspaceDir),
        key: "customSources",
        message: `allowed only in canonical global config ${workspace.opencodeConfigDir}/opencode-quota/quota-toast.json`,
      },
    ]);
  });
});
