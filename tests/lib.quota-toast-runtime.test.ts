import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  createAlibabaAuthModuleMock,
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTuiConfigInspection,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  getToastMessage,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-toast-runtime-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const ANNOUNCEMENT_TOAST_MESSAGE =
  "Notice: Maintainer announcement available. Run /quota_announcements.";

const TEST_ANNOUNCEMENT = vi.hoisted(() => ({
  id: "copilot-credits",
  message: "Copilot billing is changing.",
  url: "https://github.blog/example",
  providerIds: ["copilot"],
}));

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
  observeQuotaResetNotifications: vi.fn(),
  formatQuotaResetNotification: vi.fn(),
  getMaintainerAnnouncementsSummary: vi.fn(),
  inspectTuiConfig: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);
vi.mock("../src/lib/quota-reset-notifications.js", () => ({
  observeQuotaResetNotifications: mocks.observeQuotaResetNotifications,
  formatQuotaResetNotification: mocks.formatQuotaResetNotification,
}));
vi.mock("../src/lib/tui-config-diagnostics.js", () => ({
  inspectTuiConfig: mocks.inspectTuiConfig,
}));
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  formatMaintainerAnnouncementHomeCountLine: (activeCount: number) =>
    activeCount > 0 ? ANNOUNCEMENT_TOAST_MESSAGE : "",
  getMaintainerAnnouncementsSummary: mocks.getMaintainerAnnouncementsSummary,
}));

