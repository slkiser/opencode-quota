import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { copilotProvider } from "../src/providers/copilot.js";

vi.mock("../src/lib/copilot.js", () => ({
  queryCopilotQuota: vi.fn(),
}));

describe("copilot provider", () => {
  it("returns attempted:false when Copilot quota is unavailable", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce(null);

    const out = await copilotProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps personal quota into a percent toast entry", async () => {
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
        name: "Copilot",
        percentRemaining: 86,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps personal quota into a grouped /quota entry", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    (queryCopilotQuota as any).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      used: 42,
      total: 300,
      percentRemaining: 86,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const out = await copilotProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Copilot",
        group: "Copilot (personal)",
        label: "Quota:",
        right: "42/300",
        percentRemaining: 86,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps unlimited personal quota into a value toast entry", async () => {
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
        name: "Copilot",
        value: "Unlimited",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps unlimited personal quota into a grouped value entry", async () => {
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

    const out = await copilotProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot",
        group: "Copilot (personal)",
        label: "Quota:",
        value: "Unlimited",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps organization usage into a value toast entry", async () => {
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
        name: "Copilot Org (acme-corp)",
        value: "9 used | 2026-01 | user=alice",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps organization usage into a grouped business entry", async () => {
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

    const out = await copilotProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot",
        group: "Copilot (business)",
        label: "Usage:",
        value: "9 used | 2026-01 | org=acme-corp | user=alice",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps enterprise usage into a value toast entry", async () => {
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
        name: "Copilot Enterprise (acme-enterprise)",
        value: "19 used | 2026-01 | org=acme-corp",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps enterprise usage into a grouped business entry", async () => {
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

    const out = await copilotProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Copilot",
        group: "Copilot (business)",
        label: "Usage:",
        value: "19 used | 2026-01 | enterprise=acme-enterprise | org=acme-corp",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ]);
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
      copilotProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["copilot-chat"] })),
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

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(copilotProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
