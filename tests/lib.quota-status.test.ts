import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildProviderStatusReport,
  buildQuotaStatusReportForTest,
  expectReportSection,
  getReportSection,
  makeProviderAvailability,
} from "./helpers/quota-status-test-harness.js";

const QUOTA_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "local_estimation",
  ownership: "maintained",
  authority: "locally_derived",
} as const;

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
      hasEnterpriseUrl: false,
    },
    deployment: "github.com",
    apiHost: "api.github.com",
    enterpriseHostSource: "none",
    effectiveSource: "pat",
    override: "pat_overrides_oauth",
    billingMode: "organization_usage",
    billingScope: "organization",
    quotaApi: "github_ai_credit_api",
    billingModel: "ai_credits",
    budgetApi: "organization_budgets",
    oauthAccountingState: "available_via_copilot_internal_user",
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

const googleCompanionMocks = vi.hoisted(() => ({
  inspectAntigravityCompanionPresence: vi.fn(async () => ({
    state: "missing" as const,
    importSpecifier: "opencode-antigravity-auth/dist/src/constants.js",
    error: "Install opencode-antigravity-auth separately to enable Google Antigravity quota",
  })),
}));

const geminiCliMocks = vi.hoisted(() => ({
  inspectGeminiCliAuthPresence: vi.fn(async () => ({
    state: "missing" as const,
    accountCount: 0,
    validAccountCount: 0,
  })),
  inspectGeminiCliCompanionPresence: vi.fn(async () => ({
    state: "missing" as const,
    importSpecifier: "opencode-gemini-auth/src/constants.ts",
    error: "Install opencode-gemini-auth separately to enable Gemini CLI quota",
  })),
}));

const agyMocks = vi.hoisted(() => ({
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "missing" as const,
    accountCount: 0,
    validAccountCount: 0,
  })),
  inspectAgyCompanionPresence: vi.fn(async () => ({
    state: "missing" as const,
    importSpecifier: "@anthonyhaussman/opencode-agy-auth/dist/src/constants.js",
    error: "Install @anthonyhaussman/opencode-agy-auth separately to enable Google AGY quota",
  })),
}));

const openaiMocks = vi.hoisted(() => ({
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" as const })),
}));

const alibabaMocks = vi.hoisted(() => ({
  getAlibabaCodingPlanAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
  resolveAlibabaCodingPlanAuthCached: vi.fn(async () => ({ state: "none" as const })),
}));

const minimaxMocks = vi.hoisted(() => ({
  getMiniMaxAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
  getMiniMaxChinaAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
  resolveMiniMaxAuthCached: vi.fn(async () => ({ state: "none" as const })),
  resolveMiniMaxChinaAuthCached: vi.fn(async () => ({ state: "none" as const })),
  queryMiniMaxQuota: vi.fn(async () => ({ success: true as const, entries: [] })),
}));

const zaiMocks = vi.hoisted(() => ({
  getZaiAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
  queryZaiQuota: vi.fn(async () => null),
}));

const zhipuMocks = vi.hoisted(() => ({
  getZhipuAuthDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
  queryZhipuQuota: vi.fn(async () => null),
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

const deepSeekMocks = vi.hoisted(() => ({
  getDeepSeekKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
    authPaths: ["/tmp/auth.json"],
  })),
}));

const syntheticMocks = vi.hoisted(() => ({
  getSyntheticKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
  querySyntheticQuota: vi.fn(async () => null),
}));

const openCodeGoMocks = vi.hoisted(() => ({
  getOpenCodeGoConfigDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    missing: null,
    error: null,
    checkedPaths: [],
  })),
  resolveOpenCodeGoConfigCached: vi.fn(async () => ({ state: "none" as const })),
  queryOpenCodeGoQuota: vi.fn(async () => null),
}));

const openCodeZenMocks = vi.hoisted(() => ({
  getOpenCodeZenConfigDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    missing: null,
    error: null,
    checkedPaths: [],
  })),
  resolveOpenCodeZenConfigCached: vi.fn(async () => ({ state: "none" as const })),
  queryOpenCodeZenQuota: vi.fn(async () => ({
    success: false as const,
    error: "not configured",
  })),
}));

const mimoMocks = vi.hoisted(() => ({
  getMimoConfigDiagnostics: vi.fn(async () => ({
    state: "none" as const,
    source: null,
    error: null,
    checkedPaths: [],
  })),
}));

const anthropicMocks = vi.hoisted(() => ({
  getAnthropicDiagnostics: vi.fn(async () => ({
    installed: true,
    version: "1.2.3",
    authStatus: "authenticated",
    quotaSupported: false,
    quotaSource: "none",
    checkedCommands: ["claude --version", "claude auth status --json"],
    message:
      "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback. Claude credentials file not found at /Users/test/.claude/.credentials.json.",
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
  getOpenCodeGoConfigDiagnostics: openCodeGoMocks.getOpenCodeGoConfigDiagnostics,
  resolveOpenCodeGoConfigCached: openCodeGoMocks.resolveOpenCodeGoConfigCached,
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

vi.mock("../src/lib/opencode-go.js", () => ({
  queryOpenCodeGoQuota: openCodeGoMocks.queryOpenCodeGoQuota,
}));

vi.mock("../src/lib/opencode-zen-config.js", () => ({
  getOpenCodeZenConfigDiagnostics: openCodeZenMocks.getOpenCodeZenConfigDiagnostics,
  resolveOpenCodeZenConfigCached: openCodeZenMocks.resolveOpenCodeZenConfigCached,
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

vi.mock("../src/lib/opencode-zen.js", () => ({
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR: 100_000_000,
  queryOpenCodeZenQuota: openCodeZenMocks.queryOpenCodeZenQuota,
}));

vi.mock("../src/lib/mimo-config.js", () => ({
  getMimoConfigDiagnostics: mimoMocks.getMimoConfigDiagnostics,
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getGoogleTokenCachePath: () => "/tmp/google-token-cache.json",
}));

vi.mock("../src/lib/google.js", () => ({
  inspectAntigravityAccountsPresence: googleMocks.inspectAntigravityAccountsPresence,
}));

vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  inspectAntigravityCompanionPresence: googleCompanionMocks.inspectAntigravityCompanionPresence,
}));

vi.mock("../src/lib/google-gemini-cli.js", () => ({
  inspectGeminiCliAuthPresence: geminiCliMocks.inspectGeminiCliAuthPresence,
}));

vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: geminiCliMocks.inspectGeminiCliCompanionPresence,
}));

vi.mock("../src/lib/google-agy.js", () => ({
  inspectAgyAuthPresence: agyMocks.inspectAgyAuthPresence,
}));

vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: agyMocks.inspectAgyCompanionPresence,
}));

vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: anthropicMocks.getAnthropicDiagnostics,
}));

