import { describe, expect, it, vi } from "vitest";

const fsPromiseMocks = vi.hoisted(() => ({
  stat: vi.fn(async () => {
    throw new Error("missing");
  }),
}));

const copilotMocks = vi.hoisted(() => ({
  getCopilotQuotaAuthDiagnostics: vi.fn(() => ({
    pat: {
      state: "valid",
      checkedPaths: ["/tmp/copilot-quota-token.json"],
      selectedPath: "/tmp/copilot-quota-token.json",
      tokenKind: "github_pat",
      config: {
        token: "github_pat_123",
        tier: "business",
        organization: "acme-corp",
        username: "alice",
      },
    },
    oauth: {
      configured: true,
      keyName: "github-copilot",
      hasRefreshToken: false,
      hasAccessToken: true,
    },
    effectiveSource: "pat",
    override: "pat_overrides_oauth",
    billingMode: "organization_usage",
    billingScope: "organization",
    quotaApi: "github_billing_api",
    billingApiAccessLikely: true,
    remainingTotalsState: "not_available_from_org_usage",
    queryPeriod: {
      year: 2026,
      month: 1,
    },
    usernameFilter: "alice",
  })),
}));

const pricingMocks = vi.hoisted(() => ({
  getPricingSnapshotSource: vi.fn(() => "bundled"),
}));

const nanoGptMocks = vi.hoisted(() => ({
  getNanoGptKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
  queryNanoGptQuota: vi.fn(async () => null),
}));

vi.mock("fs/promises", () => ({
  stat: fsPromiseMocks.stat,
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  getAuthPath: () => "/tmp/auth.json",
  getAuthPaths: () => ["/tmp/auth.json"],
  readAuthFileCached: vi.fn(async () => ({})),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/tmp/data",
    configDir: "/tmp/config",
    cacheDir: "/tmp/cache",
    stateDir: "/tmp/state",
  }),
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getGoogleTokenCachePath: () => "/tmp/google-token-cache.json",
}));

vi.mock("../src/lib/google.js", () => ({
  getAntigravityAccountsCandidatePaths: () => ["/tmp/antigravity-accounts.json"],
  readAntigravityAccounts: vi.fn(async () => []),
}));

vi.mock("../src/lib/firmware.js", () => ({
  getFirmwareKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/chutes.js", () => ({
  getChutesKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/nanogpt.js", () => ({
  getNanoGptKeyDiagnostics: nanoGptMocks.getNanoGptKeyDiagnostics,
  queryNanoGptQuota: nanoGptMocks.queryNanoGptQuota,
}));

vi.mock("../src/lib/copilot.js", () => ({
  getCopilotQuotaAuthDiagnostics: copilotMocks.getCopilotQuotaAuthDiagnostics,
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  computeQwenQuota: () => ({
    day: { used: 0, limit: 1000 },
    rpm: { used: 0, limit: 60 },
  }),
  computeAlibabaCodingPlanQuota: () => ({
    tier: "lite",
    fiveHour: { used: 0, limit: 1200 },
    weekly: { used: 0, limit: 9000 },
    monthly: { used: 0, limit: 18000 },
  }),
  getQwenLocalQuotaPath: () => "/tmp/qwen-state.json",
  getAlibabaCodingPlanQuotaPath: () => "/tmp/alibaba-state.json",
  readQwenLocalQuotaState: vi.fn(async () => ({})),
  readAlibabaCodingPlanQuotaState: vi.fn(async () => ({})),
}));

vi.mock("../src/lib/qwen-auth.js", () => ({
  hasQwenOAuthAuth: () => false,
  resolveQwenLocalPlan: () => ({ state: "none" }),
}));

vi.mock("../src/lib/alibaba-auth.js", () => ({
  hasAlibabaAuth: () => false,
  resolveAlibabaCodingPlanAuth: () => ({ state: "none" }),
}));

vi.mock("../src/lib/cursor-detection.js", () => ({
  inspectCursorAuthPresence: vi.fn(async () => ({
    state: "present",
    selectedPath: "/tmp/auth.json",
    presentPaths: ["/tmp/auth.json"],
    candidatePaths: ["/tmp/auth.json"],
  })),
  inspectCursorOpenCodeIntegration: vi.fn(async () => ({
    pluginEnabled: true,
    providerConfigured: true,
    matchedPaths: ["/tmp/opencode.json"],
    checkedPaths: ["/tmp/opencode.json"],
  })),
}));

