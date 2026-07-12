import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  createSessionTokensModuleMock,
  getPromptText,
  getToastMessage,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";
import {
  PHASE5_ACCOUNTING_RESPONSE,
  PHASE5_CUSTOM_SOURCES,
  PHASE5_OPENROUTER_RESPONSE,
  PHASE5_RUNTIME_PROVIDER_IDS,
  PHASE5_SECRET_CANARIES,
  assertPhase5CanariesRedacted,
  assertPhase5FixtureOrder,
  phase5JsonResponse,
} from "./fixtures/v4-phase5-integration.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-v4-phase5-cross-surface";

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
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);

type PluginHooks = {
  config?: (input: unknown) => Promise<void> | void;
  event?: (input: unknown) => Promise<void> | void;
  "command.execute.before"?: (input: {
    command: string;
    sessionID: string;
  }) => Promise<void> | void;
};

function configFor(formatStyle: "allWindows" | "singleWindow") {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["custom-sources"],
    customSources: PHASE5_CUSTOM_SOURCES.map((source) => ({ ...source })),
    formatStyle,
    minIntervalMs: 60_000,
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: false,
    showSessionTokens: false,
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: false,
      formatStyle,
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle,
      suppressWhenNativeProviderQuota: false,
    },
  });
}

function createClient() {
  const client = createPluginTestClient({
    modelID: "team-gateway/model-one",
    providerID: "team-gateway",
  });
  client.config.providers.mockResolvedValue({
    data: {
      providers: PHASE5_RUNTIME_PROVIDER_IDS.map((id) => ({ id })),
    },
  });
  return client;
}

async function expectHandled(value: unknown): Promise<void> {
  try {
    await Promise.resolve(value);
  } catch (error) {
    expect(isCommandHandledError(error)).toBe(true);
    return;
  }
  throw new Error("Expected the ADR 0002 handled sentinel");
}

function assertFixtureContent(output: string): void {
  expect(output).toContain("64%");
  expect(output).toContain("$12.34");
  expect(output).toContain("80%");
  expect(output).toContain("HTTP 503");
  assertPhase5FixtureOrder(output);
  assertPhase5CanariesRedacted(output);
}

