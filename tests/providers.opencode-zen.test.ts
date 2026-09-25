import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOpenCodeZenQuota: vi.fn(),
  resolveOpenCodeZenAccountCached: vi.fn(),
  fetchResponse: vi.fn(),
  realQueryOpenCodeZenQuota: null as
    | null
    | typeof import("../src/lib/opencode-zen.js").queryOpenCodeZenQuota,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    url: string,
    options: { consume: (response: Response) => Promise<unknown> },
  ) => {
    const response = await mocks.fetchResponse(url);
    return await options.consume(response);
  },
}));

vi.mock("../src/lib/opencode-zen.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-zen.js")>();
  mocks.realQueryOpenCodeZenQuota = original.queryOpenCodeZenQuota;
  return {
    ...original,
    queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
  };
});

vi.mock("../src/lib/opencode-zen-config.js", () => ({
  resolveOpenCodeZenAccountCached: mocks.resolveOpenCodeZenAccountCached,
}));

import { opencodeZenProvider } from "../src/providers/opencode-zen.js";

const balanceAccounting = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const budgetAccounting = {
  ...balanceAccounting,
  resultType: "budget",
  authority: "locally_derived",
} as const;
const statusAccounting = {
  ...balanceAccounting,
  resultType: "status",
} as const;

const consoleAccount = {
  baseUrl: "https://opencode.ai/console",
  accessToken: "st_secret-token",
  activeOrgId: "wrk_123",
};

function balanceEntry(prominence: "primary" | "supplementary") {
  return {
    accounting: balanceAccounting,
    kind: "quantity",
    name: "zen-current-balance",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "current_balance" },
      prominence,
    },
    quantity: { decimal: "42.5", unit: { kind: "currency", code: "USD" } },
  } as const;
}

function autoReloadEntry(value = false) {
  return {
    accounting: statusAccounting,
    kind: "boolean",
    name: "zen-auto-reload",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "auto_reload" },
      prominence: "supplementary",
    },
    value,
  } as const;
}

function budgetEntry(
  options: {
    percentRemaining?: number;
    used?: string;
    limit?: string;
    remaining?: string;
    limitAuthority?: "provider_reported" | "user_configured";
    resetTimeIso?: string;
  } = {},
) {
  return {
    accounting: budgetAccounting,
    name: "zen-monthly-budget",
    group: "OpenCode Zen",
    percentRemaining: options.percentRemaining ?? 94.25,
    ...(options.resetTimeIso ? { resetTimeIso: options.resetTimeIso } : {}),
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
    basis: {
      used: {
        quantity: {
          decimal: options.used ?? "5.75",
          unit: { kind: "currency", code: "USD" },
        },
        authority: "provider_reported",
      },
      limit: {
        quantity: {
          decimal: options.limit ?? "100",
          unit: { kind: "currency", code: "USD" },
        },
        authority: options.limitAuthority ?? "provider_reported",
      },
      remaining: {
        quantity: {
          decimal: options.remaining ?? "94.25",
          unit: { kind: "currency", code: "USD" },
        },
        authority: "locally_derived",
      },
    },
  } as const;
}

function configured(): void {
  mocks.resolveOpenCodeZenAccountCached.mockResolvedValueOnce({
    state: "configured",
    account: consoleAccount,
  });
}

function success(overrides: Record<string, unknown> = {}, errors: string[] = []): void {
  mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
    success: true,
    errors,
    data: {
      balance: 4_250_000_000,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
      reload: false,
      reloadAmount: null,
      reloadTrigger: null,
      budgetResetIso: null,
      ...overrides,
    },
  });
}

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

