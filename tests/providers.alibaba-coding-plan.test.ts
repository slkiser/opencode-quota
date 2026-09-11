import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { matchesQuotaProviderCurrentSelection } from "../src/lib/quota-render-data.js";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba-coding-plan.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  getAuthPaths: () => ["/tmp/auth.json"],
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/providers/registry.js", () => ({ getProviders: () => [] }));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/alibaba-cli.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/alibaba-cli.js")>(
    "../src/lib/alibaba-cli.js",
  );
  return {
    ...actual,
    probeAlibabaCliUsage: vi.fn(),
  };
});

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  ALIBABA_CODING_PLAN_STATE_VERSION: 1,
  getAlibabaCodingPlanQuotaPath: () => "/tmp/alibaba-quota.json",
  readAlibabaCodingPlanQuotaState: vi.fn(),
  computeAlibabaCodingPlanQuota: vi.fn(),
}));

describe("alibaba-coding-plan provider", () => {
  const originalEnv = process.env;

  const mockCliNotInstalled = async () => {
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    (probeAlibabaCliUsage as any).mockResolvedValue({
      installed: false,
      checkedCommands: ["bl --version"],
      failureReason: "not_installed",
      message:
        "Alibaba Cloud Model Studio CLI (`bl`) is not installed or not on PATH. Install with `npm install -g bailian-cli`.",
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ALIBABA_CODING_PLAN_API_KEY;
    delete process.env.ALIBABA_API_KEY;
    await mockCliNotInstalled();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns attempted:false when no alibaba coding plan is configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({});

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("uses the maintained lite fallback when auth omits a tier", async () => {
    process.env.ALIBABA_API_KEY = "env-key";

    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );

    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "pro",
      fiveHour: { used: 0, limit: 6000, percentRemaining: 100 },
      weekly: { used: 0, limit: 45000, percentRemaining: 100 },
      monthly: { used: 0, limit: 90000, percentRemaining: 100 },
    });

    const out = await alibabaCodingPlanProvider.fetch({
      config: { quotaProviders: [] },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalledWith({ state: {}, tier: "lite" });
  });

  it("supports the alibaba-coding-plan auth key without a standalone tier setting", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );

    (readAuthFileCached as any).mockResolvedValue({
      "alibaba-coding-plan": { type: "api", key: "dashscope-key" },
    });
    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "lite",
      fiveHour: { used: 0, limit: 1200, percentRemaining: 100 },
      weekly: { used: 0, limit: 9000, percentRemaining: 100 },
      monthly: { used: 0, limit: 18000, percentRemaining: 100 },
    });

    const out = await alibabaCodingPlanProvider.fetch({
      config: { quotaProviders: [] },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalledWith({ state: {}, tier: "lite" });
  });

  it("passes quotaProviders request-limit tuning to the maintained provider", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );
    (readAuthFileCached as any).mockResolvedValue({
      "alibaba-coding-plan": { type: "api", key: "dashscope-key", tier: "pro" },
    });
    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "pro",
      fiveHour: { used: 0, limit: 2000, percentRemaining: 100 },
      weekly: { used: 0, limit: 10000, percentRemaining: 100 },
      monthly: { used: 0, limit: 20000, percentRemaining: 100 },
    });

    await alibabaCodingPlanProvider.fetch({
      config: {
        quotaProviders: [
          {
            id: "alibaba-coding-plan",
            providerId: "alibaba-coding-plan",
            label: "alibaba-coding-plan",
            mode: "local-estimate",
            windows: [
              {
                id: "five-hour",
                label: "5h",
                type: "rolling",
                durationMinutes: 300,
                requestLimit: 2000,
              },
              {
                id: "weekly",
                label: "Weekly",
                type: "rolling",
                durationMinutes: 10080,
                requestLimit: 10000,
              },
              {
                id: "monthly",
                label: "Monthly",
                type: "rolling",
                durationMinutes: 43200,
                requestLimit: 20000,
              },
            ],
          },
        ],
      },
    } as any);

    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalledWith({
      state: {},
      tier: "pro",
      limits: { fiveHour: 2000, weekly: 10000, monthly: 20000 },
    });
  });

  it("surfaces invalid auth when alibaba-coding-plan exists without usable credentials", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota } = await import("../src/lib/qwen-local-quota.js");

    (readAuthFileCached as any).mockResolvedValue({
      "alibaba-coding-plan": { type: "api", key: "   " },
      alibaba: { type: "api", key: "dashscope-key", tier: "pro" },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithErrorLabel(out, "Alibaba Coding Plan");
    expect(out.errors[0]?.message).toContain(
      "Alibaba Coding Plan auth entry present but key is empty",
    );
    expect(computeAlibabaCodingPlanQuota as any).not.toHaveBeenCalled();
  });

  it("surfaces invalid alibaba tier errors", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({
      alibaba: { type: "api", key: "dashscope-key", tier: "max" },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Alibaba Coding Plan");
    expect(out.errors[0]?.message).toContain("Unsupported Alibaba Coding Plan tier");
  });

  it("maps all rolling windows into grouped entries", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );

    (readAuthFileCached as any).mockResolvedValue({
      alibaba: { type: "api", key: "dashscope-key", tier: "pro" },
    });
    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "pro",
      fiveHour: {
        used: 120,
        limit: 6000,
        percentRemaining: 98,
        resetTimeIso: "2026-02-24T15:00:00.000Z",
      },
      weekly: {
        used: 500,
        limit: 45000,
        percentRemaining: 99,
        resetTimeIso: "2026-03-01T12:00:00.000Z",
      },
      monthly: {
        used: 1000,
        limit: 90000,
        percentRemaining: 99,
        resetTimeIso: "2026-03-26T12:00:00.000Z",
      },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(3);
    expect(out.entries[0]).toMatchObject({
      name: "Alibaba Coding Plan (Pro) 5h",
      group: "Alibaba Coding Plan (Pro)",
      label: "5h:",
      right: "120/6000",
      percentRemaining: 98,
    });
    expect(out.presentation).toBeUndefined();
  });

  function statusDetail(out: any, key: string): string | undefined {
    return out.statusDetails?.find((detail: { key: string }) => detail.key === key)?.value;
  }

  const configureLocalEstimate = async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );
    (readAuthFileCached as any).mockResolvedValue({
      "alibaba-coding-plan": { type: "api", key: "dashscope-key", tier: "pro" },
    });
    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "pro",
      fiveHour: { used: 0, limit: 6000, percentRemaining: 100 },
      weekly: { used: 0, limit: 45000, percentRemaining: 100 },
      monthly: { used: 0, limit: 90000, percentRemaining: 100 },
    });
    return { computeAlibabaCodingPlanQuota };
  };

  it("prefers the real Alibaba Token Plan quota from the bl CLI", async () => {
    const { computeAlibabaCodingPlanQuota } = await configureLocalEstimate();
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    (probeAlibabaCliUsage as any).mockResolvedValue({
      installed: true,
      version: "1.22.0",
      authenticated: true,
      consoleRegion: "ap-southeast-1",
      consoleSite: "international",
      checkedCommands: [
        "bl --version",
        "bl usage token-plan --output json --timeout 8 --console-region ap-southeast-1 --console-site international",
      ],
      usage: {
        per5Hour: { percentUsed: 0.26, resetTimeMs: 1_774_560_000_000 },
        per1Week: { percentUsed: 0.54, resetTimeMs: 1_774_999_200_000 },
      },
    });

    const out = await alibabaCodingPlanProvider.fetch({
      config: {
        alibabaBinaryPath: "bl",
        alibabaConsoleRegion: "ap-southeast-1",
        alibabaConsoleSite: "international",
      },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).not.toHaveBeenCalled();
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    expect(readAuthFileCached).not.toHaveBeenCalled();
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "local_cli",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "Alibaba Token Plan 5h",
      group: "Alibaba Token Plan",
      label: "5h:",
      percentRemaining: 74,
      resetTimeIso: new Date(1_774_560_000_000).toISOString(),
    });
    expect(out.entries[1]).toMatchObject({
      name: "Alibaba Token Plan Weekly",
      label: "Weekly:",
      percentRemaining: 46,
      resetTimeIso: new Date(1_774_999_200_000).toISOString(),
    });
    expect(statusDetail(out, "alibaba_quota_source")).toBe("alibaba-cli");
    expect(statusDetail(out, "alibaba_cli_installed")).toBe("true");
    expect(statusDetail(out, "alibaba_cli_version")).toBe("1.22.0");
    expect(statusDetail(out, "alibaba_cli_authenticated")).toBe("true");
    expect(statusDetail(out, "alibaba_console_region")).toBe("ap-southeast-1");
    expect(statusDetail(out, "alibaba_console_site")).toBe("international");
    const surfaces = renderAccountingFourSurfaces({
      data: out,
      accountingDetail: "summary",
      toastMaxWidth: 80,
      toastNarrowAt: 44,
      compactMaxWidth: 160,
    });
    for (const output of Object.values(surfaces)) {
      expect(output).toContain("Alibaba Token Plan");
      expect(output).toContain("74%");
      expect(output).toContain("46%");
      expect(output).not.toContain("Coding Plan");
    }
    const used = formatQuotaCommand({ ...out, generatedAtMs: 0, percentDisplayMode: "used" });
    expect(used).toContain("26%");
    expect(used).toContain("54%");
  });

  it.each([0, 1])("converts fraction %s to remaining percentage exactly", async (fraction) => {
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    vi.mocked(probeAlibabaCliUsage).mockResolvedValue({
      installed: true,
      authenticated: true,
      checkedCommands: [],
      usage: { per1Week: { percentUsed: fraction } },
    });
    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);
    expect(out.entries[0]?.percentRemaining).toBe((1 - fraction) * 100);
  });

  it("matches the Token Plan runtime without matching unrelated Qwen providers", () => {
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: alibabaCodingPlanProvider,
        currentProviderID: "alibaba-token-plan",
        currentModel: "qwen3.8-max",
      }),
    ).toBe(true);
    expect(
      alibabaCodingPlanProvider.matchesCurrentModel?.("qwen3", {
        currentProviderID: "alibaba-token-plan",
      }),
    ).toBe(true);
    expect(alibabaCodingPlanProvider.matchesCurrentModel?.("alibaba-token-plan/qwen3")).toBe(true);
    expect(
      alibabaCodingPlanProvider.matchesCurrentModel?.("qwen3", { currentProviderID: "openrouter" }),
    ).toBe(false);
  });

  it("renders only the weekly window when the CLI omits the 5-hour window", async () => {
    const { computeAlibabaCodingPlanQuota } = await configureLocalEstimate();
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    (probeAlibabaCliUsage as any).mockResolvedValue({
      installed: true,
      authenticated: true,
      checkedCommands: ["bl --version", "bl usage token-plan --output json --timeout 8"],
      usage: {
        per1Week: { percentUsed: 0, resetTimeMs: 1_774_999_200_000 },
      },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "Alibaba Token Plan Weekly",
      percentRemaining: 100,
    });
    expect(computeAlibabaCodingPlanQuota as any).not.toHaveBeenCalled();
    expect(statusDetail(out, "alibaba_quota_source")).toBe("alibaba-cli");
  });

  it("falls back to the local estimate when the CLI probe fails", async () => {
    const failureCases = [
      {
        failureReason: "not_authenticated",
        message:
          "Alibaba Cloud Model Studio CLI is not authenticated. Run `bl auth login --console`.",
        authenticated: false,
      },
      { failureReason: "timeout", message: "Timed out while running `bl usage token-plan`." },
      {
        failureReason: "invalid_output",
        message: "Could not parse `bl usage token-plan` JSON output.",
      },
      { failureReason: "no_data", message: "Alibaba Token Plan usage returned no quota windows." },
    ] as const;

    for (const failure of failureCases) {
      vi.clearAllMocks();
      await mockCliNotInstalled();
      const { computeAlibabaCodingPlanQuota } = await configureLocalEstimate();
      const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
      (probeAlibabaCliUsage as any).mockResolvedValue({
        installed: true,
        checkedCommands: ["bl --version", "bl usage token-plan --output json --timeout 8"],
        ...failure,
      });

      const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

      expectAttemptedWithNoErrors(out);
      expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalled();
      expect(out.entries[0]).toMatchObject({ group: "Alibaba Coding Plan (Pro)" });
      expect(statusDetail(out, "alibaba_quota_source")).toBe("local-estimate");
      expect(statusDetail(out, "alibaba_cli_message")).toBe(failure.message);
    }
  });

  it("falls back to the local estimate when the CLI probe throws", async () => {
    const { computeAlibabaCodingPlanQuota } = await configureLocalEstimate();
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    (probeAlibabaCliUsage as any).mockRejectedValue(new Error("spawn exploded"));

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalled();
    expect(statusDetail(out, "alibaba_quota_source")).toBe("local-estimate");
    expect(statusDetail(out, "alibaba_cli_message")).toBe("Could not run Alibaba Cloud CLI.");
    expect(JSON.stringify(out)).not.toContain("spawn exploded");
  });

  it("reports availability from the CLI when no opencode auth is configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({});
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    (probeAlibabaCliUsage as any).mockResolvedValue({
      installed: true,
      authenticated: true,
      checkedCommands: ["bl --version", "bl usage token-plan --output json --timeout 8"],
      usage: { per1Week: { percentUsed: 0.1, resetTimeMs: 1_774_999_200_000 } },
    });

    await expect(alibabaCodingPlanProvider.isAvailable({ config: {} } as any)).resolves.toBe(true);
  });

  it("reports unavailable when neither auth nor an authenticated CLI exist", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({});

    await expect(alibabaCodingPlanProvider.isAvailable({ config: {} } as any)).resolves.toBe(false);
  });

  const mockExpiredConsoleSession = async () => {
    const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
    (probeAlibabaCliUsage as any).mockResolvedValue({
      installed: true,
      authenticated: false,
      checkedCommands: ["bl --version", "bl usage token-plan --output json --timeout 8"],
      failureReason: "not_authenticated",
      message:
        "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
    });
  };

  const mockTokenPlanCredential = async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({
      "alibaba-token-plan": { type: "api", key: "token-plan-key" },
    });
  };

  it("stays available when the console session expired but a Token Plan credential exists", async () => {
    await mockTokenPlanCredential();
    await mockExpiredConsoleSession();

    await expect(alibabaCodingPlanProvider.isAvailable({ config: {} } as any)).resolves.toBe(true);
  });

  it("surfaces the expired console session instead of hiding the provider", async () => {
    await mockTokenPlanCredential();
    await mockExpiredConsoleSession();

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithErrorLabel(out, "Alibaba Token Plan");
    expect(out.errors[0]?.message).toBe(
      "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
    );
    expect(out.errors[0]?.retryable).not.toBe(true);
    expect(statusDetail(out, "alibaba_runtime_auth")).toBe("true");
    expect(statusDetail(out, "alibaba_cli_authenticated")).toBe("false");
    expect(statusDetail(out, "alibaba_quota_source")).toBe("(none)");
  });

  it("surfaces the install hint when the CLI is missing but a Token Plan credential exists", async () => {
    await mockTokenPlanCredential();

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithErrorLabel(out, "Alibaba Token Plan");
    expect(out.errors[0]?.message).toContain("bailian-cli");
    expect(out.errors[0]?.retryable).not.toBe(true);
  });

  it("marks transient CLI failures retryable while keeping the provider visible", async () => {
    const transientFailures = [
      { failureReason: "timeout", message: "Timed out while running `bl usage token-plan`." },
      { failureReason: "network", message: "Network error while running `bl usage token-plan`." },
    ] as const;

    for (const failure of transientFailures) {
      vi.clearAllMocks();
      await mockTokenPlanCredential();
      const { probeAlibabaCliUsage } = await import("../src/lib/alibaba-cli.js");
      (probeAlibabaCliUsage as any).mockResolvedValue({
        installed: true,
        checkedCommands: ["bl --version", "bl usage token-plan --output json --timeout 8"],
        ...failure,
      });

      const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

      expectAttemptedWithErrorLabel(out, "Alibaba Token Plan");
      expect(out.errors[0]?.message).toBe(failure.message);
      expect(out.errors[0]?.retryable).toBe(true);
    }
  });

  it("stays silent when no Alibaba credential is configured and the CLI probe fails", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({ openai: { type: "oauth" } });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectNotAttempted(out);
    await expect(alibabaCodingPlanProvider.isAvailable({ config: {} } as any)).resolves.toBe(false);
  });

  it("ignores an Alibaba auth entry without usable credentials", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValue({
      "alibaba-token-plan": { type: "api", key: "   " },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectNotAttempted(out);
    await expect(alibabaCodingPlanProvider.isAvailable({ config: {} } as any)).resolves.toBe(false);
  });
});
