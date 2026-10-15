import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { copilotProvider } from "../src/providers/copilot.js";

vi.mock("../src/lib/copilot.js", () => ({
  hasCopilotQuotaRuntimeAvailable: vi.fn(async () => false),
  queryCopilotQuota: vi.fn(),
}));

describe("copilot provider", () => {
  it("returns attempted:false when Copilot quota is unavailable", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce(null);

    const out = await copilotProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps personal quota into a canonical grouped-capable row", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      used: 42,
      total: 300,
      percentRemaining: 86,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Copilot Premium Requests",
        group: "Copilot (personal)",
        label: "Quota:",
        right: "42/300",
        percentRemaining: 86,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toBeUndefined();
    expect(out.accounting?.rows[0].value).toMatchObject({
      kind: "percent",
      remaining: 86,
      basis: { used: { quantity: { decimal: "42", unit: { kind: "count", unit: "request" } } } },
    });
  });

  it("maps explicit unlimited personal quota into a value row", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      used: 0,
      total: 1,
      percentRemaining: 100,
      unlimited: true,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot Premium Requests",
        group: "Copilot (personal)",
        label: "Quota:",
        value: "Unlimited",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toBeUndefined();
  });

  it("maps organization usage into a grouped-capable business entry", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "acme-corp",
      username: "alice",
      period: {
        year: 2026,
        month: 1,
      },
      used: 9,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot AI Credits",
        group: "Copilot (business)",
        label: "Credits:",
        value: "Used 9 | 2026-01 | org=acme-corp | user=alice",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Copilot Org (acme-corp)",
    });
  });

  it("maps enterprise usage into a grouped-capable business entry", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "enterprise_usage",
      enterprise: "acme-enterprise",
      organization: "acme-corp",
      period: {
        year: 2026,
        month: 1,
      },
      used: 19,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot AI Credits",
        group: "Copilot (business)",
        label: "Credits:",
        value: "Used 19 | 2026-01 | enterprise=acme-enterprise | org=acme-corp",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Copilot Enterprise (acme-enterprise)",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await copilotProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Copilot");
  });

  it("is available for metadata-backed Copilot runtime ids", async () => {
    await expect(
      copilotProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["copilot"] })),
    ).resolves.toBe(true);
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["github-copilot"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["copilot-chat"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["github-copilot-chat"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      copilotProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(false);
  });

  it("falls back to local Copilot quota auth when runtime provider ids are absent", async () => {
    const { hasCopilotQuotaRuntimeAvailable } = await import("../src/lib/copilot.js");
    (hasCopilotQuotaRuntimeAvailable as any).mockResolvedValueOnce(true);

    await expect(
      copilotProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(true);
  });

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(copilotProvider.isAvailable(ctx)).resolves.toBe(false);
  });

  it("shows usage-only AI credits without inventing a denominator", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      authority: "provider_reported",
      used: 100,
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
    });
    const out = await copilotProvider.fetch({} as any);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot AI Credits",
        group: "Copilot (personal)",
        label: "Credits:",
        value: "Used 100 | Included 80 | Billed 20 ($0.20)",
        resetTimeIso: undefined,
      },
    ]);
  });

  it("shows reported over-limit credits without clamping usage or inventing availability", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      authority: "provider_reported",
      used: 1250,
      total: 1000,
      percentRemaining: 0,
    });
    const out = await copilotProvider.fetch({} as any);
    expect(out.entries[0]).toMatchObject({
      name: "Copilot AI Credits",
      label: "Credits:",
      right: "1,250/1,000",
      percentRemaining: 0,
    });
  });

  it("renders placeholder quota as plan-only and preserves a failed budget as a warning", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "user_plan",
      plan: "business",
      authority: "provider_reported",
    });
    expect((await copilotProvider.fetch({} as any)).entries[0]).toMatchObject({
      kind: "value",
      label: "Plan:",
      value: "business | quota details unavailable",
    });
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "fixture-org",
      period: { year: 2026, month: 10 },
      unit: "ai_credits",
      authority: "provider_reported",
      used: 100,
      warnings: ["Budget report permission denied"],
    });
    const out = await copilotProvider.fetch({} as any);
    expect(out.entries[0]).toMatchObject({ kind: "value", name: "Copilot AI Credits" });
    expect(out.errors).toEqual([{ label: "Copilot", message: "Budget report permission denied" }]);
  });
});
