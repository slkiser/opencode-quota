import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  loadConfiguredOpenCodeConfig: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: authMocks.readAuthFileCached,
  readAuthFile: authMocks.readAuthFileCached,
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
}));

vi.mock("../src/lib/opencode-config-providers.js", () => ({
  loadConfiguredOpenCodeConfig: configMocks.loadConfiguredOpenCodeConfig,
}));

const realEnv = process.env;

describe("litellm lib", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    process.env = { ...realEnv };
    delete process.env.LITELLM_API_KEY;
    delete process.env.LITELLM_KEY;
    authMocks.readAuthFileCached.mockReset();
    authMocks.readAuthFileCached.mockResolvedValue({});
    configMocks.loadConfiguredOpenCodeConfig.mockReset();
    configMocks.loadConfiguredOpenCodeConfig.mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })) as any);
  });

  afterEach(() => {
    process.env = realEnv;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("resolveStaticApiKey", () => {
    it("returns LITELLM_API_KEY when set", async () => {
      process.env.LITELLM_API_KEY = "test-api-key";
      const { resolveStaticApiKey } = await import("../src/lib/litellm.js");
      expect(resolveStaticApiKey()).toBe("test-api-key");
    });

    it("returns LITELLM_KEY when set and LITELLM_API_KEY is not", async () => {
      process.env.LITELLM_KEY = "test-key";
      const { resolveStaticApiKey } = await import("../src/lib/litellm.js");
      expect(resolveStaticApiKey()).toBe("test-key");
    });

    it("prefers LITELLM_API_KEY over LITELLM_KEY", async () => {
      process.env.LITELLM_API_KEY = "api-key";
      process.env.LITELLM_KEY = "fallback-key";
      const { resolveStaticApiKey } = await import("../src/lib/litellm.js");
      expect(resolveStaticApiKey()).toBe("api-key");
    });

    it("returns null when neither env var is set", async () => {
      const { resolveStaticApiKey } = await import("../src/lib/litellm.js");
      expect(resolveStaticApiKey()).toBeNull();
    });

    it("ignores empty/whitespace values", async () => {
      process.env.LITELLM_API_KEY = "   ";
      const { resolveStaticApiKey } = await import("../src/lib/litellm.js");
      expect(resolveStaticApiKey()).toBeNull();
    });
  });

  describe("resolveToken", () => {
    it("prefers OAuth access token", async () => {
      const { resolveToken } = await import("../src/lib/litellm.js");
      const auth = { type: "oauth", access: "oauth-token", key: "api-key" };
      expect(resolveToken(auth, "env-key")).toBe("oauth-token");
    });

    it("falls back to API key from auth", async () => {
      const { resolveToken } = await import("../src/lib/litellm.js");
      const auth = { type: "oauth", key: "api-key" };
      expect(resolveToken(auth, "env-key")).toBe("api-key");
    });

    it("falls back to env var key when no auth tokens", async () => {
      const { resolveToken } = await import("../src/lib/litellm.js");
      const auth = { type: "oauth" };
      expect(resolveToken(auth, "env-key")).toBe("env-key");
    });

    it("returns null when no tokens available", async () => {
      const { resolveToken } = await import("../src/lib/litellm.js");
      expect(resolveToken({}, null)).toBeNull();
    });

    it("trims whitespace from tokens", async () => {
      const { resolveToken } = await import("../src/lib/litellm.js");
      const auth = { key: "  api-key  " };
      expect(resolveToken(auth, null)).toBe("api-key");
    });
  });

  describe("resolveBaseURL", () => {
    it("returns baseURL from config when available", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockResolvedValueOnce({
        provider: {
          litellm: {
            options: {
              baseURL: "https://ai-gateway.example.com/v1",
            },
          },
        },
      });

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("https://ai-gateway.example.com/v1");
    });

    it("returns default baseURL when config not available", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockResolvedValueOnce({});

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("http://localhost:4000");
    });

    it("returns default baseURL when config throws", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockRejectedValueOnce(new Error("Config not found"));

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("http://localhost:4000");
    });

    it("handles missing provider config gracefully", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockResolvedValueOnce({ provider: {} });

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("http://localhost:4000");
    });

    it("falls back to auth.json metadata.baseURL when config has no baseURL", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockResolvedValueOnce({});
      authMocks.readAuthFileCached.mockResolvedValueOnce({
        litellm: { type: "api", key: "test-key", metadata: { baseURL: "https://ai-gateway.example.com/v1" } },
      });

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("https://ai-gateway.example.com/v1");
    });

    it("prefers config baseURL over auth.json metadata.baseURL", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockResolvedValueOnce({
        provider: { litellm: { options: { baseURL: "https://config-gateway.example.com" } } },
      });
      authMocks.readAuthFileCached.mockResolvedValueOnce({
        litellm: { type: "api", key: "test-key", metadata: { baseURL: "https://auth-gateway.example.com" } },
      });

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("https://config-gateway.example.com");
    });

    it("returns default baseURL when neither config nor auth has baseURL", async () => {
      configMocks.loadConfiguredOpenCodeConfig.mockResolvedValueOnce({});
      authMocks.readAuthFileCached.mockResolvedValueOnce({
        litellm: { type: "api", key: "test-key" },
      });

      const { resolveBaseURL } = await import("../src/lib/litellm.js");
      const url = await resolveBaseURL();
      expect(url).toBe("http://localhost:4000");
    });
  });

  describe("buildURL", () => {
    it("builds URL without params", async () => {
      const { buildURL } = await import("../src/lib/litellm.js");
      const url = buildURL("http://localhost:4000", "/v2/user/info");
      expect(url).toBe("http://localhost:4000/v2/user/info");
    });

    it("builds URL with params", async () => {
      const { buildURL } = await import("../src/lib/litellm.js");
      const url = buildURL("http://localhost:4000", "/user/daily/activity", {
        start_date: "2026-01-15",
        page_size: "100",
      });
      expect(url).toContain("/user/daily/activity?");
      expect(url).toContain("start_date=2026-01-15");
      expect(url).toContain("page_size=100");
    });

    it("handles trailing slashes in baseURL", async () => {
      const { buildURL } = await import("../src/lib/litellm.js");
      const url = buildURL("http://localhost:4000///", "/path");
      expect(url).toBe("http://localhost:4000/path");
    });
  });

  describe("todayDateString", () => {
    it("returns ISO date string", async () => {
      const { todayDateString } = await import("../src/lib/litellm.js");
      expect(todayDateString()).toBe("2026-01-15");
    });
  });

  describe("fetchUserInfo", () => {
    it("fetches user info with proper headers", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            user_id: "user-123",
            spend: 100.0,
            max_budget: 500.0,
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as any);

      const { fetchUserInfo } = await import("../src/lib/litellm.js");
      const result = await fetchUserInfo("test-token", "http://localhost:4000");

      expect(result).toEqual({
        user_id: "user-123",
        spend: 100.0,
        max_budget: 500.0,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/v2/user/info"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });

    it("returns null on API error", async () => {
      const fetchMock = vi.fn(async () =>
        new Response("Internal Server Error", { status: 500 }),
      );
      vi.stubGlobal("fetch", fetchMock as any);

      const { fetchUserInfo } = await import("../src/lib/litellm.js");
      const result = await fetchUserInfo("test-token", "http://localhost:4000");

      expect(result).toBeNull();
    });

    it("returns null on network error", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("Network error");
      });
      vi.stubGlobal("fetch", fetchMock as any);

      const { fetchUserInfo } = await import("../src/lib/litellm.js");
      const result = await fetchUserInfo("test-token", "http://localhost:4000");

      expect(result).toBeNull();
    });
  });

  describe("fetchTodayActivity", () => {
    it("fetches daily activity for today", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                date: "2026-01-15",
                metrics: {
                  spend: 5.0,
                  successful_requests: 10,
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as any);

      const { fetchTodayActivity } = await import("../src/lib/litellm.js");
      const result = await fetchTodayActivity("test-token", "http://localhost:4000");

      expect(result).toEqual({
        date: "2026-01-15",
        metrics: {
          spend: 5.0,
          successful_requests: 10,
        },
      });

      const firstCall = fetchMock.mock.calls.at(0);
      expect(firstCall).toBeDefined();
      const url = new URL(String((firstCall as unknown[])[0]));
      expect(url.searchParams.get("start_date")).toBe("2026-01-15");
      expect(url.searchParams.get("end_date")).toBe("2026-01-15");
    });

    it("returns null when no results", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock as any);

      const { fetchTodayActivity } = await import("../src/lib/litellm.js");
      const result = await fetchTodayActivity("test-token", "http://localhost:4000");

      expect(result).toBeNull();
    });
  });

  describe("topModelBySpend", () => {
    it("returns model with highest spend", async () => {
      const { topModelBySpend } = await import("../src/lib/litellm.js");
      const models = {
        "model-a": { metrics: { spend: 1.0 } },
        "model-b": { metrics: { spend: 5.0 } },
        "model-c": { metrics: { spend: 2.0 } },
      };
      expect(topModelBySpend(models)).toBe("model-b");
    });

    it("returns null for empty models", async () => {
      const { topModelBySpend } = await import("../src/lib/litellm.js");
      expect(topModelBySpend({})).toBeNull();
    });

    it("returns null for undefined", async () => {
      const { topModelBySpend } = await import("../src/lib/litellm.js");
      expect(topModelBySpend(undefined)).toBeNull();
    });

    it("handles zero spend models", async () => {
      const { topModelBySpend } = await import("../src/lib/litellm.js");
      const models = {
        "model-a": { metrics: { spend: 0 } },
        "model-b": { metrics: { spend: 0 } },
      };
      const result = topModelBySpend(models);
      expect(["model-a", "model-b"]).toContain(result);
    });
  });

  describe("queryLiteLLM", () => {
    it("returns user info and daily activity", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/v2/user/info")) {
          return new Response(
            JSON.stringify({ user_id: "user-123", spend: 100.0 }),
            { status: 200 },
          );
        }
        if (url.includes("/user/daily/activity")) {
          return new Response(
            JSON.stringify({
              results: [{ date: "2026-01-15", metrics: { spend: 5.0 } }],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock as any);

      const { queryLiteLLM } = await import("../src/lib/litellm.js");
      const result = await queryLiteLLM("test-token", "http://localhost:4000");

      expect(result).toEqual({
        success: true,
        spend: 100.0,
        today: {
          date: "2026-01-15",
          metrics: { spend: 5.0 },
        },
      });
    });

    it("returns null when user info fails", async () => {
      const fetchMock = vi.fn(async () =>
        new Response("Error", { status: 500 }),
      );
      vi.stubGlobal("fetch", fetchMock as any);

      const { queryLiteLLM } = await import("../src/lib/litellm.js");
      const result = await queryLiteLLM("test-token", "http://localhost:4000");

      expect(result).toBeNull();
    });

    it("works without daily activity", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/v2/user/info")) {
          return new Response(
            JSON.stringify({ user_id: "user-123", spend: 100.0 }),
            { status: 200 },
          );
        }
        if (url.includes("/user/daily/activity")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock as any);

      const { queryLiteLLM } = await import("../src/lib/litellm.js");
      const result = await queryLiteLLM("test-token", "http://localhost:4000");

      expect(result).toEqual({
        success: true,
        spend: 100.0,
      });
    });
  });

  describe("hasLiteLLMAuthAvailable", () => {
    it("returns true when OAuth token exists", async () => {
      authMocks.readAuthFileCached.mockResolvedValueOnce({
        litellm: { type: "oauth", access: "oauth-123" },
      });

      const { hasLiteLLMAuthAvailable } = await import("../src/lib/litellm.js");
      const result = await hasLiteLLMAuthAvailable();

      expect(result).toBe(true);
    });

    it("returns true when API key exists in auth", async () => {
      authMocks.readAuthFileCached.mockResolvedValueOnce({
        litellm: { key: "api-key" },
      });

      const { hasLiteLLMAuthAvailable } = await import("../src/lib/litellm.js");
      const result = await hasLiteLLMAuthAvailable();

      expect(result).toBe(true);
    });

    it("returns true when env var is set", async () => {
      process.env.LITELLM_API_KEY = "env-key";
      authMocks.readAuthFileCached.mockResolvedValueOnce({});

      const { hasLiteLLMAuthAvailable } = await import("../src/lib/litellm.js");
      const result = await hasLiteLLMAuthAvailable();

      expect(result).toBe(true);
    });

    it("returns false when no auth available", async () => {
      authMocks.readAuthFileCached.mockResolvedValueOnce({});

      const { hasLiteLLMAuthAvailable } = await import("../src/lib/litellm.js");
      const result = await hasLiteLLMAuthAvailable();

      expect(result).toBe(false);
    });
  });
});
