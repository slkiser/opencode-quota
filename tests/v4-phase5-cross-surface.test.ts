import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  assertPhase5CanariesRedacted,
  assertPhase5FixtureOrder,
  PHASE5_ACCOUNTING_RESPONSE,
  PHASE5_OPENROUTER_RESPONSE,
  PHASE5_QUOTA_PROVIDERS,
  PHASE5_RUNTIME_PROVIDER_IDS,
  PHASE5_SECRET_CANARIES,
  phase5JsonResponse,
} from "./fixtures/v4-phase5-integration.js";
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

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-v4-phase5-cross-surface";
const MINIMAX_QUOTA_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const MINIMAX_API_KEY = "minimax-test-key";

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
  resolveMiniMaxAuthCached: vi.fn(),
  getMiniMaxAuthDiagnostics: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
}));

const otel = vi.hoisted(() => {
  const callbacks = new Map<
    string,
    (result: { observe(value: number, attributes?: Record<string, unknown>): void }) => void
  >();
  return {
    callbacks,
    getMeter: vi.fn(() => ({
      createObservableGauge: vi.fn((name: string) => ({
        addCallback: (
          callback: (result: {
            observe(value: number, attributes?: Record<string, unknown>): void;
          }) => void,
        ) => callbacks.set(name, callback),
        removeCallback: () => callbacks.delete(name),
      })),
    })),
  };
});

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: otel.getMeter },
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
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/minimax-auth.js", () => ({
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  getMiniMaxAuthDiagnostics: mocks.getMiniMaxAuthDiagnostics,
  resolveMiniMaxChinaAuthCached: vi.fn(async () => ({ state: "none" })),
  getMiniMaxChinaAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);

type PluginHooks = {
  config?: (input: unknown) => Promise<void> | void;
  dispose?: () => Promise<void> | void;
  event?: (input: unknown) => Promise<void> | void;
  "command.execute.before"?: (input: {
    command: string;
    sessionID: string;
  }) => Promise<void> | void;
  tool?: {
    quota_status?: {
      execute(
        args: Record<string, never>,
        context: { sessionID: string; metadata(value: { title: string }): void },
      ): Promise<string>;
    };
  };
};

