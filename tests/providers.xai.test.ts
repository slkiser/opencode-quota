import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  bindCredentialSource,
  createIntegrationCredentialSource,
} from "../src/lib/opencode-auth.js";
import { xaiProvider } from "../src/providers/xai.js";
import heavySubscription from "./fixtures/xai/subscriptions-heavy.sanitized.json";
import weeklyCredits from "./fixtures/xai/supergrok-weekly.json";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  fakeHttp,
  fetchRows,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const NOW = Date.parse("2026-07-15T12:00:00.000Z");
/** The end of the weekly period in the credits fixture. */
const WEEK_END = "2026-07-20T02:24:00.983Z";

/** A stored xAI OAuth login; `value` fields replace the OAuth defaults. */
function xaiLogin(id: string, value: Record<string, unknown>): CredentialDatabaseRow {
  return { id, integrationId: "xai", active: null, updated: 1, value: { type: "oauth", ...value } };
}

/** Answers the credits endpoint with `credits` and the subscriptions endpoint with `subscriptions`. */
function xaiHttp(credits: unknown = weeklyCredits, subscriptions: unknown = { subscriptions: [] }) {
  return fakeHttp((url) => (url === SUBSCRIPTIONS_URL ? subscriptions : credits));
}

function activeSubscription(tier: string, providerOfferId?: string) {
  return {
    subscriptions: [
      {
        tier: `SUBSCRIPTION_TIER_${tier}`,
        status: "SUBSCRIPTION_STATUS_ACTIVE",
        ...(providerOfferId ? { activeOffer: { providerOfferId } } : {}),
      },
    ],
  };
}

function errorDebug(fetched: { debug: Array<{ key: string; value: string }> }): string[] {
  return fetched.debug.filter((item) => item.key === "error").map((item) => item.value);
}

