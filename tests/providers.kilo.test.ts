import { beforeEach, describe, expect, it, vi } from "vitest";

import { collectQuotaRenderData } from "../src/lib/quota-render-data.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  getKiloKeyDiagnostics: vi.fn(),
  hasKiloApiKey: vi.fn(),
  queryKiloQuota: vi.fn(),
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  getKiloKeyDiagnostics: mocks.getKiloKeyDiagnostics,
  hasKiloApiKey: mocks.hasKiloApiKey,
}));

vi.mock("../src/lib/kilo.js", () => ({
  queryKiloQuota: mocks.queryKiloQuota,
}));

import { kiloProvider } from "../src/providers/kilo.js";

describe("Kilo Gateway provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getKiloKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:KILO_API_KEY",
      checkedPaths: ["env:KILO_API_KEY"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
  });

  it("uses the documented canonical provider identity and model prefix", () => {
    expect(kiloProvider.id).toBe("kilo");
    expect(kiloProvider.matchesCurrentModel?.("kilo/anthropic/claude-sonnet-4")).toBe(true);
    expect(kiloProvider.matchesCurrentModel?.("kilo-gateway/model")).toBe(false);
    expect(kiloProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available only when a trusted Kilo API key exists", async () => {
    mocks.hasKiloApiKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(true);
    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce(null);

    const out = await kiloProvider.fetch({} as any);

    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_configured", value: "true" },
        { key: "api_key_source", value: "env:KILO_API_KEY" },
      ]),
    );
  });

  it("maps one structured Kilo Pass percentage with complete USD basis", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "kilo_pass",
      baseCreditsUsd: 10,
      usageUsd: 2.5,
      bonusCreditsUsd: 5,
      remainingUsd: 12.5,
      overageUsd: 0,
      resetTimeIso: "2099-02-01T00:00:00.000Z",
    });

    const out = await kiloProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(mocks.queryKiloQuota).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        percentRemaining: 83.33333333333334,
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "2.5", unit: { kind: "currency", code: "USD" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "15", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
          remaining: {
            quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        },
        resetTimeIso: "2099-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.entries[0]?.accounting).toEqual({
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    });
    expect(out.entries[0]).not.toHaveProperty("right");
    expect(out.entries[0]?.kind).not.toBe("value");
    expect(out.presentation).toBeUndefined();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "accounting_mode", value: "kilo_pass" },
        { key: "base_credits_usd", value: "$10.00" },
        { key: "usage_usd", value: "$2.50" },
        { key: "bonus_credits_usd", value: "$5.00" },
        { key: "remaining_usd", value: "$12.50" },
        { key: "overage_usd", value: "$0.00" },
        { key: "reset_at", value: "2099-02-01T00:00:00.000Z" },
      ]),
    );
    expect(out.rawDetails).toEqual([
      { key: "base_credits_usd", value: "$10.00" },
      { key: "usage_usd", value: "$2.50" },
      { key: "bonus_credits_usd", value: "$5.00" },
      { key: "remaining_usd", value: "$12.50" },
      { key: "overage_usd", value: "$0.00" },
      { key: "reset_at", value: "2099-02-01T00:00:00.000Z" },
    ]);
    expect(JSON.stringify(out.entries)).not.toContain("$10.00");
    expect(JSON.stringify(out.entries)).not.toContain("$2.50");
    expect(JSON.stringify(out.entries)).not.toContain("$5.00");
  });

  it("preserves the semantic credits row through single-window projection", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "kilo_pass",
      baseCreditsUsd: 10,
      usageUsd: 2.5,
      bonusCreditsUsd: 5,
      remainingUsd: 12.5,
      overageUsd: 0,
    });
    const raw = await kiloProvider.fetch({} as any);
    const projectedProvider = {
      id: "kilo",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(raw),
    };

    const projected = await collectQuotaRenderData({
      client: {
        config: {
          providers: async () => ({ data: { providers: [] } }),
          get: async () => ({ data: {} }),
        },
      } as any,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["kilo"],
        formatStyle: "singleWindow",
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: false,
      formatStyle: "singleWindow",
      providers: [projectedProvider],
      bypassProviderCache: true,
    });

    expect(projected.data?.entries).toEqual([
      expect.objectContaining({
        name: "[Kilo Gateway]",
        percentRemaining: 83.33333333333334,
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        basis: expect.objectContaining({
          remaining: {
            quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        }),
      }),
    ]);
  });

  it("does not expose used or bonus amounts when no bonus exists", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "kilo_pass",
      baseCreditsUsd: 10,
      usageUsd: 2.5,
      bonusCreditsUsd: 0,
      remainingUsd: 7.5,
      overageUsd: 0,
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      expect.objectContaining({
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        percentRemaining: 75,
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "2.5", unit: { kind: "currency", code: "USD" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "10", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
          remaining: {
            quantity: { decimal: "7.5", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        },
      }),
    ]);
  });

  it("shows zero percent and zero left when usage exceeds the quota", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "kilo_pass",
      baseCreditsUsd: 10,
      usageUsd: 12,
      bonusCreditsUsd: 0,
      remainingUsd: 0,
      overageUsd: 2,
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      expect.objectContaining({
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        percentRemaining: 0,
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "12", unit: { kind: "currency", code: "USD" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "10", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
          remaining: {
            quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        },
      }),
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([{ key: "overage_usd", value: "$2.00" }]),
    );
    expect(out.rawDetails).toEqual(
      expect.arrayContaining([
        { key: "usage_usd", value: "$12.00" },
        { key: "remaining_usd", value: "$0.00" },
        { key: "overage_usd", value: "$2.00" },
      ]),
    );
    expect(JSON.stringify(out.entries)).not.toContain("$2.00");
  });

  it("omits the percent entry when total credits are zero", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "kilo_pass",
      baseCreditsUsd: 0,
      usageUsd: 0,
      bonusCreditsUsd: 0,
      remainingUsd: 0,
      overageUsd: 0,
      resetTimeIso: "2099-02-01T00:00:00.000Z",
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        kind: "quantity",
        name: "kilo-gateway-remaining-credits",
        group: "Kilo Gateway",
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
        resetTimeIso: "2099-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("restores the provider-reported Gateway balance-only fallback", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "gateway_balance",
      balanceUsd: 8.25,
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        kind: "quantity",
        name: "kilo-gateway-total-balance",
        group: "Kilo Gateway",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: { decimal: "8.25", unit: { kind: "currency", code: "USD" } },
      },
    ]);
    expect(out.entries[0]?.accounting).toEqual({
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    });
    expect(out.presentation).toBeUndefined();
    expect(out.rawDetails).toBeUndefined();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "accounting_mode", value: "gateway_balance" },
        { key: "balance_usd", value: "$8.25" },
      ]),
    );
    expect(out.statusDetails).not.toEqual(
      expect.arrayContaining([{ key: "usage_usd", value: expect.any(String) }]),
    );
  });

  it("maps API failures into a safe Kilo Gateway error", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({ success: false, error: "Unauthorized" });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithErrorLabel(out, "Kilo Gateway");
  });
});
