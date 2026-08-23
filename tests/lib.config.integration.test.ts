import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VALID_QUOTA_PROVIDER_INPUTS, VALID_QUOTA_PROVIDERS } from "./fixtures/quota-providers.js";
import {
  type ConfigLoaderWorkspace,
  createConfigLoaderEnv,
  createConfigLoaderWorkspace,
  quotaConfigSource,
  quotaSidecarConfigSource,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

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
import { applyInitInstallerPlan, planInitInstaller } from "../src/lib/init-installer.js";
import { getOpencodeRuntimeDirCandidates } from "../src/lib/opencode-runtime-paths.js";
import { applyProviderAddPlan, planProviderAdd } from "../src/lib/provider-add.js";
import { applyScopedUpdatePlan, planScopedUpdate } from "../src/lib/scoped-update.js";

describe("loadConfig integration runtime-path resolution", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  let workspace: ConfigLoaderWorkspace;
  let tempDir: string;
  let workspaceDir: string;
  let nestedDir: string;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("opencode-quota-config-integration-", {
      nestedPath: ["packages", "feature"],
    });
    tempDir = workspace.tempDir;
    mockedHomeDir.value = tempDir;
    workspaceDir = workspace.workspaceDir;
    nestedDir = workspace.nestedDir;

    process.env = {
      ...originalEnv,
      ...createConfigLoaderEnv(workspace, { home: tempDir, includePlatformAppData: true }),
    };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.chdir(nestedDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    mockedHomeDir.value = "";
    workspace.cleanup();
  });

  it("uses real runtime dirs as defaults and explicit cwd config as workspace overrides", async () => {
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir, includePlatformAppData: true }),
    } as NodeJS.ProcessEnv;
    const { configDirs } = getOpencodeRuntimeDirCandidates({ env, homeDir: tempDir });
    for (const dir of configDirs) {
      mkdirSync(dir, { recursive: true });
      writeQuotaToastConfig(dir, {
        enabled: false,
        enabledProviders: ["openai"],
        accountingDetail: "summary",
        showOnIdle: false,
        pricingSnapshot: { source: "bundled", autoRefresh: 30 },
      });
    }

    writeQuotaToastConfig(workspaceDir, {
      enabled: true,
      enabledProviders: ["nano-gpt"],
      accountingDetail: "detailed",
      formatStyle: "allWindows",
      onlyCurrentModel: true,
    });

    writeQuotaToastConfig(nestedDir, {
      enabledProviders: ["chutes"],
    });

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.enabled).toBe(true);
    expect(cfg.enabledProviders).toEqual(["nanogpt"]);
    expect(cfg.showOnIdle).toBe(false);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.accountingDetail).toBe("detailed");
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.onlyCurrentModel).toBe(true);

    expect(meta.source).toBe("files");
    expect(
      meta.paths.some((path) => configDirs.some((dir) => path === quotaConfigSource(dir))),
    ).toBe(true);
    expect(meta.paths).toContain(quotaConfigSource(workspaceDir));
    expect(meta.paths).not.toContain(quotaConfigSource(nestedDir));
    expect(meta.workspaceConfigPaths).toEqual([quotaConfigSource(workspaceDir)]);
    expect(
      meta.globalConfigPaths.some((path) =>
        configDirs.some((dir) => path === quotaConfigSource(dir)),
      ),
    ).toBe(true);
    expect(meta.settingSources.enabled).toBe(quotaConfigSource(workspaceDir));
    expect(meta.settingSources.enabledProviders).toBe(quotaConfigSource(workspaceDir));
    expect(meta.settingSources.accountingDetail).toBe(quotaConfigSource(workspaceDir));
    expect(
      configDirs.some(
        (dir) => meta.settingSources["pricingSnapshot.source"] === quotaConfigSource(dir),
      ),
    ).toBe(true);
    expect(
      configDirs.some(
        (dir) => meta.settingSources["pricingSnapshot.autoRefresh"] === quotaConfigSource(dir),
      ),
    ).toBe(true);
  });

  it("diagnoses the removed Zen display key in file and legacy sources without translation", async () => {
    writeQuotaSidecarConfig(workspaceDir, {
      opencodeZenDisplay: "detailed",
    });

    const sidecarMeta = createLoadConfigMeta();
    const sidecarConfig = await loadConfig(undefined, sidecarMeta, {
      configRootDir: workspaceDir,
    });
    expect(sidecarConfig.accountingDetail).toBe("summary");
    expect(sidecarMeta.settingSources.accountingDetail).toBeUndefined();
    expect(sidecarMeta.configIssues).toContainEqual({
      path: quotaSidecarConfigSource(workspaceDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });

    writeQuotaToastConfig(nestedDir, {
      accountingDetail: "detailed",
      opencodeZenDisplay: "default",
    });

    const legacyMeta = createLoadConfigMeta();
    const legacyConfig = await loadConfig(undefined, legacyMeta, { configRootDir: nestedDir });
    expect(legacyConfig.accountingDetail).toBe("detailed");
    expect(legacyMeta.settingSources.accountingDetail).toBe(quotaConfigSource(nestedDir));
    expect(legacyMeta.configIssues).toContainEqual({
      path: quotaConfigSource(nestedDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });
  });

  it("loads updater-migrated accounting detail with file provenance", async () => {
    const migratedPath = writeQuotaSidecarConfig(workspaceDir, {
      opencodeZenDisplay: "default",
    });
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir, includePlatformAppData: true }),
    } as NodeJS.ProcessEnv;

    const plan = await planScopedUpdate({ cwd: workspaceDir, env, homeDir: tempDir });
    expect(plan.configEdits).toEqual([
      expect.objectContaining({ path: migratedPath, displayMigrations: 1 }),
    ]);
    await applyScopedUpdatePlan(plan);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: workspaceDir });
    expect(cfg.accountingDetail).toBe("summary");
    expect(meta.settingSources.accountingDetail).toBe(quotaSidecarConfigSource(workspaceDir));
    expect(meta.configIssues).not.toContainEqual(
      expect.objectContaining({ key: "opencodeZenDisplay" }),
    );
    expect(readFileSync(migratedPath, "utf8")).not.toContain("opencodeZenDisplay");
  });

  it("keeps unsupported updater display values unchanged and diagnostic-only at runtime", async () => {
    const hostPath = writeQuotaToastConfig(workspaceDir, {
      opencodeZenDisplay: "expanded",
    });
    const original = readFileSync(hostPath, "utf8");
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir, includePlatformAppData: true }),
    } as NodeJS.ProcessEnv;

    const plan = await planScopedUpdate({ cwd: workspaceDir, env, homeDir: tempDir });
    expect(plan.configEdits).toEqual([]);
    expect(plan.manualFindings).toContainEqual({
      kind: "display-migration-manual",
      path: hostPath,
      container: "experimental.quotaToast",
      reason: "unsupported-legacy-value",
    });
    await applyScopedUpdatePlan(plan);
    expect(readFileSync(hostPath, "utf8")).toBe(original);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: workspaceDir });
    expect(cfg.accountingDetail).toBe("summary");
    expect(meta.settingSources.accountingDetail).toBeUndefined();
    expect(meta.configIssues).toContainEqual({
      path: quotaConfigSource(workspaceDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });
  });

  it("loads the recommended quota-toast.jsonc sidecar with comments", async () => {
    const sidecarDir = join(workspaceDir, "opencode-quota");
    mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = join(sidecarDir, "quota-toast.jsonc");
    writeFileSync(
      sidecarPath,
      '{ // recommended commented sidecar\n  "enabled": false,\n  "enabledProviders": ["openai"],\n}\n',
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: workspaceDir });

    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(meta.workspaceConfigPaths.some((path) => path.includes("quota-toast.jsonc"))).toBe(true);
  });

  it("loads a custom provider after init creates a manual-mode JSONC sidecar", async () => {
    const env = process.env as NodeJS.ProcessEnv;
    const configDir = getOpencodeRuntimeDirCandidates({ env, homeDir: tempDir }).configDirs[0]!;
    const initPlan = await planInitInstaller({
      env,
      homeDir: tempDir,
      selections: {
        interfaces: "web",
        scope: "global",
        configFormat: "jsonc",
        quotaUi: ["none"],
        providerMode: "manual",
        manualProviders: ["openai"],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: false,
      },
    });
    await applyInitInstallerPlan(initPlan);

    const providerPlan = await planProviderAdd({
      configDir,
      definition: {
        id: "private-gateway",
        mode: "remote-api",
        url: "https://gateway.example/accounting",
        format: "quota-v1",
        apiKeyEnv: "PRIVATE_GATEWAY_KEY",
      },
    });
    expect(providerPlan.path).toBe(join(configDir, "opencode-quota", "quota-toast.jsonc"));
    await applyProviderAddPlan(providerPlan);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: workspaceDir });
    expect(cfg.enabledProviders).toEqual(["openai", "quota-providers"]);
    expect(cfg.quotaProviders).toEqual([
      expect.objectContaining({ id: "private-gateway", mode: "remote-api" }),
    ]);
    expect(meta.settingSources.quotaProviders).toContain("quota-toast.jsonc");
  });

  it("prefers valid JSONC when both sidecars exist and reports the conflict", async () => {
    const sidecarDir = join(workspaceDir, "opencode-quota");
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(
      join(sidecarDir, "quota-toast.jsonc"),
      '{ // preferred\n  "enabledProviders": ["openai"],\n}\n',
      "utf8",
    );
    writeFileSync(
      join(sidecarDir, "quota-toast.json"),
      JSON.stringify({ enabledProviders: ["chutes"] }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: workspaceDir });

    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(meta.settingSources.enabledProviders).toContain("quota-toast.jsonc");
    expect(meta.configIssues).toContainEqual(
      expect.objectContaining({
        key: "$file",
        message: "both quota-toast.jsonc and quota-toast.json exist; using quota-toast.jsonc",
      }),
    );
  });

  it("falls through a malformed sidecar and loads valid host quota config", async () => {
    const sidecarDir = join(workspaceDir, "opencode-quota");
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, "quota-toast.jsonc"), '{ "enabledProviders": [', "utf8");
    writeQuotaToastConfig(workspaceDir, {
      enabled: false,
      enabledProviders: ["chutes"],
    });

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { configRootDir: workspaceDir });

    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledProviders).toEqual(["chutes"]);
    expect(meta.settingSources.enabledProviders).toBe(quotaConfigSource(workspaceDir));
    expect(meta.configIssues).toContainEqual(
      expect.objectContaining({
        key: "$root",
        message: "expected readable JSON object; this sidecar is not authoritative",
      }),
    );
  });

  it("classifies an OPENCODE_CONFIG_DIR overlap with the canonical global sidecar as global", async () => {
    const overlappingRoot = workspace.opencodeConfigDir;
    process.env.OPENCODE_CONFIG_DIR = overlappingRoot;

    writeQuotaSidecarConfig(overlappingRoot, {
      enabled: false,
      minIntervalMs: 12_345,
      quotaProviders: VALID_QUOTA_PROVIDER_INPUTS,
    });

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta);

    expect(cfg.enabled).toBe(false);
    expect(cfg.minIntervalMs).toBe(12_345);
    expect(cfg.quotaProviders).toEqual(VALID_QUOTA_PROVIDERS);
    expect(meta.globalConfigPaths).toEqual([quotaSidecarConfigSource(overlappingRoot)]);
    expect(meta.workspaceConfigPaths).toEqual([]);
    expect(meta.paths).toEqual(meta.globalConfigPaths);
    expect(meta.settingSources.enabled).toBe(quotaSidecarConfigSource(overlappingRoot));
    expect(meta.settingSources.minIntervalMs).toBe(quotaSidecarConfigSource(overlappingRoot));
    expect(meta.settingSources.quotaProviders).toBe(quotaSidecarConfigSource(overlappingRoot));
  });

  it("uses the provided configRootDir to pick the workspace override layer over shared global defaults", async () => {
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir, includePlatformAppData: true }),
    } as NodeJS.ProcessEnv;
    const { configDirs } = getOpencodeRuntimeDirCandidates({ env, homeDir: tempDir });

    for (const dir of configDirs) {
      mkdirSync(dir, { recursive: true });
      writeQuotaToastConfig(dir, {
        enabled: false,
        enabledProviders: ["openai"],
        minIntervalMs: 30_000,
      });
    }

    writeQuotaToastConfig(workspaceDir, {
      enabled: true,
      enabledProviders: ["nano-gpt"],
      minIntervalMs: 1_000,
      formatStyle: "allWindows",
      onlyCurrentModel: true,
    });

    writeQuotaToastConfig(nestedDir, {
      enabled: true,
      enabledProviders: ["chutes"],
      minIntervalMs: 2_000,
      formatStyle: "singleWindow",
      onlyCurrentModel: false,
    });

    const workspaceMeta = createLoadConfigMeta();
    const workspaceCfg = await loadConfig(undefined, workspaceMeta, {
      configRootDir: workspaceDir,
    });

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
    expect(workspaceMeta.settingSources.enabled).toBe(quotaConfigSource(workspaceDir));
    expect(nestedMeta.settingSources.enabled).toBe(quotaConfigSource(nestedDir));
    expect(workspaceMeta.settingSources.minIntervalMs).toBe(quotaConfigSource(workspaceDir));
    expect(nestedMeta.settingSources.minIntervalMs).toBe(quotaConfigSource(nestedDir));
  });
});
