import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
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

describe("loadConfig", () => {
  let isolatedCwd: string;

  beforeEach(() => {
    isolatedCwd = mkdtempSync(join(tmpdir(), "opencode-quota-config-sdk-"));
    runtimeDirs.value = {
      dataDirs: [],
      configDirs: [],
      cacheDirs: [],
      stateDirs: [],
    };
  });

  afterEach(() => {
    rmSync(isolatedCwd, { recursive: true, force: true });
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
      enabledProviders: ["nano-gpt", "nanogpt", "open-cursor", "gemini-cli"],
    });

    expect(cfg.config.enabledProviders).toEqual(["nanogpt", "cursor", "google-gemini-cli"]);
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
    expect(meta.paths).toEqual([workspaceConfigPath + " (experimental.quotaToast)"]);
    expect(meta.workspaceConfigPaths).toEqual(meta.paths);
    expect(meta.globalConfigPaths).toEqual([]);
    expect(meta.settingSources).toEqual({
      enabledProviders: workspaceConfigPath + " (experimental.quotaToast)",
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
