import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveRuntimeContextRoots } from "../src/lib/config-file-utils.js";
import { createLoadConfigMeta } from "../src/lib/config.js";
import type { QuotaProvider, QuotaProviderResult } from "../src/lib/entries.js";
import type { MaintainerAnnouncement } from "../src/lib/maintainer-announcements.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { loadTuiHomeBottomStatus, type TuiInitialRuntimeSeed } from "../src/lib/tui-runtime.js";
import { DEFAULT_CONFIG, type QuotaToastConfig } from "../src/lib/types.js";
import {
  formatProviderAvailabilityTimingReport,
  getProviderAvailabilityJitterOffsetMs,
  type ProviderAvailabilityTimingResult,
  type ProviderAvailabilityTimingSample,
  runProviderAvailabilityTimingSamples,
  TUI_PROVIDER_AVAILABILITY_HORIZON_MS,
} from "./helpers/tui-provider-availability-timing.js";

const ORDERED_PROVIDER_IDS = ["cursor", "synthetic", "alibaba-coding-plan"] as const;
const AVAILABLE_PROVIDER_IDS = ["cursor", "synthetic"] as const;
const NOTICE_TEXT = "Notice: Maintainer announcement available. Run /quota_announcements.";
const COMPACT_TEXT = "Cursor timing 80% | Synthetic timing 60% | +1 issue";
const COMBINED_OUTPUT = JSON.stringify({
  status: "ready",
  announcementText: NOTICE_TEXT,
  compact: { status: "ready", text: COMPACT_TEXT },
});
const COMPACT_ONLY_OUTPUT = JSON.stringify({
  status: "ready",
  compact: { status: "ready", text: COMPACT_TEXT },
});
const ANNOUNCEMENT_ONLY_OUTPUT = JSON.stringify({
  status: "ready",
  announcementText: NOTICE_TEXT,
  compact: { status: "disabled" },
});

const ANNOUNCEMENTS: readonly MaintainerAnnouncement[] = [
  {
    id: "timing-available-provider",
    message: "Timing fixture for an available provider.",
    providerIds: ["cursor"],
  },
  {
    id: "timing-unavailable-provider",
    message: "Timing fixture for an unavailable provider.",
    providerIds: ["alibaba-coding-plan"],
  },
];
const UNTARGETED_ANNOUNCEMENTS: readonly MaintainerAnnouncement[] = [
  {
    id: "timing-untargeted",
    message: "Timing fixture independent of provider availability.",
  },
];
const MIXED_DELAY_ANNOUNCEMENTS: readonly MaintainerAnnouncement[] = [
  {
    id: "timing-fast-target",
    message: "Timing fixture for a fast targeted provider.",
    providerIds: ["cursor"],
  },
];

const reportResults: ProviderAvailabilityTimingResult[] = [];

function createConfig(params: {
  announcementEnabled: boolean;
  compactEnabled: boolean;
}): QuotaToastConfig {
  return {
    ...DEFAULT_CONFIG,
    enabledProviders: [...ORDERED_PROVIDER_IDS],
    minIntervalMs: 0,
    showSessionTokens: false,
    tuiSidebarPanel: { ...DEFAULT_CONFIG.tuiSidebarPanel },
    tuiCompactStatus: {
      ...DEFAULT_CONFIG.tuiCompactStatus,
      enabled: params.compactEnabled,
      homeBottom: true,
      suppressWhenNativeProviderQuota: false,
      maxWidth: 96,
    },
    maintainerAnnouncements: {
      ...DEFAULT_CONFIG.maintainerAnnouncements,
      enabled: params.announcementEnabled,
      home: true,
    },
    export: { ...DEFAULT_CONFIG.export, enabled: false },
    telemetry: { ...DEFAULT_CONFIG.telemetry, enabled: false },
    layout: { ...DEFAULT_CONFIG.layout },
    opencodeGoWindows: [...DEFAULT_CONFIG.opencodeGoWindows],
    quotaProviders: [],
  };
}