describe("opencode Zen provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the original canonical provider id", () => {
    expect(opencodeZenProvider.id).toBe("opencode");
  });

  it.each([
    [{ state: "configured", account: consoleAccount }, "auto", true],
    [{ state: "expired", expiryMs: 0 }, "auto", true],
    [{ state: "missing_org" }, "auto", true],
    [{ state: "inactive_account" }, "auto", true],
    [{ state: "invalid_url" }, "auto", true],
    [{ state: "incompatible" }, "auto", true],
    [{ state: "read_error" }, "auto", true],
    [{ state: "none" }, "auto", false],
    [{ state: "none" }, ["opencode"], false],
    [{ state: "no_active_account" }, "auto", false],
    [{ state: "no_active_account" }, ["opencode"], true],
  ])("reports availability for %j with enabledProviders %j -> %j", async (resolution, enabledProviders, expected) => {
    mocks.resolveOpenCodeZenAccountCached.mockResolvedValueOnce(resolution);
    await expect(opencodeZenProvider.isAvailable(context({ enabledProviders }))).resolves.toBe(
      expected,
    );
  });

  it.each([
    ["opencode/gpt-5", true],
    ["opencode-zen/claude-opus", true],
    ["OPENCODE/gemini", true],
    ["openai/gpt-5", false],
    ["opencode-go/model", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeZenProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("returns attempted:false when no Console session exists", async () => {
    mocks.resolveOpenCodeZenAccountCached.mockResolvedValueOnce({ state: "none" });
    expectNotAttempted(await opencodeZenProvider.fetch(context()));
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "expired", expiryMs: 0 }, "opencode console login"],
    [{ state: "no_active_account" }, "opencode console login"],
    [{ state: "invalid_url" }, "opencode console login"],
    [{ state: "incompatible" }, "opencode console login"],
    [{ state: "read_error" }, "could not be read"],
    [{ state: "missing_org" }, "opencode console switch"],
    [{ state: "inactive_account" }, "opencode console switch"],
  ])("projects account state %j as an actionable attempted error", async (resolution, hint) => {
    mocks.resolveOpenCodeZenAccountCached.mockResolvedValueOnce(resolution);
    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode");
    expect(result.errors[0]?.message).toContain(hint);
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("projects Console failures as attempted errors", async () => {
    configured();
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
      success: false,
      error:
        "OpenCode Console session expired or invalid — run `opencode console login` to sign in again",
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode");
    expect(result.errors[0]?.message).toContain("opencode console login");
  });

  it("makes structured balance primary when no monthly budget is available", async () => {
    configured();
    success();

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
    expect(result.presentation).toBeUndefined();
  });

  it("calculates monthly-limit remaining from monthly usage (default display)", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 575_000_000 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry(),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(result.statusDetails).toEqual([
      { key: "account_state", value: "configured" },
      { key: "console_url", value: "https://opencode.ai/console" },
      { key: "balance_usd", value: "USD 42.5" },
      { key: "monthly_limit_usd", value: "USD 100" },
      { key: "auto_reload", value: "false" },
      { key: "auto_reload_amount_raw", value: "(none)" },
      { key: "auto_reload_trigger_raw", value: "(none)" },
    ]);
  });

  it("does not project a last payment status detail", async () => {
    configured();
    success({ lastPayment: 50 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.statusDetails.some((d) => d.key === "last_payment_usd")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("last_payment_usd");
  });

  it("emits only the contract-backed reload boolean and keeps ambiguous values diagnostic", async () => {
    configured();
    success({
      monthlyLimit: 100,
      monthlyUsage: 575_000_000,
      reload: true,
      reloadAmount: 20,
      reloadTrigger: 5,
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry(),
      balanceEntry("supplementary"),
      autoReloadEntry(true),
    ]);
    expect(
      result.entries.some(
        (entry) =>
          entry.semantic?.metric.kind === "component" &&
          (entry.semantic.metric.component === "auto_reload_amount" ||
            entry.semantic.metric.component === "auto_reload_trigger"),
      ),
    ).toBe(false);
    expect(result.statusDetails).toContainEqual({ key: "auto_reload_amount_raw", value: "20" });
    expect(result.statusDetails).toContainEqual({ key: "auto_reload_trigger_raw", value: "5" });
    expect(result.presentation).toBeUndefined();
  });

  it("attaches the org budget reset date to the monthly budget entry", async () => {
    configured();
    success({
      monthlyLimit: 60,
      monthlyUsage: 617_355_570,
      budgetResetIso: "2026-10-01T00:00:00.000Z",
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: Math.min(100, ((60 - 6.1735557) / 60) * 100),
        used: "6.1735557",
        limit: "60",
        remaining: "53.8264443",
        resetTimeIso: "2026-10-01T00:00:00.000Z",
      }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
  });

  it("does not reject the whole result for a parseable non-ISO org-budget reset", async () => {
    configured();
    // Run the real query pipeline against a fake HTTP layer where budgets/org
    // returns a parseable-but-non-ISO reset ("0"); the resolver must normalize
    // it to canonical ISO so shared result validation never drops the result.
    mocks.fetchResponse.mockImplementation((url: string) => {
      const route = url.slice("https://opencode.ai/console/api/".length);
      const payloads: Record<string, unknown> = {
        "billing/status": { balanceMicroCents: "4250000000" },
        "billing/account": { orgId: "wrk_123", creditLimitMicroCents: null },
        "billing/auto-recharge": {
          enabled: false,
          thresholdDollars: 5,
          rechargeAmountDollars: 20,
          pending: false,
          failureReason: null,
        },
        "budgets/org": {
          limitMicroCents: "6000000000",
          spentMicroCents: "617355570",
          exceeded: false,
          resetsAt: "2026-10-01T00:00:00",
        },
        "usage/cost-by-day": [],
      };
      const payload = payloads[route];
      if (payload === undefined) throw new Error(`unexpected url ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    if (!mocks.realQueryOpenCodeZenQuota) throw new Error("real query not captured");
    const realQuery = mocks.realQueryOpenCodeZenQuota;
    mocks.queryOpenCodeZenQuota.mockImplementation(
      (acct: typeof consoleAccount, opts?: { requestTimeoutMs?: number }) => realQuery(acct, opts),
    );

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toMatchObject({
      percentRemaining: Math.min(100, ((60 - 6.1735557) / 60) * 100),
      resetTimeIso: new Date("2026-10-01T00:00:00").toISOString(),
    });
    // Canonical ISO only: the parseable non-ISO input must never surface.
    expect(result.entries[0].resetTimeIso?.endsWith("Z")).toBe(true);
  });

  it("prefers the positive plugin monthly-limit override", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 575_000_000 });

    const result = await opencodeZenProvider.fetch(context({ opencodeMonthlyLimit: 200 }));

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: 97.125,
        limit: "200",
        remaining: "194.25",
        limitAuthority: "user_configured",
      }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
  });

  it("keeps the balance and reports failed optional Console routes", async () => {
    configured();
    success({ reload: null }, [
      "OpenCode Console billing/auto-recharge error 500",
      "OpenCode Console usage/cost-by-day error 500",
    ]);

    const result = await opencodeZenProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([balanceEntry("primary")]);
    expect(result.errors).toEqual([
      { label: "OpenCode", message: "OpenCode Console billing/auto-recharge error 500" },
      { label: "OpenCode", message: "OpenCode Console usage/cost-by-day error 500" },
    ]);
    expect(result.statusDetails).toContainEqual({ key: "auto_reload", value: "(unknown)" });
    expect(result.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value:
        "OpenCode Console billing/auto-recharge error 500 | OpenCode Console usage/cost-by-day error 500",
    });
  });

  it("uses the plugin monthly limit when the Console credit-limit request fails", async () => {
    configured();
    success({ monthlyLimit: null, monthlyUsage: 575_000_000 }, [
      "OpenCode Console billing/account error 500",
    ]);

    const result = await opencodeZenProvider.fetch(context({ opencodeMonthlyLimit: 200 }));

    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: 97.125,
        limit: "200",
        remaining: "194.25",
        limitAuthority: "user_configured",
      }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(result.errors).toEqual([
      { label: "OpenCode", message: "OpenCode Console billing/account error 500" },
    ]);
  });

  it("does not treat the last payment as a monthly limit", async () => {
    configured();
    success({ lastPayment: 50 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
  });

  it("uses structured balance when monthly usage is unavailable", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: null });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
  });

  it("uses structured balance for a zero page limit instead of emitting NaN", async () => {
    configured();
    success({ monthlyLimit: 0 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("clamps monthly usage above the limit to zero remaining", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 20_000_000_000 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toEqual(
      budgetEntry({ percentRemaining: 0, used: "200", remaining: "0" }),
    );
  });

  it("passes a user-configured timeout and otherwise keeps the Console default", async () => {
    configured();
    success();
    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 7_654, requestTimeoutMsConfigured: true }),
    );
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenLastCalledWith(consoleAccount, {
      requestTimeoutMs: 7_654,
    });

    configured();
    success();
    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 5_000, requestTimeoutMsConfigured: false }),
    );
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenLastCalledWith(consoleAccount, {
      requestTimeoutMs: undefined,
    });
  });
});
