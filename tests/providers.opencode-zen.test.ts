import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOpenCodeZenQuota: vi.fn(),
  resolveOpenCodeConsoleAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-zen.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-zen.js")>();
  return {
    ...original,
    queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
  };
});

vi.mock("../src/lib/opencode-console-auth.js", () => ({
  OPENCODE_CONSOLE_BASE_URL: "https://opencode.ai/console",
  resolveOpenCodeConsoleAuth: mocks.resolveOpenCodeConsoleAuth,
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

function balanceEntry(prominence: "primary" | "supplementary", decimal = "42.5") {
  return {
    accounting: balanceAccounting,
    kind: "quantity",
    name: "zen-current-balance",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "current_balance" },
      prominence,
    },
    quantity: { decimal, unit: { kind: "currency", code: "USD" } },
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
  } = {},
) {
  return {
    accounting: budgetAccounting,
    name: "zen-monthly-budget",
    group: "OpenCode Zen",
    percentRemaining: options.percentRemaining ?? 94.25,
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

function consoleAuth(state: "configured" | "expired" | "none" | "invalid"): void {
  if (state === "configured") {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "configured",
      credential: { accessToken: "console-token", orgId: "wrk_1", orgName: "WSC Sports" },
    });
    return;
  }
  if (state === "expired") {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "expired",
      credential: { accessToken: "console-token", orgId: "wrk_1" },
    });
    return;
  }
  if (state === "invalid") {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "invalid",
      error: "OpenCode Console credential has no access token",
    });
    return;
  }
  mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({ state: "none" });
}

function success(overrides: Record<string, unknown> = {}): void {
  mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
    success: true,
    data: {
      balance: 42.5,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
      reload: false,
      reloadAmount: null,
      reloadTrigger: null,
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
    [{ state: "configured", credential: { accessToken: "token" } }, true],
    [{ state: "expired", credential: { accessToken: "console-token" } }, true],
    [{ state: "none" }, false],
    [{ state: "invalid", error: "bad" }, false],
  ])("reports availability for console auth state %j as %s", async (state, expected) => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce(state as any);
    await expect(opencodeZenProvider.isAvailable(context())).resolves.toBe(expected);
  });

  it("returns attempted:false when no console credential exists", async () => {
    consoleAuth("none");

    const out = await opencodeZenProvider.fetch(context());

    expectNotAttempted(out);
    expect(out.statusDetails).toContainEqual({ key: "console_auth_state", value: "none" });
  });

  it("reports an expired console credential with a refresh hint", async () => {
    consoleAuth("expired");

    const out = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(out, "OpenCode");
    expect(out.errors[0]?.message).toContain("opencode auth login");
    expect(out.statusDetails).toContainEqual({ key: "console_auth_state", value: "expired" });
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("projects invalid console credentials as an attempted error", async () => {
    consoleAuth("invalid");

    const out = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(out, "OpenCode");
    expect(out.errors[0]?.message).toBe("OpenCode Console credential has no access token");
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("makes structured balance primary when no monthly budget is available", async () => {
    consoleAuth("configured");
    success();

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      balanceEntry("primary"),
      autoReloadEntry(false),
    ]);
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenCalledWith(
      { accessToken: "console-token" },
      { requestTimeoutMs: undefined },
    );
  });

  it("calculates monthly-limit remaining from monthly usage (default display)", async () => {
    consoleAuth("configured");
    success({ balance: 12, monthlyLimit: 100, monthlyUsage: 5.75 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({ percentRemaining: 94.25, used: "5.75", limit: "100", remaining: "94.25" }),
      balanceEntry("supplementary", "12"),
      autoReloadEntry(false),
    ]);
  });

  it("prefers the positive plugin monthly-limit override", async () => {
    consoleAuth("configured");
    success({ balance: 1, monthlyLimit: 100, monthlyUsage: 5.75 });

    const result = await opencodeZenProvider.fetch(
      context({ opencodeMonthlyLimit: 10 }),
    );

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: 42.5,
        used: "5.75",
        limit: "10",
        remaining: "4.25",
        limitAuthority: "user_configured",
      }),
      balanceEntry("supplementary", "1"),
      autoReloadEntry(false),
    ]);
  });

  it("emits only the contract-backed reload boolean and keeps ambiguous values diagnostic", async () => {
    consoleAuth("configured");
    success({ reload: true, reloadAmount: 20, reloadTrigger: 5 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toContainEqual(autoReloadEntry(true));
  });

  it("clamps monthly usage above the limit to zero remaining", async () => {
    consoleAuth("configured");
    success({ balance: 1, monthlyLimit: 100, monthlyUsage: 150 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({ percentRemaining: 0, used: "150", limit: "100", remaining: "0" }),
      balanceEntry("supplementary", "1"),
      autoReloadEntry(false),
    ]);
  });

  it("projects query failures as attempted errors with live_fetch_error", async () => {
    consoleAuth("configured");
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Console API error 403 (/api/billing/status)",
    });

    const out = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(out, "OpenCode");
    expect(out.errors[0]?.message).toBe(
      "OpenCode Console API error 403 (/api/billing/status)",
    );
    expect(out.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value: "OpenCode Console API error 403 (/api/billing/status)",
    });
  });

  it("passes a user-configured timeout and otherwise keeps the default", async () => {
    consoleAuth("configured");
    success();

    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 4_321, requestTimeoutMsConfigured: true }),
    );

    expect(mocks.queryOpenCodeZenQuota).toHaveBeenCalledWith(
      { accessToken: "console-token" },
      { requestTimeoutMs: 4_321 },
    );
  });
});
