import { describe, expect, it } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import type { CredentialRow } from "../src/lib/opencode-auth.js";
import {
  FIVE_HOUR,
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "../src/providers/contract.js";
import { fetchStoredKeys } from "../src/providers/key-vendor.js";

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");

function login(id: string, label: string, active = false): { row: CredentialRow } {
  return { row: { id, integrationId: "openai", label, active, value: { type: "oauth" } } };
}

const FIVE_HOUR_ROW = quotaRow({
  ...FIVE_HOUR,
  percentRemaining: 40,
  resetsAt: "2026-01-01T15:00:00.000Z",
  windowStartedAt: "2026-01-01T10:00:00.000Z",
});

describe("fetchEachLogin", () => {
  it("fetches every login, names each account like OpenCode lists it, and skips empty ones", async () => {
    const accounts = await fetchEachLogin({
      providerName: "OpenAI",
      logins: [login("a", "Work", true), login("b", "Work"), login("c", ""), login("d", "")],
      async fetchLogin({ row }) {
        if (row.id === "c") return null;
        return {
          rows: [FIVE_HOUR_ROW],
          errors: row.id === "b" ? [{ message: "partial" }] : [],
          ...(row.id === "a" ? { fallbackName: "OpenAI (Pro)" } : {}),
        };
      },
    });

    expect(accounts.map(({ name, login, errors }) => [name, login, errors])).toEqual([
      ["[OpenAI Work] (Pro) (active)", "a", []],
      ["[OpenAI Work 2]", "b", [{ message: "partial" }]],
      ["[OpenAI]", "d", []],
    ]);
  });
});

describe("fetchStoredKeys", () => {
  const logins = [
    { row: login("a", "Work").row, auth: { state: "configured" as const, apiKey: "good" } },
    { row: login("b", "").row, auth: { state: "invalid" as const, error: "key is empty" } },
    { row: login("c", "Home").row, auth: { state: "configured" as const, apiKey: "bad" } },
  ];

  it.each([
    [false, ["[Kimi Work]", "[Kimi]", "[Kimi Home]"]],
    [true, ["[Kimi]", "[Kimi Work]", "[Kimi Home]"]],
  ])("with brokenFirst %s lists the accounts %j", async (brokenFirst, names) => {
    const { attempted, accounts } = await fetchStoredKeys({
      providerName: "Kimi",
      keys: { envOrConfig: null, logins, broken: null },
      brokenFirst,
      async fetchKey(apiKey) {
        return apiKey === "bad"
          ? { rows: [], errors: [{ message: "HTTP 500" }] }
          : { rows: [FIVE_HOUR_ROW], errors: [] };
      },
    });

    expect(attempted).toBe(true);
    expect(accounts.map((account) => account.name)).toEqual(names);
    expect(accounts.find((account) => account.login === "b")?.errors).toEqual([
      { message: "key is empty" },
    ]);
  });

  it.each([
    ["the broken first login as the one error", 'Unsupported Kimi auth type: "oauth"', true],
    ["nothing to attempt without a login", null, false],
  ])("shows %s", async (_name, broken, attempted) => {
    const fetched = await fetchStoredKeys({
      providerName: "Kimi",
      keys: { envOrConfig: null, logins: [], broken },
      brokenFirst: true,
      fetchKey: async () => ({ rows: [FIVE_HOUR_ROW], errors: [] }),
    });

    expect(fetched).toEqual({
      attempted,
      accounts: broken ? [{ name: "Kimi", rows: [], errors: [{ message: broken }] }] : [],
    });
  });
});

describe("rowsFromProviderResult on the row contract", () => {
  it("adds ids, accounts and logins, then reads the errors", () => {
    const result: ProviderFetchResult = {
      attempted: true,
      accounts: [
        { name: "[Claude Work] (active)", login: "work-id", rows: [FIVE_HOUR_ROW], errors: [] },
        {
          name: "[Claude Home]",
          login: "home-id",
          rows: [FIVE_HOUR_ROW, FIVE_HOUR_ROW, { ...FIVE_HOUR_ROW, key: "Bad Key" }],
          errors: [{ message: "HTTP 429 slow down" }],
        },
      ],
      debug: [{ key: "api_key", value: "sk-secret" }],
    };

    const fetched = rowsFromProviderResult("anthropic", result, NOW_MS);

    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["anthropic.five_hour", "Work"],
      ["anthropic.five_hour", "Home"],
    ]);
    expect(fetched.rowLogins).toEqual(["work-id", "home-id"]);
    expect(fetched.error).toMatchObject({ code: "rate_limited" });
    expect(fetched.debug).toEqual([
      { key: "api_key", value: "[redacted]" },
      { key: "dropped_row", value: "anthropic.five_hour: repeated row" },
      { key: "dropped_row", value: "anthropic.Bad Key: invalid id" },
      { key: "error", value: "[Claude Home]: HTTP 429 slow down" },
      { key: "error_kind", value: "rate_limited, http 429" },
    ]);
  });

  it("reports a provider that had nothing to query as not set up", () => {
    expect(
      rowsFromProviderResult("anthropic", { attempted: false, accounts: [], debug: [] }, NOW_MS),
    ).toEqual({ rows: [], error: { code: "not_configured" }, debug: [] });
  });
});

describe("each row kind as a v6 row", () => {
  const ROWS: Array<[string, ProviderRow]> = [
    ["a percent row with its window start", FIVE_HOUR_ROW],
    [
      "a budget with used and limit",
      {
        ...quotaRow({
          key: "additional_budget",
          label: "Budget",
          window: "month",
          percentRemaining: 80,
        }),
        type: "budget",
        authority: "locally_derived",
        used: { decimal: "0.2", unit: { kind: "currency", code: "USD" } },
        limit: { decimal: "1", unit: { kind: "currency", code: "USD" } },
      },
    ],
    [
      "a text row without a window",
      {
        key: "status",
        label: "Status",
        type: "status",
        method: "local_estimation",
        authority: "locally_derived",
        prominence: "primary",
        text: "ChatGPT quota unavailable for API key",
      },
    ],
    [
      "an amount",
      {
        key: "balance",
        label: "Balance",
        type: "balance",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "supplementary",
        amount: { decimal: "8.25", unit: { kind: "currency", code: "USD" } },
      },
    ],
    [
      "a flag",
      {
        key: "available",
        label: "Available",
        type: "status",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        flag: true,
      },
    ],
  ];

  it.each(ROWS)("keeps %s", (_name, row) => {
    const result: ProviderFetchResult = {
      attempted: true,
      accounts: [{ name: "[Copilot alice] (pro)", login: "alice-id", rows: [row], errors: [] }],
      debug: [{ key: "billing_scope", value: "user" }],
    };
    const { key, ...fields } = row;

    expect(rowsFromProviderResult("copilot", result, NOW_MS)).toEqual({
      rows: [{ ...fields, id: `copilot.${key}`, providerId: "copilot", account: "alice (pro)" }],
      rowLogins: ["alice-id"],
      debug: [{ key: "billing_scope", value: "user" }],
    });
  });
});
