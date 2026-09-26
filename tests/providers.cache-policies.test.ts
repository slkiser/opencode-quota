import { beforeEach, describe, expect, it, vi } from "vitest";

const cachePolicyMocks = vi.hoisted(() => ({
  resolveGlobal: vi.fn(),
  resolveCn: vi.fn(),
  deriveIdentity: vi.fn(async (params: unknown) => JSON.stringify(params)),
  resolveZenAccount: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveKimiGlobalAuthCached: cachePolicyMocks.resolveGlobal,
  resolveKimiCnAuthCached: cachePolicyMocks.resolveCn,
  resolveKimiGlobalAuthWithDiagnosticsCached: vi.fn(),
  resolveKimiCnAuthWithDiagnosticsCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-zen-config.js", () => ({
  resolveOpenCodeZenAccountCached: cachePolicyMocks.resolveZenAccount,
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>();
  return {
    ...actual,
    deriveResolvedAuthIdentity: cachePolicyMocks.deriveIdentity,
  };
});

import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { getProviders } from "../src/providers/registry.js";

describe("provider cache policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cachePolicyMocks.resolveGlobal.mockResolvedValue({
      state: "configured",
      apiKey: "shared-kimi-secret",
      endpoint: "global",
    });
    cachePolicyMocks.resolveCn.mockResolvedValue({
      state: "configured",
      apiKey: "shared-kimi-secret",
      endpoint: "cn",
    });
  });

  it("classifies every canonical provider without an account-neutral fallback", () => {
    const registeredIds = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id).sort();
    expect(Object.keys(PROVIDER_CACHE_POLICIES).sort()).toEqual(registeredIds);
    expect(Object.values(PROVIDER_CACHE_POLICIES)).not.toContainEqual({
      kind: "account-neutral",
    });

    const uncached = Object.entries(PROVIDER_CACHE_POLICIES)
      .filter(([, policy]) => policy.kind === "uncached")
      .map(([id]) => id)
      .sort();
    expect(uncached).toEqual(["alibaba-token-plan", "cursor"]);

    expect(PROVIDER_CACHE_POLICIES["kimi-code-plan-global"].kind).toBe("resolved-auth");
    expect(PROVIDER_CACHE_POLICIES["kimi-code-plan-cn"].kind).toBe("resolved-auth");
    expect(PROVIDER_CACHE_POLICIES).not.toHaveProperty("kimi-for-coding");

    for (const id of ["anthropic", "copilot", "google-gemini-cli", "openrouter", "xai"] as const) {
      expect(PROVIDER_CACHE_POLICIES[id].kind).toBe("resolved-auth");
    }
  });

  it("keeps Kimi identities isolated through the actual regional policy resolvers", async () => {
    const globalPolicy = PROVIDER_CACHE_POLICIES["kimi-code-plan-global"];
    const cnPolicy = PROVIDER_CACHE_POLICIES["kimi-code-plan-cn"];
    if (globalPolicy.kind !== "resolved-auth" || cnPolicy.kind !== "resolved-auth") {
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
      qualifiers: ["global"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "kimi-code-plan-cn",
      principal: { kind: "credential", value: "shared-kimi-secret" },
      qualifiers: ["cn"],
    });

    cachePolicyMocks.resolveCn.mockResolvedValue({
      state: "configured",
      apiKey: "changed-cn-secret",
      endpoint: "cn",
    });

    const globalSecond = await globalPolicy.resolveIdentity(ctx, cacheContext);
    const cnSecond = await cnPolicy.resolveIdentity(ctx, cacheContext);

    expect(globalSecond).toBe(globalFirst);
    expect(cnSecond).not.toBe(cnFirst);
    expect(cachePolicyMocks.resolveGlobal).toHaveBeenCalledTimes(2);
    expect(cachePolicyMocks.resolveCn).toHaveBeenCalledTimes(2);
  });

  it("derives distinct OpenCode Zen identities for the same org on different Console URLs", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    cachePolicyMocks.resolveZenAccount.mockResolvedValue({
      state: "configured",
      account: {
        baseUrl: "https://opencode.ai/console",
        accessToken: "st_secret-token",
        activeOrgId: "wrk_shared",
      },
    });
    const cloudIdentity = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveZenAccount.mockResolvedValue({
      state: "configured",
      account: {
        baseUrl: "https://console.self-hosted.example",
        accessToken: "st_self-hosted-token",
        activeOrgId: "wrk_shared",
      },
    });
    const selfHostedIdentity = await policy.resolveIdentity(ctx, cacheContext);

    expect(cloudIdentity).not.toBeNull();
    expect(selfHostedIdentity).not.toBeNull();
    expect(cloudIdentity).not.toBe(selfHostedIdentity);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: "wrk_shared" },
      qualifiers: ["https://opencode.ai/console"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: "wrk_shared" },
      qualifiers: ["https://console.self-hosted.example"],
    });
  });

  it("returns no OpenCode Zen identity without a configured Console account", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveZenAccount.mockResolvedValue({ state: "expired", expiryMs: 0 });
    await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBeNull();
    expect(cachePolicyMocks.deriveIdentity).not.toHaveBeenCalled();
  });

  it("attaches the exhaustive policy to the stable provider singleton", async () => {
    const first = getProviders();
    const second = getProviders();
    expect(first.map(({ id }) => id)).toEqual(
      QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id),
    );

    first.forEach((provider, index) => {
      expect(second[index]).toBe(provider);
      expect(provider.cachePolicy).toBe(
        PROVIDER_CACHE_POLICIES[provider.id as keyof typeof PROVIDER_CACHE_POLICIES],
      );
    });
  });
});
