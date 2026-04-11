import { beforeEach, describe, expect, it, vi } from "vitest";

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

const googleMocks = vi.hoisted(() => ({
  inspectAntigravityAccountsPresence: vi.fn(async () => ({
    state: "missing" as const,
    presentPaths: [],
    candidatePaths: ["/tmp/antigravity-accounts.json"],
    accountCount: 0,
    validAccountCount: 0,
  })),
}));

const openaiMocks = vi.hoisted(() => ({
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" as const })),
}));

const alibabaMocks = vi.hoisted(() => ({
  getAlibabaCodingPlanAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: ["/tmp/auth.json"],
  })),
  resolveAlibabaCodingPlanAuth: vi.fn(() => ({ state: "none" as const })),
}));

const minimaxMocks = vi.hoisted(() => ({
  getMiniMaxAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: ["/tmp/auth.json"],
  })),
  resolveMiniMaxAuthCached: vi.fn(async () => ({ state: "none" as const })),
  queryMiniMaxQuota: vi.fn(async () => ({ success: true as const, entries: [] })),
}));

const zaiMocks = vi.hoisted(() => ({
  getZaiAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: ["/tmp/auth.json"],
  })),
  queryZaiQuota: vi.fn(async () => null),
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

const anthropicMocks = vi.hoisted(() => ({
  getAnthropicDiagnostics: vi.fn(async () => ({
    installed: true,
    version: "1.2.3",
    authStatus: "authenticated",
    quotaSupported: false,
    quotaSource: "none",
    checkedCommands: ["claude --version", "claude auth status --json"],
    message: "Claude CLI auth detected, but local quota windows were not exposed.",
  })),
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
  getOpencodeRuntimeDirCandidates: () => ({
    configDirs: ["/tmp/config"],
  }),
}));

vi.mock("../src/lib/opencode-go-config.js", () => ({
  getOpenCodeGoConfigDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    missing: null,
    checkedPaths: [],
  })),
  resolveOpenCodeGoConfigCached: vi.fn(async () => ({ state: "none" })),
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

vi.mock("../src/lib/opencode-go.js", () => ({
  queryOpenCodeGoQuota: vi.fn(async () => null),
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getGoogleTokenCachePath: () => "/tmp/google-token-cache.json",
}));

vi.mock("../src/lib/google.js", () => ({
  inspectAntigravityAccountsPresence: googleMocks.inspectAntigravityAccountsPresence,
}));

vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: anthropicMocks.getAnthropicDiagnostics,
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

vi.mock("../src/lib/openai.js", () => ({
  resolveOpenAIOAuth: openaiMocks.resolveOpenAIOAuth,
}));

vi.mock("../src/lib/alibaba-auth.js", () => ({
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS: 5_000,
  getAlibabaCodingPlanAuthDiagnostics: alibabaMocks.getAlibabaCodingPlanAuthDiagnostics,
  resolveAlibabaCodingPlanAuth: alibabaMocks.resolveAlibabaCodingPlanAuth,
}));

vi.mock("../src/lib/minimax-auth.js", () => ({
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
  getMiniMaxAuthDiagnostics: minimaxMocks.getMiniMaxAuthDiagnostics,
  resolveMiniMaxAuthCached: minimaxMocks.resolveMiniMaxAuthCached,
}));

vi.mock("../src/providers/minimax-coding-plan.js", () => ({
  queryMiniMaxQuota: minimaxMocks.queryMiniMaxQuota,
}));

vi.mock("../src/lib/zai-auth.js", () => ({
  DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  getZaiAuthDiagnostics: zaiMocks.getZaiAuthDiagnostics,
}));

