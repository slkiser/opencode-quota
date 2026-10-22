import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const cachePolicyMocks = vi.hoisted(() => ({
  deriveIdentity: vi.fn(async (params: unknown) => JSON.stringify(params)),
  resolveConsoleAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuth: cachePolicyMocks.resolveConsoleAuth,
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>();
  return {
    ...actual,
    deriveResolvedAuthIdentity: cachePolicyMocks.deriveIdentity,
  };
});

import type { QuotaProviderCachePolicy } from "../src/lib/entries.js";
import { composeResolvedAuthIdentities } from "../src/lib/resolved-auth-identity.js";
import { getProviders } from "../src/providers/registry.js";

const PROVIDER_CACHE_POLICIES: Readonly<Record<string, QuotaProviderCachePolicy>> =
  Object.fromEntries(getProviders().map((provider) => [provider.id, provider.cachePolicy]));

describe("provider cache policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("classifies every provider without an account-neutral fallback", () => {
    expect(Object.values(PROVIDER_CACHE_POLICIES)).not.toContainEqual({
      kind: "account-neutral",
    });

    expect(PROVIDER_CACHE_POLICIES["alibaba-token-plan"]?.kind).toBe("resolved-auth");
    expect(PROVIDER_CACHE_POLICIES["alibaba-coding-plan"]?.kind).toBe("resolved-auth");

    const uncached = Object.entries(PROVIDER_CACHE_POLICIES)
      .filter(([, policy]) => policy.kind === "uncached")
      .map(([id]) => id)
      .sort();
    expect(uncached).toEqual(["cursor"]);
  });

  it("keeps Kimi identities isolated through the actual regional policy resolvers", async () => {
    // An env key is found before any file is read.
    vi.stubEnv("KIMI_GLOBAL_API_KEY", "shared-kimi-secret");
    vi.stubEnv("KIMI_CN_API_KEY", "shared-kimi-secret");
    const globalPolicy = PROVIDER_CACHE_POLICIES["kimi-code-plan-global"];
    const cnPolicy = PROVIDER_CACHE_POLICIES["kimi-code-plan-cn"];
    if (globalPolicy?.kind !== "resolved-auth" || cnPolicy?.kind !== "resolved-auth") {
      throw new Error("Expected resolved-auth Kimi cache policies");
    }

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    const globalFirst = await globalPolicy.resolveIdentity(ctx, cacheContext);
    const cnFirst = await cnPolicy.resolveIdentity(ctx, cacheContext);

    expect(globalFirst).not.toBe(cnFirst);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "kimi-code-plan-global",
      principal: { kind: "credential", value: "shared-kimi-secret" },
      qualifiers: ["global", "env:KIMI_GLOBAL_API_KEY"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "kimi-code-plan-cn",
      principal: { kind: "credential", value: "shared-kimi-secret" },
      qualifiers: ["cn", "env:KIMI_CN_API_KEY"],
    });

    vi.stubEnv("KIMI_CN_API_KEY", "changed-cn-secret");

    const globalSecond = await globalPolicy.resolveIdentity(ctx, cacheContext);
    const cnSecond = await cnPolicy.resolveIdentity(ctx, cacheContext);

    expect(globalSecond).toBe(globalFirst);
    expect(cnSecond).not.toBe(cnFirst);
  });

  it("derives distinct OpenCode Zen identities for the same org on different Console URLs", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: { accessToken: "st_secret-token", orgId: "wrk_shared", accountId: "acc_1" },
    });
    const cloudIdentity = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: {
        accessToken: "st_self-hosted-token",
        orgId: "wrk_shared",
        accountId: "acc_1",
        server: "https://console.self-hosted.example",
      },
    });
    const selfHostedIdentity = await policy.resolveIdentity(ctx, cacheContext);

    expect(cloudIdentity).not.toBeNull();
    expect(selfHostedIdentity).not.toBeNull();
    expect(cloudIdentity).not.toBe(selfHostedIdentity);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_1"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_1"]) },
      qualifiers: ["https://console.self-hosted.example"],
    });
  });

  it("derives distinct OpenCode Zen identities for two accounts in the same org", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: { accessToken: "st_secret-token-1", orgId: "wrk_shared", accountId: "acc_a" },
    });
    const identityA = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: { accessToken: "st_secret-token-2", orgId: "wrk_shared", accountId: "acc_b" },
    });
    const identityB = await policy.resolveIdentity(ctx, cacheContext);

    expect(identityA).not.toBeNull();
    expect(identityB).not.toBeNull();
    expect(identityA).not.toBe(identityB);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_a"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_b"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
  });

  it.each([
    [
      { accessToken: "st_secret-token", accountId: "acc_1" },
      { kind: "stable-id", value: "acc_1" },
    ],
    [{ accessToken: "st_secret-token" }, { kind: "credential", value: "st_secret-token" }],
  ])(
    "uses the account, then the token, when the Console sign-in has no org (%j)",
    async (credential, principal) => {
      const policy = PROVIDER_CACHE_POLICIES.opencode;
      if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

      cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({ state: "configured", credential });
      await policy.resolveIdentity({ config: {} } as never, {} as never);

      expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
        providerId: "opencode",
        principal,
        qualifiers: ["https://opencode.ai/console"],
      });
    },
  );

  it.each([
    { state: "none" },
    { state: "expired", credential: { accessToken: "st_secret-token", orgId: "wrk_shared" } },
    { state: "invalid", error: "refresh_failed: boom" },
  ])(
    "returns no OpenCode Zen identity without a configured Console sign-in (%j)",
    async (resolution) => {
      const policy = PROVIDER_CACHE_POLICIES.opencode;
      if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

      cachePolicyMocks.resolveConsoleAuth.mockResolvedValue(resolution);
      await expect(
        policy.resolveIdentity({ config: {} } as never, {} as never),
      ).resolves.toBeNull();
      expect(cachePolicyMocks.deriveIdentity).not.toHaveBeenCalled();
    },
  );

  it.each([
    { state: "none" },
    { state: "expired", credential: { accessToken: "st_secret-token", orgId: "wrk_shared" } },
  ])(
    "keeps OpenCode Go's key identity without a usable Console sign-in (%j)",
    async (resolution) => {
      const policy = PROVIDER_CACHE_POLICIES["opencode-go"];
      if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");
      vi.stubEnv("OPENCODE_API_KEY", "go-key");
      cachePolicyMocks.resolveConsoleAuth.mockResolvedValue(resolution);

      await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBe(
        JSON.stringify({
          providerId: "opencode-go",
          principal: { kind: "credential", value: "go-key" },
          qualifiers: ["env:OPENCODE_API_KEY"],
        }),
      );
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "gives OpenCode Go one identity per Console account, stable for the same account",
    async () => {
      const policy = PROVIDER_CACHE_POLICIES["opencode-go"];
      if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");
      vi.stubEnv("OPENCODE_API_KEY", "go-key");
      const identityOf = async (accountId: string, accessToken: string) => {
        cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
          state: "configured",
          credential: { accessToken, orgId: "wrk_shared", accountId },
        });
        return await policy.resolveIdentity({ config: {} } as never, {} as never);
      };

      const first = await identityOf("acc_a", "token-1");
      const refreshed = await identityOf("acc_a", "token-2");
      const other = await identityOf("acc_b", "token-3");

      expect(first).not.toBeNull();
      expect(refreshed).toBe(first);
      expect(other).not.toBe(first);
      // The Console login and the key, composed in that order: the saved rows' identity.
      expect(other).toBe(
        await composeResolvedAuthIdentities({
          providerId: "opencode-go",
          identities: [
            JSON.stringify({
              providerId: "opencode-go",
              principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_b"]) },
              qualifiers: ["https://opencode.ai/console"],
            }),
            JSON.stringify({
              providerId: "opencode-go",
              principal: { kind: "credential", value: "go-key" },
              qualifiers: ["env:OPENCODE_API_KEY"],
            }),
          ] as never,
        }),
      );
    },
  );
});
