import { beforeEach, describe, expect, it, vi } from "vitest";

import { aggregateUsage } from "../src/lib/quota-stats.js";

import {
  buildProviderStatusReport,
  buildQuotaStatusReportForTest,
  expectReportSection,
  getReportSection,
  makeProviderAvailability,
  makeProviderPartialProbe,
  makeProviderProbe,
  makeProviderSafeFailureProbe,
  makeProviderSuccessProbe,
  makeStatusDetails,
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

const pricingMocks = vi.hoisted(() => ({
  getPricingSnapshotSource: vi.fn(() => "bundled"),
}));

const syntheticMocks = vi.hoisted(() => ({
  getSyntheticKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
  querySyntheticQuota: vi.fn(async () => null),
}));

vi.mock("fs/promises", () => ({
  stat: fsPromiseMocks.stat,
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePath: () => "/tmp/opencode.db",
  getCredentialDatabasePaths: () => ["/tmp/opencode.db"],
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

vi.mock("../src/lib/synthetic.js", () => ({
  getSyntheticKeyDiagnostics: syntheticMocks.getSyntheticKeyDiagnostics,
  querySyntheticQuota: syntheticMocks.querySyntheticQuota,
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
    { id: "opencode-go" },
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

  it("uses a Unicode ellipsis for truncated pricing diagnostic lists", async () => {
    const tokens = { input: 1, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
    const unpriced = Array.from({ length: 7 }, (_, index) => ({
      key: {
        sourceProviderID: "provider",
        sourceModelID: `unpriced-${index}`,
        mappedProvider: "provider",
        mappedModel: `mapped-${index}`,
        reason: "missing_price",
      },
      tokens,
      messageCount: 1,
    }));
    const unknown = Array.from({ length: 6 }, (_, index) => ({
      key: {
        sourceProviderID: "provider",
        sourceModelID: `unknown-${index}`,
      },
      tokens,
      messageCount: 1,
    }));
    vi.mocked(aggregateUsage).mockResolvedValueOnce({
      byModel: [],
      bySourceProvider: [],
      unpriced,
      unknown,
      totals: { unpriced: tokens, unknown: tokens },
    } as never);

    const report = await buildQuotaStatusReportForTest();
    expect(report).toContain("… (2 more)");
    expect(report).toContain("… (1 more)");
    expect(report).not.toContain("... (2 more)");
  });

  it("renders config validation errors in the toast diagnostics section", async () => {
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
    });

    expect(report).toContain("- enabledProviders: (none)");
    expect(report).toContain("- config_errors:");
    expect(report).toContain(
      "  - /tmp/project/opencode-quota/quota-toast.json (opencode-quota/quota-toast.json) enabledProviders: unknown provider id(s): opnai",
    );
  });

  it("reports effective googleModels and whether they came from defaults or a config file", async () => {
    const defaultsReport = await buildQuotaStatusReportForTest({
      configSource: "defaults",
      googleModels: ["CLAUDE"],
    });
    expect(defaultsReport).toContain("- googleModels: CLAUDE");
    expect(defaultsReport).toContain("- googleModels_source: default");

    const configPath =
      "/tmp/config/opencode-quota/quota-toast.json (opencode-quota/quota-toast.json)";
    const configuredReport = await buildQuotaStatusReportForTest({
      configSource: "files",
      googleModels: ["CLAUDE", "G3PRO"],
      settingSources: { googleModels: configPath },
    });
    expect(configuredReport).toContain("- googleModels: CLAUDE,G3PRO");
    expect(configuredReport).toContain(`- googleModels_source: configuration file (${configPath})`);
  });

  it("keeps the raw Antigravity family in live quota diagnostics", async () => {
    const report = await buildProviderStatusReport("google-antigravity", {
      providerLiveProbes: [
        makeProviderSuccessProbe(
          "google-antigravity",
          {},
          {
            entries: [
              {
                accounting: QUOTA_ACCOUNTING,
                name: "Antigravity (ali…): Claude",
                group: "[Antigravity (ali…)]",
                label: "Claude:",
                metricLabel: "Claude",
                percentRemaining: 64,
              },
            ],
            presentation: {
              classicStrategy: "preserve",
              redundantQuotaFamily: "Claude",
            },
          },
        ),
      ],
    });

    const section = getReportSection(report, "google_antigravity:");
    expect(section).toContain("- live_entry_1: Claude: percent_remaining=64");
    expect(section).not.toContain("- live_entry_1: Quota:");
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
                credentialDatabasePaths: ["/trusted/opencode.db"],
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
    expect(section).toContain("/trusted/opencode.jsonc | /trusted/opencode.db");
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
            statusDetails: makeStatusDetails({
              local_state_path: "/tmp/qwen-state.json",
              local_state_exists: "true",
              local_state_health: "valid",
              local_state_version: "1",
              local_state_last_update: "2026-03-12T12:00:00.000Z",
            }),
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
            statusDetails: makeStatusDetails({
              local_state_path: "/tmp/alibaba-state.json",
              local_state_exists: "true",
              local_state_health: "valid",
              local_state_version: "1",
              local_state_last_update: "2026-03-12T12:00:00.000Z",
            }),
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
      providerLiveProbes: [
        makeProviderSuccessProbe("copilot", {
          deployment: "github.com",
          api_host: "api.github.com",
          enterprise_host_source: "none",
          billing_mode: "organization_usage",
          billing_scope: "organization",
          quota_api: "github_ai_credit_api",
          budget_api: "organization_budgets",
          oauth_accounting_state: "available_via_copilot_internal_user",
          billing_api_access_likely: "true",
          remaining_totals_state: "not_available_from_org_usage",
          billing_period: "2026-01",
          username_filter: "alice",
          billing_usage_note: "organization AI Credit usage for the current UTC calendar month",
          remaining_quota_note:
            "the usage report exposes included-pool consumption and billed usage, but no included-pool denominator; percentages require a real budget",
        }),
      ],
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
      "- opencode.db: preferred=/tmp/opencode.db present=(none) candidates=/tmp/opencode.db",
    );
    expect(report).toContain(
      "- pricing: source=test active_source=bundled generated_at=2026-01-01T00:00:00.000Z units=usd_per_1m_tokens",
    );
    expect(report).toContain("- selection: configured=runtime active=bundled");
    expect(report).toContain(
      "- selection_note: runtime config requested the local runtime snapshot, but bundled fallback is active because no valid runtime snapshot is available",
    );
    expect(report).not.toContain("- opencode data:");
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
    const report = await buildProviderStatusReport("anthropic", {
      providerLiveProbes: [
        makeProviderSuccessProbe("anthropic", {
          cli_version: "1.2.4",
          quota_supported: "true",
          quota_source: "claude-auth-status-json",
          five_hour_remaining: "43% reset_at=2026-03-25T18:00:00.000Z",
          seven_day_remaining: "88% reset_at=2026-04-01T00:00:00.000Z",
        }),
      ],
    });

    expect(report).toContain("- cli_version: 1.2.4");
    expect(report).toContain("- quota_supported: true");
    expect(report).toContain("- quota_source: claude-auth-status-json");
    expect(report).toContain("- five_hour_remaining: 43% reset_at=2026-03-25T18:00:00.000Z");
    expect(report).toContain("- seven_day_remaining: 88% reset_at=2026-04-01T00:00:00.000Z");
  });

  it("renders Synthetic API-key diagnostics plus compact live success rows", async () => {
    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        makeProviderSuccessProbe(
          "synthetic",
          { "synthetic api key": "configured=true source=env:SYNTHETIC_API_KEY" },
          {
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
          },
        ),
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
    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        makeProviderProbe("synthetic", {
          statusDetails: makeStatusDetails({
            "synthetic api key": "configured=true source=env:SYNTHETIC_API_KEY",
          }),
        }),
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
        makeProviderProbe("openai", {
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
        }),
        makeProviderProbe("qwen-code", {
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
        }),
        makeProviderProbe("alibaba-coding-plan"),
        makeProviderSuccessProbe(
          "minimax-coding-plan",
          { auth_state: "none" },
          {
            entries: [
              {
                label: "Weekly",
                name: "MiniMax Weekly",
                percentRemaining: 63,
                right: "1600/45000",
                resetTimeIso: "2026-04-28T00:00:00.000Z",
              },
            ],
          },
        ),
        makeProviderSafeFailureProbe("copilot", {}, "Billing endpoint unavailable"),
        makeProviderProbe("google-antigravity"),
        makeProviderSuccessProbe(
          "google-gemini-cli",
          { auth_state: "missing", companion_package_state: "missing" },
          {
            entries: [
              {
                label: "Pro",
                name: "Gemini CLI Pro",
                percentRemaining: 77,
                right: "77 left",
                resetTimeIso: "2026-04-23T00:00:00.000Z",
              },
            ],
          },
        ),
        makeProviderSuccessProbe("google-agy", {
          auth_state: "missing",
          auth_source: "(none)",
        }),
        makeProviderSafeFailureProbe("chutes", {}, "probe \u001b[31mfailed\u0007\n\twith noise"),
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
    const report = await buildProviderStatusReport("google-agy", {
      providerLiveProbes: [
        makeProviderPartialProbe(
          "google-agy",
          {
            auth_state: "present",
            auth_source: "google-agy",
            account_count: "2",
            valid_account_count: "2",
            companion_package_state: "present",
            companion_package_path:
              "/tmp/node_modules/@anthonyhaussman/opencode-agy-auth/dist/src/constants.js",
          },
          {
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
        ),
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
  });

  it("sanitizes and truncates Synthetic live probe errors", async () => {
    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        makeProviderSafeFailureProbe(
          "synthetic",
          {},
          `failure \u001b[31mwith control codes\u0007\n\t${"x".repeat(200)}`,
        ),
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

  it("reports NanoGPT live subscription and balance diagnostics when configured", async () => {
    const report = await buildProviderStatusReport("nanogpt", {
      providerLiveProbes: [
        makeProviderSuccessProbe("nanogpt", {
          api_key_configured: "true",
          api_key_source: "env:NANOGPT_API_KEY",
          api_key_credential_database_paths: "/tmp/opencode.db",
          subscription_active: "false",
          subscription_state: "grace",
          enforce_daily_limit: "true",
          daily_usage:
            "5/5000 remaining=4995 percent_remaining=100 reset_at=2026-01-02T00:00:00.000Z",
          monthly_usage:
            "45/60000 remaining=59955 percent_remaining=100 reset_at=2026-02-01T00:00:00.000Z",
          billing_period_end: "2026-02-13T23:59:59.000Z",
          grace_until: "2026-01-09T00:00:00.000Z",
          balance_usd: "$129.47",
          balance_nano: "26.71801147",
          live_error_balance: "NanoGPT API error 401: Unauthorized",
        }),
      ],
    });

    expect(report).toContain("nanogpt:");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: env:NANOGPT_API_KEY");
    expect(report).toContain("- api_key_credential_database_paths: /tmp/opencode.db");
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

  it("reports all Kilo Pass raw accounting values in /quota_status", async () => {
    const report = await buildProviderStatusReport("kilo", {
      providerLiveProbes: [
        makeProviderSuccessProbe("kilo", {
          base_credits_usd: "$10.00",
          usage_usd: "$12.00",
          bonus_credits_usd: "$0.00",
          remaining_usd: "$0.00",
          overage_usd: "$2.00",
          reset_at: "2026-07-01T00:00:00.000Z",
        }),
      ],
    });

    expect(report).toContain("kilo:");
    expect(report).toContain("- base_credits_usd: $10.00");
    expect(report).toContain("- usage_usd: $12.00");
    expect(report).toContain("- bonus_credits_usd: $0.00");
    expect(report).toContain("- remaining_usd: $0.00");
    expect(report).toContain("- overage_usd: $2.00");
    expect(report).toContain("- reset_at: 2026-07-01T00:00:00.000Z");
  });

  it("formats semantic quantity and boolean live probe rows with shared accounting text", async () => {
    const report = await buildProviderStatusReport("deepseek", {
      providerLiveProbes: [
        makeProviderSuccessProbe(
          "deepseek",
          {},
          {
            entries: [
              {
                kind: "quantity",
                accounting: {
                  resultType: "balance",
                  acquisitionMethod: "remote_api",
                  ownership: "maintained",
                  authority: "provider_reported",
                },
                name: "internal-total-name",
                group: "DeepSeek",
                semantic: {
                  metric: { kind: "component", component: "total_balance" },
                  prominence: "primary",
                },
                quantity: { decimal: "12.345", unit: { kind: "currency", code: "USD" } },
              },
              {
                kind: "boolean",
                accounting: {
                  resultType: "status",
                  acquisitionMethod: "remote_api",
                  ownership: "maintained",
                  authority: "provider_reported",
                },
                name: "internal-availability-name",
                group: "DeepSeek",
                semantic: {
                  metric: { kind: "named", name: "Availability" },
                  prominence: "primary",
                },
                value: false,
              },
            ],
            errors: [],
          },
        ),
      ],
    });

    const section = getReportSection(report, "deepseek:");
    expect(section).toContain("- live_entry_1: Total balance value=USD 12.35");
    expect(section).toContain("- live_entry_2: Availability value=Low balance");
    expect(section).not.toContain("internal-total-name");
    expect(section).not.toContain("internal-availability-name");
  });

  it("reports DeepSeek API key diagnostics", async () => {
    const report = await buildProviderStatusReport("deepseek", {
      providerLiveProbes: [
        makeProviderSuccessProbe("deepseek", {
          api_key_configured: "true",
          api_key_source: "env:DEEPSEEK_API_KEY",
          api_key_checked_paths: "env:DEEPSEEK_API_KEY",
          api_key_credential_database_paths: "/tmp/opencode.db",
        }),
      ],
    });

    expect(report).toContain("deepseek:");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: env:DEEPSEEK_API_KEY");
    expect(report).toContain("- api_key_checked_paths: env:DEEPSEEK_API_KEY");
    expect(report).toContain("- api_key_credential_database_paths: /tmp/opencode.db");
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

  it("reports OpenCode Go auth and normalized usage API details", async () => {
    const report = await buildOpenCodeGoStatusReport({
      providerAvailability: [makeProviderAvailability("opencode-go")],
      providerLiveProbes: [
        makeProviderSuccessProbe("opencode-go", {
          auth_state: "configured",
          auth_source: "env:OPENCODE_API_KEY",
          auth_checked_paths: "env:OPENCODE_API_KEY | provider.opencode.options.apiKey",
          credential_database_paths: "/tmp/opencode.db",
          selected_windows: "rolling,weekly,monthly",
          rolling_usage:
            "status=ok percent_used=7 percent_remaining=93 reset_at=2026-03-12T17:45:00.000Z",
          weekly_usage:
            "status=ok percent_used=22 percent_remaining=78 reset_at=2026-03-18T18:45:00.000Z",
          monthly_usage:
            "status=ok percent_used=64 percent_remaining=36 reset_at=2026-04-10T05:38:20.000Z",
          config_state: "configured",
          workspace_id: "workspace-secret",
          auth_cookie: "cookie-secret",
          reset_in_sec: "18000",
        }),
      ],
    });

    const section = getReportSection(report, "opencode_go:");
    expect(section).toContain("- auth_state: configured");
    expect(section).toContain("- auth_source: env:OPENCODE_API_KEY");
    expect(section).toContain(
      "- auth_checked_paths: env:OPENCODE_API_KEY | provider.opencode.options.apiKey",
    );
    expect(section).toContain("- credential_database_paths: /tmp/opencode.db");
    expect(section).toContain("- selected_windows: rolling,weekly,monthly");
    expect(section).toContain(
      "- rolling_usage: status=ok percent_used=7 percent_remaining=93 reset_at=2026-03-12T17:45:00.000Z",
    );
    expect(section).toContain(
      "- weekly_usage: status=ok percent_used=22 percent_remaining=78 reset_at=2026-03-18T18:45:00.000Z",
    );
    expect(section).toContain(
      "- monthly_usage: status=ok percent_used=64 percent_remaining=36 reset_at=2026-04-10T05:38:20.000Z",
    );
    expect(section).not.toContain("config_");
    expect(section).not.toContain("workspace");
    expect(section).not.toContain("cookie");
    expect(section).not.toContain("reset_in_sec");
    expect(report).toContain(
      "- opencode-go: pricing=no (subscription percentage quota from the OpenCode Go usage API (not token-priced))",
    );
  });

  it("reports safe OpenCode Go invalid-auth details without legacy config fields", async () => {
    const report = await buildOpenCodeGoStatusReport({
      providerLiveProbes: [
        makeProviderProbe("opencode-go", {
          statusDetails: makeStatusDetails({
            auth_state: "invalid",
            auth_source: "opencode.db",
            auth_checked_paths: "env:OPENCODE_API_KEY | provider.opencode.options.apiKey",
            credential_database_paths: "/tmp/opencode.db",
            auth_error: "opencode.db entry opencode must contain a non-empty API key",
            selected_windows: "rolling,weekly,monthly",
            config_state: "invalid",
            config_error: "legacy secret",
          }),
        }),
      ],
    });

    const section = getReportSection(report, "opencode_go:");
    expect(section).toContain("- auth_state: invalid");
    expect(section).toContain("- auth_source: opencode.db");
    expect(section).toContain("- credential_database_paths: /tmp/opencode.db");
    expect(section).toContain(
      "- auth_error: opencode.db entry opencode must contain a non-empty API key",
    );
    expect(section).toContain("- selected_windows: rolling,weekly,monthly");
    expect(section).not.toContain("config_");
    expect(section).not.toContain("legacy secret");
  });

  it("reports safe OpenCode Go usage API failures", async () => {
    const report = await buildOpenCodeGoStatusReport({
      providerAvailability: [makeProviderAvailability("opencode-go")],
      providerLiveProbes: [
        makeProviderSafeFailureProbe(
          "opencode-go",
          {
            auth_state: "configured",
            auth_source: "opencode.db",
            auth_checked_paths: "env:OPENCODE_API_KEY",
            credential_database_paths: "/tmp/opencode.db",
            selected_windows: "rolling,weekly,monthly",
            live_fetch_error: "OpenCode Go API error 503: unavailable",
            dashboard_url: "https://opencode.ai/workspace/private",
          },
          "OpenCode Go API error 503: unavailable",
        ),
      ],
    });

    const section = getReportSection(report, "opencode_go:");
    expect(section).toContain("- live_fetch_error: OpenCode Go API error 503: unavailable");
    expect(section).toContain("- live_probe: error");
    expect(section).toContain("- live_error_1: OpenCode Go API error 503: unavailable");
    expect(section).not.toContain("dashboard");
    expect(section).not.toContain("workspace/private");
  });

  it("reports OpenCode Zen config and live billing details without exposing credentials", async () => {
    const report = await buildOpenCodeZenStatusReport({
      providerLiveProbes: [
        makeProviderSuccessProbe("opencode", {
          config_state: "configured",
          config_source: "env(OPENCODE_*)",
          balance_usd: "$42.50",
          monthly_limit_usd: "$50.00",
          last_payment_usd: "$20.00",
        }),
      ],
    });

    expect(report).toContain("opencode_zen:");
    expect(report).toContain("- config_state: configured");
    expect(report).toContain("- config_source: env(OPENCODE_*)");
    expect(report).toContain("- balance_usd: $42.50");
    expect(report).toContain("- monthly_limit_usd: $50.00");
    expect(report).toContain("- last_payment_usd: $20.00");
    expect(report).not.toContain("wrk-secret");
  });

  it("does not retry a failed OpenCode Zen live probe", async () => {
    const report = await buildOpenCodeZenStatusReport({
      providerLiveProbes: [
        {
          providerId: "opencode",
          result: {
            attempted: true,
            entries: [],
            errors: [{ label: "OpenCode", message: "Request timeout after 10s" }],
            statusDetails: makeStatusDetails({
              config_state: "configured",
              config_source: "env(OPENCODE_*)",
            }),
          },
        },
      ],
    });

    expect(report).toContain("- live_probe: error");
  });

  it("reports a fixed OpenCode Zen parse error without attempting a live fetch", async () => {
    const report = await buildOpenCodeZenStatusReport({
      providerLiveProbes: [
        makeProviderProbe("opencode", {
          statusDetails: makeStatusDetails({
            config_state: "invalid",
            config_error: "Failed to parse JSON",
          }),
        }),
      ],
    });

    expect(report).toContain("opencode_zen:");
    expect(report).toContain("- config_state: invalid");
    expect(report).toContain("- config_error: Failed to parse JSON");
  });

  it("reports safe Xiaomi config and partial live summaries without exposing cookie data", async () => {
    const report = await buildXiaomiStatusReport({
      providerLiveProbes: [
        {
          providerId: "xiaomi",
          result: {
            attempted: true,
            statusDetails: makeStatusDetails({
              config_state: "configured",
              config_source: "env:MIMO_USAGE_COOKIE",
              config_checked_paths: "/tmp/config/opencode-quota/mimo.json",
            }),
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
    const report = await buildMiniMaxStatusReport({
      providerLiveProbes: [
        makeProviderSuccessProbe("minimax-coding-plan", {
          auth_state: "configured",
          api_key_configured: "true",
          api_key_source: "opencode.db",
          api_key_checked_paths: "(none)",
          api_key_credential_database_paths: "/tmp/opencode.db",
          five_hour_usage: "70/4500 percent_remaining=98 reset_at=2026-03-25T18:00:00.000Z",
          weekly_usage: "105/45000 percent_remaining=100 reset_at=2026-04-01T00:00:00.000Z",
        }),
        makeProviderProbe("minimax-china-coding-plan"),
      ],
    });

    expect(report).toContain("minimax:");
    expect(report).toContain("- auth_state: configured");
    expect(report).toContain("- api_key_configured: true");
    expect(report).toContain("- api_key_source: opencode.db");
    expect(report).toContain("- api_key_checked_paths: (none)");
    expect(report).toContain("- api_key_credential_database_paths: /tmp/opencode.db");
    expect(report).toContain(
      "- five_hour_usage: 70/4500 percent_remaining=98 reset_at=2026-03-25T18:00:00.000Z",
    );
    expect(report).toContain(
      "- weekly_usage: 105/45000 percent_remaining=100 reset_at=2026-04-01T00:00:00.000Z",
    );
  });

  it("reports enterprise billing scope and token compatibility notes", async () => {
    const report = await buildProviderStatusReport("copilot", {
      providerLiveProbes: [
        makeProviderSuccessProbe("copilot", {
          pat_enterprise: "acme-enterprise",
          billing_mode: "enterprise_usage",
          billing_scope: "enterprise",
          quota_api: "github_ai_credit_api",
          budget_api: "enterprise_budgets",
          billing_api_access_likely: "false",
          remaining_totals_state: "not_available_from_enterprise_usage",
          billing_usage_note: "enterprise AI Credit usage for the current UTC calendar month",
          remaining_quota_note:
            "the usage report exposes included-pool consumption and billed usage, but no included-pool denominator; percentages require a real budget",
          token_compatibility_error:
            "GitHub's enterprise billing reports do not support fine-grained PATs or GitHub App access tokens.",
        }),
      ],
    });

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
      "- token_compatibility_error: GitHub's enterprise billing reports do not support fine-grained PATs or GitHub App access tokens.",
    );
  });

  it("does not invoke provider query modules when a status probe is absent", async () => {
    const report = await buildProviderStatusReport("synthetic");

    expect(getReportSection(report, "synthetic:")).toBe("synthetic:\n");
    expect(syntheticMocks.getSyntheticKeyDiagnostics).not.toHaveBeenCalled();
    expect(syntheticMocks.querySyntheticQuota).not.toHaveBeenCalled();
  });

  it("renders provider-owned status details without changing their row contract", async () => {
    const report = await buildSyntheticStatusReport({
      providerLiveProbes: [
        makeProviderSuccessProbe("synthetic", [
          {
            key: "diagnostic",
            value: "safe value",
          },
        ]),
      ],
    });

    const section = getReportSection(report, "synthetic:");
    expect(section).toContain("- diagnostic: safe value");
    expect(section).not.toContain("live_error");
  });

  it("locks the early /quota_status section layout after the shared report-document migration", async () => {
    const report = await buildProviderStatusReport("copilot", {
      configSource: "defaults",
      providerLiveProbes: [
        makeProviderSuccessProbe("qwen-code", {
          "qwen oauth auth configured": "false",
          qwen_oauth_source: "(none)",
          qwen_local_plan: "(none)",
        }),
        makeProviderSuccessProbe("alibaba-coding-plan", {
          "alibaba auth configured": "false",
          alibaba_api_key_source: "(none)",
          alibaba_api_key_checked_paths: "(none)",
          alibaba_api_key_credential_database_paths: "/tmp/opencode.db",
          alibaba_coding_plan: "(none)",
        }),
        makeProviderSuccessProbe("openai", {
          auth_configured: "false",
          auth_source: "(none)",
          token_status: "(none)",
          token_expires_at: "(none)",
          account_email: "(none)",
          account_id: "(none)",
        }),
        makeProviderSuccessProbe("anthropic", {
          cli_installed: "true",
          cli_version: "1.2.3",
          auth_status: "authenticated",
          quota_supported: "false",
          quota_source: "(none)",
          checked_commands: "claude --version | claude auth status --json",
          message:
            "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources. Claude credentials file not found at /Users/test/.claude/.credentials.json.",
        }),
        makeProviderSuccessProbe("cursor", {
          plan: "none",
          included_api_usd: "(none)",
          billing_cycle_start_day: "(calendar month)",
        }),
      ],
    });

    const [heading, blank, ...body] = report.split("\n");
    expect(heading).toMatch(
      /^# Quota Status \(opencode-quota v1\.2\.3\) \(\/quota_status\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/,
    );
    expect(blank).toBe("");

    const excerpt = body.slice(0, 48).join("\n");
    expect(excerpt).toMatchInlineSnapshot(`
      "toast:
      - configSource: defaults
      - configPaths: (none)
      - precedence: built-in defaults only
      - global_config_paths: (none)
      - workspace_config_paths: (none)
      - setting_sources: (none)
      - enabledProviders: copilot
      - googleModels: CLAUDE
      - googleModels_source: default
      - onlyCurrentModel: false
      - currentModel: (unknown)
      - providers:
        - copilot: enabled available

      paths:
      - opencode_dirs: data=/tmp/data config=/tmp/config cache=/tmp/cache state=/tmp/state
      - opencode.db: preferred=/tmp/opencode.db present=(none) candidates=/tmp/opencode.db
      - qwen oauth auth configured: false
      - qwen_oauth_source: (none)
      - qwen_local_plan: (none)
      - alibaba auth configured: false
      - alibaba_api_key_source: (none)
      - alibaba_api_key_checked_paths: (none)
      - alibaba_api_key_credential_database_paths: /tmp/opencode.db
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
      - message: Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources. Claude credentials file not found at /Users/test/.claude/.credentials.json.

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
