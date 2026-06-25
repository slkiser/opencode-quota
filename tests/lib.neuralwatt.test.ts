import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatNeuralwattBalanceValue,
  formatNeuralwattKwhRight,
  queryNeuralwattQuota,
} from "../src/lib/neuralwatt.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
  getAuthPaths: vi.fn(() => []),
}));

describe("queryNeuralwattQuota", () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-neuralwatt-"));
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir,
      XDG_CACHE_HOME: tempDir,
      XDG_STATE_HOME: tempDir,
    };
    delete process.env.NEURALWATT_API_KEY;
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

    await expect(queryNeuralwattQuota()).resolves.toBeNull();
  });

  it("returns Neuralwatt quota data (balance + subscription + key allowance)", async () => {
    process.env.NEURALWATT_API_KEY = "test-key";

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            snapshot_at: "2026-04-16T18:30:00Z",
            balance: {
              credits_remaining_usd: 32.6774,
              total_credits_usd: 52.34,
              credits_used_usd: 19.6626,
              accounting_method: "energy",
            },
            usage: {
              lifetime: {
                cost_usd: 243.9145,
                requests: 37801,
                tokens: 1235477176,
                energy_kwh: 15.6009,
              },
              current_month: {
                cost_usd: 160.1463,
                requests: 23902,
                tokens: 1116658995,
                energy_kwh: 9.7278,
              },
            },
            limits: { overage_limit_usd: null, rate_limit_tier: "standard" },
            subscription: {
              plan: "standard",
              status: "active",
              billing_interval: "month",
              current_period_start: "2026-04-11T05:05:25Z",
              current_period_end: "2026-05-11T05:05:25Z",
              auto_renew: true,
              kwh_included: 20.0,
              kwh_used: 13.9023,
              kwh_remaining: 6.0977,
              in_overage: false,
            },
            key: {
              name: "my-production-key",
              allowance: {
                limit_usd: 100,
                period: "monthly",
                spent_usd: 25,
                remaining_usd: 75,
                blocked: false,
              },
            },
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryNeuralwattQuota({ requestTimeoutMs: 1234 });

    expect(out).toEqual({
      success: true,
      balance: {
        creditsRemainingUsd: 32.6774,
        totalCreditsUsd: 52.34,
        creditsUsedUsd: 19.6626,
        accountingMethod: "energy",
      },
      subscription: {
        active: true,
        state: "active",
        billingInterval: "month",
        currentPeriodStartIso: "2026-04-11T05:05:25.000Z",
        currentPeriodEndIso: "2026-05-11T05:05:25.000Z",
        autoRenew: true,
        kwh: {
          used: 13.9023,
          limit: 20.0,
          remaining: 6.0977,
          percentRemaining: 30,
          resetTimeIso: "2026-05-11T05:05:25.000Z",
        },
        inOverage: false,
      },
      keyAllowance: {
        limitUsd: 100,
        spentUsd: 25,
        remainingUsd: 75,
        period: "monthly",
        blocked: false,
        window: {
          used: 25,
          limit: 100,
          remaining: 75,
          percentRemaining: 75,
          resetTimeIso: undefined,
        },
      },
      lifetimeUsage: { costUsd: 243.9145, requests: 37801, tokens: 1235477176, energyKwh: 15.6009 },
      currentMonthUsage: {
        costUsd: 160.1463,
        requests: 23902,
        tokens: 1116658995,
        energyKwh: 9.7278,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.neuralwatt.com/v1/quota",
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

  it("handles a PAYG account with null subscription (credits-only)", async () => {
    process.env.NEURALWATT_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              balance: {
                credits_remaining_usd: 5.0,
                total_credits_usd: 5.0,
                accounting_method: "token",
              },
              subscription: null,
              key: { name: "k", allowance: null },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryNeuralwattQuota();
    expect(out && out.success).toBe(true);
    if (out && out.success) {
      expect(out.balance?.creditsRemainingUsd).toBe(5.0);
      expect(out.subscription).toBeUndefined();
      expect(out.keyAllowance).toBeUndefined();
    }
  });

  it("derives kwh_remaining when missing", async () => {
    process.env.NEURALWATT_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              balance: { credits_remaining_usd: 1, accounting_method: "energy" },
              subscription: {
                status: "active",
                current_period_end: "2026-05-11T05:05:25Z",
                kwh_included: 20.0,
                kwh_used: 5.0,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryNeuralwattQuota();
    expect(out && out.success ? out.subscription?.kwh : undefined).toEqual({
      used: 5,
      limit: 20,
      remaining: 15,
      percentRemaining: 75,
      resetTimeIso: "2026-05-11T05:05:25.000Z",
    });
  });

  it("maps a 401 into an error result", async () => {
    process.env.NEURALWATT_API_KEY = "bad-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }),
            { status: 401 },
          ),
      ) as any,
    );

    await expect(queryNeuralwattQuota()).resolves.toEqual({
      success: false,
      error: expect.stringContaining("Neuralwatt API error 401"),
    });
  });

  it("maps a 429 into a rate-limited error result", async () => {
    process.env.NEURALWATT_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: { "Retry-After": "1" },
          }),
      ) as any,
    );

    const out = await queryNeuralwattQuota();
    expect(out && !out.success ? out.error : "").toContain("429");
    expect(out && !out.success ? out.error : "").toContain("retry after 1s");
  });

  it("maps an unexpected response shape into an error result", async () => {
    process.env.NEURALWATT_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unrelated: true }), { status: 200 })) as any,
    );

    await expect(queryNeuralwattQuota()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("unexpected response shape"),
    });
  });

  it("formats balance and kwh display values", () => {
    expect(formatNeuralwattBalanceValue({ creditsRemainingUsd: 32.6 })).toBe("$32.60");
    expect(formatNeuralwattBalanceValue({})).toBeNull();
    expect(formatNeuralwattKwhRight({ used: 13.9023, limit: 20 })).toBe("13.9 kWh/20 kWh");
  });
});
