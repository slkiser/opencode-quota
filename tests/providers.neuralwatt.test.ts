import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { neuralwattProvider } from "../src/providers/neuralwatt.js";

vi.mock("../src/lib/neuralwatt.js", () => ({
  queryNeuralwattQuota: vi.fn(),
  formatNeuralwattBalanceValue: vi.fn((balance: { creditsRemainingUsd?: number }) =>
    typeof balance.creditsRemainingUsd === "number"
      ? `$${balance.creditsRemainingUsd.toFixed(2)}`
      : null,
  ),
  formatNeuralwattKwhRight: vi.fn(
    (window: { used: number; limit: number }) => `${window.used} kWh/${window.limit} kWh`,
  ),
}));

vi.mock("../src/lib/neuralwatt-config.js", () => ({
  hasNeuralwattApiKey: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("neuralwatt provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryNeuralwattQuota } = await import("../src/lib/neuralwatt.js");
    (queryNeuralwattQuota as any).mockResolvedValueOnce(null);

    const out = await neuralwattProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps subscription + key allowance + credits into grouped rows", async () => {
    const { queryNeuralwattQuota } = await import("../src/lib/neuralwatt.js");
    (queryNeuralwattQuota as any).mockResolvedValueOnce({
      success: true,
      balance: { creditsRemainingUsd: 32.67 },
      subscription: {
        active: true,
        state: "active",
        currentPeriodEndIso: "2026-05-11T05:05:25.000Z",
        kwh: {
          used: 13.9023,
          limit: 20,
          remaining: 6.0977,
          percentRemaining: 30,
          resetTimeIso: "2026-05-11T05:05:25.000Z",
        },
      },
      keyAllowance: {
        limitUsd: 100,
        spentUsd: 25,
        remainingUsd: 75,
        period: "monthly",
        blocked: false,
        window: { used: 25, limit: 100, remaining: 75, percentRemaining: 75 },
      },
    });

    const out = await neuralwattProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Neuralwatt Subscription",
        group: "Neuralwatt",
        label: "Plan:",
        right: "13.9023 kWh/20 kWh",
        percentRemaining: 30,
        resetTimeIso: "2026-05-11T05:05:25.000Z",
      },
      {
        name: "Neuralwatt Key",
        group: "Neuralwatt",
        label: "Key:",
        right: "$25.00/$100.00",
        percentRemaining: 75,
      },
      {
        kind: "value",
        name: "Neuralwatt Credits",
        group: "Neuralwatt",
        label: "Credits:",
        value: "$32.67",
      },
    ]);
    expect(out.presentation).toBeUndefined();
  });

  it("falls back to credits-only when there is no subscription", async () => {
    const { queryNeuralwattQuota } = await import("../src/lib/neuralwatt.js");
    (queryNeuralwattQuota as any).mockResolvedValueOnce({
      success: true,
      balance: { creditsRemainingUsd: 5.0 },
    });

    const out = await neuralwattProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Neuralwatt Credits",
        group: "Neuralwatt",
        label: "Credits:",
        value: "$5.00",
      },
    ]);
  });

  it("reports non-active subscription state and blocked key as errors", async () => {
    const { queryNeuralwattQuota } = await import("../src/lib/neuralwatt.js");
    (queryNeuralwattQuota as any).mockResolvedValueOnce({
      success: true,
      balance: { creditsRemainingUsd: 1 },
      subscription: {
        active: false,
        state: "past_due",
        kwh: { used: 20, limit: 20, remaining: 0, percentRemaining: 0 },
      },
      keyAllowance: {
        limitUsd: 10,
        spentUsd: 10,
        remainingUsd: 0,
        period: "daily",
        blocked: true,
        window: { used: 10, limit: 10, remaining: 0, percentRemaining: 0 },
      },
    });

    const out = await neuralwattProvider.fetch({ config: {} } as any);
    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([
      { label: "Neuralwatt", message: "Subscription state: past_due" },
      { label: "Neuralwatt", message: "API key is blocked (spending allowance reached)" },
    ]);
  });

  it("reports missing usable data as an error", async () => {
    const { queryNeuralwattQuota } = await import("../src/lib/neuralwatt.js");
    (queryNeuralwattQuota as any).mockResolvedValueOnce({ success: true });

    const out = await neuralwattProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Neuralwatt");
    expect(out.entries).toEqual([]);
  });

  it("maps hard failures into toast errors", async () => {
    const { queryNeuralwattQuota } = await import("../src/lib/neuralwatt.js");
    (queryNeuralwattQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Neuralwatt API error 401: Invalid API key",
    });

    const out = await neuralwattProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Neuralwatt");
  });

  it("matches Neuralwatt model ids", () => {
    expect(neuralwattProvider.matchesCurrentModel?.("neuralwatt/Qwen/Qwen3-Coder-480B")).toBe(true);
    expect(neuralwattProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when canonical provider metadata is available", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(neuralwattProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("falls back to trusted API key presence when provider metadata is absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasNeuralwattApiKey as any).mockResolvedValueOnce(true);

    await expect(neuralwattProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("is not available when provider metadata is absent and no API key exists", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasNeuralwattApiKey as any).mockResolvedValueOnce(false);

    await expect(neuralwattProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
