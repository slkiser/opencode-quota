import { describe, expect, it } from "vitest";

import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { getProviders } from "../src/providers/registry.js";

describe("provider cache policies", () => {
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
});
