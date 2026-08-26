import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  getPromptText,
  getToastMessage,
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

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
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

type PluginHooks = {
  dispose?: () => Promise<void> | void;
  event?: (input: unknown) => Promise<void> | void;
  "command.execute.before"?: (input: {
    command: string;
    sessionID: string;
  }) => Promise<void> | void;
};

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

async function expectHandled(value: unknown): Promise<void> {
  try {
    await Promise.resolve(value);
  } catch (error) {
    expect(isCommandHandledError(error)).toBe(true);
    return;
  }
  throw new Error("Expected the handled command sentinel");
}

function expectNoProviderMisattribution(output: string): void {
  expect(output).toContain("Antigravity");
  expect(output).not.toContain("Google Antigravity");
  expect(output).not.toMatch(/\bClaude\b/u);
  expect(output).not.toMatch(/Anthropic|subscription/iu);
}

async function collectSurfaceOutputs() {
  const client = createPluginTestClient({
    modelID: "google/antigravity-claude",
    providerID: "google",
  });
  client.config.providers.mockResolvedValue({
    data: { providers: [{ id: "google" }] },
  });

  const { QuotaToastPlugin } = await import("../src/plugin.js");
  const hooks = (await QuotaToastPlugin({ client } as never)) as PluginHooks;

  await expectHandled(
    hooks["command.execute.before"]?.({
      command: "quota",
      sessionID: "antigravity-session",
    }),
  );
  const command = getPromptText(client);

  await hooks.event?.({
    event: {
      type: "session.idle",
      properties: { sessionID: "antigravity-session" },
    },
  });
  const toast = getToastMessage(client);

  const tuiApi = {
    state: {
      provider: [{ id: "google" }],
      path: { worktree: process.cwd(), directory: process.cwd() },
      session: { messages: () => [] },
    },
    client,
  } as never;
  const { loadTuiSessionQuotaSurfaces } = await import("../src/lib/tui-runtime.js");
  const surfaces = await loadTuiSessionQuotaSurfaces({
    api: tuiApi,
    sessionID: "antigravity-session",
  });
  const sidebar = [...surfaces.sidebar.lines, ...(surfaces.sidebar.linesExpanded ?? [])].join("\n");
  const compact = surfaces.compact.status === "ready" ? surfaces.compact.text : "";

  return { command, toast, sidebar, compact, surfaces, hooks };
}

describe("Google Antigravity provider surfaces", () => {
  beforeEach(async () => {
    const config = createConfig();
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: config,
      resetPluginState: true,
    });
    provider = (await import("../src/providers/google-antigravity.js")).googleAntigravityProvider;
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

  it("keeps two same-family accounts distinct without redundant family wording", async () => {
    const { command, toast, sidebar, compact, surfaces, hooks } = await collectSurfaceOutputs();

    for (const output of [command, toast, sidebar, compact]) {
      expectNoProviderMisattribution(output);
      expect(output).toContain("Antigravity (ali…)");
      expect(output).toContain("Antigravity (bob…)");
    }
    expect(command.match(/\n {2}Quota\s/gu)).toHaveLength(2);
    expect(toast).not.toMatch(/\n(?:5h|7d|Weekly)\s/u);
    expect(surfaces.sidebar.status).toBe("ready");
    expect(sidebar.match(/\nQuota\s/gu)).toHaveLength(2);
    expect(surfaces.compact.status).toBe("ready");
    expect(compact).toBe("Antigravity (ali…) 0% | Antigravity (bob…) 0%");
    expect(mocks.queryGoogleQuota).toHaveBeenCalledTimes(1);

    await hooks.dispose?.();
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

    const { command, toast, sidebar, compact, hooks } = await collectSurfaceOutputs();
    for (const output of [command, toast, sidebar, compact]) {
      expect(output).toMatch(/\bClaude\b/u);
      expect(output).toMatch(/\bG3Pro\b/u);
    }

    await hooks.dispose?.();
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

    const { command, toast, sidebar, compact, hooks } = await collectSurfaceOutputs();
    for (const output of [command, toast, sidebar, compact]) {
      expect(output).toMatch(/Antigravity \(ali…\).*Claude/su);
      expect(output).toMatch(/Antigravity \(bob…\).*G3Pro/su);
    }

    await hooks.dispose?.();
  });

  it("preserves collision-safe account labels while hiding a shared family", async () => {
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

    const { command, toast, sidebar, compact, hooks } = await collectSurfaceOutputs();
    for (const output of [command, toast, sidebar, compact]) {
      expectNoProviderMisattribution(output);
      expect(output).toContain("Antigravity (alice… 1)");
      expect(output).toContain("Antigravity (alice… 2)");
    }
    expect(compact).toBe("Antigravity (alice… 1) 64% | Antigravity (alice… 2) 37%");

    await hooks.dispose?.();
  });
});
