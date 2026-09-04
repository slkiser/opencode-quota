import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const scenario = process.argv[2];
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@slkiser/opencode-quota"))),
  "..",
);

function packageImport(relativePath) {
  return import(pathToFileURL(path.join(packageRoot, "dist", "lib", relativePath)));
}

const telemetry = await packageImport("quota-telemetry.js");
const quotaState = await packageImport("quota-state.js");
const { buildQuotaExport } = await packageImport("quota-export.js");

function accounting(overrides = {}) {
  return {
    resultType: "quota",
    acquisitionMethod: "remote_api",
    ownership: "user_configured",
    authority: "provider_reported",
    ...overrides,
  };
}

function result({ name, percentRemaining, sourceId, secret }) {
  return {
    attempted: true,
    entries: [
      {
        name,
        label: "Month:",
        percentRemaining,
        accounting: accounting({ sourceId }),
      },
    ],
    errors: secret ? [{ label: "sanitized", message: "HTTP 503" }] : [],
  };
}

function createContext(token) {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    resolveRuntimeProviderIds: async () => new Set(),
    config: {
      googleModels: [],
      cursorPlan: "auto",
      enabledProviders: "auto",
      quotaProviders: [],
      telemetryToken: token,
    },
  };
}

function createProvider(id, providerResult, counter) {
  return {
    id,
    cachePolicy: { kind: "account-neutral" },
    isAvailable: async () => true,
    fetch: async () => {
      counter.count += 1;
      return providerResult;
    },
  };
}

async function fetchAt({ provider, ctx, timestamp }) {
  const originalNow = Date.now;
  Date.now = () => timestamp;
  try {
    return await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
  } finally {
    Date.now = originalNow;
  }
}

function createSdk() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  assert.equal(metrics.setGlobalMeterProvider(provider), true);
  return { exporter, provider, reader };
}

async function collect({ exporter, provider, reader }) {
  exporter.reset();
  await provider.forceFlush();
  const { resourceMetrics, errors } = await reader.collect();
  assert.deepEqual(errors, []);
  return resourceMetrics.scopeMetrics
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .flatMap((metric) =>
      metric.dataPoints.map((point) => ({
        metric: metric.descriptor.name,
        value: point.value,
        attributes: point.attributes,
      })),
    );
}

function pointsFor(observations, metric) {
  return observations.filter((observation) => observation.metric === metric);
}