function makeAnnouncementSummary(overrides: Record<string, unknown> = {}) {
  return {
    source: "bundled_only",
    network: false,
    bundledCount: 1,
    activeCount: 1,
    futureCount: 0,
    expiredCount: 0,
    activeAnnouncements: [
      {
        announcement: TEST_ANNOUNCEMENT,
        active: true,
        reasons: [],
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

function makeToastConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  return makeQuotaToastTestConfig({
    enabled: true,
    enableToast: true,
    enabledProviders: ["openai"],
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: true,
    showSessionTokens: false,
    minIntervalMs: 60_000,
    maintainerAnnouncements: { enabled: false, home: false },
    ...overrides,
  });
}

function makeProviderResult(name: string, percentRemaining: number) {
  return {
    attempted: true,
    entries: [{ accounting: TEST_ACCOUNTING, name, percentRemaining }],
    errors: [],
  };
}

async function createRuntime(
  client: ReturnType<typeof createClient>,
  overrides: {
    isSubagentSession?: (sessionID: string) => Promise<boolean>;
    reconcileDetectedProviders?: (providerIds: readonly string[]) => Promise<void>;
    setSessionTokenError?: (error: unknown) => void;
    showToast?: (body: Record<string, unknown>) => Promise<unknown>;
    log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
    roots?: () => {
      workspaceRoot: string;
      configRoot: string;
      fallbackDirectory: string;
    };
  } = {},
) {
  const { createQuotaToastRuntime } = await import("../src/lib/quota-toast-runtime.js");
  const reconcileDetectedProviders =
    overrides.reconcileDetectedProviders ?? vi.fn().mockResolvedValue(undefined);
  const setSessionTokenError = overrides.setSessionTokenError ?? vi.fn();
  const log =
    overrides.log ??
    (async (message: string, extra?: Record<string, unknown>) => {
      await client.app.log({ body: { message, extra } });
    });
  const showToast =
    overrides.showToast ??
    (async (body: Record<string, unknown>) => client.tui.showToast({ body }));

  const runtime = createQuotaToastRuntime({
    client: client as never,
    roots:
      overrides.roots ??
      (() => ({
        workspaceRoot: process.cwd(),
        configRoot: process.cwd(),
        fallbackDirectory: process.cwd(),
      })),
    resolveSessionMeta: async (sessionID) => {
      const response = await client.session.get({ path: { id: sessionID } });
      return {
        modelID: response.data?.model?.id,
        providerID: response.data?.model?.providerID,
      };
    },
    isSubagentSession:
      overrides.isSubagentSession ??
      (async (sessionID) => {
        const response = await client.session.get({ path: { id: sessionID } });
        return Boolean(response.data?.parentID);
      }),
    reconcileDetectedProviders,
    setSessionTokenError: setSessionTokenError as never,
    showToast: showToast as never,
    log,
    onInitialized: vi.fn(),
  });

  return { runtime, reconcileDetectedProviders, setSessionTokenError };
}

async function flushFireAndForgetWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("quota toast runtime state machine", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: makeToastConfig(),
      resetPluginState: true,
    });
    mocks.observeQuotaResetNotifications.mockResolvedValue([]);
    mocks.formatQuotaResetNotification.mockReturnValue(null);
    mocks.getMaintainerAnnouncementsSummary.mockReturnValue(makeAnnouncementSummary());
    mocks.inspectTuiConfig.mockResolvedValue(createPluginTuiConfigInspection(TEST_RUNTIME_ROOT));
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("loads configuration before applying per-trigger gates", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ showOnIdle: false, showOnCompact: true, showOnQuestion: false }),
    );
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("OpenAI", 72)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-gates", trigger: "session.idle" });
    expect(mocks.loadConfig).toHaveBeenCalledOnce();
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "init" }),
    );

    await runtime.handleTrigger({ sessionID: "session-gates", trigger: "session.compacted" });
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(client.tui.showToast).toHaveBeenCalledOnce();
  });

  it("owns current-model diagnostics and toast percentage formatting", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ enabledProviders: ["openai"], onlyCurrentModel: true }),
    );
    const skippedProvider = {
      id: "openai",
      matchesCurrentModel: vi.fn().mockReturnValue(false),
      isAvailable: vi.fn(),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([skippedProvider]);
    const skippedClient = createClient({
      modelID: "claude-3.7-sonnet",
      providerID: "anthropic",
    });
    const { runtime: skippedRuntime } = await createRuntime(skippedClient);
    await skippedRuntime.handleTrigger({
      sessionID: "session-model-filter",
      trigger: "session.idle",
    });
    expect(skippedProvider.fetch).not.toHaveBeenCalled();
    expect(getToastMessage(skippedClient)).toContain(
      "OpenAI: Skipped (current model: claude-3.7-sonnet)",
    );

    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ enabledProviders: ["copilot"], percentDisplayMode: "used" }),
    );
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot", 81)),
      },
    ]);
    const formattedClient = createClient();
    const { runtime: formattedRuntime } = await createRuntime(formattedClient);
    await formattedRuntime.handleTrigger({
      sessionID: "session-percent-display",
      trigger: "session.idle",
    });
    expect(getToastMessage(formattedClient)).toContain("19% used");
    expect(getToastMessage(formattedClient)).not.toContain("81% left");
  });

  it("retries provider failures with provider-cache bypass and the complete saturated backoff", async () => {
    vi.useFakeTimers();
    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig());
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockRejectedValue(new Error("warming up")),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-backoff", trigger: "session.idle" });
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(getToastMessage(client)).toContain("OpenAI: Failed to read quota data");

    for (const delay of [3_000, 15_000, 60_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      const callsBeforeBoundary = provider.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(provider.fetch).toHaveBeenCalledTimes(callsBeforeBoundary + 1);
    }

    const scheduledDelays = client.app.log.mock.calls
      .filter((call) => call[0]?.body?.message === "Deferred quota refresh scheduled")
      .map((call) => call[0]?.body?.extra?.delayMs);
    expect(scheduledDelays).toEqual([3_000, 15_000, 60_000, 300_000, 300_000]);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it("retries provider-returned transient errors", async () => {
    vi.useFakeTimers();
    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig());
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [],
          errors: [
            { label: "OpenAI", message: "API error 503", retryable: true },
            { label: "Other", message: "API error 403" },
          ],
        })
        .mockResolvedValueOnce(makeProviderResult("Recovered", 68)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-transient-result", trigger: "session.idle" });
    expect(provider.fetch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 1)).toContain("Recovered");
  });

  it("retries suppressed provider failures and availability failures", async () => {
    vi.useFakeTimers();
    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig({ showOnBothFail: false }));
    const provider = {
      id: "openai",
      isAvailable: vi
        .fn()
        .mockRejectedValueOnce(new Error("auth unavailable"))
        .mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce(makeProviderResult("Recovered", 63)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-availability", trigger: "session.idle" });
    expect(provider.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(client.tui.showToast).toHaveBeenCalledOnce();
    expect(getToastMessage(client)).toContain("Unavailable (not detected)");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 1)).toContain("63% left");
  });

  it("preserves config_load_failed and no_reportable_data retry reasons", async () => {
    vi.useFakeTimers();
    mocks.loadConfig.mockRejectedValue(new Error("config unavailable"));
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({ attempted: false, entries: [], errors: [] }),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-reasons", trigger: "session.idle" });
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(client.app.log).toHaveBeenCalledWith({
      body: expect.objectContaining({
        message: "Deferred quota refresh scheduled",
        extra: expect.objectContaining({ reason: "config_load_failed", delayMs: 3_000 }),
      }),
    });

    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockResolvedValue(makeToastConfig({ enabledProviders: "auto" }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(client.app.log).toHaveBeenCalledWith({
      body: expect.objectContaining({
        message: "Deferred quota refresh scheduled",
        extra: expect.objectContaining({ reason: "no_reportable_data", delayMs: 15_000 }),
      }),
    });
  });

  it("consumes a pending retry immediately and clears it when configuration becomes disabled", async () => {
    vi.useFakeTimers();
    const loadedConfig = makeToastConfig();
    mocks.loadConfig.mockResolvedValueOnce(loadedConfig);
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(makeProviderResult("Immediate", 66))
        .mockRejectedValue(new Error("replacement failure")),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-immediate", trigger: "session.idle" });
    await runtime.handleTrigger({ sessionID: "session-immediate", trigger: "session.compacted" });
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 1)).toContain("Immediate");

    await runtime.handleTrigger({ sessionID: "session-disabled", trigger: "session.idle" });
    expect(provider.fetch).toHaveBeenCalledTimes(3);
    loadedConfig.enabled = false;
    await runtime.handleTrigger({ sessionID: "session-disabled", trigger: "session.compacted" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(provider.fetch).toHaveBeenCalledTimes(3);
  });

  it("suppresses duplicate lifecycle work while a deferred retry is in flight", async () => {
    vi.useFakeTimers();
    let resolveRetry: ((value: unknown) => void) | undefined;
    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig());
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("warming up"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRetry = resolve;
            }),
        ),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-in-flight", trigger: "session.idle" });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(2));
    await runtime.handleTrigger({ sessionID: "session-in-flight", trigger: "session.compacted" });
    expect(provider.fetch).toHaveBeenCalledTimes(2);

    resolveRetry?.(makeProviderResult("Recovered", 67));
    await vi.waitFor(() => expect(client.tui.showToast).toHaveBeenCalledTimes(2));
  });

  it("does not let an older completion clear a replacement retry state's in-flight guard", async () => {
    vi.useFakeTimers();
    let resolveOldToast: (() => void) | undefined;
    let resolveNewRetry: ((value: unknown) => void) | undefined;
    const loadedConfig = makeToastConfig();
    mocks.loadConfig.mockResolvedValueOnce(loadedConfig);
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("initial failure"))
        .mockResolvedValueOnce(makeProviderResult("Old retry", 70))
        .mockRejectedValueOnce(new Error("replacement failure"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveNewRetry = resolve;
            }),
        ),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    client.tui.showToast.mockImplementation(({ body }: any) => {
      if (body.message.includes("Old retry")) {
        return new Promise((resolve) => {
          resolveOldToast = () => resolve({});
        });
      }
      return Promise.resolve({});
    });
    const { runtime } = await createRuntime(client);
    const sessionID = "session-race-guard";

    await runtime.handleTrigger({ sessionID, trigger: "session.idle" });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(resolveOldToast).toBeTypeOf("function"));

    loadedConfig.enabled = false;
    await runtime.handleTrigger({ sessionID, trigger: "session.compacted" });
    loadedConfig.enabled = true;
    await runtime.handleTrigger({ sessionID, trigger: "session.idle" });
    expect(provider.fetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(4));
    resolveOldToast?.();
    await Promise.resolve();

    await runtime.handleTrigger({ sessionID, trigger: "session.compacted" });
    expect(provider.fetch).toHaveBeenCalledTimes(4);

    resolveNewRetry?.(makeProviderResult("New retry", 75));
    await vi.waitFor(() => expect(getToastMessage(client, 3)).toContain("New retry"));
  });

  it("clears a consumed pending retry when the session becomes a subagent", async () => {
    vi.useFakeTimers();
    let subagent = false;
    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig());
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockRejectedValue(new Error("temporary failure")),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client, {
      isSubagentSession: async () => subagent,
    });

    await runtime.handleTrigger({ sessionID: "session-subagent", trigger: "session.idle" });
    subagent = true;
    await runtime.handleTrigger({ sessionID: "session-subagent", trigger: "session.compacted" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(provider.fetch).toHaveBeenCalledOnce();
  });

  it("keeps retry state local to each runtime instance", async () => {
    vi.useFakeTimers();
    const configA = makeToastConfig();
    mocks.loadConfig.mockResolvedValueOnce(configA);
    const providerA = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("instance A warming up"))
        .mockResolvedValueOnce(makeProviderResult("Instance A", 64)),
    };
    mocks.getProviders.mockReturnValue([providerA]);
    const clientA = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime: runtimeA } = await createRuntime(clientA);
    await runtimeA.handleTrigger({ sessionID: "session-shared", trigger: "session.idle" });

    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig());
    const providerB = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Instance B", 82)),
    };
    mocks.getProviders.mockReturnValue([providerB]);
    const clientB = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime: runtimeB } = await createRuntime(clientB);
    await runtimeB.handleTrigger({ sessionID: "session-other", trigger: "session.idle" });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(providerA.fetch).toHaveBeenCalledTimes(2);
    expect(providerB.fetch).toHaveBeenCalledOnce();
    expect(getToastMessage(clientA, 1)).toContain("Instance A");
    expect(getToastMessage(clientB)).toContain("Instance B");
  });

  it("bypasses rendered and provider caches for configured live-local providers", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enabledProviders: ["quota-providers"],
        quotaProviders: [
          {
            id: "local-project",
            providerId: "local-project",
            label: "Local project",
            mode: "local-estimate",
            windows: [{ id: "day", label: "Day", type: "utc-day", requestLimit: 10 }],
          },
        ],
      }),
    );
    const provider = {
      id: "quota-providers",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValueOnce(makeProviderResult("Local project", 90))
        .mockResolvedValueOnce(makeProviderResult("Local project", 80)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "local-model", providerID: "local-project" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-local", trigger: "session.idle" });
    await runtime.handleTrigger({ sessionID: "session-local", trigger: "session.idle" });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 0)).toContain("90% left");
    expect(getToastMessage(client, 1)).toContain("80% left");
  });

  it("caches rendered quota rows but not error-only results", async () => {
    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig({ enabledProviders: ["deepseek"] }));
    const valueProvider = {
      id: "deepseek",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            kind: "value",
            accounting: TEST_ACCOUNTING,
            name: "DeepSeek Balance",
            value: "$12.34",
          },
        ],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([valueProvider]);
    const valueClient = createClient({ modelID: "deepseek-chat", providerID: "deepseek" });
    const { runtime: valueRuntime } = await createRuntime(valueClient);
    await valueRuntime.handleTrigger({ sessionID: "session-value", trigger: "session.idle" });
    await valueRuntime.handleTrigger({ sessionID: "session-value", trigger: "session.idle" });
    expect(valueProvider.fetch).toHaveBeenCalledOnce();
    expect(getToastMessage(valueClient, 1)).toContain("$12.34");

    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ enabledProviders: ["openrouter"], showOnBothFail: true }),
    );
    const errorProvider = {
      id: "openrouter",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [],
        errors: [{ label: "DeepSeek", message: "Billing unavailable" }],
      }),
    };
    mocks.getProviders.mockReturnValue([errorProvider]);
    const errorClient = createClient({ modelID: "openrouter/auto", providerID: "openrouter" });
    const { runtime: errorRuntime } = await createRuntime(errorClient);
    await errorRuntime.handleTrigger({ sessionID: "session-errors", trigger: "session.idle" });
    await errorRuntime.handleTrigger({ sessionID: "session-errors", trigger: "session.idle" });
    expect(errorProvider.fetch).toHaveBeenCalledTimes(2);
    expect(getToastMessage(errorClient, 1)).toContain("Billing unavailable");
  });

  it("keys rendered throttling by session render context", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ enabledProviders: ["openai"], onlyCurrentModel: true }),
    );
    const provider = {
      id: "openai",
      matchesCurrentModel: vi.fn().mockReturnValue(true),
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockImplementation(async (context: any) =>
          makeProviderResult(context.config.currentModel ?? "unknown", 70),
        ),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient();
    let currentModel = "openai/gpt-4";
    client.session.get.mockImplementation(async () => ({
      data: { model: { id: currentModel, providerID: "openai" } },
    }));
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-model-key", trigger: "session.idle" });
    currentModel = "openai/gpt-5";
    await runtime.handleTrigger({ sessionID: "session-model-key", trigger: "session.idle" });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 0)).toContain("openai/gpt-4");
    expect(getToastMessage(client, 1)).toContain("openai/gpt-5");
    expect(getToastMessage(client, 1)).not.toContain("openai/gpt-4");
  });

  it("keeps collection and reconciliation ahead of the enableToast false late gate", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enableToast: false,
        enabledProviders: "auto",
        resetNotifications: { enabled: true, windows: ["weekly"] },
      }),
    );
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("OpenAI", 71)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const reconcileDetectedProviders = vi.fn().mockResolvedValue(undefined);
    const { runtime } = await createRuntime(client, { reconcileDetectedProviders });

    await runtime.handleTrigger({ sessionID: "session-late-gate", trigger: "session.idle" });

    expect(mocks.loadConfig).toHaveBeenCalledOnce();
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(reconcileDetectedProviders).toHaveBeenCalledWith(["openai"]);
    expect(mocks.observeQuotaResetNotifications).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("shares only rendered messages across runtimes without transferring metadata or reset text", async () => {
    const sharedConfig = makeToastConfig({
      enabledProviders: "auto",
      showSessionTokens: true,
      minIntervalMs: 60_000,
      resetNotifications: { enabled: true, windows: ["weekly"] },
      maintainerAnnouncements: { enabled: true, home: true },
    });
    mocks.loadConfig.mockResolvedValueOnce(sharedConfig);
    const tokenErrorA = { sessionID: "session-shared-cache", error: "instance A token error" };
    mocks.fetchSessionTokensForDisplay.mockResolvedValueOnce({
      sessionTokens: undefined,
      error: tokenErrorA,
    });
    mocks.observeQuotaResetNotifications.mockResolvedValueOnce([
      { providerId: "copilot", entryName: "Copilot", window: "weekly" },
    ]);
    mocks.formatQuotaResetNotification.mockReturnValueOnce("Copilot weekly quota reset");
    mocks.getMaintainerAnnouncementsSummary.mockImplementation((params: any) =>
      params.enabledProviders.includes("copilot")
        ? makeAnnouncementSummary()
        : makeAnnouncementSummary({ activeCount: 0, futureCount: 1, activeAnnouncements: [] }),
    );
    const providerA = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot A", 81)),
    };
    mocks.getProviders.mockReturnValue([providerA]);
    const clientA = createClient();
    const reconcileA = vi.fn().mockResolvedValue(undefined);
    const setTokenErrorA = vi.fn();
    const { runtime: runtimeA } = await createRuntime(clientA, {
      reconcileDetectedProviders: reconcileA,
      setSessionTokenError: setTokenErrorA,
    });
    await runtimeA.handleTrigger({ sessionID: "session-shared-cache", trigger: "session.idle" });
    await flushFireAndForgetWork();

    expect(providerA.fetch).toHaveBeenCalledOnce();
    expect(reconcileA).toHaveBeenCalledWith(["copilot"]);
    expect(setTokenErrorA).toHaveBeenCalledWith(tokenErrorA);
    expect(clientA.tui.showToast).toHaveBeenCalledTimes(3);
    expect(getToastMessage(clientA, 0)).toContain("Copilot A");
    expect(getToastMessage(clientA, 1)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(clientA.tui.showToast.mock.calls[2]?.[0]?.body?.variant).toBe("success");

    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig({ ...sharedConfig }));
    const providerB = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot B", 74)),
    };
    mocks.getProviders.mockReturnValue([providerB]);
    const clientB = createClient();
    const reconcileB = vi.fn().mockResolvedValue(undefined);
    const setTokenErrorB = vi.fn();
    const { runtime: runtimeB } = await createRuntime(clientB, {
      reconcileDetectedProviders: reconcileB,
      setSessionTokenError: setTokenErrorB,
    });
    await runtimeB.handleTrigger({ sessionID: "session-shared-cache", trigger: "session.idle" });
    await flushFireAndForgetWork();

    expect(providerB.fetch).not.toHaveBeenCalled();
    expect(reconcileB).not.toHaveBeenCalled();
    expect(setTokenErrorB).not.toHaveBeenCalled();
    expect(getToastMessage(clientB)).toContain("Copilot A");
    expect(clientB.tui.showToast).toHaveBeenCalledOnce();
    expect(mocks.getMaintainerAnnouncementsSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabledProviders: [] }),
    );
    expect(mocks.observeQuotaResetNotifications).toHaveBeenCalledOnce();
  });

  it("does not reuse a rendered message across different provider configuration", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enabledProviders: ["quota-providers"],
        quotaProviders: [
          { id: "first", mode: "remote-api", url: "https://first.example", format: "quota-v1" },
        ],
      }),
    );
    const providerA = {
      id: "quota-providers",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("First config", 81)),
    };
    mocks.getProviders.mockReturnValue([providerA]);
    const clientA = createClient();
    const { runtime: runtimeA } = await createRuntime(clientA);
    await runtimeA.handleTrigger({ sessionID: "session-config-cache", trigger: "session.idle" });

    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enabledProviders: ["quota-providers"],
        quotaProviders: [
          { id: "second", mode: "remote-api", url: "https://second.example", format: "quota-v1" },
        ],
      }),
    );
    const providerB = {
      id: "quota-providers",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Second config", 74)),
    };
    mocks.getProviders.mockReturnValue([providerB]);
    const clientB = createClient();
    const { runtime: runtimeB } = await createRuntime(clientB);
    await runtimeB.handleTrigger({ sessionID: "session-config-cache", trigger: "session.idle" });

    expect(providerA.fetch).toHaveBeenCalledOnce();
    expect(providerB.fetch).toHaveBeenCalledOnce();
    expect(getToastMessage(clientB)).toContain("Second config");
    expect(getToastMessage(clientB)).not.toContain("First config");
  });

  it("separates rendered-message cache entries for each display option", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: {
              ...TEST_ACCOUNTING,
              observedAtIso: "2026-01-15T10:00:00.000Z",
            },
            name: "OpenAI Weekly",
            percentRemaining: 81,
            resetTimeIso: "2026-01-17T15:14:00.000Z",
            fixedWindow: {
              kind: "fixed_window",
              startedAtIso: "2026-01-15T09:00:00.000Z",
              observedAtIso: "2026-01-15T10:00:00.000Z",
              endsAtIso: "2026-01-17T15:14:00.000Z",
              fullReset: true,
            },
          },
        ],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig());
    const defaultClient = createClient();
    const { runtime: defaultRuntime } = await createRuntime(defaultClient);
    await defaultRuntime.handleTrigger({
      sessionID: "session-display-cache",
      trigger: "session.idle",
    });
    expect(getToastMessage(defaultClient)).toContain("81% left");
    expect(getToastMessage(defaultClient)).toContain("2d 5h 14m");

    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig({ resetTimeSpaced: false }));
    const denseClient = createClient();
    const { runtime: denseRuntime } = await createRuntime(denseClient);
    await denseRuntime.handleTrigger({
      sessionID: "session-display-cache",
      trigger: "session.idle",
    });
    expect(getToastMessage(denseClient)).toContain("81% left");
    expect(getToastMessage(denseClient)).toContain("2d5h14m");

    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ percentDisplayMode: "used", percentLabelStyle: "bare" }),
    );
    const bareClient = createClient();
    const { runtime: bareRuntime } = await createRuntime(bareClient);
    await bareRuntime.handleTrigger({
      sessionID: "session-display-cache",
      trigger: "session.idle",
    });
    expect(getToastMessage(bareClient)).toContain("19%");
    expect(getToastMessage(bareClient)).not.toContain("19% used");
    expect(bareClient.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({ title: "Quota [Used]" }),
    });

    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig({ quotaProjection: "runway" }));
    const runwayClient = createClient();
    const { runtime: runwayRuntime } = await createRuntime(runwayClient);
    await runwayRuntime.handleTrigger({
      sessionID: "session-display-cache",
      trigger: "session.idle",
    });
    expect(getToastMessage(runwayClient)).toContain("Runs out");
    expect(getToastMessage(defaultClient)).not.toContain("Runs out");

    expect(provider.fetch).toHaveBeenCalledTimes(4);
  });

  it("emits reset text only from a fresh collection", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({ resetNotifications: { enabled: true, windows: ["weekly"] } }),
    );
    mocks.observeQuotaResetNotifications.mockResolvedValue([
      { providerId: "openai", entryName: "OpenAI", window: "weekly" },
    ]);
    mocks.formatQuotaResetNotification.mockReturnValue("OpenAI weekly quota reset");
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("OpenAI", 77)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-reset-cache", trigger: "session.idle" });
    await runtime.handleTrigger({ sessionID: "session-reset-cache", trigger: "session.idle" });

    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(mocks.observeQuotaResetNotifications).toHaveBeenCalledOnce();
    const successToasts = client.tui.showToast.mock.calls.filter(
      (call) => call[0]?.body?.variant === "success",
    );
    expect(successToasts).toHaveLength(1);
  });

  it("keeps announcement state runtime-local and one-shot", async () => {
    const config = makeToastConfig({
      enabledProviders: ["copilot"],
      maintainerAnnouncements: { enabled: true, home: true },
      minIntervalMs: 0,
    });
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot", 81)),
    };

    mocks.loadConfig.mockResolvedValueOnce(config);
    mocks.getProviders.mockReturnValue([provider]);
    const clientA = createClient();
    const { runtime: runtimeA } = await createRuntime(clientA);
    await runtimeA.handleTrigger({ sessionID: "session-a-1", trigger: "question" });
    await runtimeA.handleTrigger({ sessionID: "session-a-2", trigger: "question" });
    await flushFireAndForgetWork();
    expect(
      clientA.tui.showToast.mock.calls.filter(
        (call) => call[0]?.body?.message === ANNOUNCEMENT_TOAST_MESSAGE,
      ),
    ).toHaveLength(1);

    mocks.loadConfig.mockResolvedValueOnce(makeToastConfig({ ...config }));
    mocks.getProviders.mockReturnValue([provider]);
    const clientB = createClient();
    const { runtime: runtimeB } = await createRuntime(clientB);
    await runtimeB.handleTrigger({ sessionID: "session-b", trigger: "question" });
    await flushFireAndForgetWork();
    expect(
      clientB.tui.showToast.mock.calls.filter(
        (call) => call[0]?.body?.message === ANNOUNCEMENT_TOAST_MESSAGE,
      ),
    ).toHaveLength(1);
  });

  it("suppresses announcement fallback when TUI owns the surface", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enabledProviders: ["copilot"],
        maintainerAnnouncements: { enabled: true, home: true },
        minIntervalMs: 0,
      }),
    );
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot", 81)),
      },
    ]);
    mocks.inspectTuiConfig.mockResolvedValue(
      createPluginTuiConfigInspection(TEST_RUNTIME_ROOT, {
        configured: true,
        quotaPluginConfigured: true,
      }),
    );
    const client = createClient();
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-tui-1", trigger: "question" });
    await runtime.handleTrigger({ sessionID: "session-tui-2", trigger: "question" });
    await flushFireAndForgetWork();

    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(mocks.inspectTuiConfig).toHaveBeenCalledOnce();
  });

  it("keeps future announcements pending until a later visible toast", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enabledProviders: ["copilot"],
        maintainerAnnouncements: { enabled: true, home: true },
        minIntervalMs: 60_000,
      }),
    );
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot", 81)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    mocks.getMaintainerAnnouncementsSummary
      .mockReturnValueOnce(
        makeAnnouncementSummary({ activeCount: 0, futureCount: 1, activeAnnouncements: [] }),
      )
      .mockReturnValue(makeAnnouncementSummary());
    const client = createClient();
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-future", trigger: "question" });
    await flushFireAndForgetWork();
    await runtime.handleTrigger({ sessionID: "session-future", trigger: "question" });
    await flushFireAndForgetWork();

    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(client.tui.showToast).toHaveBeenCalledTimes(3);
    expect(getToastMessage(client, 2)).toBe(ANNOUNCEMENT_TOAST_MESSAGE);
    expect(mocks.getMaintainerAnnouncementsSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  it("retries announcement fallback after TUI detection or fallback display fails", async () => {
    const config = makeToastConfig({
      enabledProviders: ["copilot"],
      maintainerAnnouncements: { enabled: true, home: true },
      minIntervalMs: 0,
    });
    mocks.loadConfig.mockResolvedValueOnce(config);
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot", 81)),
    };
    mocks.getProviders.mockReturnValue([provider]);
    mocks.inspectTuiConfig.mockRejectedValueOnce(new Error("diagnostics failed"));
    const client = createClient();
    client.tui.showToast
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("fallback failed"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const { runtime } = await createRuntime(client);

    await runtime.handleTrigger({ sessionID: "session-failure-1", trigger: "question" });
    await flushFireAndForgetWork();
    await runtime.handleTrigger({ sessionID: "session-failure-2", trigger: "question" });
    await flushFireAndForgetWork();
    await runtime.handleTrigger({ sessionID: "session-failure-3", trigger: "question" });
    await flushFireAndForgetWork();

    expect(mocks.inspectTuiConfig).toHaveBeenCalledTimes(3);
    expect(
      client.tui.showToast.mock.calls.filter(
        (call) => call[0]?.body?.message === ANNOUNCEMENT_TOAST_MESSAGE,
      ),
    ).toHaveLength(2);
  });

  it("preserves exact primary, announcement-launch, primary-log, reset, and reset-log sequencing", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeToastConfig({
        enabledProviders: ["copilot"],
        resetNotifications: { enabled: true, windows: ["weekly"] },
        maintainerAnnouncements: { enabled: true, home: true },
      }),
    );
    mocks.observeQuotaResetNotifications.mockResolvedValue([
      { providerId: "copilot", entryName: "Copilot", window: "weekly" },
    ]);
    mocks.formatQuotaResetNotification.mockReturnValue("Copilot weekly quota reset");
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(makeProviderResult("Copilot", 81)),
    };
    mocks.getProviders.mockReturnValue([provider]);

    let resolvePrimary!: () => void;
    let resolvePrimaryLog!: () => void;
    let resolveReset!: () => void;
    let resolveAnnouncementDiagnostics!: () => void;
    const primary = new Promise<unknown>((resolve) => {
      resolvePrimary = () => resolve({});
    });
    const primaryLog = new Promise<void>((resolve) => {
      resolvePrimaryLog = resolve;
    });
    const reset = new Promise<unknown>((resolve) => {
      resolveReset = () => resolve({});
    });
    const announcementDiagnostics = new Promise<unknown>((resolve) => {
      resolveAnnouncementDiagnostics = () =>
        resolve(createPluginTuiConfigInspection(TEST_RUNTIME_ROOT));
    });
    mocks.inspectTuiConfig.mockReturnValueOnce(announcementDiagnostics);

    const client = createClient();
    const showToast = vi.fn(async (body: Record<string, unknown>) => {
      if (body.variant === "success") return reset;
      if (body.message === ANNOUNCEMENT_TOAST_MESSAGE) return {};
      return primary;
    });
    const log = vi.fn(async (message: string) => {
      if (message === "Displayed quota toast") await primaryLog;
    });
    const { runtime } = await createRuntime(client, { showToast, log });

    const trigger = runtime.handleTrigger({ sessionID: "session-order", trigger: "question" });
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(mocks.inspectTuiConfig).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith("Displayed quota toast", expect.anything());

    resolvePrimary();
    await vi.waitFor(() => {
      expect(mocks.inspectTuiConfig).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "Displayed quota toast",
        expect.objectContaining({ trigger: "question" }),
      );
    });
    expect(showToast).toHaveBeenCalledTimes(1);

    resolvePrimaryLog();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(2));
    expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "success" }));
    expect(log).not.toHaveBeenCalledWith("Displayed quota reset notification", expect.anything());

    resolveReset();
    await trigger;
    expect(log).toHaveBeenCalledWith(
      "Displayed quota reset notification",
      expect.objectContaining({ trigger: "question" }),
    );

    resolveAnnouncementDiagnostics();
    await flushFireAndForgetWork();
  });
});
