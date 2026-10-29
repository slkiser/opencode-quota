import { vi } from "vite-plus/test";

export const FIRST_QUOTA_OBSERVATION_HORIZON_MS = 10_000;
export const FIRST_QUOTA_WARMUP_SAMPLES = 3;
export const FIRST_QUOTA_RECORDED_SAMPLES = 30;

export type FirstQuotaObservation = {
  firstApplyMs: number | null;
  loaderStartsAtFirstApply: number | null;
  loaderCompletionsAtFirstApply: number | null;
  acceptedLoaderOrdinal: number | null;
  applyCount: number;
  afterApplyCount: number;
  loaderCompletionsTotal: number;
  unsubscribeCount: number;
  disposeCount: number;
  predecessorApplyCount: number;
  sinkValue: string | null;
  censored: boolean;
};

export type TimingAggregate = {
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  censored: number;
};

export type FirstQuotaScenario = {
  id: string;
  description: string;
  loaderSteps: readonly LoaderStep[];
  eventAtMs?: number;
  eventRefreshDelaysMs?: readonly number[];
  recoveryDelaysMs?: readonly number[];
  disposeAtMs?: number;
  successor?: {
    createAtMs: number;
    predecessorSettlesAtMs: number;
    successorLatencyMs: number;
  };
};

export type FirstQuotaScenarioResult = {
  scenario: FirstQuotaScenario;
  samples: FirstQuotaObservation[];
  firstApplyMs: TimingAggregate;
  loaderCompletions: TimingAggregate;
  loaderStarts: TimingAggregate;
};

type LoaderStep = {
  afterMs: number;
  outcome: "resolve" | "reject";
};

type Lifecycle = {
  retain: () => void;
  release: () => void;
};

type LifecycleOptions<T> = {
  load: () => Promise<T>;
  apply: (value: T) => void;
  afterApply?: (value: T) => void;
  intervalMs: number;
  eventRefreshDelaysMs: readonly number[];
  recoveryDelaysMs?: readonly number[];
  subscribe: (scheduleRefresh: () => void) => Array<() => void>;
  onDispose: () => void;
};

export type CreateTuiRefreshLifecycle = <T>(options: LifecycleOptions<T>) => Lifecycle;

type ScriptedValue = {
  ordinal: number;
  value: string;
};

function flushPromises(): Promise<void> {
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined);
}

function aggregate(values: Array<number | null>): TimingAggregate {
  const recorded = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (recorded.length === 0) {
    return {
      min: null,
      median: null,
      p95: null,
      max: null,
      censored: values.length,
    };
  }

  const valueAt = (index: number): number => {
    const value = recorded[index];
    if (value === undefined) throw new Error(`Missing aggregate value at index ${index}`);
    return value;
  };
  const medianIndex = Math.floor(recorded.length / 2);
  const median =
    recorded.length % 2 === 0
      ? (valueAt(medianIndex - 1) + valueAt(medianIndex)) / 2
      : valueAt(medianIndex);

  return {
    min: valueAt(0),
    median,
    p95: valueAt(Math.ceil(recorded.length * 0.95) - 1),
    max: valueAt(recorded.length - 1),
    censored: values.length - recorded.length,
  };
}

