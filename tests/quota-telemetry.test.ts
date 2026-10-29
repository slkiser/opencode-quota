import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuotaProviderResult } from "../src/lib/entries.js";
import {
  __flushQuotaTelemetryInitializationForTests,
  __resetQuotaTelemetryForTests,
  __setQuotaTelemetryApiLoaderForTests,
  configureQuotaTelemetry,
  disposeQuotaTelemetryOwner,
  retainQuotaTelemetryProviders,
  updateQuotaTelemetrySnapshot,
} from "../src/lib/quota-telemetry.js";

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

type Observation = {
  value: number;
  attributes?: Record<string, unknown>;
};
type Callback = (result: {
  observe(value: number, attributes?: Record<string, unknown>): void;
}) => void;

function createOtelHarness(options: { throwOnAdd?: string } = {}) {
  const callbacks = new Map<string, Callback>();
  const instruments: Array<{ name: string; options: Record<string, unknown> }> = [];
  const createObservableGauge = vi.fn((name: string, gaugeOptions: Record<string, unknown>) => {
    instruments.push({ name, options: gaugeOptions });
    return {
      addCallback(callback: Callback) {
        if (options.throwOnAdd === name) throw new Error("callback registration failed");
        callbacks.set(name, callback);
      },
      removeCallback(callback: Callback) {
        if (callbacks.get(name) === callback) callbacks.delete(name);
      },
    };
  });
  const getMeter = vi.fn(() => ({ createObservableGauge }));
  return {
    api: { metrics: { getMeter } },
    callbacks,
    createObservableGauge,
    getMeter,
    instruments,
    collect(name: string, observe?: (observation: Observation) => void): Observation[] {
      const observations: Observation[] = [];
      callbacks.get(name)?.({
        observe(value, attributes) {
          const observation = { value, attributes };
          observations.push(observation);
          observe?.(observation);
        },
      });
      return observations;
    },
  };
}

function quotaResult(
  entries: QuotaProviderResult["entries"],
  extras: Partial<QuotaProviderResult> = {},
): QuotaProviderResult {
  return {
    attempted: true,
    entries,
    errors: [],
    ...extras,
  };
}

function enable(owner: object, identity = "config-a") {
  const token = configureQuotaTelemetry({ owner, enabled: true, identity });
  expect(token).toBeDefined();
  return token!;
}