function createProviderResult(name: string, percentRemaining: number): QuotaProviderResult {
  return {
    attempted: true,
    entries: [
      {
        name,
        percentRemaining,
        accounting: {
          resultType: "quota",
          acquisitionMethod: "local_runtime_accounting",
          ownership: "maintained",
          authority: "provider_reported",
        },
      },
    ],
    errors: [],
  };
}

function createProviders(params: {
  controlledDelayMs: number;
  controlledDelayByProvider?: Readonly<Record<string, number>>;
  callsByProvider: Record<string, number>;
  fetchesByProvider: Record<string, number>;
}): QuotaProvider[] {
  const results: Record<(typeof AVAILABLE_PROVIDER_IDS)[number], QuotaProviderResult> = {
    cursor: createProviderResult("Cursor timing", 80),
    synthetic: createProviderResult("Synthetic timing", 60),
  };

  return ORDERED_PROVIDER_IDS.map((providerId): QuotaProvider => ({
    id: providerId,
    isAvailable: async () => {
      params.callsByProvider[providerId] = (params.callsByProvider[providerId] ?? 0) + 1;
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (providerId === "alibaba-coding-plan") {
            reject(new Error("deterministic availability failure"));
            return;
          }
          resolve();
        }, params.controlledDelayByProvider?.[providerId] ?? params.controlledDelayMs);
      });
      return true;
    },
    fetch: async () => {
      params.fetchesByProvider[providerId] = (params.fetchesByProvider[providerId] ?? 0) + 1;
      const result = results[providerId as (typeof AVAILABLE_PROVIDER_IDS)[number]];
      if (!result) throw new Error(`Unexpected fetch for unavailable provider ${providerId}`);
      return result;
    },
  }));
}