async function runStandardSample(
  createLifecycle: CreateTuiRefreshLifecycle,
  scenario: FirstQuotaScenario,
): Promise<FirstQuotaObservation> {
  vi.clearAllTimers();
  vi.setSystemTime(0);

  const createdAt = Date.now();
  let loaderStarts = 0;
  let loaderCompletions = 0;
  let applyCount = 0;
  let afterApplyCount = 0;
  let unsubscribeCount = 0;
  let disposeCount = 0;
  let released = false;
  let scheduleRefresh: (() => void) | undefined;
  let firstApplyMs: number | null = null;
  let loaderStartsAtFirstApply: number | null = null;
  let loaderCompletionsAtFirstApply: number | null = null;
  let acceptedLoaderOrdinal: number | null = null;
  let sinkValue: string | null = null;

  const lifecycle = createLifecycle<ScriptedValue>({
    load: () => {
      const ordinal = ++loaderStarts;
      const step = scenario.loaderSteps[ordinal - 1];
      if (!step) return new Promise<never>(() => {});

      return new Promise<ScriptedValue>((resolve, reject) => {
        setTimeout(() => {
          loaderCompletions += 1;
          if (step.outcome === "reject") {
            reject(new Error(`scripted rejection ${ordinal}`));
            return;
          }
          resolve({ ordinal, value: `loader-${ordinal}` });
        }, step.afterMs);
      });
    },
    apply: (next) => {
      applyCount += 1;
      sinkValue = next.value;
      if (firstApplyMs !== null) return;

      firstApplyMs = Date.now() - createdAt;
      loaderStartsAtFirstApply = loaderStarts;
      loaderCompletionsAtFirstApply = loaderCompletions;
      acceptedLoaderOrdinal = next.ordinal;
    },
    afterApply: () => {
      afterApplyCount += 1;
    },
    intervalMs: 60_000,
    eventRefreshDelaysMs: scenario.eventRefreshDelaysMs ?? [],
    recoveryDelaysMs: scenario.recoveryDelaysMs,
    subscribe: (receivedScheduleRefresh) => {
      scheduleRefresh = receivedScheduleRefresh;
      return [
        () => {
          unsubscribeCount += 1;
        },
      ];
    },
    onDispose: () => {
      disposeCount += 1;
    },
  });
  lifecycle.retain();

  if (scenario.eventAtMs !== undefined) {
    if (scenario.eventAtMs === 0) {
      scheduleRefresh?.();
    } else {
      setTimeout(() => scheduleRefresh?.(), scenario.eventAtMs);
    }
  }

  if (scenario.disposeAtMs !== undefined) {
    setTimeout(() => {
      released = true;
      lifecycle.release();
    }, scenario.disposeAtMs);
  }

  await flushPromises();
  await vi.advanceTimersByTimeAsync(FIRST_QUOTA_OBSERVATION_HORIZON_MS);
  await flushPromises();

  if (!released) lifecycle.release();

  return {
    firstApplyMs,
    loaderStartsAtFirstApply,
    loaderCompletionsAtFirstApply,
    acceptedLoaderOrdinal,
    applyCount,
    afterApplyCount,
    loaderCompletionsTotal: loaderCompletions,
    unsubscribeCount,
    disposeCount,
    predecessorApplyCount: 0,
    sinkValue,
    censored: firstApplyMs === null,
  };
}

