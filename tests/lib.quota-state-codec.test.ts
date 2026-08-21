// biome-ignore-all lint/suspicious/noExplicitAny: malformed-input tests intentionally mutate typed fixtures.
// biome-ignore-all lint/suspicious/noAssignInExpressions: compact mutation cases return their assignments.
// biome-ignore-all lint/style/noNonNullAssertion: fixture shape is asserted by the valid-result contract.
import { describe, expect, it } from "vitest";

import type { QuotaProviderResult } from "../src/lib/entries.js";
import {
  cloneQuotaProviderResult,
  decodePersistedQuotaProviderCacheEntry,
  encodePersistedQuotaProviderCacheEntry,
  normalizeQuotaProviderResult,
  QUOTA_PROVIDER_CACHE_VERSION,
} from "../src/lib/quota-state-codec.js";

const EXPECTED_IDENTITY = {
  packageVersion: "4.2.0",
  key: "synthetic|account=test",
  providerId: "synthetic",
} as const;

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
  sourceId: "synthetic",
  observedAtIso: "2026-08-21T12:34:56.000Z",
} as const;

function createValidResult(): QuotaProviderResult {
  return {
    attempted: true,
    entries: [
      {
        accounting: { ...ACCOUNTING, resultType: "budget" },
        kind: "percent",
        name: "Monthly budget",
        group: "Synthetic",
        label: "Monthly:",
        metricLabel: "Budget",
        right: "$75/$100",
        sortPriority: 1,
        resetTimeIso: "2026-09-01T00:00:00.000Z",
        percentRemaining: 75,
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "25.00", unit: { kind: "currency", code: "USD" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "100", unit: { kind: "currency", code: "USD" } },
            authority: "user_configured",
          },
          remaining: {
            quantity: { decimal: "75", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        },
      },
      {
        accounting: { ...ACCOUNTING, resultType: "status" },
        kind: "value",
        name: "Status",
        value: "Active",
      },
      {
        accounting: { ...ACCOUNTING, resultType: "balance" },
        kind: "quantity",
        name: "Balance",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "42.500", unit: { kind: "currency", code: "USD" } },
      },
      {
        accounting: { ...ACCOUNTING, resultType: "status" },
        kind: "boolean",
        name: "Auto-reload",
        semantic: {
          metric: { kind: "component", component: "auto_reload" },
          prominence: "supplementary",
        },
        value: true,
      },
    ],
    errors: [{ label: "Filtered", message: "Not selected", kind: "intentional-filter" }],
    diagnostics: [
      {
        sourceId: "synthetic",
        providerId: "synthetic-api",
        mode: "remote-api",
        format: "quota-v1",
        modelIds: ["model-a"],
        apiKeyEnv: "SYNTHETIC_API_KEY",
        selected: true,
        attempted: true,
        credentialSource: "explicit_env",
        outcome: "success",
        httpStatus: 200,
        entryCount: 4,
        checkedPaths: ["env:SYNTHETIC_API_KEY"],
        credentialDatabasePaths: ["/tmp/opencode.db"],
        statePath: "/tmp/state.json",
        stateHealth: "healthy",
        stateVersion: 2,
        stateLastUpdatedAt: 1_777_777_777_777,
      },
    ],
    statusDetails: [{ key: "plan", value: "Pro" }],
    rawDetails: [{ key: "raw_balance", value: "42.500" }],
    presentation: {
      singleWindowDisplayName: "Synthetic",
      singleWindowShowRight: true,
      redundantQuotaFamily: "synthetic",
      classicStrategy: "preserve",
    },
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createEnvelope(result: QuotaProviderResult = createValidResult()) {
  return encodePersistedQuotaProviderCacheEntry({
    ...EXPECTED_IDENTITY,
    timestamp: 1_777_777_777_777,
    result,
  });
}

function expectInvalidResult(value: unknown): void {
  expect(() => normalizeQuotaProviderResult(value)).not.toThrow();
  expect(normalizeQuotaProviderResult(value)).toBeNull();
}

function expectInvalidEnvelope(value: unknown): void {
  expect(() => decodePersistedQuotaProviderCacheEntry(value, EXPECTED_IDENTITY)).not.toThrow();
  expect(decodePersistedQuotaProviderCacheEntry(value, EXPECTED_IDENTITY)).toBeNull();
}

describe("quota-state codec", () => {
  it("normalizes all four entry variants and returns a deeply owned result", () => {
    const input = createValidResult();
    const normalized = normalizeQuotaProviderResult(input);

    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(normalized?.entries).not.toBe(input.entries);
    expect(normalized?.entries[0]).not.toBe(input.entries[0]);
    expect((normalized?.entries[0] as any).semantic).not.toBe((input.entries[0] as any).semantic);
    expect((normalized?.entries[0] as any).basis.limit.quantity).not.toBe(
      (input.entries[0] as any).basis.limit.quantity,
    );
    expect((normalized?.entries[2] as any).quantity).not.toBe((input.entries[2] as any).quantity);
    expect(normalized?.errors[0]).not.toBe(input.errors[0]);
    expect(normalized?.diagnostics?.[0]).not.toBe(input.diagnostics?.[0]);
    expect(normalized?.diagnostics?.[0]?.modelIds).not.toBe(input.diagnostics?.[0]?.modelIds);
    expect(normalized?.diagnostics?.[0]?.checkedPaths).not.toBe(
      input.diagnostics?.[0]?.checkedPaths,
    );
    expect(normalized?.statusDetails?.[0]).not.toBe(input.statusDetails?.[0]);
    expect(normalized?.rawDetails?.[0]).not.toBe(input.rawDetails?.[0]);
    expect(normalized?.presentation).not.toBe(input.presentation);

    (input.entries[0] as any).basis.limit.quantity.decimal = "1";
    input.diagnostics![0]!.checkedPaths[0] = "mutated";
    expect((normalized?.entries[0] as any).basis.limit.quantity.decimal).toBe("100");
    expect(normalized?.diagnostics?.[0]?.checkedPaths).toEqual(["env:SYNTHETIC_API_KEY"]);
  });

  it("sanitizes text before strict safe-text revalidation", () => {
    const input = createValidResult();
    const quantity = input.entries[2] as any;
    quantity.name = "Balance\u001b[31m";
    quantity.group = "Synthetic\u001b[0m";
    quantity.semantic = {
      metric: { kind: "named", name: "Known\u001b[31m API" },
      prominence: "primary",
    };
    quantity.quantity.unit = { kind: "custom", symbol: "NANO\u001b[31m" };
    input.errors[0] = { label: "Error\u001b[31m", message: "Unsafe\u001b[0m" };
    input.statusDetails = [{ key: "plan\u001b[31m", value: "Pro\u001b[0m" }];
    input.presentation = { singleWindowDisplayName: "Synthetic\u001b[31m" };

    const normalized = normalizeQuotaProviderResult(input);
    expect(normalized?.entries[2]).toMatchObject({
      name: "Balance",
      group: "Synthetic",
      semantic: { metric: { name: "Known API" } },
      quantity: { unit: { symbol: "NANO" } },
    });
    expect(normalized?.errors).toEqual([{ label: "Error", message: "Unsafe" }]);
    expect(normalized?.statusDetails).toEqual([{ key: "plan", value: "Pro" }]);
    expect(normalized?.presentation).toEqual({ singleWindowDisplayName: "Synthetic" });
  });

  it("accepts local-estimate diagnostics without a remote format", () => {
    const input = createValidResult();
    input.diagnostics = [
      {
        sourceId: "local",
        providerId: "local-provider",
        mode: "local-estimate",
        modelIds: null,
        apiKeyEnv: null,
        selected: true,
        attempted: true,
        credentialSource: null,
        outcome: "local_state_error",
        entryCount: 0,
        checkedPaths: [],
        credentialDatabasePaths: [],
        stateHealth: "malformed",
        stateVersion: null,
        stateLastUpdatedAt: null,
      },
    ];

    expect(normalizeQuotaProviderResult(input)).toEqual(input);
  });

  it("is total for JSON primitives, arrays, and incomplete result objects", () => {
    for (const value of [
      null,
      true,
      false,
      0,
      1.5,
      "result",
      [],
      [createValidResult()],
      {},
      { attempted: true },
      { attempted: true, entries: [] },
      { attempted: true, entries: [], errors: [], extra: true },
    ]) {
      expectInvalidResult(value);
    }
  });

  it("rejects sparse top-level and nested arrays", () => {
    const sparseEntries = createValidResult() as any;
    sparseEntries.entries = new Array(1);
    expectInvalidResult(sparseEntries);

    const sparseErrors = createValidResult() as any;
    sparseErrors.errors = new Array(1);
    expectInvalidResult(sparseErrors);

    const sparseDiagnostics = createValidResult() as any;
    sparseDiagnostics.diagnostics[0].checkedPaths = new Array(1);
    expectInvalidResult(sparseDiagnostics);
  });

  it.each([
    ["attempted must be boolean", (value: any) => (value.attempted = "yes")],
    ["result keys are exact", (value: any) => (value.extra = true)],
    ["entry keys are exact", (value: any) => (value.entries[0].extra = true)],
    [
      "accounting result type is closed",
      (value: any) => (value.entries[0].accounting.resultType = "other"),
    ],
    [
      "accounting acquisition is closed",
      (value: any) => (value.entries[0].accounting.acquisitionMethod = "other"),
    ],
    [
      "accounting ownership is closed",
      (value: any) => (value.entries[0].accounting.ownership = "other"),
    ],
    [
      "accounting authority is closed",
      (value: any) => (value.entries[0].accounting.authority = "other"),
    ],
    ["accounting keys are exact", (value: any) => (value.entries[0].accounting.extra = true)],
    [
      "observed timestamp is strict ISO",
      (value: any) => (value.entries[0].accounting.observedAtIso = "08/21/2026"),
    ],
    [
      "reset timestamp is strict ISO",
      (value: any) => (value.entries[0].resetTimeIso = "next week"),
    ],
    [
      "sort priority is finite",
      (value: any) => (value.entries[0].sortPriority = Number.POSITIVE_INFINITY),
    ],
    [
      "semantic prominence is closed",
      (value: any) => (value.entries[0].semantic.prominence = "other"),
    ],
    [
      "window metric is closed",
      (value: any) => (value.entries[0].semantic.metric.window = "quarter"),
    ],
    ["semantic keys are exact", (value: any) => (value.entries[0].semantic.extra = true)],
    ["percent is finite", (value: any) => (value.entries[0].percentRemaining = Number.NaN)],
    ["percentage basis is nonempty", (value: any) => (value.entries[0].basis = {})],
    [
      "basis decimals are canonical",
      (value: any) => (value.entries[0].basis.used.quantity.decimal = "01"),
    ],
    [
      "basis quantities are nonnegative",
      (value: any) => (value.entries[0].basis.used.quantity.decimal = "-1"),
    ],
    [
      "basis units match",
      (value: any) =>
        (value.entries[0].basis.limit.quantity.unit = { kind: "count", unit: "token" }),
    ],
    [
      "basis fact authority is closed",
      (value: any) => (value.entries[0].basis.used.authority = "other"),
    ],
    ["value rows require strings", (value: any) => (value.entries[1].value = true)],
    ["quantity rows require semantics", (value: any) => delete value.entries[2].semantic],
    [
      "quantity decimals are canonical",
      (value: any) => (value.entries[2].quantity.decimal = "1e2"),
    ],
    ["currency codes are uppercase", (value: any) => (value.entries[2].quantity.unit.code = "usd")],
    ["boolean rows require booleans", (value: any) => (value.entries[3].value = "true")],
    ["error kinds are closed", (value: any) => (value.errors[0].kind = "warning")],
    ["error keys are exact", (value: any) => (value.errors[0].extra = true)],
    ["diagnostic modes are closed", (value: any) => (value.diagnostics[0].mode = "other")],
    ["remote diagnostics require format", (value: any) => delete value.diagnostics[0].format],
    [
      "diagnostic formats are closed",
      (value: any) => (value.diagnostics[0].format = "accounting-v1"),
    ],
    ["diagnostic selection is exact", (value: any) => (value.diagnostics[0].selected = false)],
    [
      "credential sources are closed",
      (value: any) => (value.diagnostics[0].credentialSource = "other"),
    ],
    ["diagnostic outcomes are closed", (value: any) => (value.diagnostics[0].outcome = "other")],
    ["diagnostic status is bounded", (value: any) => (value.diagnostics[0].httpStatus = 99)],
    [
      "diagnostic entry count is nonnegative",
      (value: any) => (value.diagnostics[0].entryCount = -1),
    ],
    [
      "diagnostic state health is closed",
      (value: any) => (value.diagnostics[0].stateHealth = "other"),
    ],
    [
      "diagnostic state version is nonnegative",
      (value: any) => (value.diagnostics[0].stateVersion = -1),
    ],
    [
      "diagnostic update time is finite",
      (value: any) => (value.diagnostics[0].stateLastUpdatedAt = Number.NaN),
    ],
    ["status detail keys are exact", (value: any) => (value.statusDetails[0].extra = true)],
    ["raw detail values are strings", (value: any) => (value.rawDetails[0].value = 42)],
    ["presentation keys are exact", (value: any) => (value.presentation.extra = true)],
    [
      "presentation strategy is closed",
      (value: any) => (value.presentation.classicStrategy = "other"),
    ],
  ])("rejects invalid nested data: %s", (_name, mutate) => {
    const value = cloneJson(createValidResult()) as any;
    mutate(value);
    expectInvalidResult(value);
  });

  it("rejects text that sanitizes to an invalid named metric or custom unit", () => {
    const invalidMetric = createValidResult() as any;
    invalidMetric.entries[2].semantic = {
      metric: { kind: "named", name: "\u001b[31m" },
      prominence: "primary",
    };
    expectInvalidResult(invalidMetric);

    const invalidSymbol = createValidResult() as any;
    invalidSymbol.entries[2].quantity.unit = { kind: "custom", symbol: "\u001b[31m" };
    expectInvalidResult(invalidSymbol);
  });

  it("clones known safe results without sharing nested mutable state", () => {
    const input = createValidResult();
    const cloned = cloneQuotaProviderResult(input);

    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect((cloned.entries[0] as any).basis.limit.quantity).not.toBe(
      (input.entries[0] as any).basis.limit.quantity,
    );
    expect(cloned.diagnostics?.[0]?.credentialDatabasePaths).not.toBe(
      input.diagnostics?.[0]?.credentialDatabasePaths,
    );
  });

  it("encodes V2 and round-trips parsed envelopes by semantic value", () => {
    const input = createValidResult();
    const encoded = createEnvelope(input);

    expect(encoded).toEqual({
      version: QUOTA_PROVIDER_CACHE_VERSION,
      ...EXPECTED_IDENTITY,
      timestamp: 1_777_777_777_777,
      result: input,
    });
    expect(encoded.result).not.toBe(input);
    expect((encoded.result.entries[0] as any).basis).not.toBe((input.entries[0] as any).basis);

    const parsed = JSON.parse(JSON.stringify(encoded)) as unknown;
    const decoded = decodePersistedQuotaProviderCacheEntry(parsed, EXPECTED_IDENTITY);
    expect(decoded).toEqual(encoded);
    expect(decoded).not.toBe(parsed);
    expect(decoded?.result).not.toBe((parsed as any).result);
    expect((decoded?.result.entries[0] as any).basis.limit.quantity).not.toBe(
      (parsed as any).result.entries[0].basis.limit.quantity,
    );
  });

  it("is total for parsed non-object envelopes", () => {
    for (const value of [null, true, false, 0, 1.5, "cache", [], [createEnvelope()], {}]) {
      expectInvalidEnvelope(value);
    }
  });

  it("rejects missing and extra envelope keys", () => {
    for (const key of ["version", "packageVersion", "key", "providerId", "timestamp", "result"]) {
      const value = { ...createEnvelope() } as Record<string, unknown>;
      delete value[key];
      expectInvalidEnvelope(value);
    }
    expectInvalidEnvelope({ ...createEnvelope(), extra: true });
  });

  it.each([
    ["V1", { version: 1 }],
    ["future versions", { version: 3 }],
    ["package identity", { packageVersion: "4.2.1" }],
    ["cache key identity", { key: "other" }],
    ["provider identity", { providerId: "other" }],
    ["string timestamps", { timestamp: "1777777777777" }],
    ["NaN timestamps", { timestamp: Number.NaN }],
    ["infinite timestamps", { timestamp: Number.POSITIVE_INFINITY }],
  ])("rejects envelope mismatch: %s", (_name, override) => {
    expectInvalidEnvelope({ ...createEnvelope(), ...override });
  });

  it("rejects a deeply invalid result without throwing", () => {
    const value = createEnvelope() as any;
    value.result.entries[0].basis.limit.quantity.unit.code = "usd";
    expectInvalidEnvelope(value);
  });

  it("rejects sparse nested envelope data without throwing", () => {
    const value = createEnvelope() as any;
    value.result.diagnostics[0].modelIds = new Array(1);
    expectInvalidEnvelope(value);
  });
});