describe("v4 Phase 5 cross-surface release evidence", () => {
  let currentConfig = configFor("allWindows");
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = {
      PHASE5_TEAM_ACCOUNTING_KEY: process.env.PHASE5_TEAM_ACCOUNTING_KEY,
      PHASE5_OPENROUTER_KEY: process.env.PHASE5_OPENROUTER_KEY,
      PHASE5_FAILING_KEY: process.env.PHASE5_FAILING_KEY,
    };
    process.env.PHASE5_TEAM_ACCOUNTING_KEY = PHASE5_SECRET_CANARIES.accountingKey;
    process.env.PHASE5_OPENROUTER_KEY = PHASE5_SECRET_CANARIES.openRouterKey;
    process.env.PHASE5_FAILING_KEY = PHASE5_SECRET_CANARIES.failingKey;

    currentConfig = configFor("allWindows");
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: currentConfig,
      resetPluginState: true,
    });
    mocks.loadConfig.mockImplementation(async () => currentConfig);

    const { customSourcesProvider } = await import("../src/providers/custom-sources.js");
    mocks.getProviders.mockReturnValue([customSourcesProvider]);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (url === PHASE5_CUSTOM_SOURCES[0].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.accountingKey}`);
        await new Promise((resolve) => setTimeout(resolve, 8));
        return phase5JsonResponse(PHASE5_ACCOUNTING_RESPONSE);
      }
      if (url === PHASE5_CUSTOM_SOURCES[1].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.openRouterKey}`);
        return phase5JsonResponse(PHASE5_OPENROUTER_RESPONSE);
      }
      if (url === PHASE5_CUSTOM_SOURCES[2].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.failingKey}`);
        await new Promise((resolve) => setTimeout(resolve, 3));
        return new Response(PHASE5_SECRET_CANARIES.failureBody, {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`unexpected Phase 5 fixture URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("proves server command, toast lifecycle, TUI placement, projections, order, partial failure, and redaction", async () => {
    const client = createClient();
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = (await QuotaToastPlugin({ client } as never)) as PluginHooks;

    const serverConfig: { command?: Record<string, unknown> } = {};
    await hooks.config?.(serverConfig);
    expect(serverConfig.command).toHaveProperty("quota");

    await expectHandled(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "phase5-session",
      }),
    );

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "phase5-session" },
        body: expect.objectContaining({
          noReply: true,
          parts: [expect.objectContaining({ type: "text", ignored: true })],
        }),
      }),
    );
    const serverOutput = getPromptText(client);
    assertFixtureContent(serverOutput);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "phase5-session" },
      },
    });
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    const toastOutput = getToastMessage(client);
    assertFixtureContent(toastOutput);

    const callsAfterFirstToast = vi.mocked(globalThis.fetch).mock.calls.length;
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "phase5-session" },
      },
    });
    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(callsAfterFirstToast);
    assertFixtureContent(getToastMessage(client, 1));

    const tuiApi = {
      state: {
        provider: PHASE5_RUNTIME_PROVIDER_IDS.map((id) => ({ id })),
        path: { worktree: process.cwd(), directory: process.cwd() },
        session: { messages: () => [] },
      },
      client,
    } as never;

    const { loadTuiHomeBottomStatus, loadTuiSessionQuotaSurfaces, resolveTuiSurfaceRegistration } =
      await import("../src/lib/tui-runtime.js");

    const registration = await resolveTuiSurfaceRegistration(tuiApi);
    expect(registration).toEqual(
      expect.objectContaining({
        sidebar: { enabled: true },
        compact: expect.objectContaining({
          enabled: true,
          homeBottom: true,
          sessionPrompt: true,
          suppressedByNativeProviderQuota: false,
        }),
        homeBottom: true,
      }),
    );

    const allWindows = await loadTuiSessionQuotaSurfaces({
      api: tuiApi,
      sessionID: "phase5-session",
    });
    expect(allWindows.sidebar.status).toBe("ready");
    expect(allWindows.compact.status).toBe("ready");
    const allWindowsSidebar = [
      ...allWindows.sidebar.lines,
      ...(allWindows.sidebar.linesExpanded ?? []),
    ].join("\n");
    assertFixtureContent(allWindowsSidebar);
    const sessionPromptCompact =
      allWindows.compact.status === "ready" ? allWindows.compact.text : "";
    expect(sessionPromptCompact).toContain("64%");
    expect(sessionPromptCompact).toContain("$12.34");
    expect(sessionPromptCompact).toContain("80%");
    expect(sessionPromptCompact).toContain("issue");
    assertPhase5CanariesRedacted(sessionPromptCompact);

    const homeBottom = await loadTuiHomeBottomStatus({ api: tuiApi });
    expect(homeBottom.status).toBe("ready");
    const homeCompact = homeBottom.compact.status === "ready" ? homeBottom.compact.text : "";
    expect(homeCompact).toBe(sessionPromptCompact);
    assertPhase5CanariesRedacted(homeCompact);

    currentConfig = configFor("singleWindow");
    const singleWindow = await loadTuiSessionQuotaSurfaces({
      api: tuiApi,
      sessionID: "phase5-session",
    });
    expect(singleWindow.sidebar.status).toBe("ready");
    expect(singleWindow.compact.status).toBe("ready");
    const singleWindowSidebar = singleWindow.sidebar.lines.join("\n");
    expect(singleWindowSidebar).toContain("64%");
    expect(singleWindowSidebar).toContain("80%");
    expect(singleWindowSidebar).toContain("HTTP 503");
    assertPhase5FixtureOrder(singleWindowSidebar);
    assertPhase5CanariesRedacted(singleWindowSidebar);

    const allOutput = JSON.stringify({
      serverOutput,
      toastOutput,
      allWindows,
      homeBottom,
      singleWindow,
    });
    assertPhase5CanariesRedacted(allOutput);
    for (const source of PHASE5_CUSTOM_SOURCES) {
      expect(allOutput).not.toContain(source.url);
    }
  });
});
