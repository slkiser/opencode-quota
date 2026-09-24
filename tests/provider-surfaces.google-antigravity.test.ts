import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import {
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-google-antigravity-surfaces";

let provider: typeof import("../src/providers/google-antigravity.js")["googleAntigravityProvider"];

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  queryGoogleQuota: vi.fn(),
}));

vi.mock("../src/lib/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/config.js")>()),
  ...createConfigModuleMock(mocks.loadConfig),
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  ...createPricingModuleMock(mocks),
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);
vi.mock("../src/lib/google.js", () => ({
  hasAntigravityQuotaRuntimeAvailable: vi.fn(async () => true),
  queryGoogleQuota: mocks.queryGoogleQuota,
  inspectAntigravityAccountsPresence: vi.fn(async () => ({
    state: "present",
    selectedPath: `${TEST_RUNTIME_ROOT}/antigravity-accounts.json`,
    presentPaths: [`${TEST_RUNTIME_ROOT}/antigravity-accounts.json`],
    candidatePaths: [`${TEST_RUNTIME_ROOT}/antigravity-accounts.json`],
    accountCount: 2,
    validAccountCount: 2,
  })),
}));
vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  inspectAntigravityCompanionPresence: vi.fn(async () => ({
    state: "present",
    resolvedPath: `${TEST_RUNTIME_ROOT}/opencode-antigravity-auth`,
  })),
}));

function createConfig() {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["google-antigravity"],
    formatStyle: "singleWindow",
    googleModels: ["CLAUDE"],
    minIntervalMs: 60_000,
    onlyCurrentModel: false,
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: false,
    showSessionTokens: false,
    telemetry: { enabled: false },
    maintainerAnnouncements: { enabled: false, home: false },
    tuiCommandDisplay: "dialog",
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: false,
      formatStyle: "singleWindow",
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle: "singleWindow",
      suppressWhenNativeProviderQuota: false,
    },
  });
}

function expectNoProviderMisattribution(output: string): void {
  expect(output).toContain("Antigravity");
  expect(output).not.toContain("Google Antigravity");
  expect(output).not.toMatch(/Anthropic|subscription/iu);
}

async function collectSurfaceOutputs() {
  const result = await provider.fetch({ config: createConfig() } as never);
  const data = { entries: result.entries, errors: result.errors };
  const formatConfig = {
    formatStyle: "singleWindow" as const,
    percentDisplayMode: "remaining" as const,
  };
  return {
    command: formatQuotaCommand({ ...data, generatedAtMs: 0 }),
    cli: formatQuotaRows({ ...data, version: "test", style: "allWindows" }),
    toast: formatQuotaRowsGrouped(data),
    sidebar: buildSidebarQuotaPanelLines({
      data,
      config: { ...formatConfig, formatStyle: "allWindows" },
    }).join("\n"),
    compact: buildCompactQuotaStatusLine({ data, maxWidth: 240 }),
  };
}

describe("Google Antigravity provider surfaces", () => {
  beforeEach(async () => {
    const config = createConfig();
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: config,
      resetPluginState: true,
    });
    provider = (await import("../src/providers/google-antigravity.js")).googleAntigravityProvider;
    provider.cachePolicy = { kind: "account-neutral" };
    mocks.loadConfig.mockResolvedValue(config);
    mocks.getProviders.mockReturnValue([provider]);
    mocks.queryGoogleQuota.mockResolvedValue({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 0,
          resetTimeIso: "2026-08-01T00:00:00.000Z",
        },
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "bob@example.com",
          percentRemaining: 0,
          resetTimeIso: "2026-08-02T00:00:00.000Z",
        },
      ],
      errors: [],
    });

    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("keeps same-family accounts distinct and verifies the compact line", async () => {
    const outputs = await collectSurfaceOutputs();

    for (const output of Object.values(outputs)) {
      expectNoProviderMisattribution(output);
      expect(output).toContain("Antigravity (ali…)");
      expect(output).toContain("Antigravity (bob…)");
    }
    expect(outputs.compact).toBe(
      "Antigravity (ali…): Claude 0% reset | Antigravity (bob…): Claude 0% reset",
    );
    expect(mocks.queryGoogleQuota).toHaveBeenCalled();
  });

  it("keeps family names when one account returns multiple families", async () => {
    mocks.queryGoogleQuota.mockResolvedValue({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
        },
        {
          modelId: "G3PRO",
          displayName: "G3Pro",
          accountEmail: "alice@example.com",
          percentRemaining: 37,
        },
      ],
      errors: [],
    });

    const outputs = await collectSurfaceOutputs();
    for (const output of [outputs.command, outputs.cli, outputs.toast, outputs.compact]) {
      expect(output).toMatch(/\bClaude\b/u);
      expect(output).toMatch(/\bG3Pro\b/u);
    }
    expect(outputs.sidebar).toMatch(/\bClaude\b/u);
    expect(outputs.sidebar).toMatch(/\bG3Pro\b/u);
  });

  it("keeps family names when accounts return different singleton families", async () => {
    mocks.queryGoogleQuota.mockResolvedValue({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
        },
        {
          modelId: "G3PRO",
          displayName: "G3Pro",
          accountEmail: "bob@example.com",
          percentRemaining: 37,
        },
      ],
      errors: [],
    });

    const outputs = await collectSurfaceOutputs();
    for (const output of Object.values(outputs)) {
      expect(output).toContain("Antigravity (ali…)");
      expect(output).toContain("Antigravity (bob…)");
    }
    for (const output of [outputs.command, outputs.cli, outputs.toast, outputs.compact]) {
      expect(output).toMatch(/Antigravity \(ali…\)[\s\S]*Claude/u);
      expect(output).toMatch(/Antigravity \(bob…\)[\s\S]*G3Pro/u);
    }
    expect(outputs.sidebar).toMatch(/Antigravity \(ali…\)[\s\S]*Claude/u);
    expect(outputs.sidebar).toMatch(/Antigravity \(bob…\)[\s\S]*G3Pro/u);
  });

  it("preserves collision-safe account labels for a shared family", async () => {
    mocks.queryGoogleQuota.mockResolvedValue({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@work.com",
          percentRemaining: 64,
        },
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@personal.com",
          percentRemaining: 37,
        },
      ],
      errors: [],
    });

    const outputs = await collectSurfaceOutputs();
    for (const output of Object.values(outputs)) {
      expectNoProviderMisattribution(output);
      expect(output).toContain("Antigravity (alice… 1)");
      expect(output).toContain("Antigravity (alice… 2)");
    }
    expect(outputs.compact).toBe(
      "Antigravity (alice… 1): Claude 64% | Antigravity (alice… 2): Claude 37%",
    );
  });
});
