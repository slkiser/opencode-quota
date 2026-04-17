import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba-coding-plan.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  readAlibabaCodingPlanQuotaState: vi.fn(),
  computeAlibabaCodingPlanQuota: vi.fn(),
}));

describe("alibaba-coding-plan provider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ALIBABA_CODING_PLAN_API_KEY;
    delete process.env.ALIBABA_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns attempted:false when no alibaba coding plan is configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({});

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("uses env-based fallback auth with the configured fallback tier", async () => {
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
      config: { formatStyle: "grouped", alibabaCodingPlanTier: "pro" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalledWith({ state: {}, tier: "pro" });
  });

  it("supports the alibaba-coding-plan auth key and uses configured fallback tier", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );

    (readAuthFileCached as any).mockResolvedValueOnce({
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
      config: { formatStyle: "grouped", alibabaCodingPlanTier: "pro" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalledWith({ state: {}, tier: "pro" });
  });

  it("falls back to the alibaba auth key when alibaba-coding-plan exists without usable credentials", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );

    (readAuthFileCached as any).mockResolvedValueOnce({
      "alibaba-coding-plan": { type: "api", key: "   " },
      alibaba: { type: "api", key: "dashscope-key", tier: "pro" },
    });
    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "pro",
      fiveHour: { used: 0, limit: 6000, percentRemaining: 100 },
      weekly: { used: 0, limit: 45000, percentRemaining: 100 },
      monthly: { used: 0, limit: 90000, percentRemaining: 100 },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: { formatStyle: "grouped" } } as any);

    expectAttemptedWithNoErrors(out);
    expect(computeAlibabaCodingPlanQuota as any).toHaveBeenCalledWith({ state: {}, tier: "pro" });
  });

  it("surfaces invalid alibaba tier errors", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
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

    const out = await alibabaCodingPlanProvider.fetch({ config: { formatStyle: "grouped" } } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(3);
    expect(out.entries[0]).toMatchObject({
      name: "Alibaba Coding Plan (Pro) 5h",
      group: "Alibaba Coding Plan (Pro)",
      label: "5h:",
      right: "120/6000",
      percentRemaining: 98,
    });
  });

  it("uses the worst remaining window for classic entries", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    const { computeAlibabaCodingPlanQuota, readAlibabaCodingPlanQuotaState } = await import(
      "../src/lib/qwen-local-quota.js"
    );

    (readAuthFileCached as any).mockResolvedValue({
      alibaba: { type: "api", key: "dashscope-key", tier: "lite" },
    });
    (readAlibabaCodingPlanQuotaState as any).mockResolvedValue({});
    (computeAlibabaCodingPlanQuota as any).mockReturnValue({
      tier: "lite",
      fiveHour: {
        used: 100,
        limit: 1200,
        percentRemaining: 91,
        resetTimeIso: "2026-02-24T15:00:00.000Z",
      },
      weekly: {
        used: 4500,
        limit: 9000,
        percentRemaining: 50,
        resetTimeIso: "2026-03-01T12:00:00.000Z",
      },
      monthly: {
        used: 2000,
        limit: 18000,
        percentRemaining: 89,
        resetTimeIso: "2026-03-26T12:00:00.000Z",
      },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: { formatStyle: "classic" } } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Alibaba Coding Plan (Lite) Weekly",
        percentRemaining: 50,
        resetTimeIso: "2026-03-01T12:00:00.000Z",
      },
    ]);
  });
});
