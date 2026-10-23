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
  return import(pathToFileURL(path.join(packageRoot, "dist", relativePath)));
}

const telemetry = await packageImport("lib/quota-telemetry.js");
const { buildQuotaExportFromSnapshot } = await packageImport("lib/quota-export.js");

/** A v6 quota snapshot of providers that each report one monthly percent row. */
function quotaSnapshot(providers) {
  return {
    version: 6,
    providers: providers.map(({ providerId, label, account, percentRemaining, okAtMs }) => ({
      providerId,
      label: providerId,
      rows: [
        {
          id: `${providerId}.month`,
          providerId,
          ...(account ? { account } : {}),
          label,
          type: "quota",
          method: "remote_api",
          authority: "provider_reported",
          window: "month",
          prominence: "primary",
          percentRemaining,
        },
      ],
      ...(okAtMs !== undefined ? { okAtMs } : {}),
      refreshing: false,
      debug: [],
    })),
    resetNotices: [],
    generatedAtMs: Date.now(),
    serverId: "packed-smoke",
    revision: 1,
  };
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
    const snapshot = quotaSnapshot([
      {
        providerId: "private-alpha",
        label: `Private ${secret}`,
        account: secret,
        percentRemaining: 60,
        okAtMs: base - 5_000,
      },
      {
        providerId: "private-beta",
        label: "Private beta",
        percentRemaining: 20,
        okAtMs: base - 9_000,
      },
    ]);
    // The export file and the gauges come from the same snapshot.
    const exported = buildQuotaExportFromSnapshot(snapshot);
    assert.equal(exported.version, 3);
    assert.equal(exported.providers["private-alpha"].status, "ok");
    assert.equal(exported.providers["private-beta"].status, "ok");
    assert.equal(exported.providers["private-alpha"].entries[0].percentRemaining, 60);
    assert.equal(exported.providers["private-beta"].entries[0].percentRemaining, 20);

    telemetry.publishQuotaTelemetry(token, snapshot);
    const first = await collect(sdk);
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
    for (const privateValue of [secret, "private-alpha", "private-beta"]) {
      assert.ok(!metricText.includes(privateValue));
    }
    assert.ok(JSON.stringify(exported).includes("private-alpha"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await collect(sdk);
    assert.ok(pointsFor(second, "opencode.quota.cache.age")[0].value >= firstAge[0].value);

    const copilotAge = async (okAtMs) => {
      telemetry.publishQuotaTelemetry(
        token,
        quotaSnapshot([{ providerId: "copilot", label: "Monthly", percentRemaining: 50, okAtMs }]),
      );
      return pointsFor(await collect(sdk), "opencode.quota.cache.age").filter(
        ({ attributes }) => attributes["quota.provider"] === "copilot",
      );
    };
    const recent = await copilotAge(base - 4_000);
    assert.equal(recent.length, 1);
    assert.ok(recent[0].value < 10);
    // A provider that never answered has no age; each snapshot replaces the last one.
    assert.equal((await copilotAge(undefined)).length, 0);
    assert.equal((await copilotAge(base - 2_000)).length, 1);

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

    telemetry.publishQuotaTelemetry(
      token,
      quotaSnapshot([{ providerId: "copilot", label: "Disabled", percentRemaining: 45 }]),
    );
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

  assert.doesNotThrow(() =>
    telemetry.publishQuotaTelemetry(
      token,
      quotaSnapshot([{ providerId: "copilot", label: "No provider", percentRemaining: 55 }]),
    ),
  );
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
  telemetry.publishQuotaTelemetry(
    observerToken,
    quotaSnapshot([
      {
        providerId: "copilot",
        label: "Observer",
        percentRemaining: 30,
        okAtMs: Date.now() - 1_000,
      },
    ]),
  );
  for (const callback of callbacks) {
    assert.doesNotThrow(() =>
      callback({
        observe() {
          throw new Error("host observer failed");
        },
      }),
    );
  }
  telemetry.disposeQuotaTelemetryOwner(owner);
}

/**
 * Saves an OpenRouter snapshot as OpenCode's store does, with the packaged modules and the
 * real provider (only its quota request is faked), for the packed CLI's `show --json`.
 */
async function runSeedProductionOpenRouter() {
  const { createCliQuotaClient } = await packageImport("lib/cli-show.js");
  const { loadSettings } = await packageImport("settings/index.js");
  const { PROVIDER_IDS } = await packageImport("settings/schema.js");
  const { loadProviderSource } = await packageImport("core/provider-source.js");
  const { createQuotaStore } = await packageImport("core/store.js");
  const { snapshotFilePath } = await packageImport("core/persist.js");
  const { getProviders } = await packageImport("providers/registry.js");
  const secret = process.env.OPENROUTER_API_KEY;
  assert.ok(secret);

  // The smoke folder is not in a git repository, so the terminal command uses it as is.
  const workspaceRoot = process.cwd();
  const loaded = await loadSettings({ projectDir: workspaceRoot });
  // Only OpenRouter is checked, as with `show --provider openrouter`.
  const settings = {
    ...loaded.settings,
    providers: {
      ...loaded.settings.providers,
      off: PROVIDER_IDS.filter((id) => id !== "openrouter"),
    },
  };
  const host = {
    client: createCliQuotaClient({
      directory: workspaceRoot,
      anthropicBinaryPath: settings.providers.anthropic.binaryPath,
    }),
    workspaceRoot,
    locationDirectory: workspaceRoot,
    settings: () => ({ ...loaded, settings }),
  };
  const provider = getProviders().find(({ id }) => id === "openrouter");
  assert.ok(provider);
  assert.equal(provider.cachePolicy?.kind, "resolved-auth");

  // OpenRouter's key endpoint answers a key with a $100 limit and $67 left.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/key");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    return new Response(JSON.stringify({ data: { usage: 33, limit: 100, limit_remaining: 67 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const store = createQuotaStore({
    source: () => loadProviderSource(host),
    file: snapshotFilePath(),
  });
  let snapshot;
  try {
    snapshot = await store.refresh({ reason: "manual" });
  } finally {
    await store.dispose();
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    snapshot.providers.map(({ providerId }) => providerId),
    ["openrouter"],
  );
  const exported = buildQuotaExportFromSnapshot(snapshot);
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
  metrics.disable();
}