vi.mock("../src/lib/cursor-usage.js", () => ({
  getCurrentCursorUsageSummary: vi.fn(async () => ({
    window: {
      source: "calendar_month",
      resetTimeIso: "2026-04-01T00:00:00.000Z",
    },
    api: {
      costUsd: 3.5,
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      messageCount: 2,
    },
    autoComposer: {
      costUsd: 1.25,
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      messageCount: 1,
    },
    total: {
      costUsd: 4.75,
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      messageCount: 3,
    },
    unknownModels: [],
  })),
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  getPricingSnapshotHealth: () => ({
    ageMs: 0,
    maxAgeMs: 3600000,
    stale: false,
  }),
  getPricingRefreshPolicy: () => ({
    maxAgeMs: 3600000,
  }),
  getPricingSnapshotMeta: () => ({
    source: "test",
    generatedAt: Date.UTC(2026, 0, 1),
    units: "usd_per_1m_tokens",
  }),
  getPricingSnapshotSource: pricingMocks.getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath: () => "/tmp/pricing-refresh-state.json",
  getRuntimePricingSnapshotPath: () => "/tmp/pricing-snapshot.json",
  listProviders: () => ["openai"],
  getProviderModelCount: () => 1,
  hasProvider: () => true,
  readPricingRefreshState: vi.fn(async () => null),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => [{ id: "copilot" }, { id: "cursor" }, { id: "nanogpt" }],
}));

vi.mock("../src/lib/version.js", () => ({
  getPackageVersion: vi.fn(async () => "1.2.3"),
}));

vi.mock("../src/lib/opencode-storage.js", () => ({
  getOpenCodeDbPath: () => "/tmp/opencode.db",
  getOpenCodeDbPathCandidates: () => ["/tmp/opencode.db"],
  getOpenCodeDbStats: vi.fn(async () => ({
    sessionCount: 0,
    messageCount: 0,
    assistantMessageCount: 0,
  })),
}));

vi.mock("../src/lib/quota-stats.js", () => ({
  aggregateUsage: vi.fn(async () => ({
    byModel: [],
    unknown: [],
    unpriced: [],
    bySourceProvider: [],
    totals: {
      unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    },
  })),
}));