describe("quota telemetry", () => {
  beforeEach(() => {
    vi.useRealTimers();
    __resetQuotaTelemetryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetQuotaTelemetryForTests();
  });

  it("does not load or register OpenTelemetry while disabled", async () => {
    const loader = vi.fn(async () => createOtelHarness().api);
    __setQuotaTelemetryApiLoaderForTests(loader);
    const owner = {};

    expect(
      configureQuotaTelemetry({ owner, enabled: false, identity: "disabled" }),
    ).toBeUndefined();
    await __flushQuotaTelemetryInitializationForTests();

    expect(loader).not.toHaveBeenCalled();
  });

  it("registers exactly two callbacks once and reuses them across enable transitions", async () => {
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const owner = {};

    const first = enable(owner);
    await __flushQuotaTelemetryInitializationForTests();
    expect(otel.getMeter).toHaveBeenCalledOnce();
    expect(otel.instruments).toEqual([
      {
        name: "opencode.quota.consumed",
        options: {
          description: "Normalized quota consumed, where 1 is 100% consumed",
          unit: "1",
        },
      },
      {
        name: "opencode.quota.cache.age",
        options: {
          description: "Age of the normalized cached quota observation",
          unit: "s",
        },
      },
    ]);

    expect(enable(owner)).toEqual(first);
    configureQuotaTelemetry({ owner, enabled: false, identity: "config-a" });
    expect(otel.collect("opencode.quota.consumed")).toEqual([]);
    enable(owner);
    await __flushQuotaTelemetryInitializationForTests();

    expect(otel.getMeter).toHaveBeenCalledOnce();
    expect(otel.callbacks.size).toBe(2);
  });

  it("publishes clamped deterministic quota series with only bounded attributes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:42.000Z"));
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const token = enable({});

    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "openai-cache",
      providerId: "openai",
      cacheTimestamp: Date.parse("2026-07-25T12:00:00.000Z"),
      result: quotaResult(
        [
          {
            accounting: {
              ...ACCOUNTING,
              sourceId: "account@example.com",
              observedAtIso: "2026-07-25T11:59:00.000Z",
            },
            name: "OpenAI account@example.com",
            label: "5h:",
            percentRemaining: 25,
          },
          {
            accounting: ACCOUNTING,
            name: "OpenAI another@example.com",
            label: "5 hour:",
            percentRemaining: -20,
          },
          {
            accounting: { ...ACCOUNTING, resultType: "rate_limit" },
            name: "Private https://sensitive.example",
            percentRemaining: 120,
          },
          {
            accounting: { ...ACCOUNTING, resultType: "balance" },
            kind: "value",
            name: "Balance",
            value: "$42.00",
          },
        ],
        { errors: [{ label: "OpenAI", message: "token secret" }] },
      ),
    });
    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "unknown-provider",
      providerId: "private-customer-provider",
      result: quotaResult([
        {
          accounting: ACCOUNTING,
          name: "Private Customer",
          percentRemaining: 50,
        },
      ]),
    });
    await __flushQuotaTelemetryInitializationForTests();

    const consumed = otel.collect("opencode.quota.consumed");
    expect(consumed.map(({ value }) => value).sort()).toEqual([0, 0.5, 1]);
    expect(
      consumed.every(
        ({ attributes }) =>
          JSON.stringify(Object.keys(attributes ?? {}).sort()) ===
          JSON.stringify(["quota.provider", "quota.result_type", "quota.window"]),
      ),
    ).toBe(true);
    expect(consumed).toContainEqual({
      value: 1,
      attributes: {
        "quota.provider": "openai",
        "quota.window": "five_hour",
        "quota.result_type": "quota",
      },
    });
    expect(consumed).toContainEqual({
      value: 0.5,
      attributes: {
        "quota.provider": "other",
        "quota.window": "unknown",
        "quota.result_type": "quota",
      },
    });
    expect(JSON.stringify(consumed)).not.toMatch(
      /account@example\.com|another@example\.com|sensitive\.example|token secret|\$42/,
    );

    expect(otel.collect("opencode.quota.cache.age")).toEqual([
      {
        value: 42,
        attributes: { "quota.provider": "openai" },
      },
    ]);
  });

  it("keeps structured telemetry percent-only and uses typed semantic windows", async () => {
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const token = enable({});

    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "structured",
      providerId: "openai",
      result: quotaResult([
        {
          kind: "quantity",
          accounting: { ...ACCOUNTING, resultType: "balance" },
          semantic: {
            metric: { kind: "component", component: "current_balance" },
            prominence: "supplementary",
          },
          name: "Balance",
          quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
        },
        {
          kind: "boolean",
          accounting: { ...ACCOUNTING, resultType: "status" },
          semantic: {
            metric: { kind: "component", component: "auto_reload" },
            prominence: "supplementary",
          },
          name: "Auto-reload",
          value: true,
        },
        {
          kind: "value",
          accounting: { ...ACCOUNTING, resultType: "usage" },
          name: "Legacy usage",
          value: "12 requests",
        },
        {
          accounting: ACCOUNTING,
          semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
          basis: {
            remaining: {
              quantity: { decimal: "25", unit: { kind: "count", unit: "request" } },
              authority: "provider_reported",
            },
          },
          name: "Typed weekly quota",
          label: "Monthly:",
          percentRemaining: 25,
        },
        {
          accounting: { ...ACCOUNTING, resultType: "budget" },
          semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
          name: "Aggregate budget",
          label: "Daily:",
          percentRemaining: 80,
        },
      ]),
    });
    await __flushQuotaTelemetryInitializationForTests();

    expect(otel.collect("opencode.quota.consumed")).toEqual([
      {
        value: 0.2,
        attributes: {
          "quota.provider": "openai",
          "quota.window": "unknown",
          "quota.result_type": "budget",
        },
      },
      {
        value: 0.75,
        attributes: {
          "quota.provider": "openai",
          "quota.window": "week",
          "quota.result_type": "quota",
        },
      },
    ]);
  });

  it("maps aggregate sources to custom and reduces privacy-collapsed series by maximum", async () => {
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const token = enable({});
    const entries = [
      {
        accounting: { ...ACCOUNTING, sourceId: "source-one" },
        name: "First private source",
        label: "Monthly:",
        percentRemaining: 60,
      },
      {
        accounting: { ...ACCOUNTING, sourceId: "source-two" },
        name: "Second private source",
        label: "Month:",
        percentRemaining: 20,
      },
    ] satisfies QuotaProviderResult["entries"];

    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "aggregate",
      providerId: "quota-providers",
      cacheTimestamp: 1_000,
      result: quotaResult([...entries].reverse()),
    });
    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "aggregate:private-source",
      providerId: "quota-providers:private-source",
      cacheTimestamp: 500,
      result: quotaResult(entries),
    });
    await __flushQuotaTelemetryInitializationForTests();

    expect(otel.collect("opencode.quota.consumed")).toEqual([
      {
        value: 0.8,
        attributes: {
          "quota.provider": "custom",
          "quota.window": "month",
          "quota.result_type": "quota",
        },
      },
    ]);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    expect(otel.collect("opencode.quota.cache.age")).toEqual([
      {
        value: 1.5,
        attributes: { "quota.provider": "custom" },
      },
    ]);
  });

  it("preserves newer cache timestamps, omits age for uncached data, and clamps future age", async () => {
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const token = enable({});
    const result = (percentRemaining: number) =>
      quotaResult([
        {
          accounting: ACCOUNTING,
          name: "Synthetic",
          percentRemaining,
        },
      ]);

    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "cache",
      providerId: "synthetic",
      cacheTimestamp: 2_000,
      result: result(50),
    });
    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "cache",
      providerId: "synthetic",
      cacheTimestamp: 1_000,
      result: result(0),
    });
    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "uncached",
      providerId: "other-private",
      result: result(25),
    });
    await __flushQuotaTelemetryInitializationForTests();

    expect(
      otel
        .collect("opencode.quota.consumed")
        .map(({ value }) => value)
        .sort(),
    ).toEqual([0.5, 0.75]);
    vi.spyOn(Date, "now").mockReturnValue(1_500);
    expect(otel.collect("opencode.quota.cache.age")).toEqual([
      {
        value: 0,
        attributes: { "quota.provider": "synthetic" },
      },
    ]);
  });

  it("keeps owners isolated, rejects stale generations, prunes providers, and disposes cleanly", async () => {
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const firstOwner = {};
    const secondOwner = {};
    const stale = enable(firstOwner, "first");
    const second = enable(secondOwner, "second");
    const result = quotaResult([
      { accounting: ACCOUNTING, name: "Synthetic", percentRemaining: 50 },
    ]);

    updateQuotaTelemetrySnapshot({
      token: stale,
      snapshotId: "first",
      providerId: "synthetic",
      result,
    });
    updateQuotaTelemetrySnapshot({
      token: second,
      snapshotId: "second",
      providerId: "openai",
      result,
    });
    const current = enable(firstOwner, "changed");
    updateQuotaTelemetrySnapshot({
      token: stale,
      snapshotId: "late",
      providerId: "anthropic",
      result,
    });
    updateQuotaTelemetrySnapshot({
      token: current,
      snapshotId: "current",
      providerId: "anthropic",
      result,
    });
    retainQuotaTelemetryProviders({ token: current, providerIds: [] });
    await __flushQuotaTelemetryInitializationForTests();

    expect(otel.collect("opencode.quota.consumed")).toEqual([
      {
        value: 0.5,
        attributes: {
          "quota.provider": "openai",
          "quota.window": "unknown",
          "quota.result_type": "quota",
        },
      },
    ]);
    disposeQuotaTelemetryOwner(secondOwner);
    expect(otel.collect("opencode.quota.consumed")).toEqual([]);
  });

  it("isolates API, registration, and individual observer failures", async () => {
    const rejected = vi.fn(async () => {
      throw new Error("optional API missing");
    });
    __setQuotaTelemetryApiLoaderForTests(rejected);
    expect(() => enable({})).not.toThrow();
    await expect(__flushQuotaTelemetryInitializationForTests()).resolves.toBeUndefined();

    __resetQuotaTelemetryForTests();
    const brokenApi = {
      metrics: {
        getMeter() {
          throw new Error("meter failed");
        },
      },
    };
    __setQuotaTelemetryApiLoaderForTests(async () => brokenApi);
    expect(() => enable({})).not.toThrow();
    await expect(__flushQuotaTelemetryInitializationForTests()).resolves.toBeUndefined();

    __resetQuotaTelemetryForTests();
    const brokenRegistration = createOtelHarness({
      throwOnAdd: "opencode.quota.cache.age",
    });
    __setQuotaTelemetryApiLoaderForTests(async () => brokenRegistration.api);
    expect(() => enable({})).not.toThrow();
    await expect(__flushQuotaTelemetryInitializationForTests()).resolves.toBeUndefined();
    expect(brokenRegistration.callbacks.size).toBe(0);

    __resetQuotaTelemetryForTests();
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const token = enable({});
    updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "one",
      providerId: "openai",
      result: quotaResult([
        { accounting: ACCOUNTING, name: "Daily", percentRemaining: 50 },
        { accounting: ACCOUNTING, name: "Weekly", percentRemaining: 25 },
      ]),
    });
    await __flushQuotaTelemetryInitializationForTests();

    let attempts = 0;
    expect(() =>
      otel.collect("opencode.quota.consumed", () => {
        attempts += 1;
        if (attempts === 1) throw new Error("collector failed");
      }),
    ).not.toThrow();
    expect(attempts).toBe(2);
  });

  it("does not create timers while configuring or observing", async () => {
    const otel = createOtelHarness();
    __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const setTimeout = vi.spyOn(globalThis, "setTimeout");

    enable({});
    await __flushQuotaTelemetryInitializationForTests();
    otel.collect("opencode.quota.consumed");

    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
