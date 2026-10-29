import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTuiRefreshLifecycle } from "../src/lib/tui-refresh-lifecycle.js";
import {
  FIRST_QUOTA_RECORDED_SAMPLES,
  type FirstQuotaScenario,
  type FirstQuotaScenarioResult,
  formatFirstQuotaReport,
  runFirstQuotaScenarioSamples,
} from "./helpers/tui-first-quota-timing.js";

const RECOVERY_DELAYS_MS = [500, 1_500, 4_000] as const;
const EVENT_REFRESH_DELAYS_MS = [150, 600] as const;

const scenarios: FirstQuotaScenario[] = [
  {
    id: "S0_IMMEDIATE",
    description: "Immediate success",
    loaderSteps: [{ afterMs: 0, outcome: "resolve" }],
  },
  {
    id: "S1_BEFORE_150",
    description: "Initial success before the first event refresh",
    loaderSteps: [{ afterMs: 100, outcome: "resolve" }],
    eventAtMs: 0,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
  },
  {
    id: "S2_AFTER_150",
    description: "Initial success after the first event refresh",
    loaderSteps: [
      { afterMs: 200, outcome: "resolve" },
      { afterMs: 40, outcome: "resolve" },
    ],
    eventAtMs: 0,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
  },
  {
    id: "S3_AFTER_500",
    description: "Initial success after the first mount recovery",
    loaderSteps: [
      { afterMs: 700, outcome: "resolve" },
      { afterMs: 40, outcome: "resolve" },
    ],
    recoveryDelaysMs: RECOVERY_DELAYS_MS,
  },
  {
    id: "S4_OVERLAP",
    description: "Initial success after overlapping event and recovery refreshes",
    loaderSteps: [
      { afterMs: 700, outcome: "resolve" },
      { afterMs: 100, outcome: "resolve" },
    ],
    eventAtMs: 0,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    recoveryDelaysMs: RECOVERY_DELAYS_MS,
  },
  {
    id: "S5_REJECT_RECOVER",
    description: "Initial rejection followed by queued recovery success",
    loaderSteps: [
      { afterMs: 700, outcome: "reject" },
      { afterMs: 50, outcome: "resolve" },
    ],
    recoveryDelaysMs: RECOVERY_DELAYS_MS,
  },
  {
    id: "S6_DISPOSED",
    description: "Final disposal before the initial loader settles",
    loaderSteps: [{ afterMs: 200, outcome: "resolve" }],
    disposeAtMs: 100,
  },
  {
    id: "S7_SUCCESSOR_LATE",
    description: "Successor applies before a disposed predecessor settles late",
    loaderSteps: [],
    successor: {
      createAtMs: 100,
      predecessorSettlesAtMs: 200,
      successorLatencyMs: 50,
    },
  },
];

const expected = new Map<
  string,
  { firstApplyMs: number | null; completions: number | null; starts: number | null }
>([
  ["S0_IMMEDIATE", { firstApplyMs: 0, completions: 1, starts: 1 }],
  ["S1_BEFORE_150", { firstApplyMs: 100, completions: 1, starts: 1 }],
  ["S2_AFTER_150", { firstApplyMs: 200, completions: 1, starts: 1 }],
  ["S3_AFTER_500", { firstApplyMs: 700, completions: 1, starts: 1 }],
  ["S4_OVERLAP", { firstApplyMs: 700, completions: 1, starts: 1 }],
  ["S5_REJECT_RECOVER", { firstApplyMs: 750, completions: 2, starts: 2 }],
  ["S6_DISPOSED", { firstApplyMs: null, completions: null, starts: null }],
  ["S7_SUCCESSOR_LATE", { firstApplyMs: 50, completions: 1, starts: 1 }],
]);

const queuedSuccessScenarios = new Set(["S2_AFTER_150", "S3_AFTER_500", "S4_OVERLAP"]);

const results: FirstQuotaScenarioResult[] = [];

function expectedAggregate(value: number | null) {
  if (value === null) {
    return {
      min: null,
      median: null,
      p95: null,
      max: null,
      censored: FIRST_QUOTA_RECORDED_SAMPLES,
    };
  }

  return { min: value, median: value, p95: value, max: value, censored: 0 };
}

function flushPromises(): Promise<void> {
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
});

afterAll(() => {
  if (process.env.OPENCODE_QUOTA_TUI_FIRST_QUOTA_REPORT === "1") {
    console.log(`\n${formatFirstQuotaReport(results)}`);
  }
  vi.useRealTimers();
});

