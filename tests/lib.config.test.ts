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

import { loadConfig } from "../src/lib/config.js";

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

  async function loadSdkConfig(quotaToast: Record<string, unknown>) {
    return await loadConfig(
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
      undefined,
      { cwd: isolatedCwd },
    );
  }

  it("defaults alibabaCodingPlanTier to lite and accepts explicit overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.alibabaCodingPlanTier).toBe("lite");

    const explicit = await loadSdkConfig({ alibabaCodingPlanTier: "pro" });
    expect(explicit.alibabaCodingPlanTier).toBe("pro");
  });

  it("normalizes cursor config fields without coercing invalid values", async () => {
    const defaults = await loadSdkConfig({
      cursorPlan: "bad-plan",
      cursorIncludedApiUsd: -5,
      cursorBillingCycleStartDay: 31,
    });
    expect(defaults.cursorPlan).toBe("none");
    expect(defaults.cursorIncludedApiUsd).toBeUndefined();
    expect(defaults.cursorBillingCycleStartDay).toBeUndefined();

    const explicit = await loadSdkConfig({
      cursorPlan: "pro-plus",
      cursorIncludedApiUsd: 42,
      cursorBillingCycleStartDay: 7,
    });
    expect(explicit.cursorPlan).toBe("pro-plus");
    expect(explicit.cursorIncludedApiUsd).toBe(42);
    expect(explicit.cursorBillingCycleStartDay).toBe(7);
  });

  it("defaults pricingSnapshot config and accepts valid overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.pricingSnapshot.source).toBe("auto");
    expect(defaults.pricingSnapshot.autoRefresh).toBe(7);

    const bundled = await loadSdkConfig({
      pricingSnapshot: { source: "bundled", autoRefresh: 7 },
    });
    expect(bundled.pricingSnapshot.source).toBe("bundled");
    expect(bundled.pricingSnapshot.autoRefresh).toBe(7);

    const runtime = await loadSdkConfig({
      pricingSnapshot: { source: "runtime", autoRefresh: 2 },
    });
    expect(runtime.pricingSnapshot.source).toBe("runtime");
    expect(runtime.pricingSnapshot.autoRefresh).toBe(2);

    const invalid = await loadSdkConfig({
      pricingSnapshot: { source: "remote", autoRefresh: 0 },
    });
    expect(invalid.pricingSnapshot.source).toBe("auto");
    expect(invalid.pricingSnapshot.autoRefresh).toBe(7);
  });

  it("reads formatStyle and falls back to legacy toastStyle when needed", async () => {
    const explicit = await loadSdkConfig({ formatStyle: "grouped" });
    expect(explicit.formatStyle).toBe("grouped");

    const legacyOnly = await loadSdkConfig({ toastStyle: "grouped" });
    expect(legacyOnly.formatStyle).toBe("grouped");

    const both = await loadSdkConfig({
      formatStyle: "grouped",
      toastStyle: "classic",
    });
    expect(both.formatStyle).toBe("grouped");
  });

  it("defaults anthropicBinaryPath and trims explicit overrides", async () => {
    const defaults = await loadSdkConfig({});
    expect(defaults.anthropicBinaryPath).toBe("claude");

    const explicit = await loadSdkConfig({
      anthropicBinaryPath: "  /Applications/Claude Code.app/Contents/MacOS/claude  ",
    });
    expect(explicit.anthropicBinaryPath).toBe(
      "/Applications/Claude Code.app/Contents/MacOS/claude",
    );
  });

  it("normalizes enabled provider aliases to canonical ids", async () => {
    const cfg = await loadSdkConfig({
      enabledProviders: ["nano-gpt", "nanogpt", "open-cursor"],
    });

    expect(cfg.enabledProviders).toEqual(["nanogpt", "cursor"]);
  });
});