async function runHappyPath() {
  const sdk = createSdk();
  try {
    const owner = {};
    const token = telemetry.configureQuotaTelemetry({
      owner,
      enabled: true,
      identity: "packed-real-sdk",
    });
    assert.ok(token);
    await telemetry.__flushQuotaTelemetryInitializationForTests();

    const base = Date.now();
    const secret = "packed-otel-secret-canary";
    const counters = [{ count: 0 }, { count: 0 }];
    const providers = [
      createProvider(
        "private-alpha",
        result({
          name: `Private ${secret}`,
          percentRemaining: 60,
          sourceId: "private-source-alpha",
        }),
        counters[0],
      ),
      createProvider(
        "private-beta",
        result({
          name: "Private beta",
          percentRemaining: 20,
          sourceId: "private-source-beta",
          secret,
        }),
        counters[1],
      ),
    ];
    const ctx = createContext(token);

    await fetchAt({ provider: providers[0], ctx, timestamp: base - 5_000 });
    await fetchAt({ provider: providers[1], ctx, timestamp: base - 9_000 });
    assert.deepEqual(
      counters.map(({ count }) => count),
      [1, 1],
    );

    const requestsBeforePassiveReads = counters.map(({ count }) => count);
    const exported = await buildQuotaExport({ providers, ctx, ttlMs: 60_000, fromCache: true });
    assert.equal(exported.version, 2);
    assert.equal(exported.providers["private-alpha"].status, "ok");
    assert.equal(exported.providers["private-beta"].status, "partial");
    assert.equal(exported.providers["private-alpha"].entries[0].percentRemaining, 60);
    assert.equal(exported.providers["private-beta"].entries[0].percentRemaining, 20);
    assert.deepEqual(
      counters.map(({ count }) => count),
      requestsBeforePassiveReads,
    );

    const first = await collect(sdk);
    assert.deepEqual(
      counters.map(({ count }) => count),
      requestsBeforePassiveReads,
    );
    const consumed = pointsFor(first, "opencode.quota.consumed");
    assert.deepEqual(consumed, [
      {
        metric: "opencode.quota.consumed",
        value: 0.8,
        attributes: {
          "quota.provider": "other",
          "quota.window": "month",
          "quota.result_type": "quota",
        },
      },
    ]);
    const firstAge = pointsFor(first, "opencode.quota.cache.age");
    assert.equal(firstAge.length, 1);
    assert.deepEqual(firstAge[0].attributes, { "quota.provider": "other" });
    assert.ok(Math.abs(firstAge[0].value - exported.cacheAgeSeconds) <= 1);

    const metricText = JSON.stringify(first);
    for (const privateValue of [
      secret,
      "private-alpha",
      "private-beta",
      "private-source-alpha",
      "private-source-beta",
    ]) {
      assert.ok(!metricText.includes(privateValue));
    }
    assert.ok(JSON.stringify(exported).includes("private-alpha"));
    assert.ok(JSON.stringify(exported).includes("private-source-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await collect(sdk);
    assert.deepEqual(
      counters.map(({ count }) => count),
      requestsBeforePassiveReads,
    );
    assert.ok(pointsFor(second, "opencode.quota.cache.age")[0].value >= firstAge[0].value);

    const orderingResult = result({
      name: "Ordering",
      percentRemaining: 50,
      sourceId: "ordering-private",
    });
    telemetry.updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "ordering:cached",
      providerId: "copilot",
      cacheTimestamp: base - 4_000,
      result: orderingResult,
    });
    telemetry.updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "ordering:cached",
      providerId: "copilot",
      cacheTimestamp: base - 20_000,
      result: orderingResult,
    });
    let ordering = await collect(sdk);
    const orderedAge = pointsFor(ordering, "opencode.quota.cache.age").find(
      ({ attributes }) => attributes["quota.provider"] === "copilot",
    );
    assert.ok(orderedAge);
    assert.ok(orderedAge.value < 10);

    telemetry.updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "ordering:uncached",
      supersededSnapshotIds: ["ordering:cached"],
      providerId: "copilot",
      result: orderingResult,
    });
    ordering = await collect(sdk);
    assert.equal(
      pointsFor(ordering, "opencode.quota.cache.age").some(
        ({ attributes }) => attributes["quota.provider"] === "copilot",
      ),
      false,
    );

    telemetry.updateQuotaTelemetrySnapshot({
      token,
      snapshotId: "ordering:cached",
      supersededSnapshotIds: ["ordering:uncached"],
      providerId: "copilot",
      cacheTimestamp: base - 2_000,
      result: orderingResult,
    });
    ordering = await collect(sdk);
    assert.equal(
      pointsFor(ordering, "opencode.quota.cache.age").filter(
        ({ attributes }) => attributes["quota.provider"] === "copilot",
      ).length,
      1,
    );

    telemetry.disposeQuotaTelemetryOwner(owner);
    const disposed = await collect(sdk);
    assert.equal(disposed.length, 0);
  } finally {
    await sdk.provider.shutdown();
  }
}

async function runDisabled() {
  const sdk = createSdk();
  try {
    const token = telemetry.configureQuotaTelemetry({
      owner: {},
      enabled: false,
      identity: "packed-disabled",
    });
    assert.equal(token, undefined);
    await telemetry.__flushQuotaTelemetryInitializationForTests();

    const counter = { count: 0 };
    const provider = createProvider(
      "private-disabled",
      result({ name: "Disabled", percentRemaining: 45, sourceId: "disabled-source" }),
      counter,
    );
    const ctx = createContext(token);
    await fetchAt({ provider, ctx, timestamp: Date.now() - 1_000 });
    const exported = await buildQuotaExport({
      providers: [provider],
      ctx,
      ttlMs: 60_000,
      fromCache: true,
    });
    assert.equal(exported.providers[provider.id].status, "ok");
    assert.equal(counter.count, 1);
    assert.equal((await collect(sdk)).length, 0);
  } finally {
    await sdk.provider.shutdown();
  }
}

async function runNoGlobalProvider() {
  const owner = {};
  const token = telemetry.configureQuotaTelemetry({
    owner,
    enabled: true,
    identity: "packed-no-global-provider",
  });
  assert.ok(token);
  await telemetry.__flushQuotaTelemetryInitializationForTests();

  const counter = { count: 0 };
  const provider = createProvider(
    "private-no-provider",
    result({ name: "No provider", percentRemaining: 55, sourceId: "no-provider-source" }),
    counter,
  );
  const ctx = createContext(token);
  await fetchAt({ provider, ctx, timestamp: Date.now() - 1_000 });
  const exported = await buildQuotaExport({
    providers: [provider],
    ctx,
    ttlMs: 60_000,
    fromCache: true,
  });
  assert.equal(exported.providers[provider.id].status, "ok");
  assert.equal(counter.count, 1);
  telemetry.disposeQuotaTelemetryOwner(owner);
}

