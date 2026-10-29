import { describe, expect, it, vi } from "vite-plus/test";

import { hasNativeProviderQuotaClient } from "../src/lib/tui-native-provider-quota.js";

describe("hasNativeProviderQuotaClient", () => {
  it("detects supported experimental provider quota shapes without invoking them", () => {
    const providerQuota = vi.fn();
    const provider_quota = vi.fn();
    const quota = vi.fn();

    expect(hasNativeProviderQuotaClient({ experimental: { providerQuota } })).toBe(true);
    expect(hasNativeProviderQuotaClient({ experimental: { provider_quota } })).toBe(true);
    expect(hasNativeProviderQuotaClient({ experimental: { provider: { quota } } })).toBe(true);

    expect(providerQuota).not.toHaveBeenCalled();
    expect(provider_quota).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
  });

  it("returns false for missing or unrelated client shapes", () => {
    expect(hasNativeProviderQuotaClient(undefined)).toBe(false);
    expect(hasNativeProviderQuotaClient(null)).toBe(false);
    expect(hasNativeProviderQuotaClient({})).toBe(false);
    expect(hasNativeProviderQuotaClient({ experimental: null })).toBe(false);
    expect(hasNativeProviderQuotaClient({ experimental: { providerQuota: undefined } })).toBe(
      false,
    );
    expect(hasNativeProviderQuotaClient({ experimental: { provider_quota: null } })).toBe(false);
    expect(hasNativeProviderQuotaClient({ experimental: { provider: {} } })).toBe(false);
    expect(hasNativeProviderQuotaClient({ experimental: { provider: { quota: undefined } } })).toBe(
      false,
    );
    expect(hasNativeProviderQuotaClient({ providerQuota: vi.fn() })).toBe(false);
  });

  it("ignores falsey primitive feature-flag sentinels", () => {
    expect(hasNativeProviderQuotaClient({ experimental: { providerQuota: false } })).toBe(false);
    expect(hasNativeProviderQuotaClient({ experimental: { provider_quota: 0 } })).toBe(false);
    expect(hasNativeProviderQuotaClient({ experimental: { provider: { quota: "" } } })).toBe(false);
  });
});
