import { describe, expect, it, vi } from "vitest";

import type { QuotaToastEntry } from "../src/lib/entries.js";
import { modelProviderMatchesRuntimeId } from "../src/lib/provider-model-matching.js";
import { matchesQuotaProviderCurrentSelection } from "../src/lib/quota-render-data.js";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba-coding-plan.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/alibaba-token-plan.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/alibaba-token-plan.js")>(
    "../src/lib/alibaba-token-plan.js",
  );
  return {
    ...actual,
    resolveAlibabaTokenPlanExecutable: vi.fn(actual.resolveAlibabaTokenPlanExecutable),
    queryAlibabaTokenPlanQuota: vi.fn(actual.queryAlibabaTokenPlanQuota),
  };
});

vi.mock("../src/lib/qwen-local-quota.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/qwen-local-quota.js")>();
  return {
    ...actual,
    readAlibabaCodingPlanQuotaState: vi.fn(actual.readAlibabaCodingPlanQuotaState),
  };
});

const accounting = {
  resultType: "quota" as const,
  acquisitionMethod: "local_cli" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};

describe("alibaba-token-plan provider", () => {
  it("is available from explicit selection or recognized runtime presence without probing PATH", async () => {
    const { resolveAlibabaTokenPlanExecutable } = await import("../src/lib/alibaba-token-plan.js");
    const supported = process.platform === "darwin" || process.platform === "linux";
    const selected = createProviderAvailabilityContext({
      providerIds: ["alibaba-token-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(selected)).resolves.toBe(supported);
    expect(resolveAlibabaTokenPlanExecutable).not.toHaveBeenCalled();

    const codingPlanOnly = createProviderAvailabilityContext({
      providerIds: ["alibaba", "alibaba-coding-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(codingPlanOnly)).resolves.toBe(false);
    expect(resolveAlibabaTokenPlanExecutable).not.toHaveBeenCalled();

    const runtime = createProviderAvailabilityContext({
      configOverrides: { currentProviderID: "alibaba-token-plan" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(runtime)).resolves.toBe(supported);

    const model = createProviderAvailabilityContext({
      configOverrides: { currentModel: "alibaba-token-plan/qwen3" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(model)).resolves.toBe(supported);
  });

  it("matches only its own runtime identity and never Coding Plan models", () => {
    expect(
      alibabaTokenPlanProvider.matchesCurrentModel("alibaba-token-plan/qwen3", {
        currentProviderID: "alibaba-token-plan",
      } as any),
    ).toBe(true);
    expect(
      alibabaTokenPlanProvider.matchesCurrentModel("alibaba/qwen3-coder", {
        currentProviderID: "alibaba",
      } as any),
    ).toBe(false);
    expect(
      alibabaTokenPlanProvider.matchesCurrentModel("alibaba-coding-plan/qwen3", {
        currentProviderID: "alibaba-coding-plan",
      } as any),
    ).toBe(false);
    expect(alibabaTokenPlanProvider.matchesCurrentModel("alibaba/qwen3-coder")).toBe(false);
    expect(modelProviderMatchesRuntimeId("alibaba/qwen3", "alibaba-token-plan")).toBe(false);
    expect(modelProviderMatchesRuntimeId("alibaba-token-plan/qwen3", "alibaba-coding-plan")).toBe(
      false,
    );
    expect(modelProviderMatchesRuntimeId("alibaba-token-plan/qwen3", "alibaba-token-plan")).toBe(
      true,
    );
  });

  it("returns a fixed attempted setup failure when the CLI is absent", async () => {
    const { queryAlibabaTokenPlanQuota } = await import("../src/lib/alibaba-token-plan.js");
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValue({
      ok: false,
      error: {
        kind: "executable_not_found",
        message: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
      },
    });
    const out = await alibabaTokenPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Alibaba Personal Token Plan");
    expect(out.errors[0]?.message).toBe(
      "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
    );
  });

  it("returns not-attempted on unsupported platforms", async () => {
    const { queryAlibabaTokenPlanQuota } = await import("../src/lib/alibaba-token-plan.js");
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValue({
      ok: false,
      error: {
        kind: "unsupported_platform",
        message: "Alibaba Personal Token Plan is not supported on this platform.",
      },
    });
    const out = await alibabaTokenPlanProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("maps official windows without fabricating a sibling", async () => {
    const { queryAlibabaTokenPlanQuota } = await import("../src/lib/alibaba-token-plan.js");
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValue({
      ok: true,
      weekly: {
        percentRemaining: 60,
        resetTimeIso: "2024-05-01T20:53:20.000Z",
      },
    });
    const out = await alibabaTokenPlanProvider.fetch({ config: { requestTimeoutMs: 5000 } } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "alibaba-token-plan")).toEqual([
      {
        name: "Alibaba Personal Token Plan Weekly",
        group: "Alibaba Personal Token Plan",
        label: "Weekly:",
        percentRemaining: 60,
        resetTimeIso: "2024-05-01T20:53:20.000Z",
      },
    ]);
    expect(out.entries.some((entry) => entry.label === "5h:")).toBe(false);
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: alibabaTokenPlanProvider,
        currentProviderID: "alibaba-token-plan",
        currentModel: "alibaba-token-plan/qwen3",
      }),
    ).toBe(true);
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: alibabaCodingPlanProvider,
        currentProviderID: "alibaba-token-plan",
        currentModel: "alibaba-token-plan/qwen3",
      }),
    ).toBe(false);
  });

  it("keeps Coding Plan fetch successful while Token Plan fails", async () => {
    const originalKey = process.env.ALIBABA_API_KEY;
    process.env.ALIBABA_API_KEY = "coding-plan-non-regression-key";
    try {
      const { queryAlibabaTokenPlanQuota } = await import("../src/lib/alibaba-token-plan.js");
      vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValue({
        ok: false,
        error: {
          kind: "not_authenticated",
          message:
            "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
        },
      });
      const tokenOut = await alibabaTokenPlanProvider.fetch({ config: {} } as any);
      expectAttemptedWithErrorLabel(tokenOut, "Alibaba Personal Token Plan");

      const { readAlibabaCodingPlanQuotaState } = await import("../src/lib/qwen-local-quota.js");
      vi.mocked(readAlibabaCodingPlanQuotaState).mockResolvedValue({
        version: 1,
        recent: [],
        updatedAt: Date.now(),
      });
      const codingOut = await alibabaCodingPlanProvider.fetch({
        config: { quotaProviders: [] },
      } as any);
      expectAttemptedWithNoErrors(codingOut);
      expect(visibleEntries(codingOut.entries, "alibaba-coding-plan").length).toBeGreaterThan(0);
      expect(JSON.stringify(codingOut)).not.toContain("Alibaba Personal Token Plan");
      expect(JSON.stringify(codingOut)).not.toContain("bl auth login");
    } finally {
      if (originalKey === undefined) delete process.env.ALIBABA_API_KEY;
      else process.env.ALIBABA_API_KEY = originalKey;
    }
  });

  it("surfaces sanitized console-auth failure as an attempted error", async () => {
    const { queryAlibabaTokenPlanQuota } = await import("../src/lib/alibaba-token-plan.js");
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValue({
      ok: false,
      error: {
        kind: "not_authenticated",
        message:
          "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
      },
    });
    const out = await alibabaTokenPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Alibaba Personal Token Plan");
    expect(out.errors[0]?.message).toContain("bl auth login --console");
    expect(JSON.stringify(out)).not.toContain("stderr");
  });
});

describe("alibaba-token-plan four-surface formatting", () => {
  it("renders only returned windows across command, toast, sidebar, and compact", () => {
    const entries: QuotaToastEntry[] = [
      {
        accounting,
        name: "Alibaba Personal Token Plan Weekly",
        group: "Alibaba Personal Token Plan",
        label: "Weekly:",
        percentRemaining: 60,
      },
    ];
    const outputs = renderAccountingFourSurfaces({
      data: { entries, errors: [] },
      accountingDetail: "summary",
      toastMaxWidth: 80,
      toastNarrowAt: 44,
      compactMaxWidth: 160,
    });
    for (const output of Object.values(outputs)) {
      expect(output).toContain("Alibaba Personal Token Plan");
      expect(output).toContain("60%");
      expect(output).not.toContain("Alibaba Coding Plan");
    }
  });
});
