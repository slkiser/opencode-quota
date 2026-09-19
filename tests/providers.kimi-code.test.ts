import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const authMocks = vi.hoisted(() => ({
  resolveKimiCodePlanGlobalAuthCached: vi.fn(),
  resolveKimiCodePlanCnAuthCached: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  resolveKimiCodePlanGlobalAuthCached: authMocks.resolveKimiCodePlanGlobalAuthCached,
  resolveKimiCodePlanCnAuthCached: authMocks.resolveKimiCodePlanCnAuthCached,
  getKimiCodePlanGlobalAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    authPaths: [],
  })),
  getKimiCodePlanCnAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    authPaths: [],
  })),
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/kimi.js", () => ({
  queryKimiQuota: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

import { kimiCodePlanCnProvider, kimiCodePlanGlobalProvider } from "../src/providers/kimi-code.js";

describe("kimi-code-plan-cn provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveKimiCodePlanCnAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "test-key",
    });
  });

  it("returns attempted:false when no kimi auth is configured", async () => {
    authMocks.resolveKimiCodePlanCnAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("returns error when kimi auth is invalid", async () => {
    authMocks.resolveKimiCodePlanCnAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: "Invalid API key",
    });

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Kimi Code (CN)");
    expect(out.errors[0]?.message).toBe("Invalid API key");
  });

  it("maps success into canonical grouped-capable entries for all windows", async () => {
    const { queryKimiQuota } = await import("../src/lib/kimi.js");
    (queryKimiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "Kimi Code (CN)",
      windows: [
        {
          label: "Weekly limit",
          used: 250,
          limit: 1000,
          percentRemaining: 75,
          resetTimeIso: "2026-01-08T00:00:00.000Z",
        },
        {
          label: "5h limit",
          used: 100,
          limit: 500,
          percentRemaining: 80,
          resetTimeIso: "2026-01-01T05:00:00.000Z",
        },
      ],
    });

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kimi-code-plan-cn")).toEqual([
      {
        name: "Kimi Code (CN) Weekly limit",
        group: "Kimi Code (CN)",
        label: "Weekly limit:",
        right: "250/1000",
        percentRemaining: 75,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
      {
        name: "Kimi Code (CN) 5h limit",
        group: "Kimi Code (CN)",
        label: "5h limit:",
        right: "100/500",
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T05:00:00.000Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Kimi Code (CN)",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryKimiQuota } = await import("../src/lib/kimi.js");
    (queryKimiQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await kimiCodePlanCnProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Kimi Code (CN)");
  });

  it("matches kimi CN and legacy model ids", () => {
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("kimi-code-plan-cn/k3")).toBe(true);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("kimi-code-plan-cn/kimi-for-coding")).toBe(
      true,
    );
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("kimi-for-coding/kimi-k2")).toBe(true);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("kimi-code/kimi-k2")).toBe(true);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("kimi/kimi-k2")).toBe(true);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("kimi-code-plan-global/k3")).toBe(false);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when provider ids include kimi-code-plan-cn and auth is configured", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);

    const available = await kimiCodePlanCnProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-cn"] }),
    );
    expect(available).toBe(true);
  });

  it("is available for legacy kimi-for-coding runtime ids", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);

    const available = await kimiCodePlanCnProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-for-coding"] }),
    );
    expect(available).toBe(true);
  });

  it("is available when auth is invalid so the provider can surface the error", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);
    authMocks.resolveKimiCodePlanCnAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: 'Unsupported Kimi auth type: "oauth"',
    });

    const available = await kimiCodePlanCnProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-cn"] }),
    );
    expect(available).toBe(true);
  });

  it("is not available when provider ids exist but auth is missing", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);
    authMocks.resolveKimiCodePlanCnAuthCached.mockResolvedValueOnce({ state: "none" });

    const available = await kimiCodePlanCnProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-cn"] }),
    );
    expect(available).toBe(false);
  });

  it("is not available when provider lookup throws", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockRestore();

    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    const available = await kimiCodePlanCnProvider.isAvailable(ctx);
    expect(available).toBe(false);
    expect(authMocks.resolveKimiCodePlanCnAuthCached).not.toHaveBeenCalled();
  });
});

describe("kimi-code-plan-global provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveKimiCodePlanGlobalAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "test-key",
    });
  });

  it("matches global model ids only", () => {
    expect(kimiCodePlanGlobalProvider.matchesCurrentModel?.("kimi-code-plan-global/k3")).toBe(true);
    expect(kimiCodePlanGlobalProvider.matchesCurrentModel?.("kimi-code-plan-global/k3-256k")).toBe(
      true,
    );
    expect(
      kimiCodePlanGlobalProvider.matchesCurrentModel?.("kimi-code-plan-global/kimi-for-coding"),
    ).toBe(true);
    expect(
      kimiCodePlanGlobalProvider.matchesCurrentModel?.(
        "kimi-code-plan-global/kimi-for-coding-highspeed",
      ),
    ).toBe(true);
    expect(kimiCodePlanGlobalProvider.matchesCurrentModel?.("kimi-code-plan-cn/k3")).toBe(false);
    expect(kimiCodePlanGlobalProvider.matchesCurrentModel?.("kimi-for-coding/kimi-k2")).toBe(false);
  });

  it("is available when provider ids include kimi-code-plan-global", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);

    const available = await kimiCodePlanGlobalProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-global"] }),
    );
    expect(available).toBe(true);
  });
});