describe("TUI first accepted quota lifecycle baseline", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      const result = await runFirstQuotaScenarioSamples(createTuiRefreshLifecycle, scenario);
      const scenarioExpected = expected.get(scenario.id);
      if (!scenarioExpected) throw new Error(`Missing expectation for ${scenario.id}`);

      expect(result.firstApplyMs).toEqual(expectedAggregate(scenarioExpected.firstApplyMs));
      expect(result.loaderCompletions).toEqual(expectedAggregate(scenarioExpected.completions));
      expect(result.loaderStarts).toEqual(expectedAggregate(scenarioExpected.starts));

      for (const sample of result.samples) {
        if (scenario.id === "S6_DISPOSED") {
          expect(sample).toMatchObject({
            firstApplyMs: null,
            loaderStartsAtFirstApply: null,
            loaderCompletionsAtFirstApply: null,
            acceptedLoaderOrdinal: null,
            applyCount: 0,
            afterApplyCount: 0,
            loaderCompletionsTotal: 1,
            unsubscribeCount: 1,
            disposeCount: 1,
            predecessorApplyCount: 0,
            sinkValue: null,
            censored: true,
          });
          continue;
        }

        const expectedOrdinal = scenarioExpected.starts;
        const queuedSuccess = queuedSuccessScenarios.has(scenario.id);
        expect(sample).toMatchObject({
          firstApplyMs: scenarioExpected.firstApplyMs,
          loaderStartsAtFirstApply: scenarioExpected.starts,
          loaderCompletionsAtFirstApply: scenarioExpected.completions,
          acceptedLoaderOrdinal: expectedOrdinal,
          applyCount: queuedSuccess ? 2 : 1,
          afterApplyCount: queuedSuccess ? 2 : 1,
          predecessorApplyCount: 0,
          sinkValue:
            scenario.id === "S7_SUCCESSOR_LATE"
              ? "successor"
              : `loader-${queuedSuccess ? 2 : expectedOrdinal}`,
          censored: false,
        });
        expect(sample.unsubscribeCount).toBe(scenario.id === "S7_SUCCESSOR_LATE" ? 2 : 1);
        expect(sample.disposeCount).toBe(scenario.id === "S7_SUCCESSOR_LATE" ? 2 : 1);
      }

      results.push(result);
    });
  }

  it("keeps the active result when the queued follow-up rejects and recovers later", async () => {
    let resolveInitial: ((value: string) => void) | undefined;
    let rejectQueued: ((error: Error) => void) | undefined;
    let resolveLater: ((value: string) => void) | undefined;
    let loadCall = 0;
    let sink: string | undefined;
    const load = vi.fn(() => {
      loadCall += 1;
      if (loadCall === 1) {
        return new Promise<string>((resolve) => {
          resolveInitial = resolve;
        });
      }
      if (loadCall === 2) {
        return new Promise<string>((_resolve, reject) => {
          rejectQueued = reject;
        });
      }
      return new Promise<string>((resolve) => {
        resolveLater = resolve;
      });
    });
    const apply = vi.fn((value: string) => {
      sink = value;
    });
    const afterApply = vi.fn();
    const lifecycle = createTuiRefreshLifecycle({
      load,
      apply,
      afterApply,
      intervalMs: 60_000,
      eventRefreshDelaysMs: [],
      subscribe: () => [],
      onDispose: vi.fn(),
    });
    lifecycle.retain();

    lifecycle.reload();
    resolveInitial?.("initial");
    await flushPromises();

    expect(load).toHaveBeenCalledTimes(2);
    expect(sink).toBe("initial");
    expect(apply).toHaveBeenCalledOnce();
    expect(afterApply).toHaveBeenCalledOnce();

    rejectQueued?.(new Error("queued refresh failed"));
    await flushPromises();

    expect(sink).toBe("initial");
    expect(apply).toHaveBeenCalledOnce();
    expect(afterApply).toHaveBeenCalledOnce();

    lifecycle.reload();
    expect(load).toHaveBeenCalledTimes(3);
    resolveLater?.("recovered");
    await flushPromises();

    expect(sink).toBe("recovered");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(afterApply).toHaveBeenCalledTimes(2);
    lifecycle.release();
  });

  it("starts immediately, polls at 60000 ms, and stops polling after final release", async () => {
    const load = vi.fn(async () => "quota");
    const apply = vi.fn();
    const unsubscribe = vi.fn();
    const onDispose = vi.fn();
    const lifecycle = createTuiRefreshLifecycle({
      load,
      apply,
      intervalMs: 60_000,
      eventRefreshDelaysMs: [],
      subscribe: () => [unsubscribe],
      onDispose,
    });
    lifecycle.retain();

    expect(load).toHaveBeenCalledOnce();
    await flushPromises();
    expect(apply).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);

    lifecycle.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
  });

  it("keeps a retained lifecycle alive and suppresses late work after final release", async () => {
    let scheduleRefresh: (() => void) | undefined;
    let resolveLoad: ((value: string) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const apply = vi.fn();
    const afterApply = vi.fn();
    const unsubscribe = vi.fn();
    const onDispose = vi.fn();
    const lifecycle = createTuiRefreshLifecycle({
      load,
      apply,
      afterApply,
      intervalMs: 60_000,
      eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
      recoveryDelaysMs: RECOVERY_DELAYS_MS,
      subscribe: (receivedScheduleRefresh) => {
        scheduleRefresh = receivedScheduleRefresh;
        return [unsubscribe];
      },
      onDispose,
    });
    lifecycle.retain();
    lifecycle.retain();

    lifecycle.release();
    scheduleRefresh?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(load).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    lifecycle.release();
    resolveLoad?.("late quota");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(load).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(afterApply).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
  });
});