describe("buildQuotaStatusReport", () => {
  it("distinguishes organization billing access from computable remaining quota totals", async () => {
    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");

    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["copilot"],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "pro",
      pricingSnapshotSource: "runtime",
      onlyCurrentModel: false,
      providerAvailability: [
        {
          id: "copilot",
          enabled: true,
          available: true,
        },
      ],
      generatedAtMs: Date.UTC(2026, 2, 12, 12, 45, 0),
    });

    expect(report).toMatch(
      /^# Quota Status \(opencode-quota v1\.2\.3\) \(\/quota_status\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/,
    );
    expect(report).toContain(
      "- opencode_dirs: data=/tmp/data config=/tmp/config cache=/tmp/cache state=/tmp/state",
    );
    expect(report).toContain(
      "- auth.json: preferred=/tmp/auth.json present=(none) candidates=/tmp/auth.json",
    );
    expect(report).toContain(
      "- pricing: source=test active_source=bundled generated_at=2026-01-01T00:00:00.000Z units=usd_per_1m_tokens",
    );
    expect(report).toContain("- selection: configured=runtime active=bundled");
    expect(report).toContain(
      "- selection_note: runtime config requested the local runtime snapshot, but bundled fallback is active because no valid runtime snapshot is available",
    );
    expect(report).not.toContain("- opencode data:");
    expect(report).toContain("- qwen_local_plan: (none)");
    expect(report).toContain("- alibaba auth configured: false");
    expect(report).toContain("- alibaba coding plan fallback tier: lite");
    expect(report).toContain("- alibaba_coding_plan: (none)");
    expect(report).toContain("nanogpt:");
    expect(report).toContain("- api_key_configured: false");
    expect(report).toContain("- api_key_source: (none)");
    expect(report).toContain("- api_key_checked_paths: (none)");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("cursor:");
    expect(report).toContain("- plan: Pro");
    expect(report).toContain("- included_api_usd: $20.00");
    expect(report).toContain("- auth_state: present");
    expect(report).toContain("- plugin_enabled: true");
    expect(report).toContain("- provider_configured: true");
    expect(report).toContain("- cycle_source: calendar_month");
    expect(report).toContain("- api_usage: $3.50 across 2 messages");
    expect(report).toContain("- total_cursor_usage: $4.75 across 3 messages");
    expect(report).toContain("copilot_quota_auth:");
    expect(report).toContain("- billing_mode: organization_usage");
    expect(report).toContain("- billing_scope: organization");
    expect(report).toContain("- quota_api: github_billing_api");
    expect(report).toContain("- billing_api_access_likely: true");
    expect(report).toContain("- remaining_totals_state: not_available_from_org_usage");
    expect(report).toContain("- billing_period: 2026-01");
    expect(report).toContain("- username_filter: alice");
    expect(report).toContain(
      "- billing_usage_note: organization premium usage for the current billing period",
    );
    expect(report).toContain(
      "- remaining_quota_note: valid PAT access can query billing usage, but pooled org usage does not provide a true per-user remaining quota",
    );
    expect(report).toContain(
      "- nanogpt: pricing=no (subscription usage windows (weekly tokens, daily images, optional daily tokens; not token-priced))",
    );
  });

  it("reports NanoGPT live subscription usage diagnostics when configured", async () => {
    nanoGptMocks.getNanoGptKeyDiagnostics.mockResolvedValueOnce({
      configured: true,
      source: "env:NANOGPT_API_KEY",
      checkedPaths: ["env:NANOGPT_API_KEY"],
      authPaths: ["/tmp/auth.json"],
    });
    nanoGptMocks.queryNanoGptQuota.mockResolvedValueOnce({
      success: true,
      subscription: {
        active: false,
        state: "grace",
        enforceDailyLimit: true,
        weeklyInputTokens: {
          used: 59_650_170,
          limit: 60_000_000,
          remaining: 349_830,
          percentRemaining: 1,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        dailyImages: {
          used: 5,
          limit: 100,
          remaining: 95,
          percentRemaining: 95,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
        dailyInputTokens: undefined,
        graceUntilIso: "2026-01-09T00:00:00.000Z",
      },
    });

    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");
    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["nanogpt"],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      pricingSnapshotSource: "auto",
      onlyCurrentModel: false,
      providerAvailability: [
        {
          id: "nanogpt",
          enabled: true,
          available: true,
        },
      ],
      generatedAtMs: Date.UTC(2026, 2, 12, 12, 45, 0),
    });

    expect(report).toContain("nanogpt:");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: env:NANOGPT_API_KEY");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("- subscription_active: false");
    expect(report).toContain("- subscription_state: grace");
    expect(report).toContain("- enforce_daily_limit: true");
    expect(report).toContain(
      "- weekly_input_tokens_usage: 59650170/60000000 remaining=349830 percent_remaining=1 reset_at=2026-01-02T00:00:00.000Z",
    );
    expect(report).toContain(
      "- daily_images_usage: 5/100 remaining=95 percent_remaining=95 reset_at=2026-02-01T00:00:00.000Z",
    );
    expect(report).toContain("- daily_input_tokens_usage: (none)");
    expect(report).toContain("- grace_until: 2026-01-09T00:00:00.000Z");
    expect(report).not.toContain("- monthly_usage:");
    expect(report).not.toContain("- billing_period_end:");
    expect(report).not.toContain("- balance_usd:");
    expect(report).not.toContain("- balance_nano:");
    expect(report).not.toContain("- live_error_balance:");
  });

  it("reports enterprise billing scope and token compatibility notes", async () => {
    copilotMocks.getCopilotQuotaAuthDiagnostics.mockReturnValueOnce({
      pat: {
        state: "valid",
        checkedPaths: ["/tmp/copilot-quota-token.json"],
        selectedPath: "/tmp/copilot-quota-token.json",
        tokenKind: "github_pat",
        config: {
          token: "github_pat_123",
          tier: "enterprise",
          enterprise: "acme-enterprise",
          organization: "acme-corp",
          username: "alice",
        },
      },
      oauth: {
        configured: false,
        keyName: null,
        hasRefreshToken: false,
        hasAccessToken: false,
      },
      effectiveSource: "pat",
      override: "none",
      billingMode: "enterprise_usage",
      billingScope: "enterprise",
      quotaApi: "github_billing_api",
      billingApiAccessLikely: false,
      remainingTotalsState: "not_available_from_enterprise_usage",
      queryPeriod: {
        year: 2026,
        month: 1,
      },
      usernameFilter: "alice",
      tokenCompatibilityError:
        "GitHub's enterprise premium usage endpoint does not support fine-grained personal access tokens. Use a classic PAT or another supported non-fine-grained token for enterprise billing.",
    });

    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");

    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["copilot"],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      pricingSnapshotSource: "auto",
      onlyCurrentModel: false,
      providerAvailability: [
        {
          id: "copilot",
          enabled: true,
          available: true,
        },
      ],
      generatedAtMs: Date.UTC(2026, 2, 12, 12, 45, 0),
    });

    expect(report).toContain("- pat_enterprise: acme-enterprise");
    expect(report).toContain("- billing_mode: enterprise_usage");
    expect(report).toContain("- billing_scope: enterprise");
    expect(report).toContain("- quota_api: github_billing_api");
    expect(report).toContain("- billing_api_access_likely: false");
    expect(report).toContain("- remaining_totals_state: not_available_from_enterprise_usage");
    expect(report).toContain(
      "- billing_usage_note: enterprise premium usage for the current billing period",
    );
    expect(report).toContain(
      "- remaining_quota_note: valid enterprise billing access can query pooled enterprise usage, but it does not provide a true per-user remaining quota",
    );
    expect(report).toContain("- token_compatibility_error: GitHub's enterprise premium usage endpoint does not support fine-grained personal access tokens.");
  });
});