describe("xAI provider", () => {
  const world = useProviderWorld();

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  it.each([
    ["no login", []],
    ["only an API key login", [xaiLogin("a", { type: "api", key: "xai-key" })]],
    ["an OAuth login without an access token", [xaiLogin("a", { refresh: "refresh-only" })]],
  ])("is not configured with %s", async (_name, logins) => {
    world.storeLogins(logins);
    const http = xaiHttp();

    await expect(fetchRows(xaiProvider)).resolves.toEqual({
      rows: [],
      error: { code: "not_configured" },
      debug: [],
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("reads the credits meter and the plan with the stored login's token", async () => {
    world.storeLogins([xaiLogin("cred_1", { access: "token-1", expires: NOW + 60_000 })]);
    const http = xaiHttp(weeklyCredits, heavySubscription);

    const fetched = await fetchRows(xaiProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["xai.credits", "Heavy", "Weekly", "week", 95, WEEK_END],
    ]);
    // The period start is the pace marker's evidence, for a stored login too.
    expect(fetched.rows[0]?.windowStartedAt).toBe("2026-07-13T02:24:00.983Z");
    expect(fetched.error).toBeUndefined();
    expect(fetched.rowLogins).toEqual(["cred_1"]);
    expect(http.mock.calls.map(([url]) => url)).toEqual([CREDITS_URL, SUBSCRIPTIONS_URL]);
    for (const [, init] of http.mock.calls) {
      expect(requestHeader(init, "Authorization")).toBe("Bearer token-1");
      expect(requestHeader(init, "x-grok-client-surface")).toBe("grok-build");
    }
  });

  it.each([
    ["no active subscription", { subscriptions: [] }, "SuperGrok"],
    ["the Lite tier", activeSubscription("SUPER_GROK_LITE"), "Lite"],
    ["the Heavy tier", activeSubscription("SUPER_GROK_HEAVY"), "Heavy"],
    ["the Pro tier without a Heavy offer", activeSubscription("SUPER_GROK_PRO"), "SuperGrok"],
    [
      "a look-alike Heavy offer",
      activeSubscription("SUPER_GROK_PRO", "not-heavy-p3m-30-may2026"),
      "SuperGrok",
    ],
    ["a failed subscription request", new Response("denied", { status: 403 }), "SuperGrok"],
  ])("names the plan from %s", async (_name, subscriptions, plan) => {
    world.storeLogins([xaiLogin("cred_1", { access: "token-1" })]);
    xaiHttp(weeklyCredits, subscriptions);

    const fetched = await fetchRows(xaiProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["xai.credits", plan, "Weekly", "week", 95, WEEK_END],
    ]);
  });

  it.each([
    [
      "a monthly period",
      {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-08-01T00:00:00Z" },
        creditUsagePercent: 25,
      },
      ["Monthly", "month", 75, "2026-08-01T00:00:00.000Z"],
    ],
    [
      "a daily period",
      {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_DAILY", end: "2026-07-16T00:00:00Z" },
        creditUsagePercent: 10,
      },
      ["Daily", "day", 90, "2026-07-16T00:00:00.000Z"],
    ],
    [
      "a weekly period without a usage percent (0% used)",
      { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-20T00:00:00Z" } },
      ["Weekly", "week", 100, "2026-07-20T00:00:00.000Z"],
    ],
    [
      "an unknown period that ends with the billing period",
      {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_CUSTOM" },
        creditUsagePercent: 40,
        billingPeriodEnd: "2026-08-01T00:00:00Z",
      },
      ["Period", null, 60, "2026-08-01T00:00:00.000Z"],
    ],
  ])("labels the row with %s", async (_name, config, [label, window, percent, resetsAt]) => {
    world.storeLogins([xaiLogin("cred_1", { access: "token-1" })]);
    xaiHttp({ config });

    const fetched = await fetchRows(xaiProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["xai.credits", "SuperGrok", label, window, percent, resetsAt],
    ]);
  });

  it.each([
    [
      "an expired token, without asking xAI",
      { access: "token-1", expires: NOW - 1 },
      weeklyCredits,
      "login_expired",
      "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
    ],
    [
      "an HTTP error, with the token redacted",
      { access: "token-1" },
      new Response("denied for token-1", { status: 500 }),
      "provider_error",
      "xAI API error 500: denied for [redacted]",
    ],
    [
      "a reply without a period",
      { access: "token-1" },
      { config: { currentPeriod: {} } },
      "no_data",
      "No quota data",
    ],
    [
      "a usage percent that is not a number",
      { access: "token-1" },
      { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }, creditUsagePercent: "5" } },
      "bad_response",
      "xAI credits response returned an invalid usage percentage",
    ],
  ])("reports %s", async (_name, login, credits, code, message) => {
    world.storeLogins([xaiLogin("cred_1", login)]);
    const http = xaiHttp(credits);

    const fetched = await fetchRows(xaiProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe(code);
    expect(errorDebug(fetched)).toEqual([`[xAI]: ${message}`]);
    expect(http).toHaveBeenCalledTimes(code === "login_expired" ? 0 : 1);
  });

  it("shows each login's row, and a login OpenCode could not return as its error", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "xai",
        id: "cred_work",
        label: "work",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "token-1" },
      },
      {
        integrationId: "xai",
        id: "cred_old",
        label: "default",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "token-2" },
        resolveError: "HTTP 401",
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
    const http = xaiHttp();

    try {
      const fetched = await fetchRows(xaiProvider);

      expect(rowSummary(fetched.rows)).toEqual([
        ["xai.credits", "work (SuperGrok)", "Weekly", "week", 95, WEEK_END],
      ]);
      expect(fetched.rowLogins).toEqual(["cred_work"]);
      expect(fetched.error?.code).toBe("login_expired");
      expect(errorDebug(fetched)).toEqual([
        "[xAI]: xAI sign-in could not be refreshed: refresh_failed: HTTP 401. Run `opencode auth login xai`.",
      ]);
      expect(http.mock.calls.map(([, init]) => requestHeader(init, "Authorization"))).toEqual([
        "Bearer token-1",
        "Bearer token-1",
      ]);
    } finally {
      unbind();
    }
  });

  it.each([
    ["an OAuth login", [xaiLogin("a", { access: "token-1" })], true],
    ["only an API key login", [xaiLogin("a", { type: "api", key: "xai-key" })], false],
    ["no login", [], false],
  ])("is available with %s", async (_name, logins, expected) => {
    world.storeLogins(logins);
    const ctx = createProviderAvailabilityContext({ providerIds: ["xai"] });

    await expect(xaiProvider.isAvailable(ctx)).resolves.toBe(expected);
  });

  it.each([
    ["grok-4", "xai", true],
    ["grok-4", "grok", false],
    ["xai/grok-4", undefined, true],
    ["openai/grok-4", undefined, false],
  ])("matches model %s with current provider %s: %s", (model, currentProviderID, expected) => {
    expect(
      xaiProvider.matchesCurrentModel?.(model, { enabledProviders: "auto", currentProviderID }),
    ).toBe(expected);
  });
});
