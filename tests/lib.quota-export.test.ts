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
  resolveExportPath,
  buildQuotaExport,
  writeQuotaExport,
} from "../src/lib/quota-export.js";

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
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      onlyCurrentModel: false,
    },
    session: {},
  };
}

// --------------- describe blocks ---------------

describe("resolveExportPath", () => {
  it("handles empty, tilde, absolute, and relative paths", () => {
    expect(resolveExportPath("")).toBe(
      "/tmp/test-opencode-quota-export/cache/quota-export.json",
    );
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
            name: "Copilot",
            percentRemaining: 75,
            resetTimeIso: "2026-07-01T00:00:00.000Z",
            label: "Monthly:",
          },
          { name: "OpenCode Go", kind: "value", value: "$42.50", label: "Weekly:" },
          { name: "Custom Metric", percentRemaining: 100, label: "Arbitrary:" },
          // Name matches a window keyword ("Monthly") but the label does not:
          // window must be derived from label only, so this stays undefined.
          { name: "Monthly Premium Requests", percentRemaining: 40, label: "Usage:" },
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

    expect(exportData.version).toBe(1);
    expect(exportData.fromCache).toBe(true);
    expect(exportData.exportedAt).toBe(Math.floor(Date.now() / 1000));

    const provider = exportData.providers.copilot;
    expect(provider).toBeDefined();
    expect(provider.status).toBe("ok");

    if (provider.status === "ok") {
      expect(provider.entries).toEqual([
        {
          name: "Copilot",
          percentRemaining: 75,
          resetAt: Math.floor(new Date("2026-07-01T00:00:00.000Z").getTime() / 1000),
          window: "Monthly",
          unlimited: false,
        },
        { name: "OpenCode Go", window: "Weekly", unlimited: false },
        { name: "Custom Metric", percentRemaining: 100, unlimited: false },
        // Monthly Premium Requests has label "Usage:" (not "Monthly"),
        // so window must NOT be set.
        { name: "Monthly Premium Requests", percentRemaining: 40, unlimited: false },
      ]);
    }
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
        result: { attempted: true, entries: [{ name: "A", percentRemaining: 90 }], errors: [] },
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
    const exportData: any = { version: 1, providers: {} };
    await writeQuotaExport(exportData, "/tmp/export.json");

    expect(writeJsonAtomic).toHaveBeenCalledWith("/tmp/export.json", exportData, {
      trailingNewline: true,
    });
  });
});
