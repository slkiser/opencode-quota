import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { anthropicEnterpriseProvider } from "../src/providers/anthropic-enterprise.js";

vi.mock("../src/lib/anthropic-enterprise.js", () => ({
  queryAnthropicEnterpriseQuota: vi.fn(),
}));

vi.mock("../src/lib/anthropic-enterprise-config.js", () => ({
  resolveAnthropicEnterpriseConfigCached: vi.fn(),
  DEFAULT_ANTHROPIC_ENTERPRISE_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

const MOCK_CONFIG = {
  orgId: "org-uuid-123",
  sessionKey: "sk-session-abc",
  accountId: "acct-uuid-456",
};

describe("anthropic-enterprise provider", () => {
  it("returns not-attempted when config state is none", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({ state: "none" });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("returns error when config state is incomplete", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "incomplete",
      source: "environment",
      missing: "ANTHROPIC_ENTERPRISE_SESSION_KEY",
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Claude Enterprise");
    expect(out.errors[0]?.message).toContain("ANTHROPIC_ENTERPRISE_SESSION_KEY");
  });

  it("returns error when config state is invalid", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "invalid",
      source: "/path/to/config.json",
      error: "Config file must contain a JSON object",
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Claude Enterprise");
  });

  it("returns error when API query fails", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const { queryAnthropicEnterpriseQuota } = await import(
      "../src/lib/anthropic-enterprise.js"
    );

    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "configured",
      config: MOCK_CONFIG,
      source: "environment",
    });
    (queryAnthropicEnterpriseQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Org usage API returned 401",
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Claude Enterprise");
    expect(out.errors[0]?.message).toContain("401");
  });

  it("maps org usage into a percent entry with dollar right-hand summary", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const { queryAnthropicEnterpriseQuota } = await import(
      "../src/lib/anthropic-enterprise.js"
    );

    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "configured",
      config: MOCK_CONFIG,
      source: "environment",
    });
    (queryAnthropicEnterpriseQuota as any).mockResolvedValueOnce({
      success: true,
      orgUsage: {
        isEnabled: true,
        monthlyLimitUsd: 25000,
        usedCreditsUsd: 10000,
        utilization: 40,
        currency: "USD",
      },
      userLimit: null,
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "Claude Enterprise Org Monthly",
      group: "Claude Enterprise",
      label: "Org:",
      percentRemaining: 60,
    });
    expect((out.entries[0] as any).right).toContain("$10,000");
    expect((out.entries[0] as any).right).toContain("$25,000");
  });

  it("maps user limit into a percent entry when accountId is configured", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const { queryAnthropicEnterpriseQuota } = await import(
      "../src/lib/anthropic-enterprise.js"
    );

    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "configured",
      config: MOCK_CONFIG,
      source: "environment",
    });
    (queryAnthropicEnterpriseQuota as any).mockResolvedValueOnce({
      success: true,
      orgUsage: null,
      userLimit: {
        isEnabled: true,
        monthlyLimitUsd: 25000,
        usedCreditsUsd: 25000,
        accountName: "Dion Jones",
        groupName: null,
        period: "monthly",
        currency: "USD",
      },
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "Claude Enterprise User Monthly",
      group: "Claude Enterprise",
      percentRemaining: 0,
    });
  });

  it("returns both org and user entries when both are available", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const { queryAnthropicEnterpriseQuota } = await import(
      "../src/lib/anthropic-enterprise.js"
    );

    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "configured",
      config: MOCK_CONFIG,
      source: "environment",
    });
    (queryAnthropicEnterpriseQuota as any).mockResolvedValueOnce({
      success: true,
      orgUsage: {
        isEnabled: true,
        monthlyLimitUsd: 100000,
        usedCreditsUsd: 50000,
        utilization: 50,
        currency: "USD",
      },
      userLimit: {
        isEnabled: true,
        monthlyLimitUsd: 25000,
        usedCreditsUsd: 12500,
        accountName: null,
        groupName: null,
        period: "monthly",
        currency: "USD",
      },
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
  });

  it("returns error when org usage is not enabled and no user limit", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const { queryAnthropicEnterpriseQuota } = await import(
      "../src/lib/anthropic-enterprise.js"
    );

    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "configured",
      config: MOCK_CONFIG,
      source: "environment",
    });
    (queryAnthropicEnterpriseQuota as any).mockResolvedValueOnce({
      success: true,
      orgUsage: { isEnabled: false, monthlyLimitUsd: 0, usedCreditsUsd: 0, utilization: 0, currency: "USD" },
      userLimit: null,
    });

    const out = await anthropicEnterpriseProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Claude Enterprise");
  });

  it("isAvailable returns true when config is configured", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({
      state: "configured",
      config: MOCK_CONFIG,
      source: "environment",
    });

    await expect(anthropicEnterpriseProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("isAvailable returns false when config state is none", async () => {
    const { resolveAnthropicEnterpriseConfigCached } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    (resolveAnthropicEnterpriseConfigCached as any).mockResolvedValueOnce({ state: "none" });

    await expect(anthropicEnterpriseProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
