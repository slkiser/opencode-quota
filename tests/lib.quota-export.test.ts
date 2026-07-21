import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --------------- mock modules ---------------

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/tmp/test-opencode-quota-export/data",
    configDir: "/tmp/test-opencode-quota-export/config",
    cacheDir: "/tmp/test-opencode-quota-export/cache",
    stateDir: "/tmp/test-opencode-quota-export/state",
  }),
}));

vi.mock("../src/lib/atomic-json.js", () => ({
  writeJsonAtomic: vi.fn(),
}));

// Mock readCachedProviderResult — each test sets it up via the hoisted ref.
const { mockReadCachedProviderResult } = vi.hoisted(() => {
  const mockReadCachedProviderResult = vi.fn();
  return { mockReadCachedProviderResult };
});

vi.mock("../src/lib/quota-state.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-state.js")>(
    "../src/lib/quota-state.js",
  );
  return {
    ...actual,
    readCachedProviderResult: mockReadCachedProviderResult,
  };
});

// --------------- imports ---------------

import { writeJsonAtomic } from "../src/lib/atomic-json.js";
import {
  accountingContractExport,
  accountingContractResult,
} from "./fixtures/accounting-contract.js";
import { resolveExportPath, buildQuotaExport, writeQuotaExport } from "../src/lib/quota-export.js";

// --------------- helpers ---------------

function createMockProvider(id: string) {
  return {
    id,
    isAvailable: vi.fn(),
    fetch: vi.fn(),
  };
}

function createMockContext(): any {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    config: {
      googleModels: ["CLAUDE"],
      anthropicBinaryPath: "claude",
      cursorPlan: "none",
      onlyCurrentModel: false,
    },
    session: {},
  };
}

const QUOTA_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

// --------------- describe blocks ---------------

describe("resolveExportPath", () => {
  it("handles empty, tilde, absolute, and relative paths", () => {
    expect(resolveExportPath("")).toBe("/tmp/test-opencode-quota-export/cache/quota-export.json");
    expect(resolveExportPath("~/my-exports/quota.json")).toBe(
      join(homedir(), "my-exports/quota.json"),
    );
    expect(resolveExportPath("/etc/opencode/export.json")).toBe("/etc/opencode/export.json");
    expect(resolveExportPath("relative/path/quota.json")).toBe("relative/path/quota.json");
  });
});