vi.mock("../src/lib/zai.js", () => ({
  queryZaiQuota: zaiMocks.queryZaiQuota,
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function buildMiniMaxStatusReport(overrides: Record<string, unknown> = {}) {
    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");

    return buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["minimax-coding-plan"],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      pricingSnapshotSource: "auto",
      onlyCurrentModel: false,
      providerAvailability: [
        {
          id: "minimax-coding-plan",
          enabled: true,
          available: true,
        },
      ],
      generatedAtMs: Date.UTC(2026, 2, 12, 12, 45, 0),
      ...overrides,
    } as any);
  }

  async function buildZaiStatusReport(overrides: Record<string, unknown> = {}) {
    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");

    return buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["zai"],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      pricingSnapshotSource: "auto",
      onlyCurrentModel: false,
      providerAvailability: [
        {
          id: "zai",
          enabled: true,
          available: true,
        },
      ],
      generatedAtMs: Date.UTC(2026, 2, 12, 12, 45, 0),
      ...overrides,
    } as any);
  }

  it("distinguishes organization billing access from computable remaining quota totals", async () => {
    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");

    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["copilot"],
      anthropicBinaryPath: "/opt/claude/bin/claude",
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
    expect(report).toContain("openai:");
    expect(report).toContain("- auth_configured: false");
    expect(report).toContain("- auth_source: (none)");
    expect(report).toContain("- token_status: (none)");
    expect(report).toContain("- token_expires_at: (none)");
    expect(report).toContain("- account_email: (none)");
    expect(report).toContain("- account_id: (none)");
    expect(report).toContain("- qwen_oauth_source: (none)");
    expect(report).toContain("- qwen_local_plan: (none)");
    expect(report).toContain("- alibaba auth configured: false");
    expect(report).toContain("- alibaba coding plan fallback tier: lite");
    expect(report).toContain("- alibaba_coding_plan: (none)");
    expect(report).toContain("anthropic:");
    expect(report).toContain("- cli_installed: true");
    expect(report).toContain("- cli_version: 1.2.3");
    expect(report).toContain("- auth_status: authenticated");
    expect(report).toContain("- quota_supported: false");
    expect(report).toContain("- quota_source: (none)");
    expect(report).toContain("- checked_commands: claude --version | claude auth status --json");
    expect(report).toContain(
      "- message: Claude CLI auth detected, but local quota windows were not exposed.",
    );
    expect(anthropicMocks.getAnthropicDiagnostics).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
    });
    expect(report).toContain("nanogpt:");
    expect(report).toContain("- api_key_configured: false");
    expect(report).toContain("- api_key_source: (none)");
    expect(report).toContain("- api_key_checked_paths: (none)");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("zai:");
    expect(report).toContain("- auth_state: none");
    expect(report).toContain("- api_key_source: (none)");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("firmware:");
    expect(report).toContain("chutes:");
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
    expect(report).toContain("google_antigravity:");
    expect(report).toContain("- auth_state: missing");
    expect(report).toContain("- selected_accounts_path: (none)");
    expect(report).toContain("- present_accounts_paths: (none)");
    expect(report).toContain("- candidate_accounts_paths: /tmp/antigravity-accounts.json");
    expect(report).toContain("- account_count: 0");
    expect(report).toContain("- valid_account_count: 0");
    expect(report).toContain("- token_cache_path: /tmp/google-token-cache.json exists=false");
    expect(report).toContain(
      "- billing_usage_note: organization premium usage for the current billing period",
    );
    expect(report).toContain(
      "- remaining_quota_note: valid PAT access can query billing usage, but pooled org usage does not provide a true per-user remaining quota",
    );
    expect(report).toContain(
      "- nanogpt: pricing=no (subscription request quota + account balance (not token-priced))",
    );
  });

  it("reports Anthropic quota window details when the local Claude CLI exposes them", async () => {
    anthropicMocks.getAnthropicDiagnostics.mockResolvedValueOnce({
      installed: true,
      version: "1.2.4",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: ["claude --version", "claude auth status --json"],
      quota: {
        success: true,
        five_hour: {
          percentRemaining: 43,
          resetTimeIso: "2026-03-25T18:00:00.000Z",
        },
        seven_day: {
          percentRemaining: 88,
          resetTimeIso: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    const { buildQuotaStatusReport } = await import("../src/lib/quota-status.js");
    const report = await buildQuotaStatusReport({
      configSource: "test",
      configPaths: [],
      enabledProviders: ["anthropic"],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      pricingSnapshotSource: "auto",
      onlyCurrentModel: false,
      providerAvailability: [
        {
          id: "anthropic",
          enabled: true,
          available: true,
        },
      ],
      generatedAtMs: Date.UTC(2026, 2, 12, 12, 45, 0),
    });

    expect(report).toContain("- cli_version: 1.2.4");
    expect(report).toContain("- quota_supported: true");
    expect(report).toContain("- quota_source: claude-auth-status-json");
    expect(report).toContain("- five_hour_remaining: 43% reset_at=2026-03-25T18:00:00.000Z");
    expect(report).toContain("- seven_day_remaining: 88% reset_at=2026-04-01T00:00:00.000Z");
  });

  it("reports NanoGPT live subscription and balance diagnostics when configured", async () => {
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
        daily: {
          used: 5,
          limit: 5000,
          remaining: 4995,
          percentRemaining: 100,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        monthly: {
          used: 45,
          limit: 60000,
          remaining: 59955,
          percentRemaining: 100,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
        currentPeriodEndIso: "2026-02-13T23:59:59.000Z",
        graceUntilIso: "2026-01-09T00:00:00.000Z",
      },
      balance: {
        usdBalance: 129.46956147,
        usdBalanceRaw: "129.46956147",
        nanoBalanceRaw: "26.71801147",
      },
      endpointErrors: [
        {
          endpoint: "balance",
          message: "NanoGPT API error 401: Unauthorized",
        },
      ],
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
      "- daily_usage: 5/5000 remaining=4995 percent_remaining=100 reset_at=2026-01-02T00:00:00.000Z",
    );
    expect(report).toContain(
      "- monthly_usage: 45/60000 remaining=59955 percent_remaining=100 reset_at=2026-02-01T00:00:00.000Z",
    );
    expect(report).toContain("- billing_period_end: 2026-02-13T23:59:59.000Z");
    expect(report).toContain("- grace_until: 2026-01-09T00:00:00.000Z");
    expect(report).toContain("- balance_usd: $129.47");
    expect(report).toContain("- balance_nano: 26.71801147");
    expect(report).toContain("- live_error_balance: NanoGPT API error 401: Unauthorized");
  });

  it("reports MiniMax auth diagnostics and live quota details when configured", async () => {
    minimaxMocks.getMiniMaxAuthDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "auth.json",
      checkedPaths: ["/tmp/auth.json"],
    });
    minimaxMocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
      state: "configured",
      apiKey: "test-key",
    });
    minimaxMocks.queryMiniMaxQuota.mockResolvedValueOnce({
      success: true,
      entries: [
        {
          window: "five_hour",
          name: "Renamed MiniMax 5h",
          right: "70/4500",
          percentRemaining: 98,
          resetTimeIso: "2026-03-25T18:00:00.000Z",
        },
        {
          window: "weekly",
          name: "Renamed MiniMax Weekly",
          right: "105/45000",
          percentRemaining: 100,
          resetTimeIso: "2026-04-01T00:00:00.000Z",
        },
      ],
    });

    const report = await buildMiniMaxStatusReport();

    expect(report).toContain("minimax:");
    expect(report).toContain("- auth_state: configured");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: auth.json");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain(
      "- five_hour_usage: 70/4500 percent_remaining=98 reset_at=2026-03-25T18:00:00.000Z",
    );
    expect(report).toContain(
      "- weekly_usage: 105/45000 percent_remaining=100 reset_at=2026-04-01T00:00:00.000Z",
    );
    expect(minimaxMocks.resolveMiniMaxAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
    expect(minimaxMocks.queryMiniMaxQuota).toHaveBeenCalledWith("test-key");
  });

  it("reports MiniMax auth errors", async () => {
    minimaxMocks.getMiniMaxAuthDiagnostics.mockResolvedValueOnce({
      state: "invalid",
      source: "auth.json",
      checkedPaths: ["/tmp/auth.json"],
      error: 'Unsupported MiniMax auth type: "oauth"',
    });

    const invalidReport = await buildMiniMaxStatusReport();

    expect(invalidReport).toContain("minimax:");
    expect(invalidReport).toContain("- auth_state: invalid");
    expect(invalidReport).toContain("- api_key_configured: false");
    expect(invalidReport).toContain("- api_key_source: auth.json");
    expect(invalidReport).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(invalidReport).toContain('- auth_error: Unsupported MiniMax auth type: "oauth"');
    expect(minimaxMocks.resolveMiniMaxAuthCached).not.toHaveBeenCalled();
    expect(minimaxMocks.queryMiniMaxQuota).not.toHaveBeenCalled();
  });

  it("reports MiniMax endpoint errors", async () => {
    minimaxMocks.getMiniMaxAuthDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "auth.json",
      checkedPaths: ["/tmp/auth.json"],
    });
    minimaxMocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
      state: "configured",
      apiKey: "test-key",
    });
    minimaxMocks.queryMiniMaxQuota.mockResolvedValueOnce({
      success: false,
      error: "MiniMax API error 401: Unauthorized",
    });

    const fetchErrorReport = await buildMiniMaxStatusReport();

    expect(fetchErrorReport).toContain("- live_fetch_error: MiniMax API error 401: Unauthorized");
  });

  it("reports Z.ai auth diagnostics and live quota details when configured", async () => {
    zaiMocks.getZaiAuthDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "auth.json",
      checkedPaths: ["/tmp/auth.json"],
    });
    zaiMocks.queryZaiQuota.mockResolvedValueOnce({
      success: true,
      label: "Z.ai",
      windows: {
        fiveHour: { percentRemaining: 67, resetTimeIso: "2026-03-25T18:00:00.000Z" },
        weekly: { percentRemaining: 44, resetTimeIso: "2026-04-01T00:00:00.000Z" },
        mcp: { percentRemaining: 90, resetTimeIso: "2026-04-10T00:00:00.000Z" },
      },
    });

    const report = await buildZaiStatusReport();

    expect(report).toContain("zai:");
    expect(report).toContain("- auth_state: configured");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: auth.json");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("- five_hour_remaining: 67% reset_at=2026-03-25T18:00:00.000Z");
    expect(report).toContain("- weekly_remaining: 44% reset_at=2026-04-01T00:00:00.000Z");
    expect(report).toContain("- mcp_remaining: 90% reset_at=2026-04-10T00:00:00.000Z");
  });

  it("reports Z.ai auth errors", async () => {
    zaiMocks.getZaiAuthDiagnostics.mockResolvedValueOnce({
      state: "invalid",
      source: "auth.json",
      checkedPaths: ["/tmp/auth.json"],
      error: 'Unsupported Z.ai auth type: "oauth"',
    });

    const report = await buildZaiStatusReport();

    expect(report).toContain("zai:");
    expect(report).toContain("- auth_state: invalid");
    expect(report).toContain("- api_key_configured: false");
    expect(report).toContain("- api_key_source: auth.json");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain('- auth_error: Unsupported Z.ai auth type: "oauth"');
    expect(zaiMocks.queryZaiQuota).not.toHaveBeenCalled();
  });

  it("reports Z.ai endpoint errors", async () => {
    zaiMocks.getZaiAuthDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "auth.json",
      checkedPaths: ["/tmp/auth.json"],
    });
    zaiMocks.queryZaiQuota.mockResolvedValueOnce({
      success: false,
      error: "Z.ai API error 401: Unauthorized",
    });

    const report = await buildZaiStatusReport();

    expect(report).toContain("- live_fetch_error: Z.ai API error 401: Unauthorized");
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
    expect(report).toContain(
      "- token_compatibility_error: GitHub's enterprise premium usage endpoint does not support fine-grained personal access tokens.",
    );
  });
});
