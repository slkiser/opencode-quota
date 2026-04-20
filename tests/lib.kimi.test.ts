import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  resolveKimiAuthCached: vi.fn(),
}));

const fetchMocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  resolveKimiAuthCached: authMocks.resolveKimiAuthCached,
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: fetchMocks.fetchWithTimeout,
}));

import { queryKimiQuota } from "../src/lib/kimi.js";

function mockKimiAuthConfigured(apiKey = "test-key") {
  authMocks.resolveKimiAuthCached.mockResolvedValueOnce({ state: "configured", apiKey });
}

function mockKimiHttpSuccess(payload: unknown) {
  fetchMocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: true,
    json: async () => payload,
  });
}

function mockKimiHttpFailure(status: number, text: string) {
  fetchMocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => text,
  });
}

describe("queryKimiQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveKimiAuthCached.mockResolvedValue({ state: "configured", apiKey: "test-key" });
  });

  it("returns null when auth is none", async () => {
    authMocks.resolveKimiAuthCached.mockResolvedValueOnce({ state: "none" });
    const result = await queryKimiQuota();
    expect(result).toBeNull();
  });

  it("returns error when auth is invalid", async () => {
    authMocks.resolveKimiAuthCached.mockResolvedValueOnce({ state: "invalid", error: "bad auth" });
    const result = await queryKimiQuota();
    expect(result).toEqual({ success: false, error: "bad auth" });
  });

  it("parses string numbers from real API shape", async () => {
    mockKimiAuthConfigured();
    mockKimiHttpSuccess({
      usage: {
        limit: "100",
        used: "45",
        remaining: "55",
        resetTime: "2026-04-16T15:36:21.718434Z",
      },
      limits: [
        {
          window: {
            duration: 300,
            timeUnit: "TIME_UNIT_MINUTE",
          },
          detail: {
            limit: "100",
            used: "22",
            remaining: "78",
            resetTime: "2026-04-16T16:36:21.718434Z",
          },
        },
      ],
      parallel: {
        limit: "20",
      },
    });

    const result = await queryKimiQuota();

    expect(result).toMatchObject({
      success: true,
      label: "Kimi Code",
      windows: [
        {
          label: "Weekly limit",
          used: 45,
          limit: 100,
          percentRemaining: 55,
          resetTimeIso: "2026-04-16T15:36:21.718Z",
        },
        {
          label: "5h limit",
          used: 22,
          limit: 100,
          percentRemaining: 78,
          resetTimeIso: "2026-04-16T16:36:21.718Z",
        },
      ],
    });
  });

  it("computes used from remaining when used is absent", async () => {
    mockKimiAuthConfigured();
    mockKimiHttpSuccess({
      usage: {
        limit: "100",
        remaining: "30",
      },
    });

    const result = await queryKimiQuota();

    expect(result).toMatchObject({
      success: true,
      windows: [
        {
          label: "Weekly limit",
          used: 70,
          limit: 100,
          percentRemaining: 30,
        },
      ],
    });
  });

  it("returns error when endpoint fails", async () => {
    mockKimiAuthConfigured();
    mockKimiHttpFailure(401, "Unauthorized");

    const result = await queryKimiQuota();

    expect(result).toEqual({
      success: false,
      error: "Kimi API error 401: Unauthorized",
    });
  });

  it("returns error with unexpected response keys when endpoint has no usable data", async () => {
    mockKimiAuthConfigured();
    mockKimiHttpSuccess({ message: "hello", code: 0 });

    const result = await queryKimiQuota();

    expect(result).toMatchObject({
      success: false,
      error: "Unexpected response structure (keys: message, code)",
    });
  });

  it("returns API error on non-200 with sanitized text", async () => {
    mockKimiAuthConfigured();
    mockKimiHttpFailure(403, "Forbidden access");

    const result = await queryKimiQuota();

    expect(result).toMatchObject({
      success: false,
      error: "Kimi API error 403: Forbidden access",
    });
  });

  it("sanitizes thrown errors", async () => {
    mockKimiAuthConfigured();
    fetchMocks.fetchWithTimeout.mockRejectedValue(new Error("network error"));

    const result = await queryKimiQuota();

    expect(result).toEqual({
      success: false,
      error: "network error",
    });
  });
});
