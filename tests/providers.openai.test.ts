import { beforeEach, describe, expect, it, vi } from "vitest";
import { openaiProvider } from "../src/providers/openai.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasOpenAIOAuthCached: vi.fn(),
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" })),
  queryOpenAIQuota: vi.fn(),
  queryOpenAIQuotaForCredential: vi.fn(),
}));

vi.mock("../src/lib/openai-multi-auth.js", () => ({
  hasOpenAIMultiAuthAccountsConfigured: vi.fn(),
  readOpenAIMultiAuthAccounts: vi.fn(),
  inspectOpenAIMultiAuthPresence: vi.fn(),
}));

describe("openai provider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const openai = await import("../src/lib/openai.js");
    (openai.hasOpenAIOAuthCached as any).mockResolvedValue(false);
    (openai.resolveOpenAIOAuth as any).mockReturnValue({ state: "none" });
    (openai.queryOpenAIQuota as any).mockResolvedValue(null);
    (openai.queryOpenAIQuotaForCredential as any).mockReset();
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    (multiAuth.hasOpenAIMultiAuthAccountsConfigured as any).mockResolvedValue(false);
    (multiAuth.readOpenAIMultiAuthAccounts as any).mockResolvedValue(null);
    (multiAuth.inspectOpenAIMultiAuthPresence as any).mockResolvedValue({
      state: "missing",
      accountCount: 0,
      enabledAccountCount: 0,
      cachedAccessTokenCount: 0,
    });
  });

  it("passes configured requestTimeoutMs to the query", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    await openaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expect(queryOpenAIQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when not configured", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    const out = await openaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into canonical grouped-capable windows with single-window display metadata", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Pro)",
      windows: {
        hourly: { percentRemaining: 42, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 80, resetTimeIso: "2026-01-07T00:00:00.000Z" },
        monthly: { percentRemaining: 67, resetTimeIso: "2026-02-01T00:00:00.000Z" },
        codeReview: { percentRemaining: 55, resetTimeIso: "2026-01-02T00:00:00.000Z" },
      },
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "openai")).toEqual([
      {
        name: "OpenAI (Pro) 5h",
        group: "OpenAI (Pro)",
        label: "5h:",
        percentRemaining: 42,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Weekly",
        group: "OpenAI (Pro)",
        label: "Weekly:",
        percentRemaining: 80,
        resetTimeIso: "2026-01-07T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Monthly",
        group: "OpenAI (Pro)",
        label: "Monthly:",
        percentRemaining: 67,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Code Review",
        group: "OpenAI (Pro)",
        label: "Code Review:",
        percentRemaining: 55,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.entries.at(-1)?.accounting.resultType).toBe("rate_limit");
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "OpenAI (Pro)",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenAI");
  });

  it("queries multiple cached accounts independently with distinct source ids", async () => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    (multiAuth.readOpenAIMultiAuthAccounts as any).mockResolvedValueOnce([
      {
        index: 0,
        accountId: "business-account",
        accountLabel: "Business",
        accessToken: "cached-business",
        sourceId: "openai-multi-auth:business",
      },
      {
        index: 1,
        accountId: "personal-account",
        accountLabel: "Personal (role:owner) [id:419b14]",
        accessToken: "cached-personal",
        sourceId: "openai-multi-auth:personal",
      },
    ]);
    (multiAuth.inspectOpenAIMultiAuthPresence as any).mockResolvedValueOnce({
      state: "present",
      accountCount: 2,
      enabledAccountCount: 2,
      cachedAccessTokenCount: 2,
    });
    (openai.queryOpenAIQuotaForCredential as any).mockImplementation(
      async (credential: { accessToken: string; refreshToken?: string }) => {
        expect(credential).not.toHaveProperty("refreshToken");
        return {
          success: true,
          label: "OpenAI (Plus)",
          windows: {
            weekly: { percentRemaining: credential.accessToken.includes("business") ? 0 : 68 },
          },
        };
      },
    );

    const out = await openaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(openai.queryOpenAIQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
    expect(openai.queryOpenAIQuotaForCredential).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(openai.queryOpenAIQuotaForCredential).mock.calls) {
      expect(call[1]).toEqual({ requestTimeoutMs: 12000 });
    }
    expect(out.entries.map((entry) => entry.group)).toEqual(["OpenAI (Plus)", "OpenAI (Plus) #2"]);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "openai-multi-auth:business",
      "openai-multi-auth:personal",
    ]);
  });

  it("numbers repeated plan labels across many subscriptions", async () => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    (multiAuth.readOpenAIMultiAuthAccounts as any).mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, index) => ({
        index,
        accountId: `account-${index}`,
        accountLabel: `Account ${index + 1} (role:owner) [id:${index}]`,
        accessToken: `cached-${index}`,
        sourceId: `openai-multi-auth:${index}`,
      })),
    );
    (multiAuth.inspectOpenAIMultiAuthPresence as any).mockResolvedValueOnce({
      state: "present",
      accountCount: 6,
      enabledAccountCount: 6,
      cachedAccessTokenCount: 6,
    });
    (openai.queryOpenAIQuotaForCredential as any).mockResolvedValue({
      success: true,
      label: "OpenAI (Plus)",
      windows: { weekly: { percentRemaining: 68 } },
    });

    const out = await openaiProvider.fetch({} as any);

    expect(out.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Plus)",
      "OpenAI (Plus) #2",
      "OpenAI (Plus) #3",
      "OpenAI (Plus) #4",
      "OpenAI (Plus) #5",
      "OpenAI (Plus) #6",
    ]);
    expect(new Set(out.entries.map((entry) => entry.accounting.sourceId)).size).toBe(6);
  });

  it("keeps native quota and healthy multi-auth quota when one account lacks a cached token", async () => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    (openai.resolveOpenAIOAuth as any).mockReturnValue({
      state: "configured",
      sourceKey: "openai",
      accessToken: "native-cached",
      accountId: "native-account",
      email: "native@example.invalid",
    });
    (openai.queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Plus)",
      windows: { weekly: { percentRemaining: 50 } },
    });
    (multiAuth.readOpenAIMultiAuthAccounts as any).mockResolvedValueOnce([
      { index: 0, accountId: "stale", planType: "Business", sourceId: "stale" },
      {
        index: 1,
        accountId: "personal",
        accountLabel: "Personal",
        accessToken: "cached-personal",
        sourceId: "personal",
      },
    ]);
    (multiAuth.inspectOpenAIMultiAuthPresence as any).mockResolvedValueOnce({
      state: "present",
      accountCount: 2,
      enabledAccountCount: 2,
      cachedAccessTokenCount: 1,
    });
    (openai.queryOpenAIQuotaForCredential as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Plus)",
      windows: { weekly: { percentRemaining: 68 } },
    });

    const out = await openaiProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(2);
    expect(out.entries.map((entry) => entry.group)).toEqual(["OpenAI (Plus)", "OpenAI (Plus) #2"]);
    expect(JSON.stringify(out)).not.toMatch(
      /native@example|native-account|native-cached|account_email|account_id/,
    );
    expect(out.statusDetails?.filter((detail) => detail.key === "auth_source")).toHaveLength(1);
    expect(out.errors).toEqual([
      {
        label: "OpenAI (Business)",
        message: "Cached access token unavailable; refresh this account in oc-codex-multi-auth.",
      },
    ]);
  });

  it("does not query a duplicate multi-auth account when strong native identity matches", async () => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    (openai.resolveOpenAIOAuth as any).mockReturnValue({
      state: "configured",
      sourceKey: "openai",
      accessToken: "native-cached",
      accountId: "same-account",
      email: "same@example.invalid",
    });
    (openai.queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Plus)",
      windows: { weekly: { percentRemaining: 50 } },
    });
    (multiAuth.readOpenAIMultiAuthAccounts as any).mockResolvedValueOnce([
      {
        index: 0,
        accountId: "same-account",
        email: "same@example.invalid",
        accessToken: "rotated-cached",
        sourceId: "same-source",
      },
    ]);

    const out = await openaiProvider.fetch({} as any);

    expect(out.errors).toEqual([]);
    expect(out.entries).toHaveLength(1);
    expect(openai.queryOpenAIQuotaForCredential).not.toHaveBeenCalled();
  });

  it.each([
    [{ accessToken: "shared" }, { accessToken: "shared" }, true],
    [{ accountUserId: "member" }, { accountUserId: "member" }, true],
    [
      { accountId: "workspace", accountUserId: "member" },
      { accountId: "workspace", accountUserId: "member" },
      true,
    ],
    [
      { accountId: "workspace", accountUserId: "member" },
      { accountId: "other", accountUserId: "member" },
      false,
    ],
    [{ accountId: "workspace", accountUserId: "member" }, { accountId: "workspace" }, false],
    [{ accountId: "workspace" }, { accountId: "workspace", accountUserId: "member" }, false],
    [
      { accountId: "workspace", accountUserId: "one" },
      { accountId: "workspace", accountUserId: "two" },
      false,
    ],
    [{ email: "same@example.invalid" }, { email: "same@example.invalid" }, false],
  ])("deduplicates only proven identity: %j / %j", async (native, account, duplicate) => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    vi.mocked(openai.resolveOpenAIOAuth).mockReturnValue({
      state: "configured",
      sourceKey: "openai",
      accessToken: "native",
      email: "same@example.invalid",
      ...native,
    });
    vi.mocked(multiAuth.readOpenAIMultiAuthAccounts).mockResolvedValueOnce([
      {
        index: 0,
        sourceId: "source",
        accessToken: "multi",
        email: "same@example.invalid",
        ...account,
      },
    ]);
    vi.mocked(openai.queryOpenAIQuota).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Plus)",
      windows: { weekly: { percentRemaining: 50 } },
    });
    vi.mocked(openai.queryOpenAIQuotaForCredential).mockResolvedValue({
      success: true,
      label: "OpenAI (Plus)",
      windows: { weekly: { percentRemaining: 60 } },
    });
    const out = await openaiProvider.fetch({} as any);
    expect(out.entries).toHaveLength(duplicate ? 1 : 2);
    expect(openai.queryOpenAIQuotaForCredential).toHaveBeenCalledTimes(duplicate ? 0 : 1);
  });

  it("allocates one group per multi-window source in native-first storage order", async () => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    const success = {
      success: true as const,
      label: "OpenAI (Plus)",
      windows: {
        hourly: { percentRemaining: 20 },
        weekly: { percentRemaining: 60 },
      },
    };
    vi.mocked(openai.queryOpenAIQuota).mockResolvedValueOnce(success);
    vi.mocked(multiAuth.readOpenAIMultiAuthAccounts).mockResolvedValueOnce([
      { index: 0, accessToken: "first", sourceId: "first" },
      { index: 1, accessToken: "second", sourceId: "second" },
    ]);
    let finishFirst!: () => void;
    vi.mocked(openai.queryOpenAIQuotaForCredential).mockImplementation(async (credential) => {
      if (credential.accessToken === "first")
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      else finishFirst();
      return success;
    });
    const out = await openaiProvider.fetch({} as any);
    expect(out.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Plus)",
      "OpenAI (Plus)",
      "OpenAI (Plus) #2",
      "OpenAI (Plus) #2",
      "OpenAI (Plus) #3",
      "OpenAI (Plus) #3",
    ]);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      undefined,
      undefined,
      "first",
      "first",
      "second",
      "second",
    ]);
  });

  it("uses safe plan fallbacks and preserves healthy results after API failure", async () => {
    const multiAuth = await import("../src/lib/openai-multi-auth.js");
    const openai = await import("../src/lib/openai.js");
    vi.mocked(openai.queryOpenAIQuota).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (native@example.invalid)",
      windows: { weekly: { percentRemaining: 50 } },
    });
    vi.mocked(multiAuth.readOpenAIMultiAuthAccounts).mockResolvedValueOnce([
      {
        index: 0,
        accessToken: "first",
        sourceId: "first",
        planType: "Business",
        accountLabel: "private@example.invalid",
      },
      {
        index: 1,
        accessToken: "second",
        sourceId: "second",
        accountLabel: "private@example.invalid",
      },
      { index: 2, accessToken: "third", sourceId: "third", planType: "Plus" },
    ]);
    vi.mocked(openai.queryOpenAIQuotaForCredential)
      .mockResolvedValueOnce({
        success: true,
        label: "OpenAI",
        windows: { weekly: { percentRemaining: 60 } },
      })
      .mockResolvedValueOnce({
        success: true,
        label: "OpenAI (private@example.invalid)",
        windows: { weekly: { percentRemaining: 70 } },
      })
      .mockResolvedValueOnce({ success: false, error: "OpenAI API error 401" });
    const out = await openaiProvider.fetch({} as any);
    expect(out.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Account 1)",
      "OpenAI (Business)",
      "OpenAI (Account 2)",
    ]);
    expect(out.errors).toEqual([{ label: "OpenAI (Plus)", message: "OpenAI API error 401" }]);
    expect(JSON.stringify(out)).not.toContain("private@example.invalid");
    expect(JSON.stringify(out)).not.toContain("native@example.invalid");
  });

  it("is available when provider ids include openai/chatgpt/codex", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["chatgpt"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["codex"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["opencode"] })),
    ).resolves.toBe(false);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai"] })),
    ).resolves.toBe(false);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledTimes(2);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to native OpenCode auth when provider ids do not include an OpenAI alias", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValueOnce(true);

    const ctx = createProviderAvailabilityContext({ providerIds: ["zai"] });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to available when provider lookup throws", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).not.toHaveBeenCalled();
  });
});
