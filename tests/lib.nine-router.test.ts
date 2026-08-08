import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchNineRouterAccounts,
  fetchNineRouterUsage,
  NINE_ROUTER_MAX_BODY_BYTES,
  resolveNineRouterConfig,
} from "../src/lib/nine-router.js";

const ROOT = "https://router.example/management/";
const KEY = "test-9router-key";
const ID = "A0B1C2D3-E4F5-4A6B-8C9D-0E1F2A3B4C5D";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { OPENCODE_NINEROUTER_URL: ROOT, OPENCODE_NINEROUTER_API_KEY: KEY, ...overrides };
}

function account(id = ID, provider = "codex"): Record<string, unknown> {
  return {
    id,
    provider,
    name: "Codex account",
    displayName: "Codex account",
    email: "person@example.test",
    isActive: true,
  };
}

function listing(
  connections: readonly Record<string, unknown>[],
  pagination: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connections,
    pagination: {
      page: 1,
      pageSize: 500,
      total: connections.length,
      totalPages: 1,
      ...pagination,
    },
  };
}

function configured() {
  const config = resolveNineRouterConfig(env());
  if (!config.success) throw new Error("valid fixture configuration required");
  return config;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("nineRouter management client", () => {
  it("normalizes secure roots and never exposes the API key", () => {
    const result = resolveNineRouterConfig(env());
    expect(result).toEqual({ success: true, root: "https://router.example/management" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([
    ["missing root", env({ OPENCODE_NINEROUTER_URL: undefined })],
    ["missing key", env({ OPENCODE_NINEROUTER_API_KEY: undefined })],
    ["credentials", env({ OPENCODE_NINEROUTER_URL: "https://user:pass@router.example" })],
    ["query", env({ OPENCODE_NINEROUTER_URL: "https://router.example/?key=private" })],
    ["fragment", env({ OPENCODE_NINEROUTER_URL: "https://router.example/#private" })],
    ["API endpoint", env({ OPENCODE_NINEROUTER_URL: "https://router.example/v1" })],
    ["remote HTTP", env({ OPENCODE_NINEROUTER_URL: "http://router.example" })],
  ])("rejects %s without leaking configuration", (_name, input) => {
    const result = resolveNineRouterConfig(input);
    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("router.example");
  });

  it.each([
    "http://localhost:20128",
    "http://127.0.0.1:20128",
    "http://[::1]:20128",
  ])("accepts loopback HTTP root %s", (root) =>
    expect(resolveNineRouterConfig(env({ OPENCODE_NINEROUTER_URL: root }))).toEqual({
      success: true,
      root,
    }));

  it("requests the encoded account list with Bearer authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(listing([account()])));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNineRouterAccounts(configured(), "codex")).resolves.toMatchObject({
      success: true,
      accounts: [{ id: ID, provider: "codex" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://router.example/management/api/providers/client?provider=codex&accountStatus=active&page=1&pageSize=500&sort=priority",
      expect.objectContaining({
        headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      }),
    );
  });

  it("paginates, retains first connection identifiers, and preserves account provider", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(listing([account("first"), account("duplicate")], { total: 501, totalPages: 2 })),
      )
      .mockResolvedValueOnce(
        json(
          listing([account("duplicate"), account("second", "kiro")], {
            page: 2,
            total: 501,
            totalPages: 2,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchNineRouterAccounts(configured());
    expect(result).toMatchObject({
      success: true,
      accounts: [{ id: "first" }, { id: "duplicate" }, { id: "second", provider: "kiro" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["bad totals", listing([account()], { total: 501, totalPages: 1 })],
    ["bad page size", listing([account()], { pageSize: 499 })],
    ["excess rows", listing(Array.from({ length: 501 }, (_, index) => account(`id-${index}`)))],
    ["account cap", listing([account()], { total: 5001, totalPages: 11 })],
    ["page cap", listing([account()], { total: 5000, totalPages: 11 })],
  ])("rejects inconsistent pagination for %s before another request", async (_name, body) => {
    const fetchMock = vi.fn().mockResolvedValue(json(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNineRouterAccounts(configured(), "codex")).resolves.toEqual({
      success: false,
      error: "Invalid nineRouter provider response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("filters unsafe, inactive, and provider-mismatched accounts without leaking data", async () => {
    const unsafeProvider = "unsafe\u0000provider";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(
            listing([
              { ...account("unsafe"), provider: unsafeProvider },
              { ...account("other"), provider: "other" },
              { ...account("inactive"), isActive: false },
              { ...account("good", " KIRO / test ") },
            ]),
          ),
        ),
    );
    const result = await fetchNineRouterAccounts(configured(), "kiro / test");
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        accounts: [expect.objectContaining({ id: "good", provider: "kiro / test" })],
        errors: [
          { error: "Invalid account identifier" },
          { error: "Invalid account identifier" },
          { error: "Invalid account identifier" },
        ],
      }),
    );
    expect(JSON.stringify(result)).not.toContain(unsafeProvider);
  });

  it("keeps complete 500-row pages and percent-encodes opaque usage identifiers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          listing(
            Array.from({ length: 500 }, (_, index) => account(`id-${index}`)),
            { total: 500 },
          ),
        ),
      )
      .mockResolvedValueOnce(json({ quotas: { weekly: { used: 25, total: 100 } } }));
    vi.stubGlobal("fetch", fetchMock);
    const accounts = await fetchNineRouterAccounts(configured(), "codex");
    expect(accounts).toMatchObject({
      success: true,
      accounts: expect.arrayContaining([expect.objectContaining({ id: "id-499" })]),
    });
    await expect(fetchNineRouterUsage(configured(), "kiro/connection id")).resolves.toMatchObject({
      success: true,
      windows: [{ kind: "weekly", percentRemaining: 75 }],
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining(encodeURIComponent("kiro/connection id")),
      expect.anything(),
    );
  });

  it("parses trusted percentage variants, caps values, and calculates duration resets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          quotas: {
            unlimited: { unlimited: true },
            remaining: { remainingPercentage: 125 },
            usedPercent: { used_percent: 125 },
            percentUsed: { percent_used: -5 },
            quantity: { used: 2, total: 8 },
            duration: { remainingPercentage: 70, reset_after_seconds: 600 },
          },
        }),
      ),
    );
    await expect(fetchNineRouterUsage(configured(), ID)).resolves.toEqual({
      success: true,
      windows: [
        { kind: "unlimited", percentRemaining: 100 },
        { kind: "remaining", percentRemaining: 100 },
        { kind: "usedPercent", percentRemaining: 0 },
        { kind: "percentUsed", percentRemaining: 100 },
        { kind: "quantity", percentRemaining: 75 },
        { kind: "duration", percentRemaining: 70, resetTimeIso: "2026-08-03T12:10:00.000Z" },
      ],
    });
  });

  it("drops unsafe and normalized-colliding quota keys without returning raw input", async () => {
    const unsafe = "unsafe\u0000key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          quotas: {
            " exact ": { used_percent: 20 },
            exact: { used_percent: 30 },
            [unsafe]: { used_percent: 40 },
            Good: { used_percent: 60 },
          },
        }),
      ),
    );
    const result = await fetchNineRouterUsage(configured(), ID);
    expect(result).toEqual({
      success: true,
      windows: [{ kind: "Good", percentRemaining: 40 }],
      errors: [{ error: "Ambiguous nineRouter quota key after normalization" }],
    });
    expect(JSON.stringify(result)).not.toContain(unsafe);
  });

  it.each([
    "private\u0000id",
    "x".repeat(257),
    "  ",
  ])("rejects unsafe usage identifier %j without a request", async (id) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNineRouterUsage(configured(), id)).resolves.toEqual({
      success: false,
      error: "Invalid account identifier",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes message-only errors and rejects malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ message: "ignore\nprivate\u0000body" }))
        .mockResolvedValueOnce(
          new Response("{", { headers: { "content-type": "application/json" } }),
        )
        .mockResolvedValueOnce(
          new Response("x".repeat(NINE_ROUTER_MAX_BODY_BYTES + 1), {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(fetchNineRouterUsage(configured(), ID)).resolves.toEqual({
      success: false,
      error: "ignore privatebody",
      safeDisplayMessage: true,
    });
    await expect(fetchNineRouterUsage(configured(), ID)).resolves.toEqual(
      expect.objectContaining({ success: false }),
    );
    await expect(fetchNineRouterUsage(configured(), ID)).resolves.toEqual(
      expect.objectContaining({ success: false }),
    );
  });

  it.each([
    401, 403, 429, 503,
  ])("returns safe HTTP %i failure and bounded retry metadata", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("private", { status, headers: { "Retry-After": "45" } })),
    );
    await expect(fetchNineRouterUsage(configured(), ID)).resolves.toEqual({
      success: false,
      error: `HTTP ${status}`,
      retryAfterMs: 45_000,
    });
  });

  it("converts aborted requests into bounded timeout failures", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      ),
    );
    const pending = fetchNineRouterUsage(configured(), ID, 10);
    await vi.advanceTimersByTimeAsync(11);
    await expect(pending).resolves.toEqual({ success: false, error: "Request timeout after 0s" });
  });
});