describe("buildQuotaExport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    mockReadCachedProviderResult.mockReset();
  });

  it("returns status ok and maps cached entries into export rows", async () => {
    mockReadCachedProviderResult.mockResolvedValue({
      hit: true,
      result: {
        attempted: true,
        entries: [
          {
            accounting: QUOTA_ACCOUNTING,
            name: "Copilot",
            percentRemaining: 75,
            resetTimeIso: "2026-07-01T00:00:00.000Z",
            label: "Monthly:",
          },
          {
            accounting: QUOTA_ACCOUNTING,
            name: "OpenCode Go",
            kind: "value",
            value: "$42.50",
            label: "Weekly:",
          },
          {
            accounting: QUOTA_ACCOUNTING,
            name: "Custom Metric",
            percentRemaining: 100,
            label: "Arbitrary:",
          },
          // Name matches a window keyword ("Monthly") but the label does not:
          // window must be derived from label only, so this stays undefined.
          {
            accounting: QUOTA_ACCOUNTING,
            name: "Monthly Premium Requests",
            percentRemaining: 40,
            label: "Usage:",
          },
        ],
        errors: [],
      },
      timestamp: new Date("2026-06-01T11:00:00.000Z").getTime(),
    });

    const exportData = await buildQuotaExport({
      providers: [createMockProvider("copilot")],
      ctx: createMockContext(),
      ttlMs: 60_000,
      fromCache: true,
    });

    expect(exportData.version).toBe(2);
    expect(exportData.fromCache).toBe(true);
    expect(exportData.exportedAt).toBe(Math.floor(Date.now() / 1000));

    const provider = exportData.providers.copilot;
    expect(provider).toBeDefined();
    expect(provider.status).toBe("ok");

    if (provider.status === "ok") {
      expect(provider.entries).toEqual([
        {
          name: "Copilot",
          ...QUOTA_ACCOUNTING,
          renderType: "percent",
          percentRemaining: 75,
          resetAt: Math.floor(new Date("2026-07-01T00:00:00.000Z").getTime() / 1000),
          window: "Monthly",
        },
        {
          name: "OpenCode Go",
          ...QUOTA_ACCOUNTING,
          renderType: "value",
          value: "$42.50",
          window: "Weekly",
        },
        {
          name: "Custom Metric",
          ...QUOTA_ACCOUNTING,
          renderType: "percent",
          percentRemaining: 100,
        },
        {
          name: "Monthly Premium Requests",
          ...QUOTA_ACCOUNTING,
          renderType: "percent",
          percentRemaining: 40,
        },
      ]);
    }
  });

  it("matches the v2 all-result-types JSON golden", async () => {
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    mockReadCachedProviderResult.mockResolvedValue({
      hit: true,
      result: accountingContractResult,
      timestamp: new Date("2026-07-10T23:59:00.000Z").getTime(),
    });

    const actual = await buildQuotaExport({
      providers: [createMockProvider("fixture")],
      ctx: createMockContext(),
      ttlMs: 60_000,
      fromCache: true,
    });
    const golden = JSON.parse(
      readFileSync(
        new URL("./fixtures/quota-export-v2-all-result-types.json", import.meta.url),
        "utf8",
      ),
    );

    expect(actual).toEqual(accountingContractExport);
    expect(actual).toEqual(golden);
  });

  it("omits invalid optional timestamps instead of exporting NaN", async () => {
    mockReadCachedProviderResult.mockResolvedValue({
      hit: true,
      result: {
        attempted: true,
        entries: [
          {
            accounting: { ...QUOTA_ACCOUNTING, observedAtIso: "not-a-date" },
            name: "Invalid timestamps",
            percentRemaining: 50,
            resetTimeIso: "also-not-a-date",
          },
        ],
        errors: [],
      },
      timestamp: Date.now(),
    });

    const actual = await buildQuotaExport({
      providers: [createMockProvider("fixture")],
      ctx: createMockContext(),
      ttlMs: 60_000,
      fromCache: true,
    });
    expect(actual.providers.fixture).toMatchObject({
      status: "ok",
      entries: [
        {
          name: "Invalid timestamps",
          ...QUOTA_ACCOUNTING,
          renderType: "percent",
          percentRemaining: 50,
        },
      ],
    });
  });

  it("exports flat quota-provider definition entry identity and ordered coarse source statuses", async () => {
    const ctx = createMockContext();
    ctx.config.quotaProviders = [
      {
        id: "same-label-one",
        providerId: "gateway-one",
        label: "Same label",
        mode: "remote-api",
        url: "https://secret-one.example/accounting",
        format: "accounting-v1",
        apiKeyEnv: "GATEWAY_ONE_KEY",
      },
      {
        id: "same-label-two",
        providerId: "gateway-two",
        label: "Same label",
        mode: "remote-api",
        url: "https://secret-two.example/accounting",
        format: "accounting-v1",
      },
      {
        id: "not-selected",
        providerId: "gateway-three",
        label: "Not selected",
        mode: "remote-api",
        url: "https://secret-three.example/accounting",
        format: "accounting-v1",
      },
    ];
    mockReadCachedProviderResult.mockResolvedValue({
      hit: true,
      result: {
        attempted: true,
        entries: [
          {
            accounting: {
              ...QUOTA_ACCOUNTING,
              ownership: "user_configured",
              sourceId: "same-label-one",
            },
            name: "Same label",
            percentRemaining: 25,
          },
        ],
        errors: [{ label: "Same label", message: "secondary source unavailable" }],
        diagnostics: [
          {
            sourceId: "same-label-one",
            providerId: "gateway-one",
            format: "accounting-v1",
            modelIds: null,
            apiKeyEnv: "GATEWAY_ONE_KEY",
            selected: true,
            attempted: true,
            credentialSource: "explicit_env",
            outcome: "success",
            entryCount: 1,
            checkedPaths: ["env:GATEWAY_ONE_KEY"],
            authPaths: ["/trusted/auth.json"],
          },
          {
            sourceId: "same-label-two",
            providerId: "gateway-two",
            format: "accounting-v1",
            modelIds: null,
            apiKeyEnv: null,
            selected: true,
            attempted: true,
            credentialSource: "auth_json",
            outcome: "invalid_json",
            entryCount: 0,
            checkedPaths: ["/trusted/opencode.json"],
            authPaths: ["/trusted/auth.json"],
          },
        ],
      },
      timestamp: Date.now(),
    });

    const actual = await buildQuotaExport({
      providers: [createMockProvider("quota-providers")],
      ctx,
      ttlMs: 60_000,
      fromCache: true,
    });

    expect(actual.version).toBe(2);
    expect(actual.providers["quota-providers"]).toMatchObject({
      status: "partial",
      entries: [expect.objectContaining({ sourceId: "same-label-one", percentRemaining: 25 })],
      errors: [{ label: "Same label", message: "secondary source unavailable" }],
      sources: [
        { id: "same-label-one", providerId: "gateway-one", status: "ok", entryCount: 1 },
        { id: "same-label-two", providerId: "gateway-two", status: "error", entryCount: 0 },
        {
          id: "not-selected",
          providerId: "gateway-three",
          status: "unavailable",
          entryCount: 0,
        },
      ],
    });
    const customProvider = actual.providers["quota-providers"];
    expect(customProvider.sources?.map((source) => Object.keys(source))).toEqual([
      ["id", "providerId", "status", "entryCount"],
      ["id", "providerId", "status", "entryCount"],
      ["id", "providerId", "status", "entryCount"],
    ]);
    const json = JSON.stringify(actual);
    expect(json).not.toContain("invalid_json");
    expect(json).not.toContain("private raw failure");
    expect(json).not.toContain("secret-one.example");
    expect(json).not.toContain("GATEWAY_ONE_KEY");
    expect(json).not.toContain("/trusted/auth.json");
  });

  it("returns ordered unavailable quota-provider definitions when the cache has no aggregate entry", async () => {
    const ctx = createMockContext();
    ctx.config.quotaProviders = [
      {
        id: "first",
        providerId: "gateway-one",
        label: "First",
        mode: "remote-api",
        url: "https://one.example/accounting",
        format: "accounting-v1",
      },
      {
        id: "second",
        providerId: "gateway-two",
        label: "Second",
        mode: "remote-api",
        url: "https://two.example/accounting",
        format: "accounting-v1",
      },
    ];
    mockReadCachedProviderResult.mockResolvedValue({ hit: false });

    const actual = await buildQuotaExport({
      providers: [createMockProvider("quota-providers")],
      ctx,
      ttlMs: 60_000,
      fromCache: true,
    });

    expect(actual.providers["quota-providers"]).toEqual({
      status: "unavailable",
      sources: [
        { id: "first", providerId: "gateway-one", status: "unavailable", entryCount: 0 },
        { id: "second", providerId: "gateway-two", status: "unavailable", entryCount: 0 },
      ],
    });
  });

  it("returns status unavailable when provider has no cache entry", async () => {
    mockReadCachedProviderResult.mockResolvedValue({ hit: false });

    const exportData = await buildQuotaExport({
      providers: [createMockProvider("ghost")],
      ctx: createMockContext(),
      ttlMs: 60_000,
      fromCache: true,
    });

    expect(exportData.providers.ghost).toEqual({ status: "unavailable" });
  });

  it("returns status error with a sanitized message when cache has only errors", async () => {
    mockReadCachedProviderResult.mockResolvedValue({
      hit: true,
      result: {
        attempted: true,
        entries: [],
        // Includes an ANSI escape + control chars + newline that must be stripped.
        errors: [{ label: "Fetch", message: "Request failed\n\u001b[31mwith 429\u0007" }],
      },
      timestamp: new Date("2026-06-01T11:00:00.000Z").getTime(),
    });

    const exportData = await buildQuotaExport({
      providers: [createMockProvider("broken")],
      ctx: createMockContext(),
      ttlMs: 60_000,
      fromCache: true,
    });

    expect(exportData.providers.broken).toEqual({
      status: "error",
      fetchedAt: Math.floor(new Date("2026-06-01T11:00:00.000Z").getTime() / 1000),
      error: "Request failed with 429",
    });
  });

  it("computes cacheAgeSeconds from oldest fetchedAt across ok/error providers", async () => {
    mockReadCachedProviderResult
      .mockResolvedValueOnce({
        hit: true,
        result: {
          attempted: true,
          entries: [{ accounting: QUOTA_ACCOUNTING, name: "A", percentRemaining: 90 }],
          errors: [],
        },
        timestamp: new Date("2026-06-01T10:00:00.000Z").getTime(), // 2h old
      })
      .mockResolvedValueOnce({
        hit: true,
        result: { attempted: true, entries: [], errors: [{ label: "E", message: "err" }] },
        timestamp: new Date("2026-06-01T11:30:00.000Z").getTime(), // 30m old
      });

    const exportData = await buildQuotaExport({
      providers: [createMockProvider("a"), createMockProvider("b")],
      ctx: createMockContext(),
      ttlMs: 60_000,
      fromCache: true,
    });

    // Oldest is "a" at 10:00, now is 12:00 → 2h = 7200s
    expect(exportData.cacheAgeSeconds).toBe(7200);
  });
});

describe("writeQuotaExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls writeJsonAtomic with the resolved path and trailing newline", async () => {
    const exportData: any = { version: 2, providers: {} };
    await writeQuotaExport(exportData, "/tmp/export.json");

    expect(writeJsonAtomic).toHaveBeenCalledWith("/tmp/export.json", exportData, {
      trailingNewline: true,
    });
  });
});