async function runSuccessorSample(
  createLifecycle: CreateTuiRefreshLifecycle,
  scenario: FirstQuotaScenario,
): Promise<FirstQuotaObservation> {
  const successor = scenario.successor;
  if (!successor) throw new Error(`Missing successor script for ${scenario.id}`);

  vi.clearAllTimers();
  vi.setSystemTime(0);

  let predecessorApplyCount = 0;
  let loaderCompletions = 0;
  let applyCount = 0;
  let afterApplyCount = 0;
  let unsubscribeCount = 0;
  let disposeCount = 0;
  let firstApplyMs: number | null = null;
  let sinkValue: string | null = null;
  let measuredLifecycle: Lifecycle | undefined;

  const predecessor = createLifecycle<string>({
    load: () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("predecessor"), successor.predecessorSettlesAtMs);
      }),
    apply: (value) => {
      predecessorApplyCount += 1;
      sinkValue = value;
    },
    intervalMs: 60_000,
    eventRefreshDelaysMs: [],
    subscribe: () => [
      () => {
        unsubscribeCount += 1;
      },
    ],
    onDispose: () => {
      disposeCount += 1;
    },
  });
  predecessor.retain();

  setTimeout(() => {
    predecessor.release();
    const successorCreatedAt = Date.now();
    measuredLifecycle = createLifecycle<ScriptedValue>({
      load: () =>
        new Promise<ScriptedValue>((resolve) => {
          setTimeout(() => {
            loaderCompletions += 1;
            resolve({ ordinal: 1, value: "successor" });
          }, successor.successorLatencyMs);
        }),
      apply: (next) => {
        applyCount += 1;
        sinkValue = next.value;
        if (firstApplyMs === null) firstApplyMs = Date.now() - successorCreatedAt;
      },
      afterApply: () => {
        afterApplyCount += 1;
      },
      intervalMs: 60_000,
      eventRefreshDelaysMs: [],
      subscribe: () => [
        () => {
          unsubscribeCount += 1;
        },
      ],
      onDispose: () => {
        disposeCount += 1;
      },
    });
    measuredLifecycle.retain();
  }, successor.createAtMs);

  await vi.advanceTimersByTimeAsync(FIRST_QUOTA_OBSERVATION_HORIZON_MS);
  await flushPromises();
  measuredLifecycle?.release();

  return {
    firstApplyMs,
    loaderStartsAtFirstApply: firstApplyMs === null ? null : 1,
    loaderCompletionsAtFirstApply: firstApplyMs === null ? null : loaderCompletions,
    acceptedLoaderOrdinal: firstApplyMs === null ? null : 1,
    applyCount,
    afterApplyCount,
    loaderCompletionsTotal: loaderCompletions,
    unsubscribeCount,
    disposeCount,
    predecessorApplyCount,
    sinkValue,
    censored: firstApplyMs === null,
  };
}

export async function runFirstQuotaScenarioSamples(
  createLifecycle: CreateTuiRefreshLifecycle,
  scenario: FirstQuotaScenario,
): Promise<FirstQuotaScenarioResult> {
  const runSample = scenario.successor ? runSuccessorSample : runStandardSample;

  for (let index = 0; index < FIRST_QUOTA_WARMUP_SAMPLES; index += 1) {
    await runSample(createLifecycle, scenario);
  }

  const samples: FirstQuotaObservation[] = [];
  for (let index = 0; index < FIRST_QUOTA_RECORDED_SAMPLES; index += 1) {
    samples.push(await runSample(createLifecycle, scenario));
  }

  return {
    scenario,
    samples,
    firstApplyMs: aggregate(samples.map((sample) => sample.firstApplyMs)),
    loaderCompletions: aggregate(samples.map((sample) => sample.loaderCompletionsAtFirstApply)),
    loaderStarts: aggregate(samples.map((sample) => sample.loaderStartsAtFirstApply)),
  };
}

function formatValue(value: number | null): string {
  return value === null ? "CENSORED" : String(value);
}

export function formatFirstQuotaReport(results: FirstQuotaScenarioResult[]): string {
  const lines = [
    "TUI first accepted quota run (virtual ms)",
    `Warmups: ${FIRST_QUOTA_WARMUP_SAMPLES}; recorded: ${FIRST_QUOTA_RECORDED_SAMPLES}; horizon: ${FIRST_QUOTA_OBSERVATION_HORIZON_MS} ms`,
    "| Scenario | T min | T median | T p95 | T max | T censored | C min | C median | C p95 | C max | C censored | Starts median |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.scenario.id} | ${formatValue(result.firstApplyMs.min)} | ${formatValue(result.firstApplyMs.median)} | ${formatValue(result.firstApplyMs.p95)} | ${formatValue(result.firstApplyMs.max)} | ${result.firstApplyMs.censored} | ${formatValue(result.loaderCompletions.min)} | ${formatValue(result.loaderCompletions.median)} | ${formatValue(result.loaderCompletions.p95)} | ${formatValue(result.loaderCompletions.max)} | ${result.loaderCompletions.censored} | ${formatValue(result.loaderStarts.median)} |`,
    );
  }

  return lines.join("\n");
}