async function runFailingInfrastructure() {
  telemetry.__setQuotaTelemetryApiLoaderForTests(async () => {
    throw new Error("loader unavailable");
  });
  const loaderToken = telemetry.configureQuotaTelemetry({
    owner: {},
    enabled: true,
    identity: "packed-failing-loader",
  });
  assert.ok(loaderToken);
  await telemetry.__flushQuotaTelemetryInitializationForTests();

  telemetry.__resetQuotaTelemetryForTests();
  telemetry.__setQuotaTelemetryApiLoaderForTests(async () => ({
    metrics: {
      getMeter() {
        throw new Error("registration unavailable");
      },
    },
  }));
  const registrationToken = telemetry.configureQuotaTelemetry({
    owner: {},
    enabled: true,
    identity: "packed-failing-registration",
  });
  assert.ok(registrationToken);
  await telemetry.__flushQuotaTelemetryInitializationForTests();

  telemetry.__resetQuotaTelemetryForTests();
  const callbacks = [];
  telemetry.__setQuotaTelemetryApiLoaderForTests(async () => ({
    metrics: {
      getMeter: () => ({
        createObservableGauge: () => ({
          addCallback(callback) {
            callbacks.push(callback);
          },
          removeCallback() {},
        }),
      }),
    },
  }));
  const owner = {};
  const observerToken = telemetry.configureQuotaTelemetry({
    owner,
    enabled: true,
    identity: "packed-failing-observer",
  });
  assert.ok(observerToken);
  await telemetry.__flushQuotaTelemetryInitializationForTests();
  telemetry.updateQuotaTelemetrySnapshot({
    token: observerToken,
    snapshotId: "observer",
    providerId: "copilot",
    cacheTimestamp: Date.now() - 1_000,
    result: result({ name: "Observer", percentRemaining: 30, sourceId: "observer-private" }),
  });
  for (const callback of callbacks) {
    assert.doesNotThrow(() =>
      callback({
        observe() {
          throw new Error("host observer failed");
        },
      }),
    );
  }

  const counter = { count: 0 };
  const provider = createProvider(
    "private-failing-infrastructure",
    result({ name: "Still usable", percentRemaining: 35, sourceId: "failure-source" }),
    counter,
  );
  const ctx = createContext(observerToken);
  await fetchAt({ provider, ctx, timestamp: Date.now() - 1_000 });
  const exported = await buildQuotaExport({
    providers: [provider],
    ctx,
    ttlMs: 60_000,
    fromCache: true,
  });
  assert.equal(exported.providers[provider.id].status, "ok");
  assert.equal(counter.count, 1);
  telemetry.disposeQuotaTelemetryOwner(owner);
}

async function runSeedProductionOpenRouter() {
  const { createCliQuotaClient, resolveCliRoots } = await packageImport("cli-show.js");
  const { createExportProviderContext } = await packageImport("quota-export.js");
  const { resolveQuotaRuntimeContext } = await packageImport("quota-runtime-context.js");
  const secret = process.env.OPENROUTER_API_KEY;
  assert.ok(secret);

  const roots = resolveCliRoots(process.cwd());
  const client = createCliQuotaClient({ configRootDir: roots.configRoot });
  const runtime = await resolveQuotaRuntimeContext({
    client,
    roots,
    includeSessionMeta: false,
  });
  const ctx = createExportProviderContext(runtime);
  const provider = runtime.providers.find(({ id }) => id === "openrouter");
  assert.ok(provider);
  assert.equal(provider.cachePolicy?.kind, "resolved-auth");
  provider.fetch = async () =>
    result({
      name: "Packed production OpenRouter",
      percentRemaining: 67,
      sourceId: "openrouter",
    });

  await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
  const exported = await buildQuotaExport({
    providers: [provider],
    ctx,
    ttlMs: 60_000,
    fromCache: true,
  });
  assert.equal(exported.providers.openrouter.status, "ok");
  assert.equal(exported.providers.openrouter.entries[0].percentRemaining, 67);
  assert.ok(!JSON.stringify(exported).includes(secret));
}

try {
  if (scenario === "happy") await runHappyPath();
  else if (scenario === "disabled") await runDisabled();
  else if (scenario === "no-global-provider") await runNoGlobalProvider();
  else if (scenario === "failing-infrastructure") await runFailingInfrastructure();
  else if (scenario === "seed-production-openrouter") await runSeedProductionOpenRouter();
  else throw new Error(`Unknown packed real OpenTelemetry scenario: ${scenario}`);
  console.log(`Packed real OpenTelemetry scenario passed: ${scenario}`);
} finally {
  telemetry.__resetQuotaTelemetryForTests();
  quotaState.__resetQuotaStateForTests();
  metrics.disable();
}
