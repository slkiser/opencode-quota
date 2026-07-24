import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasOpenRouterApiKeyConfigured,
  queryOpenRouterQuota,
  resolveOpenRouterApiKey,
} from "../src/lib/openrouter.js";
import {
  fetchRemoteQuotaProvider,
  resolveQuotaProviderApiKey,
} from "../src/lib/quota-providers-remote.js";

vi.mock("../src/lib/quota-providers-remote.js", () => ({
  fetchRemoteQuotaProvider: vi.fn(),
  resolveQuotaProviderApiKey: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter quota", () => {
  it("uses the standard OpenRouter credential sources and key endpoint", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValueOnce({
      key: "secret",
      source: "auth.json",
      checkedPaths: [],
      authPaths: [],
    });
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValueOnce({
      success: true,
      entries: [],
    });

    await queryOpenRouterQuota({ requestTimeoutMs: 1234 });

    expect(resolveQuotaProviderApiKey).toHaveBeenCalledWith({
      id: "openrouter",
      providerId: "openrouter",
      label: "OpenRouter",
      mode: "remote-api",
      url: "https://openrouter.ai/api/v1/key",
      apiKeyEnv: "OPENROUTER_API_KEY",
      format: "openrouter-key-v1",
    });
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openrouter",
        url: "https://openrouter.ai/api/v1/key",
        format: "openrouter-key-v1",
      }),
      "secret",
      1234,
    );
  });

  it("does not make a request when no trusted key exists", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue({
      source: null,
      checkedPaths: [],
      authPaths: [],
    });

    await expect(queryOpenRouterQuota()).resolves.toBeNull();
    await expect(hasOpenRouterApiKeyConfigured()).resolves.toBe(false);
    await expect(resolveOpenRouterApiKey()).resolves.toEqual({
      source: null,
      checkedPaths: [],
      authPaths: [],
    });
    expect(fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("marks reused OpenRouter mapping entries as maintained", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue({
      key: "secret",
      source: "env",
      checkedPaths: [],
      authPaths: [],
    });
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          name: "OpenRouter budget",
          percentRemaining: 80,
        },
      ],
    });

    await expect(queryOpenRouterQuota()).resolves.toEqual({
      success: true,
      entries: [
        expect.objectContaining({
          accounting: expect.objectContaining({ ownership: "maintained" }),
        }),
      ],
    });
  });

  it("returns safe remote errors unchanged", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue({
      key: "SUPER_SECRET",
      source: "env",
      checkedPaths: [],
      authPaths: [],
    });
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({
      success: false,
      error: "HTTP 401",
    });

    const result = await queryOpenRouterQuota();
    expect(result).toEqual({ success: false, error: "HTTP 401" });
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET");
  });
});
