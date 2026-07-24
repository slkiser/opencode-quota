import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { copilotProvider } from "../src/providers/copilot.js";

vi.mock("../src/lib/copilot.js", () => ({
  hasCopilotQuotaRuntimeAvailable: vi.fn(async () => false),
  queryCopilotQuota: vi.fn(),
}));

describe("copilot provider", () => {
  it("returns attempted:false when Copilot accounting is unavailable", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce(null);
    expectNotAttempted(await copilotProvider.fetch({} as any));
  });

  it("renders personal PAT AI Credit accounting as usage-only", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      period: { year: 2026, month: 1 },
      used: 100,
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      authority: "provider_reported",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "copilot")).toEqual([
      {
        kind: "value",
        name: "Copilot AI Credits",
        group: "Copilot (personal)",
        label: "Credits:",
        value: "Used 100 · Included 80 · Billed 20 ($0.20)",
        resetTimeIso: undefined,
      },
    ]);
    expect(out.entries[0]).not.toHaveProperty("percentRemaining");
    expect(out.entries[0]).not.toHaveProperty("right");
    expect(out.entries[0]?.accounting).toMatchObject({
      resultType: "usage",
      authority: "provider_reported",
    });
  });

  it("renders OAuth premium_interactions neutrally and marks local arithmetic derived", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      unit: "premium_interactions",
      used: 600.5,
      total: 1000,
      percentRemaining: 40,
      authority: "locally_derived",
      plan: "enterprise",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "copilot")).toEqual([
      {
        name: "Copilot Premium Interactions",
        group: "Copilot (personal)",
        label: "Quota:",
        right: "600.5/1,000",
        percentRemaining: 40,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.entries[0]?.accounting).toMatchObject({
      resultType: "quota",
      authority: "locally_derived",
    });
  });

  it("renders pooled organization credits plus a real additional-usage budget", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      username: "alice",
      period: { year: 2026, month: 1 },
      unit: "ai_credits",
      used: 100,
      authority: "provider_reported",
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      budget: {
        amountUsd: 1,
        spentUsd: 0.2,
        scope: "user",
        percentRemaining: 80,
        authority: "locally_derived",
      },
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "copilot")).toEqual([
      {
        kind: "value",
        name: "Copilot AI Credits",
        group: "Copilot (business)",
        label: "Credits:",
        value: "Used 100 · Included 80 · Billed 20 ($0.20) · 2026-01 · org=acme · user=alice",
        resetTimeIso: undefined,
      },
      {
        name: "Copilot Additional Usage",
        group: "Copilot (business)",
        label: "Budget:",
        right: "$0.20/$1.00",
        percentRemaining: 80,
        resetTimeIso: undefined,
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting.resultType)).toEqual(["usage", "budget"]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Copilot Org (acme)",
    });
  });

  it("keeps a zero denominator as a value-only budget row", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "enterprise_usage",
      enterprise: "octo",
      period: { year: 2026, month: 1 },
      unit: "ai_credits",
      used: 10,
      authority: "provider_reported",
      includedUsed: 0,
      billedUsed: 10,
      billedAmountUsd: 0.1,
      budget: {
        amountUsd: 0,
        spentUsd: 0.1,
        scope: "enterprise",
        authority: "provider_reported",
      },
    });

    const out = await copilotProvider.fetch({} as any);
    expect(visibleEntries(out.entries, "copilot")[1]).toEqual({
      kind: "value",
      name: "Copilot Additional Usage",
      group: "Copilot (business)",
      label: "Budget:",
      value: "$0.10 spent | $0.00 budget | scope=enterprise",
      resetTimeIso: undefined,
    });
  });

  it("keeps partial budget failures alongside successful usage", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      period: { year: 2026, month: 1 },
      unit: "ai_credits",
      used: 10,
      authority: "provider_reported",
      includedUsed: 10,
      billedUsed: 0,
      warnings: ["Budget endpoint forbidden"],
    });

    const out = await copilotProvider.fetch({} as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors).toEqual([{ label: "Copilot", message: "Budget endpoint forbidden" }]);
  });

  it("renders explicitly eligible legacy premium requests separately", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      unit: "premium_requests",
      used: 150,
      authority: "locally_derived",
      total: 1500,
      percentRemaining: 90,
      plan: "pro+",
    });

    const out = await copilotProvider.fetch({} as any);
    expect(visibleEntries(out.entries, "copilot")).toEqual([
      {
        name: "Copilot Premium Requests",
        group: "Copilot (personal)",
        label: "Quota:",
        right: "150/1,500",
        percentRemaining: 90,
        resetTimeIso: undefined,
      },
    ]);
  });

  it("renders token-billing placeholders as plan-only without a fake percentage or denominator", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_plan",
      authority: "provider_reported",
      plan: "business",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "copilot")).toEqual([
      {
        kind: "value",
        name: "Copilot",
        group: "Copilot (personal)",
        label: "Plan:",
        value: "business | quota details unavailable",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.entries[0]).not.toHaveProperty("percentRemaining");
    expect(out.entries[0]).not.toHaveProperty("right");
  });

  it("maps explicit failures into provider errors", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Forbidden",
    });
    expectAttemptedWithErrorLabel(await copilotProvider.fetch({} as any), "Copilot");
  });

  it("uses runtime provider ids or trusted local billing auth for availability", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["github-copilot"] }),
      ),
    ).resolves.toBe(true);

    const { hasCopilotQuotaRuntimeAvailable } = await import("../src/lib/copilot.js");
    (hasCopilotQuotaRuntimeAvailable as any).mockResolvedValueOnce(true);
    await expect(
      copilotProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(true);
  });

  it("does not claim availability when provider lookup throws", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("boom") }),
      ),
    ).resolves.toBe(false);
  });
});