function configFor(formatStyle: "allWindows" | "singleWindow") {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["quota-providers"],
    quotaProviders: PHASE5_QUOTA_PROVIDERS.map((source) => ({ ...source })),
    formatStyle,
    minIntervalMs: 60_000,
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: false,
    showSessionTokens: true,
    sessionTokenScope: "tree",
    maintainerAnnouncements: {
      enabled: false,
      home: false,
    },
    telemetry: {
      enabled: true,
    },
    tuiCommandDisplay: "dialog",
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

function configForMiniMax() {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["minimax-coding-plan"],
    formatStyle: "allWindows",
    minIntervalMs: 60_000,
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: false,
    showSessionTokens: false,
    maintainerAnnouncements: {
      enabled: false,
      home: false,
    },
    telemetry: {
      enabled: false,
    },
    tuiCommandDisplay: "dialog",
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: false,
      formatStyle: "allWindows",
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle: "allWindows",
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

function assertTreeSessionTokenTotals(output: string): void {
  expect(output).toMatch(/1\.2K[^\n]*300[^\n]*45/u);
}

function assertFixtureContent(output: string): void {
  expect(output).toContain("64%");
  expect(output).toContain("$12.34");
  expect(output).toContain("80%");
  expect(output).toContain("adapter.mappings[2]");
  expect(output).toContain("HTTP 503");
  assertPhase5FixtureOrder(output);
  assertPhase5CanariesRedacted(output);
}

describe("v4 Phase 5 cross-surface release evidence", () => {
  let currentConfig = configFor("allWindows");
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    const { __resetQuotaTelemetryForTests } = await import("../src/lib/quota-telemetry.js");
    __resetQuotaTelemetryForTests();
    otel.callbacks.clear();
    otel.getMeter.mockClear();
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
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: {
        models: [
          {
            modelID: "tree-model",
            input: 1200,
            cachedInput: 300,
            totalInput: 1500,
            output: 45,
          },
        ],
        totalInput: 1200,
        totalCachedInput: 300,
        totalCombinedInput: 1500,
        totalOutput: 45,
      },
    });
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    mocks.resolveMiniMaxAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: MINIMAX_API_KEY,
      endpoint: "international",
    });
    mocks.getMiniMaxAuthDiagnostics.mockResolvedValue({
      state: "configured",
      source: "opencode.db",
      endpoint: "international",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });

    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([quotaProvidersProvider]);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (url === PHASE5_QUOTA_PROVIDERS[0].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.accountingKey}`);
        await new Promise((resolve) => setTimeout(resolve, 8));
        return phase5JsonResponse(PHASE5_ACCOUNTING_RESPONSE);
      }
      if (url === PHASE5_QUOTA_PROVIDERS[1].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.openRouterKey}`);
        return phase5JsonResponse(PHASE5_OPENROUTER_RESPONSE);
      }
      if (url === PHASE5_QUOTA_PROVIDERS[2].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.failingKey}`);
        await new Promise((resolve) => setTimeout(resolve, 3));
        return new Response(PHASE5_SECRET_CANARIES.failureBody, {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === MINIMAX_QUOTA_URL) {
        expect(authorization).toBe(`Bearer ${MINIMAX_API_KEY}`);
        return phase5JsonResponse({
          model_remains: [
            {
              model_name: "MiniMax-M*",
              current_interval_total_count: 100,
              current_interval_usage_count: 35,
              remains_time: 3_600_000,
              current_weekly_total_count: 200,
              current_weekly_usage_count: 160,
              weekly_remains_time: 86_400_000,
            },
          ],
          base_resp: { status_code: 0, status_msg: "success" },
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
    const { __resetQuotaTelemetryForTests } = await import("../src/lib/quota-telemetry.js");
    __resetQuotaTelemetryForTests();
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
    expect(serverOutput).toMatch(/^Quota \(\/quota\)/);
    expect(serverOutput).not.toContain("```");
    expect(serverOutput).not.toMatch(/^#{1,6} /mu);
    expect(serverOutput).toMatch(/→ \[Team Accounting\]\n {2}Month quota/u);
    const serverBars = serverOutput.match(/[█░]+/gu) ?? [];
    expect(serverBars.length).toBeGreaterThan(0);
    expect(serverBars.every((bar) => Array.from(bar).length === 10)).toBe(true);
    expect(serverOutput).toMatch(/Month quota\s+[█░]{10}\s+64% left \| 64\/100 \| reset /);
    expect(serverOutput).toMatch(/Balance\s+\$12\.34/);
    assertFixtureContent(serverOutput);
    assertTreeSessionTokenTotals(serverOutput);
    expect(serverOutput).toContain("tree-model");

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "phase5-session" },
      },
    });
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    const toastOutput = getToastMessage(client);
    assertFixtureContent(toastOutput);
    assertTreeSessionTokenTotals(toastOutput);
    expect(toastOutput).toContain("tree-model");

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

    const statusMetadata = vi.fn();
    expect(hooks.tool?.quota_status).toBeDefined();
    await hooks.tool?.quota_status?.execute(
      {},
      {
        sessionID: "phase5-session",
        metadata: statusMetadata,
      },
    );
    expect(statusMetadata).toHaveBeenCalledWith({ title: "Quota Status" });
    const statusOutput = getPromptText(client, 1);
    expect(statusOutput).toMatch(/^# Quota Status .*\(\/quota_status\)/u);
    expect(statusOutput).toContain("provider_team-accounting:");
    expect(statusOutput).toContain("provider_openrouter-primary:");
    expect(statusOutput).toContain("provider_failing-accounting:");
    expect(statusOutput).toContain("outcome=success");
    expect(statusOutput).toContain("outcome=http_error");
    assertPhase5CanariesRedacted(statusOutput);
    for (const source of PHASE5_QUOTA_PROVIDERS) {
      expect(statusOutput).not.toContain(source.url);
    }

    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    const { resolveQuotaRuntimeContext } = await import("../src/lib/quota-runtime-context.js");
    const runtime = await resolveQuotaRuntimeContext({
      client: client as never,
      roots: { workspaceRoot: process.cwd() },
      config: currentConfig,
      providers: [quotaProvidersProvider],
      configureTelemetry: false,
    });
    const { buildQuotaExport, createExportProviderContext } = await import(
      "../src/lib/quota-export.js"
    );
    const exportContext = createExportProviderContext(runtime);
    const fetchCallsBeforeExport = vi.mocked(globalThis.fetch).mock.calls.length;
    const exportData = await buildQuotaExport({
      providers: [quotaProvidersProvider],
      ctx: exportContext,
      ttlMs: currentConfig.minIntervalMs,
      fromCache: true,
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(fetchCallsBeforeExport);
    expect(exportData.version).toBe(2);
    const exportedProvider = exportData.providers["quota-providers"];
    expect(exportedProvider?.status).toBe("partial");
    if (!exportedProvider || !("entries" in exportedProvider)) {
      throw new Error("Expected cached Phase 5 quota-provider export entries");
    }
    expect(exportedProvider.sources).toEqual([
      { id: "team-accounting", providerId: "team-gateway", status: "ok", entryCount: 2 },
      { id: "openrouter-primary", providerId: "openrouter", status: "ok", entryCount: 1 },
      {
        id: "failing-accounting",
        providerId: "failing-gateway",
        status: "error",
        entryCount: 0,
      },
    ]);
    expect(
      exportedProvider.entries.map((entry) =>
        entry.renderType === "percent" ? entry.percentRemaining : entry.value,
      ),
    ).toEqual([64, "$12.34", 80]);
    const exportOutput = JSON.stringify(exportData);
    assertPhase5CanariesRedacted(exportOutput);
    for (const source of PHASE5_QUOTA_PROVIDERS) {
      expect(exportOutput).not.toContain(source.url);
    }
    expect(exportOutput).not.toMatch(/telemetryToken|opencode\.quota\./u);

    const { classifyQuotaWindowText } = await import("../src/lib/quota-entry-display.js");
    const expectedConsumed = new Map<string, number>();
    for (const entry of exportedProvider.entries) {
      if (entry.renderType !== "percent" || !Number.isFinite(entry.percentRemaining)) continue;
      const attributes = {
        "quota.provider": "custom",
        "quota.window": classifyQuotaWindowText(entry.window ?? "") ?? "unknown",
        "quota.result_type": entry.resultType,
      };
      const key = JSON.stringify(attributes);
      const consumed = Math.min(1, Math.max(0, (100 - entry.percentRemaining) / 100));
      expectedConsumed.set(key, Math.max(expectedConsumed.get(key) ?? 0, consumed));
    }

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
    assertTreeSessionTokenTotals(allWindowsSidebar);
    expect(allWindowsSidebar).toContain("tree-model");
    const sessionPromptCompact =
      allWindows.compact.status === "ready" ? allWindows.compact.text : "";
    expect(sessionPromptCompact).toContain("64%");
    expect(sessionPromptCompact).toContain("$12.34");
    expect(sessionPromptCompact).toContain("80%");
    expect(sessionPromptCompact).toContain("issue");
    expect(sessionPromptCompact).toContain("tok 1.2K (300) in / 45 out");
    assertTreeSessionTokenTotals(sessionPromptCompact);
    assertPhase5CanariesRedacted(sessionPromptCompact);

    const homeBottom = await loadTuiHomeBottomStatus({ api: tuiApi });
    expect(homeBottom.status).toBe("ready");
    const homeCompact = homeBottom.compact.status === "ready" ? homeBottom.compact.text : "";
    expect(homeCompact).toBe(sessionPromptCompact.replace(/ \| tok [^|]+(?= \|)/u, ""));
    expect(homeCompact).not.toContain("tok ");
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
    assertTreeSessionTokenTotals(singleWindowSidebar);

    expect(mocks.fetchSessionTokensForDisplay).toHaveBeenCalledWith({
      enabled: true,
      sessionID: "phase5-session",
      scope: "tree",
    });

    const allOutput = JSON.stringify({
      serverOutput,
      toastOutput,
      allWindows,
      homeBottom,
      singleWindow,
    });
    assertPhase5CanariesRedacted(allOutput);
    for (const source of PHASE5_QUOTA_PROVIDERS) {
      expect(allOutput).not.toContain(source.url);
    }

    const { __flushQuotaTelemetryInitializationForTests } = await import(
      "../src/lib/quota-telemetry.js"
    );
    await __flushQuotaTelemetryInitializationForTests();
    const fetchCallsBeforeMetrics = vi.mocked(globalThis.fetch).mock.calls.length;
    const providerDiscoveryCallsBeforeMetrics = client.config.providers.mock.calls.length;
    const metricObservedAt = Date.now();
    const observations: Array<{
      metric: string;
      value: number;
      attributes?: Record<string, unknown>;
    }> = [];
    for (const [metric, callback] of otel.callbacks) {
      callback({
        observe: (value, attributes) => {
          observations.push({ metric, value, attributes });
        },
      });
    }
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(fetchCallsBeforeMetrics);
    expect(client.config.providers).toHaveBeenCalledTimes(providerDiscoveryCallsBeforeMetrics);
    expect(otel.getMeter).toHaveBeenCalledOnce();
    expect(new Set(observations.map(({ metric }) => metric))).toEqual(
      new Set(["opencode.quota.consumed", "opencode.quota.cache.age"]),
    );
    const actualConsumed = new Map(
      observations
        .filter(({ metric }) => metric === "opencode.quota.consumed")
        .map(({ attributes, value }) => [JSON.stringify(attributes), value]),
    );
    expect(actualConsumed).toEqual(expectedConsumed);
    expect(
      observations
        .filter(({ metric }) => metric === "opencode.quota.consumed")
        .every(
          ({ attributes }) =>
            attributes?.["quota.provider"] === "custom" &&
            JSON.stringify(Object.keys(attributes).sort()) ===
              JSON.stringify(["quota.provider", "quota.result_type", "quota.window"]),
        ),
    ).toBe(true);
    const cacheAgeObservations = observations.filter(
      ({ metric }) => metric === "opencode.quota.cache.age",
    );
    expect(
      cacheAgeObservations.every(
        ({ attributes }) =>
          JSON.stringify(attributes) === JSON.stringify({ "quota.provider": "custom" }),
      ),
    ).toBe(true);
    expect(cacheAgeObservations).toHaveLength(1);
    const oldestFetchedAt = Math.min(
      ...Object.values(exportData.providers)
        .filter((provider) => "fetchedAt" in provider)
        .map((provider) => provider.fetchedAt),
    );
    expect(
      Math.abs(cacheAgeObservations[0].value - (metricObservedAt / 1000 - oldestFetchedAt)),
    ).toBeLessThanOrEqual(1);
    const telemetryOutput = JSON.stringify(observations);
    assertPhase5CanariesRedacted(telemetryOutput);
    for (const source of PHASE5_QUOTA_PROVIDERS) {
      expect(telemetryOutput).not.toContain(source.id);
      expect(telemetryOutput).not.toContain(source.label);
      expect(telemetryOutput).not.toContain(source.url);
    }
    expect(allOutput).not.toMatch(/telemetryToken|opencode\.quota\./);
    await hooks.dispose?.();
  });

  it("renders non-empty MiniMax five-hour and weekly quota on all four surfaces", async () => {
    currentConfig = configForMiniMax();
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    const { minimaxCodingPlanProvider } = await import("../src/providers/minimax-coding-plan.js");
    mocks.getProviders.mockReturnValue([minimaxCodingPlanProvider]);

    const client = createClient();
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "minimax-coding-plan" }] },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = (await QuotaToastPlugin({ client } as never)) as PluginHooks;

    await expectHandled(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "minimax-session",
      }),
    );
    const serverOutput = getPromptText(client);
    expect(serverOutput).toContain("MiniMax Coding Plan");
    expect(serverOutput).toContain("5h quota");
    expect(serverOutput).toContain("Week quota");
    expect(serverOutput).toContain("35%");
    expect(serverOutput).toContain("80%");
    expect(serverOutput).not.toContain("Invalid normalized provider result");

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "minimax-session" },
      },
    });
    const toastOutput = getToastMessage(client);
    expect(toastOutput).toContain("MiniMax Coding Plan");
    expect(toastOutput).toContain("Five-hour");
    expect(toastOutput).toContain("Weekly");
    expect(toastOutput).toContain("35%");
    expect(toastOutput).toContain("80%");

    const tuiApi = {
      state: {
        provider: [{ id: "minimax-coding-plan" }],
        path: { worktree: process.cwd(), directory: process.cwd() },
        session: { messages: () => [] },
      },
      client,
    } as never;
    const { loadTuiSessionQuotaSurfaces } = await import("../src/lib/tui-runtime.js");
    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: tuiApi,
      sessionID: "minimax-session",
    });

    expect(surfaces.sidebar.status).toBe("ready");
    const sidebarOutput = [
      ...surfaces.sidebar.lines,
      ...(surfaces.sidebar.linesExpanded ?? []),
    ].join("\n");
    expect(sidebarOutput).toContain("MiniMax Coding Plan");
    expect(sidebarOutput).toContain("Five-hour");
    expect(sidebarOutput).toContain("Weekly");
    expect(sidebarOutput).toContain("35%");
    expect(sidebarOutput).toContain("80%");

    expect(surfaces.compact.status).toBe("ready");
    const compactOutput = surfaces.compact.status === "ready" ? surfaces.compact.text : "";
    expect(compactOutput).toContain("35%");
    expect(compactOutput).toContain("80%");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    await hooks.dispose?.();
  });
});
