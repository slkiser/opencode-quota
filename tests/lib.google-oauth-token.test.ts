import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const cache = vi.hoisted(() => ({
  getCachedAccessToken: vi.fn(),
  makeAccountCacheKey: vi.fn(() => "account-key"),
  setCachedAccessToken: vi.fn(),
}));
vi.mock("../src/lib/google-token-cache.js", () => cache);

import { getGoogleAccessToken } from "../src/lib/google-oauth-token.js";

const now = 1_800_000_000_000;
const account = { refreshToken: "refresh-token", projectId: "project" };
const credentials = { clientId: "client-id", clientSecret: "client-secret" };
const fetchMock = vi.fn<typeof fetch>();

describe("shared Google OAuth tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockReset()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "refreshed", expires_in: 3600 })),
      );
    cache.getCachedAccessToken.mockReset().mockResolvedValue(null);
    cache.setCachedAccessToken.mockReset().mockResolvedValue();
  });

  it("prefers the process cache over a valid account token", async () => {
    cache.getCachedAccessToken.mockResolvedValue({ accessToken: "cached" });
    await expect(
      getGoogleAccessToken({
        account: { ...account, accessToken: "account-token", expiresAt: now + 3_600_000 },
        credentials,
      }),
    ).resolves.toEqual({ accessToken: "cached" });
    expect(cache.makeAccountCacheKey).toHaveBeenCalledWith(account);
    expect(cache.getCachedAccessToken).toHaveBeenCalledWith({
      key: "account-key",
      skewMs: 120_000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([119_999, 120_000, 120_001])("checks account expiry at %i ms", async (remainingMs) => {
    const valid = remainingMs > 120_000;
    await expect(
      getGoogleAccessToken({
        account: { ...account, accessToken: "account-token", expiresAt: now + remainingMs },
        credentials,
      }),
    ).resolves.toEqual({ accessToken: valid ? "account-token" : "refreshed" });
    expect(fetchMock).toHaveBeenCalledTimes(valid ? 0 : 1);
  });

  it("forces a refresh past both cached tokens and stores the minimum one-second lifetime", async () => {
    cache.getCachedAccessToken.mockResolvedValue({ accessToken: "cached" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 0 })),
    );
    await expect(
      getGoogleAccessToken({
        account: { ...account, accessToken: "account-token", expiresAt: now + 3_600_000 },
        credentials,
        force: true,
      }),
    ).resolves.toEqual({ accessToken: "fresh" });
    expect(cache.getCachedAccessToken).not.toHaveBeenCalled();
    const request = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(request?.body as URLSearchParams)).toEqual({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    });
    expect(cache.setCachedAccessToken).toHaveBeenCalledWith({
      key: "account-key",
      entry: { accessToken: "fresh", expiresAt: now + 1000 },
    });
  });

  it.each([
    ['{"error":"invalid_grant","error_description":"ignored"}', 400, "Token revoked"],
    ['{"error_description":"Client rejected"}', 403, "Client rejected"],
    ["{}", 503, "HTTP 503"],
    ["not JSON", 502, "HTTP 502"],
    ["not JSON", 200, "Token refresh failed"],
  ])("maps refresh response %s (%i)", async (body, status, error) => {
    fetchMock.mockResolvedValue(new Response(body, { status }));
    await expect(getGoogleAccessToken({ account, credentials })).resolves.toEqual({ error });
    expect(cache.setCachedAccessToken).not.toHaveBeenCalled();
  });

  it.each([undefined, 25])("times out body reads with timeout %s", async (timeoutMs) => {
    fetchMock.mockResolvedValue({ ok: false, json: () => new Promise(() => {}) } as Response);
    const result = getGoogleAccessToken({ account, credentials, timeoutMs });
    await vi.advanceTimersByTimeAsync(timeoutMs ?? 8000);
    await expect(result).resolves.toEqual({ error: "Token refresh timeout" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cache.setCachedAccessToken).not.toHaveBeenCalled();
  });

  it("maps network errors without caching a token", async () => {
    fetchMock.mockRejectedValue(new Error("Network unavailable"));
    await expect(getGoogleAccessToken({ account, credentials })).resolves.toEqual({
      error: "Token refresh failed",
    });
    expect(cache.setCachedAccessToken).not.toHaveBeenCalled();
  });
});