vi.mock("../src/lib/synthetic.js", () => ({
  getSyntheticKeyDiagnostics: syntheticMocks.getSyntheticKeyDiagnostics,
  querySyntheticQuota: syntheticMocks.querySyntheticQuota,
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

vi.mock("../src/lib/deepseek.js", () => ({
  getDeepSeekKeyDiagnostics: deepSeekMocks.getDeepSeekKeyDiagnostics,
}));

vi.mock("../src/lib/copilot.js", () => ({
  getCopilotQuotaAuthDiagnostics: copilotMocks.getCopilotQuotaAuthDiagnostics,
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  QWEN_LOCAL_QUOTA_STATE_VERSION: 1,
  ALIBABA_CODING_PLAN_STATE_VERSION: 1,
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
  resolveAlibabaCodingPlanAuthCached: alibabaMocks.resolveAlibabaCodingPlanAuthCached,
}));

vi.mock("../src/lib/minimax-auth.js", () => ({
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
  getMiniMaxAuthDiagnostics: minimaxMocks.getMiniMaxAuthDiagnostics,
  getMiniMaxChinaAuthDiagnostics: minimaxMocks.getMiniMaxChinaAuthDiagnostics,
  resolveMiniMaxAuthCached: minimaxMocks.resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached: minimaxMocks.resolveMiniMaxChinaAuthCached,
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

vi.mock("../src/lib/zhipu-auth.js", () => ({
  DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS: 5_000,
  getZhipuAuthDiagnostics: zhipuMocks.getZhipuAuthDiagnostics,
}));

vi.mock("../src/lib/zhipu.js", () => ({
  queryZhipuQuota: zhipuMocks.queryZhipuQuota,
}));

vi.mock("../src/lib/cursor-detection.js", () => ({
  CURSOR_CANONICAL_PLUGIN_PACKAGE: "@playwo/opencode-cursor-oauth",
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
  getProviders: () => [
    { id: "copilot" },
    { id: "cursor" },
    { id: "synthetic" },
    { id: "nanogpt" },
    { id: "deepseek" },
    { id: "xiaomi" },
    { id: "kimi-for-coding" },
    { id: "kimi-code" },
  ],
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

  it("renders config validation errors in the toast diagnostics section", async () => {
    const geminiCliClient = { config: { get: vi.fn() } };

    const report = await buildQuotaStatusReportForTest({
      configSource: "files",
      configPaths: [
        "/tmp/project/opencode-quota/quota-toast.json (opencode-quota/quota-toast.json)",
      ],
      settingSources: {
        enabledProviders:
          "/tmp/project/opencode-quota/quota-toast.json (opencode-quota/quota-toast.json)",
      },
      configIssues: [
        {
          path: "/tmp/project/opencode-quota/quota-toast.json (opencode-quota/quota-toast.json)",
          key: "enabledProviders",
          message: "unknown provider id(s): opnai",
        },
      ],
      geminiCliClient,
    });

    expect(report).toContain("- enabledProviders: (none)");
    expect(report).toContain("- config_errors:");
    expect(report).toContain(
      "  - /tmp/project/opencode-quota/quota-toast.json (opencode-quota/quota-toast.json) enabledProviders: unknown provider id(s): opnai",
    );
    expect(geminiCliMocks.inspectGeminiCliAuthPresence).toHaveBeenCalledWith(geminiCliClient);
  });

  it("renders only safe quota-provider identity and diagnostic fields", async () => {
    const report = await buildQuotaStatusReportForTest({
      enabledProviders: ["quota-providers"],
      quotaProviders: [
        {
          id: "first-source",
          providerId: "internal_gateway",
          label: "Duplicate label",
          mode: "remote-api",
          url: "https://private.example/secret-path",
          format: "json-v1",
          adapter: {
            mappings: [
              {
                resultType: "status",
                name: "Private status",
                metric: { type: "status", value: { literal: "private-adapter-literal" } },
              },
            ],
          },
          apiKeyEnv: "INTERNAL_GATEWAY_KEY",
          modelIds: ["model-a"],
        },
        {
          id: "second-source",
          providerId: "openrouter",
          label: "Duplicate label",
          mode: "remote-api",
          url: "https://openrouter.ai/api/v1/key",
          format: "openrouter-key-v1",
        },
      ],
      providerLiveProbes: [
        {
          providerId: "quota-providers",
          result: {
            attempted: true,
            entries: [],
            errors: [{ label: "Duplicate label", message: "raw body secret" }],
            diagnostics: [
              {
                sourceId: "first-source",
                providerId: "internal_gateway",
                mode: "remote-api",
                format: "json-v1",
                modelIds: ["model-a"],
                apiKeyEnv: "INTERNAL_GATEWAY_KEY",
                selected: true,
                attempted: true,
                credentialSource: "global_opencode_jsonc",
                outcome: "http_error",
                httpStatus: 401,
                entryCount: 0,
                checkedPaths: ["env:INTERNAL_GATEWAY_KEY", "/trusted/opencode.jsonc"],
                authPaths: ["/trusted/auth.json"],
              },
            ],
          },
        },
      ],
    });

    const section = getReportSection(report, "quota_providers:");
    expect(section).toContain("provider_first-source:");
    expect(section).toContain("provider_id=internal_gateway");
    expect(section).toContain("mode=remote-api");
    expect(section).toContain("format=json-v1");
    expect(section).toContain("coverage=model-a");
    expect(section).toContain("outcome=http_error");
    expect(section).toContain("credential_category=trusted_global_config");
    expect(section).toContain("env_name=INTERNAL_GATEWAY_KEY");
    expect(section).toContain("/trusted/opencode.jsonc | /trusted/auth.json");
    expect(section).toContain("provider_second-source:");
    expect(section).toContain("outcome=unavailable");
    expect(section).not.toContain("private.example");
    expect(section).not.toContain("openrouter.ai");
    expect(section).not.toContain("raw body secret");
    expect(section).not.toContain("private-adapter-literal");
    expect(section).not.toContain("401");
  });

  it("uses maintained Qwen and Alibaba probes and state paths for tuning diagnostics", async () => {
    const report = await buildQuotaStatusReportForTest({
      enabledProviders: ["qwen-code", "alibaba-coding-plan"],
      quotaProviders: [
        {
          id: "qwen-code",
          providerId: "qwen-code",
          mode: "local-estimate",
          windows: [
            { id: "daily", type: "utc-day", requestLimit: 900 },
            { id: "rpm", type: "rolling", durationMinutes: 1, requestLimit: 50 },
          ],
        },
        {
          id: "alibaba-coding-plan",
          providerId: "alibaba-coding-plan",
          mode: "local-estimate",
          windows: [
            { id: "five-hour", type: "rolling", durationMinutes: 300, requestLimit: 1000 },
            { id: "weekly", type: "rolling", durationMinutes: 10080, requestLimit: 8000 },
            { id: "monthly", type: "rolling", durationMinutes: 43200, requestLimit: 16000 },
          ],
        },
      ],
      providerLiveProbes: [
        {
          providerId: "qwen-code",
          result: {
            attempted: true,
            entries: [
              {
                accounting: QUOTA_ACCOUNTING,
                name: "Qwen Free Daily",
                percentRemaining: 90,
              },
            ],
            errors: [{ label: "Qwen", message: "one local row failed" }],
          },
        },
        {
          providerId: "alibaba-coding-plan",
          result: {
            attempted: true,
            entries: [
              {
                accounting: QUOTA_ACCOUNTING,
                name: "Alibaba 5h",
                percentRemaining: 80,
              },
            ],
            errors: [],
          },
        },
      ],
    });

    const section = getReportSection(report, "quota_providers:");
    expect(section).toContain(
      "provider_qwen-code: provider_id=qwen-code mode=local-estimate coverage=all_models outcome=partial",
    );
    expect(section).toContain("limits=daily:900,rpm:50");
    expect(section).toContain("state_path=/tmp/qwen-state.json");
    expect(section).toContain(
      "provider_alibaba-coding-plan: provider_id=alibaba-coding-plan mode=local-estimate coverage=all_models outcome=success",
    );
    expect(section).toContain("limits=five-hour:1000,weekly:8000,monthly:16000");
    expect(section).toContain("state_path=/tmp/alibaba-state.json");
    expect(section).not.toContain("quota-providers/qwen-code.json");
    expect(section).not.toContain("quota-providers/alibaba-coding-plan.json");
  });

  const buildMiniMaxStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport(
      ["minimax-coding-plan", "minimax-china-coding-plan"],
      overrides as any,
    );

  const buildZaiStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport("zai", overrides as any);

  const buildZhipuStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport("zhipu", overrides as any);

  const buildOpenCodeGoStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport("opencode-go", {
      providerAvailability: [makeProviderAvailability("opencode-go", { available: false })],
      ...overrides,
    } as any);

  const buildOpenCodeZenStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport("opencode", overrides as any);

  const buildXiaomiStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport("xiaomi", overrides as any);

  const buildSyntheticStatusReport = (overrides: Record<string, unknown> = {}) =>
    buildProviderStatusReport("synthetic", overrides as any);

  it("renders simplified maintainer announcement diagnostics", async () => {
    const report = await buildSyntheticStatusReport({
      maintainerAnnouncements: {
        config: {
          enabled: true,
          home: true,
        },
        summary: {
          source: "bundled_only",
          network: false,
          bundledCount: 4,
          activeCount: 2,
          futureCount: 1,
          expiredCount: 1,
          activeAnnouncements: [],
          evaluations: [],
        },
      },
    });

    expectReportSection(
      report,
      "maintainer_announcements:",
      [
        "- enabled: true",
        "- home: true",
        "- source: bundled_only",
        "- network: false",
        "- active: 2",
        "- future: 1",
        "- expired: 1",
      ],
      ["state_path", "toast", "bundled_count", "active_count", "dismissed"],
    );
  });

  it("distinguishes organization billing access from computable remaining quota totals", async () => {
    const report = await buildQuotaStatusReportForTest({
      configSource: "files",
      configPaths: [
        "/tmp/config/opencode.json (experimental.quotaToast)",
        "/tmp/project/opencode.jsonc (experimental.quotaToast)",
      ],
      globalConfigPaths: ["/tmp/config/opencode.json (experimental.quotaToast)"],
      workspaceConfigPaths: ["/tmp/project/opencode.jsonc (experimental.quotaToast)"],
      settingSources: {
        enabled: "/tmp/config/opencode.json (experimental.quotaToast)",
        enableToast: "/tmp/config/opencode.json (experimental.quotaToast)",
        minIntervalMs: "/tmp/project/opencode.jsonc (experimental.quotaToast)",
        enabledProviders: "/tmp/project/opencode.jsonc (experimental.quotaToast)",
        "pricingSnapshot.source": "/tmp/config/opencode.json (experimental.quotaToast)",
        "pricingSnapshot.autoRefresh": "/tmp/project/opencode.jsonc (experimental.quotaToast)",
        showOnIdle: "/tmp/config/opencode.json (experimental.quotaToast)",
        showOnQuestion: "/tmp/project/opencode.jsonc (experimental.quotaToast)",
        showOnCompact: "/tmp/project/opencode.jsonc (experimental.quotaToast)",
        showOnBothFail: "/tmp/config/opencode.json (experimental.quotaToast)",
        "layout.maxWidth": "/tmp/project/opencode.jsonc (experimental.quotaToast)",
      },
      tuiDiagnostics: {
        workspaceRoot: "/tmp/workspace",
        configRoot: "/tmp/project",
        configured: true,
        inferredSelectedPath: "/tmp/project/tui.jsonc",
        presentPaths: ["/tmp/config/tui.json", "/tmp/project/tui.jsonc"],
        candidatePaths: [
          "/tmp/config/tui.json",
          "/tmp/config/tui.jsonc",
          "/tmp/project/tui.json",
          "/tmp/project/tui.jsonc",
        ],
        quotaPluginConfigured: true,
        quotaPluginConfigPaths: ["/tmp/project/tui.jsonc"],
      },
      enabledProviders: ["copilot"],
      anthropicBinaryPath: "/opt/claude/bin/claude",
      cursorPlan: "pro",
      pricingSnapshotSource: "runtime",
    });

    expect(report).toMatch(
      /^# Quota Status \(opencode-quota v1\.2\.3\) \(\/quota_status\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/,
    );
    expect(report).toContain(
      "- opencode_dirs: data=/tmp/data config=/tmp/config cache=/tmp/cache state=/tmp/state",
    );
    expect(report).toContain(
      "- configPaths: /tmp/config/opencode.json (experimental.quotaToast) | /tmp/project/opencode.jsonc (experimental.quotaToast)",
    );
    expect(report).toContain("- precedence: global defaults -> workspace overrides");
    expect(report).toContain(
      "- global_config_paths: /tmp/config/opencode.json (experimental.quotaToast)",
    );
    expect(report).toContain(
      "- workspace_config_paths: /tmp/project/opencode.jsonc (experimental.quotaToast)",
    );
    expect(report).toContain(
      "- setting_sources: enabled<=/tmp/config/opencode.json (experimental.quotaToast) | enableToast<=/tmp/config/opencode.json (experimental.quotaToast) | minIntervalMs<=/tmp/project/opencode.jsonc (experimental.quotaToast) | enabledProviders<=/tmp/project/opencode.jsonc (experimental.quotaToast) | pricingSnapshot.source<=/tmp/config/opencode.json (experimental.quotaToast) | pricingSnapshot.autoRefresh<=/tmp/project/opencode.jsonc (experimental.quotaToast) | showOnIdle<=/tmp/config/opencode.json (experimental.quotaToast) | showOnQuestion<=/tmp/project/opencode.jsonc (experimental.quotaToast) | showOnCompact<=/tmp/project/opencode.jsonc (experimental.quotaToast) | showOnBothFail<=/tmp/config/opencode.json (experimental.quotaToast) | layout.maxWidth<=/tmp/project/opencode.jsonc (experimental.quotaToast)",
    );
    expect(report).toContain("tui:");
    expect(report).toContain("- workspace_root: /tmp/workspace");
    expect(report).toContain("- config_root: /tmp/project");
    expect(report).toContain("- config_configured: true");
    expect(report).toContain("- inferred_selected_config_path: /tmp/project/tui.jsonc");
    expect(report).toContain(
      "- present_config_paths: /tmp/config/tui.json | /tmp/project/tui.jsonc",
    );
    expect(report).toContain(
      "- candidate_config_paths: /tmp/config/tui.json | /tmp/config/tui.jsonc | /tmp/project/tui.json | /tmp/project/tui.jsonc",
    );
    expect(report).toContain("- quota_plugin_configured: true");
    expect(report).toContain("- quota_plugin_paths: /tmp/project/tui.jsonc");
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
    expect(report).toContain("- alibaba_api_key_source: (none)");
    expect(report).toContain("- alibaba_api_key_checked_paths: (none)");
    expect(report).toContain("- alibaba_api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("- alibaba_coding_plan: (none)");
    expect(report).toContain("anthropic:");
    expect(report).toContain("- cli_installed: true");
    expect(report).toContain("- cli_version: 1.2.3");
    expect(report).toContain("- auth_status: authenticated");
    expect(report).toContain("- quota_supported: false");
    expect(report).toContain("- quota_source: (none)");
    expect(report).toContain("- checked_commands: claude --version | claude auth status --json");
    expect(report).toContain(
      "- message: Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback. Claude credentials file not found at /Users/test/.claude/.credentials.json.",
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
    expect(report).toContain("- api_key_checked_paths: (none)");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("synthetic:");
    expect(report).toContain("chutes:");
    expect(report).toContain("cursor:");
    expect(report).toContain("- plan: Pro");
    expect(report).toContain("- included_api_usd: $20.00");
    expect(report).toContain("- auth_state: present");
    expect(report).toContain("- plugin_enabled: true");
    expect(report).toContain("- canonical_plugin_package: @playwo/opencode-cursor-oauth");
    expect(report).toContain("- provider_configured: true");
    expect(report).toContain("- cycle_source: calendar_month");
    expect(report).toContain("- api_usage: $3.50 across 2 messages");
    expect(report).toContain("- total_cursor_usage: $4.75 across 3 messages");
    expect(report).toContain("copilot_quota_auth:");
    expect(report).toContain("- deployment: github.com");
    expect(report).toContain("- api_host: api.github.com");
    expect(report).toContain("- enterprise_host_source: none");
    expect(report).toContain("- billing_mode: organization_usage");
    expect(report).toContain("- billing_scope: organization");
    expect(report).toContain("- quota_api: github_ai_credit_api");
    expect(report).toContain("- budget_api: organization_budgets");
    expect(report).toContain("- oauth_accounting_state: available_via_copilot_internal_user");
    expect(report).toContain("- billing_api_access_likely: true");
    expect(report).toContain("- remaining_totals_state: not_available_from_org_usage");
    expect(report).toContain("- billing_period: 2026-01");
    expect(report).toContain("- username_filter: alice");
    expect(report).not.toContain("github_pat_123");
    expect(report).not.toContain("https://api.github.com");
    expect(report).not.toContain("?token=");
    expect(report).toContain("google_antigravity:");
    expect(report).toContain("- auth_state: missing");
    expect(report).toContain("- selected_accounts_path: (none)");
    expect(report).toContain("- present_accounts_paths: (none)");
    expect(report).toContain("- candidate_accounts_paths: /tmp/antigravity-accounts.json");
    expect(report).toContain("- account_count: 0");
    expect(report).toContain("- valid_account_count: 0");
    expect(report).toContain("- companion_package_state: missing");
    expect(report).toContain("- companion_package_path: (none)");
    expect(report).toContain(
      "- companion_error: Install opencode-antigravity-auth separately to enable Google Antigravity quota",
    );
    expect(report).toContain("- token_cache_path: /tmp/google-token-cache.json exists=false");
    expect(report).toContain(
      "- billing_usage_note: organization AI Credit usage for the current UTC calendar month",
    );
    expect(report).toContain(
      "- remaining_quota_note: the usage report exposes included-pool consumption and billed usage, but no included-pool denominator; percentages require a real budget",
    );
    expect(report).toContain(
      "- synthetic: pricing=no (subscription request quota (not token-priced))",
    );
    expect(report).toContain(
      "- nanogpt: pricing=no (subscription request quota + account balance (not token-priced))",
    );
    expect(report).toContain(
      "- kimi-for-coding: pricing=no (request quota via Kimi Code API (not token-priced))",
    );
    expect(report).toContain(
      "- kimi-code: pricing=no (request quota via Kimi Code API (not token-priced))",
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

    const report = await buildProviderStatusReport("anthropic");

    expect(report).toContain("- cli_version: 1.2.4");
    expect(report).toContain("- quota_supported: true");
    expect(report).toContain("- quota_source: claude-auth-status-json");
    expect(report).toContain("- five_hour_remaining: 43% reset_at=2026-03-25T18:00:00.000Z");
    expect(report).toContain("- seven_day_remaining: 88% reset_at=2026-04-01T00:00:00.000Z");
  });

  it("reports Anthropic quota window details when the Claude OAuth fallback wins", async () => {
    anthropicMocks.getAnthropicDiagnostics.mockResolvedValueOnce({
      installed: true,
      version: "1.2.5",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      checkedCommands: ["claude --version", "claude auth status --json"],
      quota: {
        success: true,
        five_hour: {
          percentRemaining: 65,
          resetTimeIso: "2026-03-25T18:00:00.000Z",
        },
        seven_day: {
          percentRemaining: 85,
          resetTimeIso: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    const report = await buildProviderStatusReport("anthropic");

    expect(report).toContain("- cli_version: 1.2.5");
    expect(report).toContain("- quota_supported: true");
    expect(report).toContain("- quota_source: claude-credentials-oauth-api");
    expect(report).toContain("- five_hour_remaining: 65% reset_at=2026-03-25T18:00:00.000Z");
    expect(report).toContain("- seven_day_remaining: 85% reset_at=2026-04-01T00:00:00.000Z");
  });

  it("renders Synthetic API-key diagnostics plus compact live success rows", async () => {
    syntheticMocks.getSyntheticKeyDiagnostics.mockResolvedValueOnce({
      configured: true,
      source: "env:SYNTHETIC_API_KEY",
      checkedPaths: ["env:SYNTHETIC_API_KEY"],
    });

    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        {
          providerId: "synthetic",
          result: {
            attempted: true,
            entries: [
              {
                name: "Synthetic 5h",
                group: "Synthetic",
                label: "5h:",
                percentRemaining: 84.4,
                right: "9/50",
                resetTimeIso: "2026-04-21T18:00:00.000Z",
              },
              {
                name: "Synthetic Weekly",
                group: "Synthetic",
                label: "Weekly:",
                percentRemaining: 8.4552365,
                right: "$22/$24",
                resetTimeIso: "2026-04-27T18:00:00.000Z",
              },
            ],
            errors: [],
          },
        },
      ],
    });

    expect(report).toContain("synthetic:");
    expect(report).toContain("- synthetic api key: configured=true source=env:SYNTHETIC_API_KEY");
    expect(report).toContain("- live_probe: success");
    expect(report).toContain(
      "- live_entry_1: 5h: 9/50 percent_remaining=84 reset_at=2026-04-21T18:00:00.000Z",
    );
    expect(report).toContain(
      "- live_entry_2: Weekly: $22/$24 percent_remaining=8 reset_at=2026-04-27T18:00:00.000Z",
    );
    expect(syntheticMocks.querySyntheticQuota).not.toHaveBeenCalled();
  });

  it("renders Synthetic live no-data state when the shared probe returns nothing reportable", async () => {
    syntheticMocks.getSyntheticKeyDiagnostics.mockResolvedValueOnce({
      configured: true,
      source: "env:SYNTHETIC_API_KEY",
      checkedPaths: ["env:SYNTHETIC_API_KEY"],
    });

    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        {
          providerId: "synthetic",
          result: {
            attempted: false,
            entries: [],
            errors: [],
          },
        },
      ],
    });

    expect(report).toContain("synthetic:");
    expect(report).toContain("- synthetic api key: configured=true source=env:SYNTHETIC_API_KEY");
    expect(report).toContain("- live_probe: no_data");
  });

  it("renders compact live probes in mapped and probe-only provider sections", async () => {
    const report = await buildQuotaStatusReportForTest({
      enabledProviders: [
        "openai",
        "qwen-code",
        "alibaba-coding-plan",
        "minimax-coding-plan",
        "copilot",
        "google-antigravity",
        "google-gemini-cli",
        "chutes",
      ],
      providerLiveProbes: [
        {
          providerId: "openai",
          result: {
            attempted: true,
            entries: [
              {
                label: "Pro",
                name: "OpenAI Pro",
                percentRemaining: 91,
                right: "91/100",
                resetTimeIso: "2026-04-22T00:00:00.000Z",
              },
            ],
            errors: [],
          },
        },
        {
          providerId: "qwen-code",
          result: {
            attempted: true,
            entries: [
              {
                label: "Daily",
                name: "Qwen Code Daily",
                percentRemaining: 88,
                right: "120/1000",
                resetTimeIso: "2026-04-22T00:00:00.000Z",
              },
            ],
            errors: [],
          },
        },
        {
          providerId: "alibaba-coding-plan",
          result: {
            attempted: false,
            entries: [],
            errors: [],
          },
        },
        {
          providerId: "minimax-coding-plan",
          result: {
            attempted: true,
            entries: [
              {
                label: "Weekly",
                name: "MiniMax Weekly",
                percentRemaining: 63,
                right: "1600/45000",
                resetTimeIso: "2026-04-28T00:00:00.000Z",
              },
            ],
            errors: [],
          },
        },
        {
          providerId: "copilot",
          result: {
            attempted: true,
            entries: [],
            errors: [{ label: "Copilot", message: "Billing endpoint unavailable" }],
          },
        },
        {
          providerId: "google-antigravity",
          result: {
            attempted: false,
            entries: [],
            errors: [],
          },
        },
        {
          providerId: "google-gemini-cli",
          result: {
            attempted: true,
            entries: [
              {
                label: "Pro",
                name: "Gemini CLI Pro",
                percentRemaining: 77,
                right: "77 left",
                resetTimeIso: "2026-04-23T00:00:00.000Z",
              },
            ],
            errors: [],
          },
        },
        {
          providerId: "chutes",
          result: {
            attempted: true,
            entries: [],
            errors: [
              {
                label: "Chutes",
                message: "probe \u001b[31mfailed\u0007\n\twith noise",
              },
            ],
          },
        },
      ],
    });

    const openaiSection = getReportSection(report, "openai:");
    expect(openaiSection).toContain("- live_probe: success");
    expect(openaiSection).toContain(
      "- live_entry_1: Pro 91/100 percent_remaining=91 reset_at=2026-04-22T00:00:00.000Z",
    );

    const qwenSection = getReportSection(report, "qwen_code:");
    expect(qwenSection).toContain("- live_probe: success");
    expect(qwenSection).toContain(
      "- live_entry_1: Daily 120/1000 percent_remaining=88 reset_at=2026-04-22T00:00:00.000Z",
    );

    const alibabaSection = getReportSection(report, "alibaba_coding_plan:");
    expect(alibabaSection).toContain("- live_probe: no_data");

    const minimaxSection = getReportSection(report, "minimax:");
    expect(minimaxSection).toContain("- auth_state: none");
    expect(minimaxSection).toContain("- live_probe: success");
    expect(minimaxSection).toContain(
      "- live_entry_1: Weekly 1600/45000 percent_remaining=63 reset_at=2026-04-28T00:00:00.000Z",
    );

    const copilotSection = getReportSection(report, "copilot_quota_auth:");
    expect(copilotSection).toContain("- live_probe: error");
    expect(copilotSection).toContain("- live_error_1: Billing endpoint unavailable");

    const googleSection = getReportSection(report, "google_antigravity:");
    expect(googleSection).toContain("- live_probe: no_data");

    const geminiCliSection = getReportSection(report, "google_gemini_cli:");
    expect(geminiCliSection).toContain("- auth_state: missing");
    expect(geminiCliSection).toContain("- companion_package_state: missing");
    expect(geminiCliSection).toContain("- live_probe: success");
    expect(geminiCliSection).toContain(
      "- live_entry_1: Pro 77 left percent_remaining=77 reset_at=2026-04-23T00:00:00.000Z",
    );

    const agySection = getReportSection(report, "google_agy:");
    expect(agySection).toContain("- auth_state: missing");
    expect(agySection).toContain("- auth_source: (none)");

    const chutesSection = getReportSection(report, "chutes:");
    expect(chutesSection).toContain("- live_probe: error");
    expect(chutesSection).toContain("- live_error_1: probe failed with noise");
    expect(chutesSection).not.toContain("\u001b[31m");
    expect(chutesSection).not.toContain("\u0007");
  });

  it("reports Google AGY auth, companion, and live quota diagnostics", async () => {
    const agyClient = { config: { get: vi.fn() } };
    agyMocks.inspectAgyAuthPresence.mockResolvedValueOnce({
      state: "present",
      sourceKey: "google-agy",
      accountCount: 2,
      validAccountCount: 2,
    });
    agyMocks.inspectAgyCompanionPresence.mockResolvedValueOnce({
      state: "present",
      importSpecifier: "@anthonyhaussman/opencode-agy-auth/dist/src/constants.js",
      resolvedPath: "/tmp/node_modules/@anthonyhaussman/opencode-agy-auth/dist/src/constants.js",
    });

    const report = await buildProviderStatusReport("google-agy", {
      agyClient,
      providerLiveProbes: [
        {
          providerId: "google-agy",
          result: {
            attempted: true,
            entries: [
              {
                label: "Gemini Models:",
                name: "Gemini Models (alice@example.com)",
                group: "Google AGY",
                percentRemaining: 42,
                right: "120 left",
                resetTimeIso: "2026-04-24T00:00:00.000Z",
              },
            ],
            errors: [
              {
                label: "Google AGY",
                message: "secondary account unavailable",
              },
            ],
          },
        },
      ],
    });

    const agySection = getReportSection(report, "google_agy:");
    expect(agySection).toContain("- auth_state: present");
    expect(agySection).toContain("- auth_source: google-agy");
    expect(agySection).toContain("- account_count: 2");
    expect(agySection).toContain("- valid_account_count: 2");
    expect(agySection).toContain("- companion_package_state: present");
    expect(agySection).toContain(
      "- companion_package_path: /tmp/node_modules/@anthonyhaussman/opencode-agy-auth/dist/src/constants.js",
    );
    expect(agySection).toContain("- live_probe: partial");
    expect(agySection).toContain(
      "- live_entry_1: Gemini Models: 120 left percent_remaining=42 reset_at=2026-04-24T00:00:00.000Z",
    );
    expect(agySection).toContain("- live_error_1: secondary account unavailable");
    expect(agyMocks.inspectAgyAuthPresence).toHaveBeenCalledWith(agyClient);
  });

  it("sanitizes and truncates Synthetic live probe errors", async () => {
    syntheticMocks.getSyntheticKeyDiagnostics.mockResolvedValueOnce({
      configured: true,
      source: "env:SYNTHETIC_API_KEY",
      checkedPaths: ["env:SYNTHETIC_API_KEY"],
    });

    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        {
          providerId: "synthetic",
          result: {
            attempted: true,
            entries: [],
            errors: [
              {
                label: "Synthetic",
                message: `failure \u001b[31mwith control codes\u0007\n\t${"x".repeat(200)}`,
              },
            ],
          },
        },
      ],
    });

    expect(report).toContain("- live_probe: error");
    const errorLine = report.split("\n").find((line) => line.startsWith("- live_error_1: "));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("failure with control codes");
    expect(errorLine).not.toContain("\u001b[31m");
    expect(errorLine).not.toContain("\u0007");
    expect(errorLine).not.toContain("\n");
    expect(errorLine).not.toContain("\t");
    expect(errorLine!.length).toBeLessThanOrEqual(140);
  });

  it("strips OSC and APC terminal escape sequences from Synthetic live probe errors", async () => {
    syntheticMocks.getSyntheticKeyDiagnostics.mockResolvedValueOnce({
      configured: true,
      source: "env:SYNTHETIC_API_KEY",
      checkedPaths: ["env:SYNTHETIC_API_KEY"],
    });

    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        {
          providerId: "synthetic",
          result: {
            attempted: true,
            entries: [],
            errors: [
              {
                label: "Synthetic",
                message:
                  "prefix \u001b]2;window-title\u001b\\ shown \u001b]8;;https://example.test\u0007click\u001b]8;;\u0007 \u001b_hidden\u001b\\ suffix",
              },
            ],
          },
        },
      ],
    });

    const errorLine = report.split("\n").find((line) => line.startsWith("- live_error_1: "));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("prefix shown click suffix");
    expect(errorLine).not.toContain("\u001b]");
    expect(errorLine).not.toContain("\u001b\\");
    expect(errorLine).not.toContain("window-title");
    expect(errorLine).not.toContain("https://example.test");
    expect(errorLine).not.toContain("hidden");
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

    const report = await buildProviderStatusReport("nanogpt");

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

  it("reports DeepSeek API key diagnostics", async () => {
    deepSeekMocks.getDeepSeekKeyDiagnostics.mockResolvedValueOnce({
      configured: true,
      source: "env:DEEPSEEK_API_KEY",
      checkedPaths: ["env:DEEPSEEK_API_KEY"],
      authPaths: ["/tmp/auth.json"],
    });

    const report = await buildProviderStatusReport("deepseek");

    expect(report).toContain("deepseek:");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: env:DEEPSEEK_API_KEY");
    expect(report).toContain("- api_key_checked_paths: env:DEEPSEEK_API_KEY");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain("- deepseek: pricing=no (account balance only (not token-priced))");
  });

  it("reports the xAI live quota probe", async () => {
    const report = await buildProviderStatusReport("xai", {
      providerLiveProbes: [
        {
          providerId: "xai",
          result: {
            attempted: true,
            entries: [
              {
                label: "Weekly:",
                name: "xAI SuperGrok Weekly",
                percentRemaining: 73,
                resetTimeIso: "2026-07-27T00:00:00.000Z",
              },
            ],
            errors: [],
          },
        },
      ],
    } as any);

    const section = getReportSection(report, "xai:");
    expect(section).toContain("- live_probe: success");
    expect(section).toContain(
      "- live_entry_1: Weekly: percent_remaining=73 reset_at=2026-07-27T00:00:00.000Z",
    );
  });

  it("reports OpenCode Go rolling, weekly, and monthly live usage when configured", async () => {
    openCodeGoMocks.getOpenCodeGoConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      missing: null,
      error: null,
      checkedPaths: ["env:OPENCODE_GO_WORKSPACE_ID", "env:OPENCODE_GO_AUTH_COOKIE"],
    });
    openCodeGoMocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      config: { workspaceId: "ws-123", authCookie: "cookie-abc" },
    });
    openCodeGoMocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: true,
      rolling: {
        usagePercent: 7,
        percentRemaining: 93,
        resetInSec: 18000,
        resetTimeIso: "2026-03-12T17:45:00.000Z",
      },
      weekly: {
        usagePercent: 22,
        percentRemaining: 78,
        resetInSec: 540000,
        resetTimeIso: "2026-03-18T18:45:00.000Z",
      },
      monthly: {
        usagePercent: 64,
        percentRemaining: 36,
        resetInSec: 2480000,
        resetTimeIso: "2026-04-10T05:38:20.000Z",
      },
    });

    const report = await buildOpenCodeGoStatusReport({
      providerAvailability: [makeProviderAvailability("opencode-go")],
    });

    expect(report).toContain("opencode_go:");
    expect(report).toContain("- config_state: configured");
    expect(report).toContain("- config_source: env");
    expect(report).toContain("- selected_windows: rolling,weekly,monthly");
    expect(report).toContain(
      "- rolling_usage: percent_used=7 percent_remaining=93 reset_in_sec=18000 reset_at=2026-03-12T17:45:00.000Z",
    );
    expect(report).toContain(
      "- weekly_usage: percent_used=22 percent_remaining=78 reset_in_sec=540000 reset_at=2026-03-18T18:45:00.000Z",
    );
    expect(report).toContain(
      "- monthly_usage: percent_used=64 percent_remaining=36 reset_in_sec=2480000 reset_at=2026-04-10T05:38:20.000Z",
    );
    expect(openCodeGoMocks.resolveOpenCodeGoConfigCached).toHaveBeenCalledWith({
      maxAgeMs: 30_000,
    });
    expect(openCodeGoMocks.queryOpenCodeGoQuota).toHaveBeenCalledWith("ws-123", "cookie-abc");
  });

  it("reports available OpenCode Go live usage without failing when a default window is absent", async () => {
    openCodeGoMocks.getOpenCodeGoConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      missing: null,
      error: null,
      checkedPaths: ["env:OPENCODE_GO_WORKSPACE_ID", "env:OPENCODE_GO_AUTH_COOKIE"],
    });
    openCodeGoMocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      config: { workspaceId: "ws-123", authCookie: "cookie-abc" },
    });
    openCodeGoMocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: true,
      rolling: {
        usagePercent: 7,
        percentRemaining: 93,
        resetInSec: 18000,
        resetTimeIso: "2026-03-12T17:45:00.000Z",
      },
      weekly: {
        usagePercent: 22,
        percentRemaining: 78,
        resetInSec: 540000,
        resetTimeIso: "2026-03-18T18:45:00.000Z",
      },
    });

    const report = await buildOpenCodeGoStatusReport();

    expect(report).toContain("- selected_windows: rolling,weekly,monthly");
    expect(report).toContain(
      "- rolling_usage: percent_used=7 percent_remaining=93 reset_in_sec=18000 reset_at=2026-03-12T17:45:00.000Z",
    );
    expect(report).toContain(
      "- weekly_usage: percent_used=22 percent_remaining=78 reset_in_sec=540000 reset_at=2026-03-18T18:45:00.000Z",
    );
    expect(report).not.toContain("- monthly_usage:");
    expect(report).not.toContain("- live_fetch_error:");
  });

  it("does not report an OpenCode Go status error when a reordered full selection is missing a window", async () => {
    openCodeGoMocks.getOpenCodeGoConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      missing: null,
      error: null,
      checkedPaths: ["env:OPENCODE_GO_WORKSPACE_ID", "env:OPENCODE_GO_AUTH_COOKIE"],
    });
    openCodeGoMocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      config: { workspaceId: "ws-123", authCookie: "cookie-abc" },
    });
    openCodeGoMocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: true,
      rolling: {
        usagePercent: 7,
        percentRemaining: 93,
        resetInSec: 18000,
        resetTimeIso: "2026-03-12T17:45:00.000Z",
      },
      monthly: {
        usagePercent: 64,
        percentRemaining: 36,
        resetInSec: 2480000,
        resetTimeIso: "2026-04-10T05:38:20.000Z",
      },
    });

    const report = await buildOpenCodeGoStatusReport({
      opencodeGoWindows: ["weekly", "monthly", "rolling"],
    });

    expect(report).toContain("- selected_windows: weekly,monthly,rolling");
    expect(report).toContain(
      "- rolling_usage: percent_used=7 percent_remaining=93 reset_in_sec=18000 reset_at=2026-03-12T17:45:00.000Z",
    );
    expect(report).toContain(
      "- monthly_usage: percent_used=64 percent_remaining=36 reset_in_sec=2480000 reset_at=2026-04-10T05:38:20.000Z",
    );
    expect(report).not.toContain("- live_fetch_error:");
  });

  it("reports a clear OpenCode Go status error when a selected window is absent", async () => {
    openCodeGoMocks.getOpenCodeGoConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      missing: null,
      error: null,
      checkedPaths: ["env:OPENCODE_GO_WORKSPACE_ID", "env:OPENCODE_GO_AUTH_COOKIE"],
    });
    openCodeGoMocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env",
      config: { workspaceId: "ws-123", authCookie: "cookie-abc" },
    });
    openCodeGoMocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: true,
      rolling: {
        usagePercent: 7,
        percentRemaining: 93,
        resetInSec: 18000,
        resetTimeIso: "2026-03-12T17:45:00.000Z",
      },
      monthly: {
        usagePercent: 64,
        percentRemaining: 36,
        resetInSec: 2480000,
        resetTimeIso: "2026-04-10T05:38:20.000Z",
      },
    });

    const report = await buildOpenCodeGoStatusReport({ opencodeGoWindows: ["weekly"] });

    expect(report).toContain("- selected_windows: weekly");
    expect(report).toContain(
      "- rolling_usage: percent_used=7 percent_remaining=93 reset_in_sec=18000 reset_at=2026-03-12T17:45:00.000Z",
    );
    expect(report).toContain(
      "- live_fetch_error: Selected OpenCode Go dashboard window(s) missing: weekly (weeklyUsage)",
    );
  });

  it("reports OpenCode Go invalid config details without attempting a live fetch", async () => {
    openCodeGoMocks.getOpenCodeGoConfigDiagnostics.mockResolvedValueOnce({
      state: "invalid",
      source: "/tmp/config/opencode-quota/opencode-go.json",
      missing: null,
      error: "Config file must contain a JSON object",
      checkedPaths: ["/tmp/config/opencode-quota/opencode-go.json"],
    });

    const report = await buildOpenCodeGoStatusReport();

    expect(report).toContain("opencode_go:");
    expect(report).toContain("- config_state: invalid");
    expect(report).toContain("- config_source: /tmp/config/opencode-quota/opencode-go.json");
    expect(report).toContain("- config_error: Config file must contain a JSON object");
    expect(report).toContain("- config_checked_paths: /tmp/config/opencode-quota/opencode-go.json");
    expect(openCodeGoMocks.resolveOpenCodeGoConfigCached).not.toHaveBeenCalled();
    expect(openCodeGoMocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("reports OpenCode Zen config and live billing details without exposing credentials", async () => {
    openCodeZenMocks.getOpenCodeZenConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env(OPENCODE_*)",
      missing: null,
      error: null,
      checkedPaths: ["/tmp/config/opencode-quota/opencode.json"],
    });
    openCodeZenMocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env(OPENCODE_*)",
      config: { workspaceId: "wrk-secret", authCookie: "cookie-secret" },
    });
    openCodeZenMocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 50,
        monthlyUsage: 750_000_000,
        lastPayment: 20,
      },
    });

    const report = await buildOpenCodeZenStatusReport();

    expect(report).toContain("opencode_zen:");
    expect(report).toContain("- config_state: configured");
    expect(report).toContain("- config_source: env(OPENCODE_*)");
    expect(report).toContain("- balance_usd: $42.50");
    expect(report).toContain("- monthly_limit_usd: $50.00");
    expect(report).toContain("- last_payment_usd: $20.00");
    expect(report).not.toContain("wrk-secret");
    expect(report).not.toContain("cookie-secret");
  });

  it("reuses the OpenCode Zen live probe instead of fetching billing twice", async () => {
    openCodeZenMocks.getOpenCodeZenConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env(OPENCODE_*)",
      missing: null,
      error: null,
      checkedPaths: ["/tmp/config/opencode-quota/opencode.json"],
    });

    const report = await buildOpenCodeZenStatusReport({
      providerLiveProbes: [
        {
          providerId: "opencode",
          result: {
            attempted: true,
            entries: [
              {
                accounting: {
                  resultType: "budget",
                  acquisitionMethod: "dashboard_scrape",
                  ownership: "maintained",
                  authority: "locally_derived",
                },
                name: "",
                group: "OpenCode Zen",
                percentRemaining: 92.5,
              },
            ],
            errors: [],
            statusDetails: [
              { key: "balance_usd", value: "$42.50" },
              { key: "monthly_limit_usd", value: "$50.00" },
              { key: "last_payment_usd", value: "$20.00" },
            ],
          },
        },
      ],
    });

    expect(report).toContain("- balance_usd: $42.50");
    expect(report).toContain("- monthly_limit_usd: $50.00");
    expect(report).toContain("- last_payment_usd: $20.00");
    expect(report).toContain("- live_probe: success");
    expect(openCodeZenMocks.resolveOpenCodeZenConfigCached).not.toHaveBeenCalled();
    expect(openCodeZenMocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", []],
    [
      "unrelated",
      [
        {
          providerId: "synthetic",
          result: { attempted: true, entries: [], errors: [] },
        },
      ],
    ],
  ])(
    "fetches OpenCode Zen details once when live probes are %s",
    async (_label, providerLiveProbes) => {
      openCodeZenMocks.getOpenCodeZenConfigDiagnostics.mockResolvedValueOnce({
        state: "configured",
        source: "env(OPENCODE_*)",
        missing: null,
        error: null,
        checkedPaths: ["/tmp/config/opencode-quota/opencode.json"],
      });
      openCodeZenMocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce({
        state: "configured",
        source: "env(OPENCODE_*)",
        config: { workspaceId: "wrk", authCookie: "cookie" },
      });
      openCodeZenMocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
        success: true,
        data: {
          balance: 4_250_000_000,
          monthlyLimit: 50,
          monthlyUsage: 750_000_000,
          lastPayment: 20,
        },
      });

      const report = await buildOpenCodeZenStatusReport({ providerLiveProbes });

      expect(report).toContain("- balance_usd: $42.50");
      expect(openCodeZenMocks.queryOpenCodeZenQuota).toHaveBeenCalledOnce();
    },
  );

  it("does not retry a failed OpenCode Zen live probe", async () => {
    openCodeZenMocks.getOpenCodeZenConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env(OPENCODE_*)",
      missing: null,
      error: null,
      checkedPaths: ["/tmp/config/opencode-quota/opencode.json"],
    });

    const report = await buildOpenCodeZenStatusReport({
      providerLiveProbes: [
        {
          providerId: "opencode",
          result: {
            attempted: true,
            entries: [],
            errors: [{ label: "OpenCode", message: "Request timeout after 10s" }],
          },
        },
      ],
    });

    expect(report).toContain("- live_probe: error");
    expect(openCodeZenMocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("reports a fixed OpenCode Zen parse error without attempting a live fetch", async () => {
    openCodeZenMocks.getOpenCodeZenConfigDiagnostics.mockResolvedValueOnce({
      state: "invalid",
      source: "/tmp/config/opencode-quota/opencode.json",
      missing: null,
      error: "Failed to parse JSON",
      checkedPaths: ["/tmp/config/opencode-quota/opencode.json"],
    });

    const report = await buildOpenCodeZenStatusReport();

    expect(report).toContain("opencode_zen:");
    expect(report).toContain("- config_state: invalid");
    expect(report).toContain("- config_error: Failed to parse JSON");
    expect(openCodeZenMocks.resolveOpenCodeZenConfigCached).not.toHaveBeenCalled();
    expect(openCodeZenMocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("reports safe Xiaomi config and partial live summaries without exposing cookie data", async () => {
    mimoMocks.getMimoConfigDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "env:MIMO_USAGE_COOKIE",
      error: null,
      checkedPaths: ["/tmp/config/opencode-quota/mimo.json"],
    });

    const report = await buildXiaomiStatusReport({
      providerLiveProbes: [
        {
          providerId: "xiaomi",
          result: {
            attempted: true,
            entries: [
              {
                accounting: {
                  resultType: "quota",
                  acquisitionMethod: "dashboard_scrape",
                  ownership: "maintained",
                  authority: "provider_reported",
                },
                name: "Xiaomi MiMo Monthly",
                group: "Xiaomi MiMo",
                label: "Monthly:",
                right: "25/100",
                percentRemaining: 75,
              },
              {
                accounting: {
                  resultType: "balance",
                  acquisitionMethod: "dashboard_scrape",
                  ownership: "maintained",
                  authority: "provider_reported",
                },
                kind: "value",
                name: "Xiaomi MiMo Total Balance",
                group: "Xiaomi MiMo",
                label: "Total:",
                value: "$12.50",
              },
            ],
            errors: [{ label: "Xiaomi MiMo", message: "detail response unavailable" }],
          },
        },
      ],
    });

    const section = getReportSection(report, "xiaomi:");
    expect(section).toContain("- config_state: configured");
    expect(section).toContain("- config_source: env:MIMO_USAGE_COOKIE");
    expect(section).toContain("- config_checked_paths: /tmp/config/opencode-quota/mimo.json");
    expect(section).toContain("- live_probe: partial");
    expect(section).toContain("percent_remaining=75");
    expect(section).toContain("Total: value=$12.50");
    expect(section).toContain("detail response unavailable");
    expect(report).toContain(
      "- xiaomi: pricing=no (dashboard monthly token quota and balances; per-key costs unsupported)",
    );
    expect(report).not.toContain("api-platform_serviceToken");
    expect(report).not.toContain("userId");
    expect(report).not.toContain("service-secret");
    expect(report).not.toContain("user-secret");
  });

  it("reports MiniMax auth diagnostics and live quota details when configured", async () => {
    minimaxMocks.getMiniMaxAuthDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "auth.json",
      endpoint: "international",
      checkedPaths: [],
      authPaths: ["/tmp/auth.json"],
    });
    minimaxMocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
      state: "configured",
      apiKey: "test-key",
      endpoint: "international",
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
    expect(report).toContain("- api_key_checked_paths: (none)");
    expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(report).toContain(
      "- five_hour_usage: 70/4500 percent_remaining=98 reset_at=2026-03-25T18:00:00.000Z",
    );
    expect(report).toContain(
      "- weekly_usage: 105/45000 percent_remaining=100 reset_at=2026-04-01T00:00:00.000Z",
    );
    expect(minimaxMocks.resolveMiniMaxAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
    expect(minimaxMocks.queryMiniMaxQuota).toHaveBeenCalledWith("test-key", {
      endpoint: "international",
      label: "MiniMax Coding Plan",
    });
  });

  it("reports MiniMax auth errors", async () => {
    minimaxMocks.getMiniMaxAuthDiagnostics.mockResolvedValueOnce({
      state: "invalid",
      source: "auth.json",
      checkedPaths: [],
      authPaths: ["/tmp/auth.json"],
      error: 'Unsupported MiniMax auth type: "oauth"',
    });

    const invalidReport = await buildMiniMaxStatusReport();

    expect(invalidReport).toContain("minimax:");
    expect(invalidReport).toContain("- auth_state: invalid");
    expect(invalidReport).toContain("- api_key_configured: false");
    expect(invalidReport).toContain("- api_key_source: auth.json");
    expect(invalidReport).toContain("- api_key_checked_paths: (none)");
    expect(invalidReport).toContain("- api_key_auth_paths: /tmp/auth.json");
    expect(invalidReport).toContain('- auth_error: Unsupported MiniMax auth type: "oauth"');
    expect(minimaxMocks.resolveMiniMaxAuthCached).not.toHaveBeenCalled();
    expect(minimaxMocks.queryMiniMaxQuota).not.toHaveBeenCalled();
  });

  it("reports MiniMax API errors", async () => {
    minimaxMocks.getMiniMaxAuthDiagnostics.mockResolvedValueOnce({
      state: "configured",
      source: "auth.json",
      endpoint: "international",
      checkedPaths: [],
      authPaths: ["/tmp/auth.json"],
    });
    minimaxMocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
      state: "configured",
      apiKey: "test-key",
      endpoint: "international",
    });
    minimaxMocks.queryMiniMaxQuota.mockResolvedValueOnce({
      success: false,
      error: "MiniMax API error 401: Unauthorized",
    });

    const fetchErrorReport = await buildMiniMaxStatusReport();

    expect(fetchErrorReport).toContain("- live_fetch_error: MiniMax API error 401: Unauthorized");
  });

  describe.each([
    {
      name: "Z.ai",
      sectionTitle: "zai:",
      getAuthDiagnostics: zaiMocks.getZaiAuthDiagnostics,
      queryQuota: zaiMocks.queryZaiQuota,
      buildStatusReport: buildZaiStatusReport,
      unsupportedAuthError: 'Unsupported Z.ai auth type: "oauth"',
      endpointError: "Z.ai API error 401: Unauthorized",
    },
    {
      name: "Zhipu",
      sectionTitle: "zhipu:",
      getAuthDiagnostics: zhipuMocks.getZhipuAuthDiagnostics,
      queryQuota: zhipuMocks.queryZhipuQuota,
      buildStatusReport: buildZhipuStatusReport,
      unsupportedAuthError: 'Unsupported Zhipu auth type: "oauth"',
      endpointError: "Zhipu API error 401: Unauthorized",
    },
  ])("$name status diagnostics", (provider) => {
    it("reports auth diagnostics and live quota details when configured", async () => {
      provider.getAuthDiagnostics.mockResolvedValueOnce({
        state: "configured",
        source: "auth.json",
        checkedPaths: [],
        authPaths: ["/tmp/auth.json"],
      });
      provider.queryQuota.mockResolvedValueOnce({
        success: true,
        label: provider.name,
        windows: {
          fiveHour: { percentRemaining: 67, resetTimeIso: "2026-03-25T18:00:00.000Z" },
          weekly: { percentRemaining: 44, resetTimeIso: "2026-04-01T00:00:00.000Z" },
          mcp: { percentRemaining: 90, resetTimeIso: "2026-04-10T00:00:00.000Z" },
        },
      });

      const report = await provider.buildStatusReport();

      expect(report).toContain(provider.sectionTitle);
      expect(report).toContain("- auth_state: configured");
      expect(report).toContain("- api_key_configured: true");
      expect(report).toContain("- api_key_source: auth.json");
      expect(report).toContain("- api_key_checked_paths: (none)");
      expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
      expect(report).toContain("- five_hour_remaining: 67% reset_at=2026-03-25T18:00:00.000Z");
      expect(report).toContain("- weekly_remaining: 44% reset_at=2026-04-01T00:00:00.000Z");
      expect(report).toContain("- mcp_remaining: 90% reset_at=2026-04-10T00:00:00.000Z");
    });

    it("reports auth errors", async () => {
      provider.getAuthDiagnostics.mockResolvedValueOnce({
        state: "invalid",
        source: "auth.json",
        checkedPaths: [],
        authPaths: ["/tmp/auth.json"],
        error: provider.unsupportedAuthError,
      });

      const report = await provider.buildStatusReport();

      expect(report).toContain(provider.sectionTitle);
      expect(report).toContain("- auth_state: invalid");
      expect(report).toContain("- api_key_configured: false");
      expect(report).toContain("- api_key_source: auth.json");
      expect(report).toContain("- api_key_checked_paths: (none)");
      expect(report).toContain("- api_key_auth_paths: /tmp/auth.json");
      expect(report).toContain(`- auth_error: ${provider.unsupportedAuthError}`);
      expect(provider.queryQuota).not.toHaveBeenCalled();
    });

    it("reports endpoint errors", async () => {
      provider.getAuthDiagnostics.mockResolvedValueOnce({
        state: "configured",
        source: "auth.json",
        checkedPaths: [],
        authPaths: ["/tmp/auth.json"],
      });
      provider.queryQuota.mockResolvedValueOnce({
        success: false,
        error: provider.endpointError,
      });

      const report = await provider.buildStatusReport();

      expect(report).toContain(`- live_fetch_error: ${provider.endpointError}`);
    });
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
        hasEnterpriseUrl: false,
      },
      deployment: "github.com",
      apiHost: "api.github.com",
      enterpriseHostSource: "none",
      effectiveSource: "pat",
      override: "none",
      billingMode: "enterprise_usage",
      billingScope: "enterprise",
      quotaApi: "github_ai_credit_api",
      billingModel: "ai_credits",
      budgetApi: "enterprise_budgets",
      oauthAccountingState: "not_configured",
      billingApiAccessLikely: false,
      remainingTotalsState: "not_available_from_enterprise_usage",
      queryPeriod: {
        year: 2026,
        month: 1,
      },
      usernameFilter: "alice",
      tokenCompatibilityError:
        "GitHub\'s enterprise billing reports do not support fine-grained PATs or GitHub App access tokens. Use a classic PAT held by an enterprise admin or billing manager.",
    });

    const report = await buildProviderStatusReport("copilot");

    expect(report).toContain("- pat_enterprise: acme-enterprise");
    expect(report).toContain("- billing_mode: enterprise_usage");
    expect(report).toContain("- billing_scope: enterprise");
    expect(report).toContain("- quota_api: github_ai_credit_api");
    expect(report).toContain("- budget_api: enterprise_budgets");
    expect(report).toContain("- billing_api_access_likely: false");
    expect(report).toContain("- remaining_totals_state: not_available_from_enterprise_usage");
    expect(report).toContain(
      "- billing_usage_note: enterprise AI Credit usage for the current UTC calendar month",
    );
    expect(report).toContain(
      "- remaining_quota_note: the usage report exposes included-pool consumption and billed usage, but no included-pool denominator; percentages require a real budget",
    );
    expect(report).toContain(
      "- token_compatibility_error: GitHub\'s enterprise billing reports do not support fine-grained PATs or GitHub App access tokens.",
    );
  });

  it("locks the early /quota_status section layout after the shared report-document migration", async () => {
    const report = await buildProviderStatusReport("copilot", { configSource: "defaults" });

    const [heading, blank, ...body] = report.split("\n");
    expect(heading).toMatch(
      /^# Quota Status \(opencode-quota v1\.2\.3\) \(\/quota_status\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/,
    );
    expect(blank).toBe("");

    const excerpt = body.slice(0, 46).join("\n");
    expect(excerpt).toMatchInlineSnapshot(`
      "toast:
      - configSource: defaults
      - configPaths: (none)
      - precedence: built-in defaults only
      - global_config_paths: (none)
      - workspace_config_paths: (none)
      - setting_sources: (none)
      - enabledProviders: copilot
      - onlyCurrentModel: false
      - currentModel: (unknown)
      - providers:
        - copilot: enabled available

      paths:
      - opencode_dirs: data=/tmp/data config=/tmp/config cache=/tmp/cache state=/tmp/state
      - auth.json: preferred=/tmp/auth.json present=(none) candidates=/tmp/auth.json
      - qwen oauth auth configured: false
      - qwen_oauth_source: (none)
      - qwen_local_plan: (none)
      - alibaba auth configured: false
      - alibaba_api_key_source: (none)
      - alibaba_api_key_checked_paths: (none)
      - alibaba_api_key_auth_paths: /tmp/auth.json
      - alibaba_coding_plan: (none)

      openai:
      - auth_configured: false
      - auth_source: (none)
      - token_status: (none)
      - token_expires_at: (none)
      - account_email: (none)
      - account_id: (none)

      anthropic:
      - cli_installed: true
      - cli_version: 1.2.3
      - auth_status: authenticated
      - quota_supported: false
      - quota_source: (none)
      - checked_commands: claude --version | claude auth status --json
      - message: Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback. Claude credentials file not found at /Users/test/.claude/.credentials.json.

      cursor:
      - plan: none
      - included_api_usd: (none)
      - billing_cycle_start_day: (calendar month)"
    `);

    const titles = report
      .split("\n")
      .filter((line) => /^[a-z0-9_]+:$/u.test(line))
      .join("\n");
    expect(titles).toMatchInlineSnapshot(`
      "toast:
paths:
openai:
anthropic:
cursor:
minimax:
minimax_china:
kimi:
opencode_go:
opencode_zen:
xiaomi:
zai:
zhipu:
synthetic:
chutes:
deepseek:
xai:
nanogpt:
copilot_quota_auth:
google_antigravity:
google_gemini_cli:
google_agy:
storage:
pricing_snapshot:
supported_providers_pricing:
unpriced_models:
unknown_pricing:"
    `);
  });
});
