/**
 * The API-key vendors (Ollama Cloud, DeepSeek, OpenRouter)
 * through their public `fetch`, with a key in the environment and fake HTTP replies.
 * Kimi Code and MiniMax, which also need a key, share the "without a key" check.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuotaProvider } from "../src/lib/entries.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { deepseekProvider } from "../src/providers/deepseek.js";
import { kimiCodePlanCnProvider, kimiCodePlanGlobalProvider } from "../src/providers/kimi-code.js";
import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
} from "../src/providers/minimax-coding-plan.js";
import { ollamaCloudProvider } from "../src/providers/ollama-cloud.js";
import { openRouterProvider } from "../src/providers/openrouter.js";
import {
  fakeHttp,
  fetchRows,
  keyLogin,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

vi.mock("../src/lib/provider-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/provider-availability.js")>()),
  isCanonicalProviderAvailable: vi.fn(),
}));

const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";

const VENDORS = {
  "ollama-cloud": { provider: ollamaCloudProvider, keyEnv: "OLLAMA_API_KEY" },
  deepseek: { provider: deepseekProvider, keyEnv: "DEEPSEEK_API_KEY" },
  openrouter: { provider: openRouterProvider, keyEnv: "OPENROUTER_API_KEY" },
} as const;
type VendorId = keyof typeof VENDORS;
const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];

/** The vendors above plus Kimi Code and MiniMax, which also need a key. */
const KEY_PROVIDERS: Array<Pick<QuotaProvider, "id" | "fetch">> = [
  ...Object.values(VENDORS).map((vendor) => vendor.provider),
  kimiCodePlanGlobalProvider,
  kimiCodePlanCnProvider,
  minimaxCodingPlanProvider,
  minimaxChinaCodingPlanProvider,
];

const KEY = "test-key";

function setKey(id: VendorId): void {
  process.env[VENDORS[id].keyEnv] = KEY;
}

/** A reply for every request, or a function of the URL that returns one. */
type Reply = unknown;

/** A JSON reply with a JSON content type (OpenRouter checks it). */
function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** What one fetch shows: the row summaries, the error code and the "error" debug lines. */
async function fetchSummary(provider: Pick<QuotaProvider, "id" | "fetch">, reply: Reply) {
  fakeHttp((url) => (typeof reply === "function" ? reply(url) : reply));
  const fetched = await fetchRows(provider);
  return {
    rows: rowSummary(fetched.rows),
    error: fetched.error?.code ?? null,
    errorLines: fetched.debug.filter((item) => item.key === "error").map((item) => item.value),
  };
}

type VendorCase = {
  name: string;
  reply: Reply;
  rows: unknown[];
  error?: string;
  errorLines?: string[];
};

/** One `it` per case: the vendor's key is set and every request gets the case's reply. */
function describeVendor(id: VendorId, cases: VendorCase[]): void {
  describe(id, () => {
    it.each(cases)("$name", async ({ reply, rows, error = null, errorLines = [] }) => {
      setKey(id);
      expect(await fetchSummary(VENDORS[id].provider, reply)).toEqual({ rows, error, errorLines });
    });
  });
}

const world = useProviderWorld();

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-01-01T12:00:00.000Z"), toFake: ["Date"] });
});

