import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { deepseekProvider } from "../src/providers/deepseek.js";

vi.mock("../src/lib/deepseek.js", () => ({
  queryDeepSeekBalance: vi.fn(),
  hasDeepSeekApiKeyConfigured: vi.fn(),
  formatDeepSeekBalanceValue: vi.fn(
    (balance: { currency: "CNY" | "USD"; totalBalance: string }) =>
      `${balance.currency === "CNY" ? "¥" : "$"}${balance.totalBalance}`,
  ),
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

  it("maps balance infos into grouped value rows", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable: true,
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "12.34",
          grantedBalance: "2.00",
          toppedUpBalance: "10.34",
        },
        {
          currency: "CNY",
          totalBalance: "88.00",
          grantedBalance: "0.00",
          toppedUpBalance: "88.00",
        },
      ],
    });

    const out = await deepseekProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);
    expectAttemptedWithNoErrors(out);
    expect(queryDeepSeekBalance).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "DeepSeek Balance",
        group: "DeepSeek",
        label: "Balance:",
        value: "$12.34",
      },
      {
        kind: "value",
        name: "DeepSeek Balance",
        group: "DeepSeek",
        label: "Balance:",
        value: "¥88.00",
      },
    ]);
  });

  it("maps unavailable empty balance responses into a status row", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      isAvailable: false,
      balanceInfos: [],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "DeepSeek",
        group: "DeepSeek",
        label: "Status:",
        value: "Low balance",
      },
    ]);
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