function createApi(providerIds: readonly string[] = ORDERED_PROVIDER_IDS) {
  return {
    state: {
      provider: providerIds.map((id) => ({ id })),
      path: {
        worktree: process.cwd(),
        directory: process.cwd(),
      },
    },
    client: {
      config: {
        providers: vi.fn().mockResolvedValue({
          data: { providers: providerIds.map((id) => ({ id })) },
        }),
        get: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
}

async function runSample(params: {
  scenario: string;
  controlledDelayMs: number;
  controlledDelayByProvider?: Readonly<Record<string, number>>;
  announcementEnabled: boolean;
  compactEnabled: boolean;
  announcements?: readonly MaintainerAnnouncement[];
}): Promise<ProviderAvailabilityTimingSample> {
  vi.clearAllTimers();
  vi.setSystemTime(0);
  __resetQuotaStateForTests();

  const callsByProvider: Record<string, number> = {};
  const fetchesByProvider: Record<string, number> = {};
  const providers = createProviders({
    controlledDelayMs: params.controlledDelayMs,
    controlledDelayByProvider: params.controlledDelayByProvider,
    callsByProvider,
    fetchesByProvider,
  });
  const api = createApi();
  const initialRuntimeSeed: TuiInitialRuntimeSeed = {
    roots: resolveRuntimeContextRoots({
      worktreeRoot: process.cwd(),
      activeDirectory: process.cwd(),
      fallbackDirectory: process.cwd(),
    }),
    config: createConfig(params),
    configMeta: createLoadConfigMeta(),
    providers,
  };

  const startedAtMs = Date.now();
  const loadPromise = loadTuiHomeBottomStatus({
    api: api as never,
    nowMs: 0,
    announcements: params.announcements ?? ANNOUNCEMENTS,
    initialRuntimeSeed,
  });
  await vi.runAllTimersAsync();
  const state = await loadPromise;
  const elapsedMs = Date.now() - startedAtMs;
  const reachedHorizon = elapsedMs > TUI_PROVIDER_AVAILABILITY_HORIZON_MS;
  const readyCompactMs = !reachedHorizon && state.compact.status === "ready" ? elapsedMs : null;
  const homeCompletionMs = reachedHorizon ? null : elapsedMs;

  return {
    scenario: params.scenario,
    controlledDelayMs: params.controlledDelayMs,
    readyCompactMs,
    homeCompletionMs,
    callsByProvider: { ...callsByProvider },
    totalAvailabilityCalls: Object.values(callsByProvider).reduce((sum, count) => sum + count, 0),
    fetchesByProvider: { ...fetchesByProvider },
    totalFetches: Object.values(fetchesByProvider).reduce((sum, count) => sum + count, 0),
    outputSignature: JSON.stringify(state),
    censored: reachedHorizon,
  };
}

function expectInvariantVectors(params: {
  result: ProviderAvailabilityTimingResult;
  callsByProvider: Readonly<Record<string, number>>;
  fetchesByProvider: Readonly<Record<string, number>>;
  outputSignature: string;
}): void {
  expect(params.result.distinctCallCountVectors).toEqual([
    [
      ...ORDERED_PROVIDER_IDS.map(
        (providerId) => `${providerId}=${params.callsByProvider[providerId] ?? 0}`,
      ),
      `total=${Object.values(params.callsByProvider).reduce((sum, count) => sum + count, 0)}`,
    ].join(","),
  ]);
  expect(params.result.distinctFetchCountVectors).toEqual([
    [
      ...ORDERED_PROVIDER_IDS.map(
        (providerId) => `${providerId}=${params.fetchesByProvider[providerId] ?? 0}`,
      ),
      `total=${Object.values(params.fetchesByProvider).reduce((sum, count) => sum + count, 0)}`,
    ].join(","),
  ]);
  expect(params.result.distinctOutputSignatures).toEqual([params.outputSignature]);
  expect(params.result.samples.every((sample) => !sample.censored)).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  __resetQuotaStateForTests();
});

afterAll(() => {
  if (process.env.OPENCODE_QUOTA_TUI_PROVIDER_AVAILABILITY_REPORT === "1") {
    console.log(`\n${formatProviderAvailabilityTimingReport(reportResults)}`);
  }
  vi.useRealTimers();
});

describe("TUI home provider availability timing", () => {
  it("measures the narrowed targeted path, controls, and deterministic jitter", async () => {
    for (const controlledDelayMs of [25, 100]) {
      const scenario = `combined-${controlledDelayMs}`;
      const result = await runProviderAvailabilityTimingSamples({
        scenario,
        delayDescription: `${controlledDelayMs} ms fixed`,
        orderedProviderIds: ORDERED_PROVIDER_IDS,
        runSample: () =>
          runSample({
            scenario,
            controlledDelayMs,
            announcementEnabled: true,
            compactEnabled: true,
          }),
      });
      reportResults.push(result);

      expect(result.readyCompact).toEqual({
        min: controlledDelayMs * 2,
        median: controlledDelayMs * 2,
        p95: controlledDelayMs * 2,
        max: controlledDelayMs * 2,
        censored: 0,
      });
      expect(result.homeCompletion).toEqual(result.readyCompact);
      expectInvariantVectors({
        result,
        callsByProvider: { cursor: 2, synthetic: 1, "alibaba-coding-plan": 2 },
        fetchesByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 0 },
        outputSignature: COMBINED_OUTPUT,
      });
    }

    const jitterResult = await runProviderAvailabilityTimingSamples({
      scenario: "combined-jitter",
      delayDescription: "25 + [0,3,7,1,5] ms",
      orderedProviderIds: ORDERED_PROVIDER_IDS,
      runSample: (sampleIndex) => {
        const controlledDelayMs = 25 + getProviderAvailabilityJitterOffsetMs(sampleIndex);
        return runSample({
          scenario: "combined-jitter",
          controlledDelayMs,
          announcementEnabled: true,
          compactEnabled: true,
        });
      },
    });
    reportResults.push(jitterResult);
    expect(jitterResult.readyCompact).toEqual({
      min: 50,
      median: 56,
      p95: 64,
      max: 64,
      censored: 0,
    });
    expectInvariantVectors({
      result: jitterResult,
      callsByProvider: { cursor: 2, synthetic: 1, "alibaba-coding-plan": 2 },
      fetchesByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 0 },
      outputSignature: COMBINED_OUTPUT,
    });

    const compactOnlyResult = await runProviderAvailabilityTimingSamples({
      scenario: "compact-only",
      delayDescription: "25 ms fixed",
      orderedProviderIds: ORDERED_PROVIDER_IDS,
      runSample: () =>
        runSample({
          scenario: "compact-only",
          controlledDelayMs: 25,
          announcementEnabled: false,
          compactEnabled: true,
        }),
    });
    reportResults.push(compactOnlyResult);
    expect(compactOnlyResult.readyCompact).toEqual({
      min: 25,
      median: 25,
      p95: 25,
      max: 25,
      censored: 0,
    });
    expectInvariantVectors({
      result: compactOnlyResult,
      callsByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 1 },
      fetchesByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 0 },
      outputSignature: COMPACT_ONLY_OUTPUT,
    });

    const announcementOnlyResult = await runProviderAvailabilityTimingSamples({
      scenario: "announcement-only",
      delayDescription: "25 ms fixed",
      orderedProviderIds: ORDERED_PROVIDER_IDS,
      runSample: () =>
        runSample({
          scenario: "announcement-only",
          controlledDelayMs: 25,
          announcementEnabled: true,
          compactEnabled: false,
        }),
    });
    reportResults.push(announcementOnlyResult);
    expect(announcementOnlyResult.readyCompact).toEqual({
      min: null,
      median: null,
      p95: null,
      max: null,
      censored: 30,
    });
    expect(announcementOnlyResult.homeCompletion).toEqual({
      min: 25,
      median: 25,
      p95: 25,
      max: 25,
      censored: 0,
    });
    expectInvariantVectors({
      result: announcementOnlyResult,
      callsByProvider: { cursor: 1, synthetic: 0, "alibaba-coding-plan": 1 },
      fetchesByProvider: { cursor: 0, synthetic: 0, "alibaba-coding-plan": 0 },
      outputSignature: ANNOUNCEMENT_ONLY_OUTPUT,
    });
  });

  it("measures untargeted and mixed-delay combined baselines", async () => {
    const untargetedFixedResult = await runProviderAvailabilityTimingSamples({
      scenario: "untargeted-combined-25",
      delayDescription: "25 ms fixed",
      orderedProviderIds: ORDERED_PROVIDER_IDS,
      runSample: () =>
        runSample({
          scenario: "untargeted-combined-25",
          controlledDelayMs: 25,
          announcementEnabled: true,
          compactEnabled: true,
          announcements: UNTARGETED_ANNOUNCEMENTS,
        }),
    });
    reportResults.push(untargetedFixedResult);
    expect(untargetedFixedResult.readyCompact).toEqual({
      min: 25,
      median: 25,
      p95: 25,
      max: 25,
      censored: 0,
    });
    expectInvariantVectors({
      result: untargetedFixedResult,
      callsByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 1 },
      fetchesByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 0 },
      outputSignature: COMBINED_OUTPUT,
    });

    const untargetedJitterResult = await runProviderAvailabilityTimingSamples({
      scenario: "untargeted-combined-jitter",
      delayDescription: "25 + [0,3,7,1,5] ms",
      orderedProviderIds: ORDERED_PROVIDER_IDS,
      runSample: (sampleIndex) => {
        const controlledDelayMs = 25 + getProviderAvailabilityJitterOffsetMs(sampleIndex);
        return runSample({
          scenario: "untargeted-combined-jitter",
          controlledDelayMs,
          announcementEnabled: true,
          compactEnabled: true,
          announcements: UNTARGETED_ANNOUNCEMENTS,
        });
      },
    });
    reportResults.push(untargetedJitterResult);
    expect(untargetedJitterResult.readyCompact).toEqual({
      min: 25,
      median: 28,
      p95: 32,
      max: 32,
      censored: 0,
    });
    expectInvariantVectors({
      result: untargetedJitterResult,
      callsByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 1 },
      fetchesByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 0 },
      outputSignature: COMBINED_OUTPUT,
    });

    const mixedDelayResult = await runProviderAvailabilityTimingSamples({
      scenario: "mixed-delay-combined",
      delayDescription: "cursor=10,synthetic=100,alibaba-coding-plan=40 ms",
      orderedProviderIds: ORDERED_PROVIDER_IDS,
      runSample: () =>
        runSample({
          scenario: "mixed-delay-combined",
          controlledDelayMs: 100,
          controlledDelayByProvider: {
            cursor: 10,
            synthetic: 100,
            "alibaba-coding-plan": 40,
          },
          announcementEnabled: true,
          compactEnabled: true,
          announcements: MIXED_DELAY_ANNOUNCEMENTS,
        }),
    });
    reportResults.push(mixedDelayResult);
    expect(mixedDelayResult.readyCompact).toEqual({
      min: 110,
      median: 110,
      p95: 110,
      max: 110,
      censored: 0,
    });
    expectInvariantVectors({
      result: mixedDelayResult,
      callsByProvider: { cursor: 2, synthetic: 1, "alibaba-coding-plan": 1 },
      fetchesByProvider: { cursor: 1, synthetic: 1, "alibaba-coding-plan": 0 },
      outputSignature: COMBINED_OUTPUT,
    });
  });

  it("narrows announcement probes in runtime order and performs fresh checks on later loads", async () => {
    const probeOrder: string[] = [];
    const providers: QuotaProvider[] = ORDERED_PROVIDER_IDS.map((providerId) => ({
      id: providerId,
      isAvailable: async () => {
        probeOrder.push(providerId);
        if (providerId === "alibaba-coding-plan") {
          throw new Error("deterministic announcement availability failure");
        }
        return true;
      },
      fetch: async () => {
        throw new Error("announcement-only loads must not fetch quota");
      },
    }));
    const api = createApi();
    const initialRuntimeSeed: TuiInitialRuntimeSeed = {
      roots: resolveRuntimeContextRoots({
        worktreeRoot: process.cwd(),
        activeDirectory: process.cwd(),
        fallbackDirectory: process.cwd(),
      }),
      config: createConfig({ announcementEnabled: true, compactEnabled: false }),
      configMeta: createLoadConfigMeta(),
      providers,
    };
    const announcements: readonly MaintainerAnnouncement[] = [
      {
        id: "reverse-target-order",
        message: "Provider order must follow runtime order.",
        providerIds: ["alibaba-coding-plan", "cursor"],
      },
    ];

    const first = await loadTuiHomeBottomStatus({
      api: api as never,
      announcements,
      initialRuntimeSeed,
    });
    const second = await loadTuiHomeBottomStatus({
      api: api as never,
      announcements,
      initialRuntimeSeed,
    });

    expect(first).toEqual({
      status: "ready",
      announcementText: NOTICE_TEXT,
      compact: { status: "disabled" },
    });
    expect(second).toEqual(first);
    expect(probeOrder).toEqual(["cursor", "alibaba-coding-plan", "cursor", "alibaba-coding-plan"]);
  });

  it("keeps legal quota-providers announcement and compact observations context-sensitive", async () => {
    const observedOnlyCurrentModel: boolean[] = [];
    let fetchCount = 0;
    const provider: QuotaProvider = {
      id: "quota-providers",
      isAvailable: async (ctx) => {
        observedOnlyCurrentModel.push(ctx.config.onlyCurrentModel);
        return !ctx.config.onlyCurrentModel;
      },
      fetch: async () => {
        fetchCount += 1;
        return createProviderResult("Custom timing", 70);
      },
    };
    const config: QuotaToastConfig = {
      ...createConfig({ announcementEnabled: true, compactEnabled: true }),
      enabledProviders: ["quota-providers"],
      onlyCurrentModel: true,
    };
    const api = createApi(["quota-providers"]);
    const initialRuntimeSeed: TuiInitialRuntimeSeed = {
      roots: resolveRuntimeContextRoots({
        worktreeRoot: process.cwd(),
        activeDirectory: process.cwd(),
        fallbackDirectory: process.cwd(),
      }),
      config,
      configMeta: createLoadConfigMeta(),
      providers: [provider],
    };

    const state = await loadTuiHomeBottomStatus({
      api: api as never,
      announcements: [
        {
          id: "custom-provider-context",
          message: "Context-sensitive aggregate provider announcement.",
          providerIds: ["quota-providers"],
        },
      ],
      initialRuntimeSeed,
    });

    expect(observedOnlyCurrentModel).toEqual([true, false]);
    expect(fetchCount).toBe(1);
    expect(state.announcementText).toBeUndefined();
    expect(state).toMatchObject({
      status: "ready",
      compact: { status: "ready" },
    });
  });
});
