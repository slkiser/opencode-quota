import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatDeepSeekBalanceValue, queryDeepSeekBalance } from "../src/lib/deepseek.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
  getAuthPaths: vi.fn(() => []),
}));

describe("queryDeepSeekBalance", () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-deepseek-"));
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir,
      XDG_CACHE_HOME: tempDir,
      XDG_STATE_HOME: tempDir,
    };
    delete process.env.DEEPSEEK_API_KEY;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when not configured", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValueOnce({});

    await expect(queryDeepSeekBalance()).resolves.toBeNull();
  });

  it("returns DeepSeek balance data from the API", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              {
                currency: "USD",
                total_balance: "12.34",
                granted_balance: "2.00",
                topped_up_balance: "10.34",
              },
            ],
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryDeepSeekBalance({ requestTimeoutMs: 1234 });

    expect(out).toEqual({
      success: true,
      isAvailable: true,
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "12.34",
          grantedBalance: "2.00",
          toppedUpBalance: "10.34",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "User-Agent": "OpenCode-Quota-Toast/1.0",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("filters unsupported currencies and preserves supported CNY balances", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              is_available: false,
              balance_infos: [
                { currency: "EUR", total_balance: "9.99" },
                { currency: "cny", total_balance: "88.00" },
              ],
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryDeepSeekBalance();

    expect(out && out.success ? out.balanceInfos : []).toEqual([
      {
        currency: "CNY",
        totalBalance: "88.00",
        grantedBalance: "0.00",
        toppedUpBalance: "0.00",
      },
    ]);
  });

  it("handles API errors", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";

    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })) as any);

    const out = await queryDeepSeekBalance();
    expect(out && !out.success ? out.error : "").toContain("DeepSeek API error 401");
  });

  it("sanitizes API error text before returning it", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized\u001b[31m", { status: 401 })) as any,
    );

    const out = await queryDeepSeekBalance();
    expect(out && !out.success ? out.error : "").toBe("DeepSeek API error 401: Unauthorized");
  });

  it("reports unexpected response shapes as sanitized errors", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as any);

    const out = await queryDeepSeekBalance();
    expect(out && !out.success ? out.error : "").toBe(
      "DeepSeek balance response returned an unexpected response shape",
    );
  });
});

describe("formatDeepSeekBalanceValue", () => {
  it("formats USD and CNY balances", () => {
    expect(formatDeepSeekBalanceValue({ currency: "USD", totalBalance: "12.34" })).toBe("$12.34");
    expect(formatDeepSeekBalanceValue({ currency: "CNY", totalBalance: "88.00" })).toBe("¥88.00");
  });
});
