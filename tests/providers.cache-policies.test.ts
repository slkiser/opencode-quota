import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext } from "../src/lib/entries.js";

const mocks = vi.hoisted(() => ({
  composeResolvedAuthIdentities: vi.fn(),
  hasOpenAIOAuthCached: vi.fn(),
  resolveOpenAIAuthIdentity: vi.fn(),
  resolveOpenAIMultiAuthIdentity: vi.fn(),
}));

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasOpenAIOAuthCached: mocks.hasOpenAIOAuthCached,
  resolveOpenAIAuthIdentity: mocks.resolveOpenAIAuthIdentity,
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" })),
  queryOpenAIQuota: vi.fn(),
  queryOpenAIQuotaForCredential: vi.fn(),
}));

vi.mock("../src/lib/openai-multi-auth.js", () => ({
  hasOpenAIMultiAuthAccountsConfigured: vi.fn(),
  readOpenAIMultiAuthAccounts: vi.fn(),
  inspectOpenAIMultiAuthPresence: vi.fn(),
  resolveOpenAIMultiAuthIdentity: mocks.resolveOpenAIMultiAuthIdentity,
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  composeResolvedAuthIdentities: mocks.composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity: vi.fn(),
}));

const TEST_CONTEXT = {} as QuotaProviderContext;

import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { getProviders } from "../src/providers/registry.js";

describe("provider cache policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOpenAIAuthIdentity.mockResolvedValue(null);
    mocks.hasOpenAIOAuthCached.mockResolvedValue(false);
    mocks.resolveOpenAIMultiAuthIdentity.mockResolvedValue({ state: "inactive" });
    mocks.composeResolvedAuthIdentities.mockImplementation(
      async ({ identities }: { identities: readonly string[] }) =>
        `composed:${identities.join("|")}`,
    );
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
    expect(uncached).toEqual(["cursor", "qwen-code"]);

    for (const id of [
      "anthropic",
      "copilot",
      "google-antigravity",
      "google-gemini-cli",
      "openrouter",
      "xai",
    ] as const) {
      expect(PROVIDER_CACHE_POLICIES[id].kind).toBe("resolved-auth");
    }
  });

  it("attaches the exhaustive policy to the stable provider singleton", () => {
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

  it("preserves the native resolver exactly when the multi-auth pool is inactive", async () => {
    const nativeIdentity = "native-identity";
    mocks.resolveOpenAIAuthIdentity.mockResolvedValue(nativeIdentity);

    await expect(PROVIDER_CACHE_POLICIES.openai.resolveIdentity(TEST_CONTEXT, {})).resolves.toBe(
      nativeIdentity,
    );
    expect(mocks.resolveOpenAIAuthIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.hasOpenAIOAuthCached).not.toHaveBeenCalled();
  });

  it("uses the active multi-auth identity when native auth is absent", async () => {
    const multiIdentity = "multi-identity";
    mocks.resolveOpenAIMultiAuthIdentity.mockResolvedValue({
      state: "active",
      identity: multiIdentity,
    });

    await expect(PROVIDER_CACHE_POLICIES.openai.resolveIdentity(TEST_CONTEXT, {})).resolves.toBe(
      multiIdentity,
    );
    expect(mocks.hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("composes native and multi-auth identities in sorted order", async () => {
    mocks.resolveOpenAIAuthIdentity.mockResolvedValue("native-identity");
    mocks.resolveOpenAIMultiAuthIdentity.mockResolvedValue({
      state: "active",
      identity: "multi-identity",
    });

    await expect(PROVIDER_CACHE_POLICIES.openai.resolveIdentity(TEST_CONTEXT, {})).resolves.toBe(
      "composed:multi-identity|native-identity",
    );
    expect(mocks.composeResolvedAuthIdentities).toHaveBeenCalledWith({
      providerId: "openai",
      identities: ["multi-identity", "native-identity"],
    });
  });

  it("fails closed when native auth is configured but its identity cannot be protected", async () => {
    mocks.resolveOpenAIMultiAuthIdentity.mockResolvedValue({
      state: "active",
      identity: "multi-identity",
    });
    mocks.hasOpenAIOAuthCached.mockResolvedValue(true);

    await expect(
      PROVIDER_CACHE_POLICIES.openai.resolveIdentity(TEST_CONTEXT, {}),
    ).resolves.toBeNull();
  });

  it("fails closed when active multi-auth identity resolution is incomplete", async () => {
    mocks.resolveOpenAIMultiAuthIdentity.mockResolvedValue({ state: "active", identity: null });
    mocks.resolveOpenAIAuthIdentity.mockResolvedValue("native-identity");

    await expect(
      PROVIDER_CACHE_POLICIES.openai.resolveIdentity(TEST_CONTEXT, {}),
    ).resolves.toBeNull();
    expect(mocks.resolveOpenAIAuthIdentity).not.toHaveBeenCalled();
  });

  it("does not publish an incomplete composed identity", async () => {
    mocks.resolveOpenAIAuthIdentity.mockResolvedValue("native-identity");
    mocks.resolveOpenAIMultiAuthIdentity.mockResolvedValue({
      state: "active",
      identity: "multi-identity",
    });
    mocks.composeResolvedAuthIdentities.mockResolvedValue(null);

    await expect(
      PROVIDER_CACHE_POLICIES.openai.resolveIdentity(TEST_CONTEXT, {}),
    ).resolves.toBeNull();
  });
});
