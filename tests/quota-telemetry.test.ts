import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import {
  __flushQuotaTelemetryInitializationForTests,
  __resetQuotaTelemetryForTests,
  __setQuotaTelemetryApiLoaderForTests,
  configureQuotaTelemetry,
  disposeQuotaTelemetryOwner,
  publishQuotaTelemetry,
} from "../src/lib/quota-telemetry.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

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

/** A fake OpenTelemetry API that the telemetry loads from now on. */
function installOtel(options: { throwOnAdd?: string } = {}) {
  const otel = createOtelHarness(options);
  __setQuotaTelemetryApiLoaderForTests(async () => otel.api);
  return otel;
}

const provider = (providerId: string, rows: QuotaRow[], extras: Partial<ProviderSnapshot> = {}) =>
  providerSnapshot(providerId, providerId, rows, extras);

/** One observation of "opencode.quota.consumed". */
const consumedSeries = (value: number, provider: string, window: string, resultType = "quota") => ({
  value,
  attributes: {
    "quota.provider": provider,
    "quota.window": window,
    "quota.result_type": resultType,
  },
});

function snapshot(...providers: ProviderSnapshot[]): QuotaSnapshot {
  return { version: 6, providers, resetNotices: [], generatedAtMs: 0 };
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
    const otel = installOtel();
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
    const otel = installOtel();
    const token = enable({});

    publishQuotaTelemetry(
      token,
      snapshot(
        provider(
          "openai",
          [
            row("openai.five_hour", {
              account: "account@example.com",
              window: "five_hour",
              percentRemaining: 25,
            }),
            row("openai.five_hour", {
              account: "another@example.com",
              window: "five_hour",
              percentRemaining: -20,
            }),
            row("openai.private", {
              label: "Private https://sensitive.example",
              percentRemaining: 120,
            }),
            row("openai.balance", {
              type: "balance",
              amount: { decimal: "42", unit: { kind: "currency", code: "USD" } },
            }),
          ],
          {
            okAtMs: Date.parse("2026-07-25T12:00:00.000Z"),
            error: { code: "provider_error", detail: "token secret" },
          },
        ),
        provider("private-customer-provider", [
          row("private-customer-provider.monthly", { percentRemaining: 50 }),
        ]),
      ),
    );
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
    expect(consumed).toContainEqual(consumedSeries(1, "openai", "five_hour"));
    expect(consumed).toContainEqual(consumedSeries(0.5, "other", "unknown"));
    expect(JSON.stringify(consumed)).not.toMatch(
      /account@example\.com|another@example\.com|sensitive\.example|token secret|42/,
    );

    expect(otel.collect("opencode.quota.cache.age")).toEqual([
      { value: 42, attributes: { "quota.provider": "openai" } },
    ]);
  });

  it.each([
    { name: "a weekly quota", extras: { window: "week" as const }, attributes: ["week", "quota"] },
    {
      name: "a monthly budget",
      extras: { window: "month" as const, type: "budget" as const },
      attributes: ["month", "budget"],
    },
    { name: "a row without a window", extras: {}, attributes: ["unknown", "quota"] },
  ])("names $name by the row's window and type", async ({ extras, attributes }) => {
    const otel = installOtel();
    publishQuotaTelemetry(
      enable({}),
      snapshot(
        provider("copilot", [
          row("copilot.row", { ...extras, percentRemaining: 40 }),
          row("copilot.spend", {
            type: "usage",
            amount: { decimal: "3", unit: { kind: "currency", code: "USD" } },
          }),
          row("copilot.enabled", { type: "status", flag: true }),
        ]),
      ),
    );
    await __flushQuotaTelemetryInitializationForTests();

    expect(otel.collect("opencode.quota.consumed")).toEqual([
      consumedSeries(0.6, "copilot", attributes[0], attributes[1]),
    ]);
  });

  it("maps aggregate sources to custom and reduces privacy-collapsed series by maximum", async () => {
    const otel = installOtel();
    publishQuotaTelemetry(
      enable({}),
      snapshot(
        provider("quota-providers", [
          row("quota-providers.team", { window: "month", percentRemaining: 70 }),
          row("quota-providers.gateway", { window: "month", percentRemaining: 40 }),
        ]),
        provider("private-a", [row("private-a.monthly", { percentRemaining: 80 })]),
        provider("private-b", [row("private-b.monthly", { percentRemaining: 30 })]),
      ),
    );
    await __flushQuotaTelemetryInitializationForTests();

    expect(otel.collect("opencode.quota.consumed")).toEqual([
      consumedSeries(0.6, "custom", "month"),
      consumedSeries(0.7, "other", "unknown"),
    ]);
  });

  it("replaces the owner's series with each snapshot and ages them from the last answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const otel = installOtel();
    const token = enable({});
    await __flushQuotaTelemetryInitializationForTests();
    const ages = (okAtMs: number | undefined, providerId = "copilot") => {
      publishQuotaTelemetry(
        token,
        snapshot(
          provider(providerId, [row(`${providerId}.m`, { percentRemaining: 50 })], { okAtMs }),
        ),
      );
      return otel.collect("opencode.quota.cache.age");
    };

    expect(ages(Date.now() - 10_000)).toEqual([
      { value: 10, attributes: { "quota.provider": "copilot" } },
    ]);
    // Before a provider ever answered there is no age; a clock that went back gives 0.
    expect(ages(undefined)).toEqual([]);
    expect(ages(Date.now() + 5_000)).toEqual([
      { value: 0, attributes: { "quota.provider": "copilot" } },
    ]);
    // A provider missing from the next snapshot leaves no series behind.
    ages(Date.now() - 1_000, "openai");
    expect(otel.collect("opencode.quota.consumed")).toEqual([
      consumedSeries(0.5, "openai", "unknown"),
    ]);
  });

  it("keeps owners isolated, rejects stale generations, and disposes cleanly", async () => {
    const otel = installOtel();
    const firstOwner = {};
    const secondOwner = {};
    const stale = enable(firstOwner, "config-a");
    const current = enable(firstOwner, "config-b");
    const second = enable(secondOwner);
    expect(current.generation).toBeGreaterThan(stale.generation);
    const weekly = (percentRemaining: number) =>
      snapshot(provider("copilot", [row("copilot.w", { window: "week", percentRemaining })]));

    publishQuotaTelemetry(stale, weekly(0));
    publishQuotaTelemetry(current, weekly(90));
    publishQuotaTelemetry(second, weekly(60));
    await __flushQuotaTelemetryInitializationForTests();
    expect(otel.collect("opencode.quota.consumed").map(({ value }) => value)).toEqual([0.4]);

    disposeQuotaTelemetryOwner(secondOwner);
    expect(otel.collect("opencode.quota.consumed").map(({ value }) => value)).toEqual([
      expect.closeTo(0.1),
    ]);
    configureQuotaTelemetry({ owner: firstOwner, enabled: false, identity: "config-b" });
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
    const brokenRegistration = installOtel({ throwOnAdd: "opencode.quota.cache.age" });
    expect(() => enable({})).not.toThrow();
    await expect(__flushQuotaTelemetryInitializationForTests()).resolves.toBeUndefined();
    expect(brokenRegistration.callbacks.size).toBe(0);

    __resetQuotaTelemetryForTests();
    const otel = installOtel();
    const token = enable({});
    publishQuotaTelemetry(
      token,
      snapshot(
        provider("openai", [
          row("openai.daily", { window: "day", percentRemaining: 50 }),
          row("openai.weekly", { window: "week", percentRemaining: 25 }),
        ]),
      ),
    );
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
    const otel = installOtel();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const setTimeout = vi.spyOn(globalThis, "setTimeout");

    enable({});
    await __flushQuotaTelemetryInitializationForTests();
    otel.collect("opencode.quota.consumed");

    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