describe("every API-key vendor", () => {
  it.each(KEY_PROVIDERS.map((provider) => [provider.id, provider] as const))(
    "%s without a key is not configured and sends nothing",
    async (_id, provider) => {
      const http = fakeHttp(() => {
        throw new Error("no request expected");
      });

      const fetched = await fetchRows(provider);

      expect(fetched.rows).toEqual([]);
      expect(fetched.error).toEqual({ code: "not_configured" });
      expect(http).not.toHaveBeenCalled();
    },
  );

  it.each<{
    id: VendorId;
    requests: string[];
    authHeader: string;
    auth: string;
    errorLines: string[];
  }>([
    {
      id: "ollama-cloud",
      requests: ["GET https://ollama.com/api/balance"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["Ollama Cloud: Ollama Cloud balance API error 401: Unauthorized"],
    },
    {
      id: "deepseek",
      requests: ["GET https://api.deepseek.com/user/balance"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["DeepSeek: DeepSeek API error 401: Unauthorized"],
    },
    {
      id: "openrouter",
      requests: ["GET https://openrouter.ai/api/v1/key"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["OpenRouter: HTTP 401"],
    },
  ])("$id sends its key to its endpoint and shows a 401 as login_expired", async (vendor) => {
    setKey(vendor.id);
    const http = fakeHttp(() => new Response("Unauthorized\u001b[31m", { status: 401 }));

    const fetched = await fetchRows(VENDORS[vendor.id].provider);

    expect(http.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual(
      vendor.requests,
    );
    for (const [, init] of http.mock.calls) {
      expect(requestHeader(init, vendor.authHeader)).toBe(vendor.auth);
    }
    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe("login_expired");
    expect(fetched.debug.filter((item) => item.key === "error").map((item) => item.value)).toEqual(
      vendor.errorLines,
    );
  });
});

/** The credit-plan example of https://docs.ollama.com/api/balance. */
const OLLAMA_CREDIT_PLAN = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
  },
  purchased: { balance_usd: 25 },
};

/** The legacy-plan example of https://docs.ollama.com/api/balance. */
const OLLAMA_LEGACY_PLAN = {
  included: {
    session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
  },
  purchased: { balance_usd: 25 },
};

const OLLAMA_PURCHASED_ROW = ["ollama-cloud.purchased", null, "Purchased", null, "25 USD", null];
const OLLAMA_NO_DATA = "Ollama Cloud: Ollama Cloud returned no limits or balance";

describeVendor("ollama-cloud", [
  {
    name: "shows a credit plan's included credits for the period, and purchased credits",
    reply: OLLAMA_CREDIT_PLAN,
    rows: [
      [
        "ollama-cloud.monthly",
        null,
        "Monthly",
        "month",
        "72.5 (27.5 USD of 100 USD)",
        "2026-10-15T09:30:00.000Z",
      ],
      OLLAMA_PURCHASED_ROW,
    ],
  },
  {
    name: "shows a legacy plan's session and weekly limits with their resets",
    reply: OLLAMA_LEGACY_PLAN,
    rows: [
      ["ollama-cloud.session", null, "Session", "session", 75, "2026-10-01T07:00:00.000Z"],
      ["ollama-cloud.weekly", null, "Weekly", "week", 40, "2026-10-05T00:00:00.000Z"],
      OLLAMA_PURCHASED_ROW,
    ],
  },
  {
    name: "hides $0 purchased credits next to other rows",
    reply: { ...OLLAMA_LEGACY_PLAN, purchased: { balance_usd: 0 } },
    rows: [
      ["ollama-cloud.session", null, "Session", "session", 75, "2026-10-01T07:00:00.000Z"],
      ["ollama-cloud.weekly", null, "Weekly", "week", 40, "2026-10-05T00:00:00.000Z"],
    ],
  },
  {
    name: "clamps included credits above the allowance to 100%",
    reply: { ...OLLAMA_CREDIT_PLAN, included: { balance_usd: 150, allowance_usd: 100 } },
    rows: [
      ["ollama-cloud.monthly", null, "Monthly", "month", "100 (0 USD of 100 USD)", null],
      OLLAMA_PURCHASED_ROW,
    ],
  },
  {
    name: "clamps a negative included balance to 0%",
    reply: { ...OLLAMA_CREDIT_PLAN, included: { balance_usd: -5, allowance_usd: 100 } },
    rows: [
      ["ollama-cloud.monthly", null, "Monthly", "month", "0 (100 USD of 100 USD)", null],
      OLLAMA_PURCHASED_ROW,
    ],
  },
  {
    name: "shows only purchased credits, even $0, when there is no included allowance",
    reply: {
      included: { balance_usd: 0, allowance_usd: 0, period: OLLAMA_CREDIT_PLAN.included.period },
      purchased: { balance_usd: 0 },
    },
    rows: [["ollama-cloud.purchased", null, "Purchased", null, "0 USD", null]],
  },
  {
    name: "keeps a limit without a reset when resets_at is not a time",
    reply: {
      included: { session: { remaining_percent: 0, resets_at: "soon" } },
      purchased: { balance_usd: 0 },
    },
    rows: [["ollama-cloud.session", null, "Session", "session", 0, null]],
  },
  {
    name: "keeps valid fields next to invalid ones and reports the invalid ones",
    reply: {
      included: {
        session: { remaining_percent: 20, resets_at: "2026-10-01T07:00:00Z" },
        weekly: { remaining_percent: 150 },
      },
      purchased: { balance_usd: "25" },
    },
    rows: [["ollama-cloud.session", null, "Session", "session", 20, "2026-10-01T07:00:00.000Z"]],
    error: "bad_response",
    errorLines: [
      "Ollama Cloud: Weekly: ignored invalid remaining percent",
      "Ollama Cloud: Purchased credits: ignored invalid balance",
    ],
  },
  {
    name: "reports an included shape it does not know as a bad response",
    reply: { included: { monthly: {} }, purchased: { balance_usd: 25 } },
    rows: [OLLAMA_PURCHASED_ROW],
    error: "bad_response",
    errorLines: ["Ollama Cloud: Included: invalid, expected credits or session and weekly limits"],
  },
  {
    name: "shows no data for a plan without an included allowance or purchased credits",
    reply: { included: { balance_usd: 0, allowance_usd: 0 } },
    rows: [],
    error: "no_data",
    errorLines: [OLLAMA_NO_DATA],
  },
  {
    name: "shows no data for an empty reply",
    reply: {},
    rows: [],
    error: "no_data",
    errorLines: [OLLAMA_NO_DATA],
  },
  {
    name: "shows no data for the retired /api/usage reply",
    reply: { limits: { session: { usage: 0.25 }, weekly: { usage: 0.4 } } },
    rows: [],
    error: "no_data",
    errorLines: [OLLAMA_NO_DATA],
  },
]);

it("dates Ollama Cloud's monthly row from the included period", async () => {
  setKey("ollama-cloud");
  fakeHttp(() => OLLAMA_CREDIT_PLAN);

  const fetched = await fetchRows(ollamaCloudProvider);

  expect(fetched.rows[0]).toMatchObject({
    id: "ollama-cloud.monthly",
    windowStartedAt: "2026-09-15T09:30:00.000Z",
    resetsAt: "2026-10-15T09:30:00.000Z",
    remaining: { decimal: "72.5" },
  });
  expect(fetched.debug).toEqual(
    expect.arrayContaining([
      { key: "included_balance_usd", value: "72.5" },
      { key: "included_allowance_usd", value: "100" },
      { key: "included_period_from", value: "2026-09-15T09:30:00.000Z" },
      { key: "included_period_until", value: "2026-10-15T09:30:00.000Z" },
      { key: "purchased_balance_usd", value: "25" },
    ]),
  );
});

describeVendor("deepseek", [
  {
    name: "shows each balance component with its exact decimal",
    reply: {
      is_available: true,
      balance_infos: [
        {
          currency: "USD",
          total_balance: "12.340000000000000001",
          granted_balance: "2.00",
          topped_up_balance: "10.340000000000000001",
        },
      ],
    },
    rows: [
      ["deepseek.total_balance.usd", null, "Balance", null, "12.340000000000000001 USD", null],
      ["deepseek.granted_balance.usd", null, "Granted", null, "2.00 USD", null],
      [
        "deepseek.topped_up_balance.usd",
        null,
        "Topped up",
        null,
        "10.340000000000000001 USD",
        null,
      ],
    ],
  },
  {
    // Without a total, the availability flag stands in for it.
    name: "keeps valid components and reports malformed decimals instead of reading them as zero",
    reply: {
      is_available: true,
      balance_infos: [
        {
          currency: "USD",
          total_balance: "12.34\u001b[31m",
          granted_balance: "1.2345678901234567890",
          topped_up_balance: "not-a-number",
        },
      ],
    },
    rows: [
      ["deepseek.granted_balance.usd", null, "Granted", null, "1.2345678901234567890 USD", null],
      ["deepseek.available", null, "Available", null, true, null],
    ],
    error: "bad_response",
    errorLines: [
      "DeepSeek USD: total_balance returned an invalid decimal",
      "DeepSeek USD: topped_up_balance returned an invalid decimal",
    ],
  },
  {
    name: "keeps CNY in any case and skips unsupported currencies",
    reply: {
      is_available: true,
      balance_infos: [
        { currency: "EUR", total_balance: "9.99" },
        { currency: "cny", total_balance: "88.00" },
      ],
    },
    rows: [["deepseek.total_balance.cny", null, "Balance", null, "88.00 CNY", null]],
  },
  {
    name: "shows only the availability flag when no balance is reported",
    reply: { is_available: false, balance_infos: [] },
    rows: [["deepseek.available", null, "Available", null, false, null]],
  },
]);

describeVendor("openrouter", [
  {
    name: "shows a key with a limit as the budget left",
    reply: () => jsonReply({ data: { usage: 2, limit: 10, limit_remaining: 8 } }),
    rows: [["openrouter.key", null, "Budget", null, 80, null]],
  },
  {
    // `limit_remaining` covers the limit window; `usage` is the key's lifetime total.
    name: "reads the budget left from limit_remaining, not lifetime usage",
    reply: () => jsonReply({ data: { usage: 50, limit: 10, limit_remaining: 7.5 } }),
    rows: [["openrouter.key", null, "Budget", null, 75, null]],
  },
  {
    name: "shows a key without a limit as its spend",
    reply: () => jsonReply({ data: { usage: 3.5, limit: null, limit_remaining: null } }),
    rows: [["openrouter.key", null, "Spend", null, "$3.50", null]],
  },
  {
    name: "shows a key without a limit as this month's spend when the reply has it",
    reply: () =>
      jsonReply({
        data: { usage: 3.5, usage_monthly: 1.25, limit: null, limit_remaining: null },
      }),
    rows: [["openrouter.key", null, "This month", "month", "$1.25", null]],
  },
  {
    name: "rejects more left than the limit",
    reply: () => jsonReply({ data: { usage: 1, limit: 10, limit_remaining: 11 } }),
    rows: [],
    error: "bad_response",
    errorLines: ["OpenRouter: Invalid openrouter-key-v1 response"],
  },
]);

it.runIf(POSIX_IDENTITY_STORAGE)(
  "tells OpenRouter keys apart for the cache without holding the key",
  async () => {
    const policy = openRouterProvider.cachePolicy;
    if (policy.kind !== "resolved-auth") throw new Error("expected a resolved-auth policy");
    const identity = () => policy.resolveIdentity({} as never, {});
    await expect(identity()).resolves.toBeNull();

    setKey("openrouter");
    const first = await identity();
    process.env.OPENROUTER_API_KEY = "other-key";
    const second = await identity();

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(`${first} ${second}`).not.toContain(KEY);
  },
);

describe("DeepSeek and Ollama Cloud stored keys", () => {
  const STORED_KEY_VENDORS = [
    {
      id: "deepseek",
      reply: { balance_infos: [{ currency: "USD", total_balance: "1.00" }] },
      rowId: "deepseek.total_balance.usd",
    },
    { id: "ollama-cloud", reply: OLLAMA_CREDIT_PLAN, rowId: "ollama-cloud.monthly" },
  ] as const;

  /** The keys the requests were sent with, and the account of each row with `rowId`. */
  async function fetchKeysAndAccounts(id: VendorId, reply: unknown, rowId: string) {
    const http = fakeHttp(() => reply);
    const fetched = await fetchRows(VENDORS[id].provider);
    return {
      keys: http.mock.calls.map(([, init]) => requestHeader(init ?? {}, "Authorization")),
      accounts: fetched.rows.filter((row) => row.id === rowId).map((row) => row.account),
      error: fetched.error ?? null,
    };
  }

  it.each(STORED_KEY_VENDORS)("$id queries each stored key as its own account", async (vendor) => {
    world.storeLogins([
      keyLogin("work", vendor.id, "work-key", { label: "work", updated: 2 }),
      keyLogin("home", vendor.id, "home-key", { label: "home", updated: 1 }),
    ]);

    expect(await fetchKeysAndAccounts(vendor.id, vendor.reply, vendor.rowId)).toEqual({
      keys: ["Bearer work-key", "Bearer home-key"],
      accounts: ["work", "home"],
      error: null,
    });
  });

  it.each(STORED_KEY_VENDORS)(
    "$id leaves out a stored login that is not a usable key",
    async (vendor) => {
      world.storeLogins([
        keyLogin("empty", vendor.id, " ", { updated: 3 }),
        keyLogin("number", vendor.id, 42, { updated: 2 }),
        keyLogin("work", vendor.id, "work-key", { updated: 1 }),
      ]);

      expect(await fetchKeysAndAccounts(vendor.id, vendor.reply, vendor.rowId)).toEqual({
        keys: ["Bearer work-key"],
        accounts: [undefined],
        error: null,
      });
    },
  );

  it.each(STORED_KEY_VENDORS)(
    "$id uses an env key alone, before the stored keys",
    async (vendor) => {
      setKey(vendor.id);
      world.storeLogins([keyLogin("work", vendor.id, "work-key", { label: "work" })]);

      expect(await fetchKeysAndAccounts(vendor.id, vendor.reply, vendor.rowId)).toEqual({
        keys: [`Bearer ${KEY}`],
        accounts: [undefined],
        error: null,
      });
    },
  );
});

describe("availability and model matching", () => {
  // DeepSeek also counts a configured OpenCode provider; the rest need a key.
  it.each<[VendorId, boolean, boolean, boolean]>([
    ["deepseek", true, false, true],
    ["deepseek", false, true, true],
    ["deepseek", false, false, false],
    ["ollama-cloud", true, false, false],
    ["ollama-cloud", false, true, true],
    ["openrouter", true, false, false],
    ["openrouter", false, true, true],
  ])(
    "%s with an OpenCode provider %s and a key %s is available: %s",
    async (id, configured, withKey, expected) => {
      vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(configured);
      if (withKey) setKey(id);

      await expect(VENDORS[id].provider.isAvailable({} as never)).resolves.toBe(expected);
    },
  );

  it.each<[VendorId, string, boolean]>([
    ["deepseek", "deepseek/deepseek-chat", true],
    ["ollama-cloud", "ollama-cloud/gpt-oss:20b-cloud", true],
    ["ollama-cloud", "OLLAMA-CLOUD/gpt-oss:120b-cloud", true],
    ["ollama-cloud", "ollama/gpt-oss", false],
    ["openrouter", "openrouter/anthropic/claude", true],
    ...VENDOR_IDS.map((id): [VendorId, string, boolean] => [id, "openai/gpt-5", false]),
  ])("%s matches the model %s: %s", (id, model, expected) => {
    expect(VENDORS[id].provider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
