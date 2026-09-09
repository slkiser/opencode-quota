import { describe, expect, it, vi } from "vitest";
import { deepseekProvider } from "../src/providers/deepseek.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/deepseek.js", () => ({
  queryDeepSeekBalance: vi.fn(),
  hasDeepSeekApiKeyConfigured: vi.fn(),
  getDeepSeekKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("deepseek provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce(null);

    const out = await deepseekProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps separate currencies and exact source precision into complete semantic rows", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable: true,
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "12.340000000000000001",
          grantedBalance: "2.00",
          toppedUpBalance: "10.340000000000000001",
        },
        {
          currency: "CNY",
          totalBalance: "88.00",
          grantedBalance: "0.00",
          toppedUpBalance: "88.00",
        },
      ],
      parseIssues: [],
    });

    const out = await deepseekProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);
    expectAttemptedWithNoErrors(out);
    expect(queryDeepSeekBalance).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      {
        kind: "quantity",
        name: "deepseek-usd-total-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: {
          decimal: "12.340000000000000001",
          unit: { kind: "currency", code: "USD" },
        },
      },
      {
        kind: "quantity",
        name: "deepseek-usd-granted-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "granted_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "2.00", unit: { kind: "currency", code: "USD" } },
      },
      {
        kind: "quantity",
        name: "deepseek-usd-topped-up-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "topped_up_balance" },
          prominence: "supplementary",
        },
        quantity: {
          decimal: "10.340000000000000001",
          unit: { kind: "currency", code: "USD" },
        },
      },
      {
        kind: "quantity",
        name: "deepseek-cny-total-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: { decimal: "88.00", unit: { kind: "currency", code: "CNY" } },
      },
      {
        kind: "quantity",
        name: "deepseek-cny-granted-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "granted_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "0.00", unit: { kind: "currency", code: "CNY" } },
      },
      {
        kind: "quantity",
        name: "deepseek-cny-topped-up-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "topped_up_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "88.00", unit: { kind: "currency", code: "CNY" } },
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.resultType === "balance")).toBe(true);
    expect(out.entries.every((entry) => entry.accounting.authority === "provider_reported")).toBe(
      true,
    );
    expect(out.entries.every((entry) => !("right" in entry))).toBe(true);
    expect(out.entries.every((entry) => !("barValue" in entry))).toBe(true);
    expect(out.entries.every((entry) => entry.kind !== "value")).toBe(true);
  });

  it("keeps valid components and reports a malformed total without inventing zero", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable: true,
      balanceInfos: [
        { currency: "USD", grantedBalance: "1.25", toppedUpBalance: "3.75" },
        { currency: "CNY", totalBalance: "8.5" },
      ],
      parseIssues: [{ currency: "USD", field: "total_balance" }],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(3);
    expect(JSON.stringify(out.entries)).not.toContain("0.00");
    expect(out.errors).toEqual([
      { label: "DeepSeek USD", message: "total_balance returned an invalid decimal" },
    ]);
  });

  it.each([
    [true, "Available"],
    [false, "Low balance"],
  ])("maps empty balance responses into a semantic boolean (%s)", async (isAvailable, _text) => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable,
      balanceInfos: [],
      parseIssues: [],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      {
        kind: "boolean",
        name: "deepseek-availability",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "named", name: "Availability" },
          prominence: "primary",
        },
        value: isAvailable,
      },
    ]);
    expect(out.entries[0]?.accounting.resultType).toBe("status");
  });

  it("keeps valid sibling rows and diagnostics without inventing availability", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable: undefined,
      balanceInfos: [{ currency: "USD", grantedBalance: "1.25" }],
      parseIssues: [{ currency: "USD", field: "total_balance" }],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);

    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      {
        kind: "quantity",
        name: "deepseek-usd-granted-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "granted_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "1.25", unit: { kind: "currency", code: "USD" } },
      },
    ]);
    expect(out.entries.some((entry) => entry.kind === "boolean")).toBe(false);
    expect(out.errors).toEqual([
      { label: "DeepSeek USD", message: "total_balance returned an invalid decimal" },
    ]);
  });

  it("returns no data when an empty response omits availability", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable: undefined,
      balanceInfos: [],
      parseIssues: [],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);

    expect(out).toMatchObject({ attempted: true, entries: [], errors: [] });
  });

  it("maps errors into toast errors", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await deepseekProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "DeepSeek");
  });

  it("matches DeepSeek model ids", () => {
    expect(deepseekProvider.matchesCurrentModel?.("deepseek/deepseek-chat")).toBe(true);
    expect(deepseekProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when DeepSeek provider ids are reported by metadata", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(true);
    expect(isCanonicalProviderAvailable).toHaveBeenCalledWith({
      ctx: {},
      providerId: "deepseek",
      fallbackOnError: false,
    });
  });

  it("falls back to trusted API key presence when provider ids are absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasDeepSeekApiKeyConfigured } = await import("../src/lib/deepseek.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasDeepSeekApiKeyConfigured as any).mockResolvedValueOnce(true);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("is not available when provider ids are absent and no trusted API key exists", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasDeepSeekApiKeyConfigured } = await import("../src/lib/deepseek.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasDeepSeekApiKeyConfigured as any).mockResolvedValueOnce(false);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
