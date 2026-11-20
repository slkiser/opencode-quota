import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { devinProvider } from "../src/providers/devin.js";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import {
  fakeHttp,
  fetchRows,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

const DEFAULT_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const NOW = Date.parse("2026-11-15T02:00:00.000Z");
const DAILY_RESET = Date.parse("2026-11-15T08:00:00.000Z") / 1000;
const WEEKLY_RESET = Date.parse("2026-11-22T08:00:00.000Z") / 1000;
const TOKEN = "devin-session-token$header.payload.signature";

/** A stored Devin sign-in; `value` fields replace the defaults. */
function devinLogin(
  id: string,
  value: Record<string, unknown> = {},
  fields: Partial<CredentialDatabaseRow> = {},
): CredentialDatabaseRow {
  return {
    id,
    integrationId: "devin",
    active: null,
    updated: 1,
    value: { type: "oauth", access: TOKEN, refresh: "", ...value },
    ...fields,
  };
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = BigInt(value);
  while (rest > 127n) {
    bytes.push(Number(rest & 127n) | 128);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
}

const number = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const message = (field: number, body: readonly number[]) => [
  ...varint((field << 3) | 2),
  ...varint(body.length),
  ...body,
];
const text = (field: number, value: string) => message(field, [...new TextEncoder().encode(value)]);

/** A 32-bit and a 64-bit value (fields 4 and 5), as the model list of a real reply has. */
const FIXED_WIDTH_FIELDS = [(4 << 3) | 5, 0, 0, 128, 63, (5 << 3) | 1, 0, 0, 0, 0, 0, 0, 240, 63];

type Plan = {
  name?: string;
  dailyLeft?: number;
  weeklyLeft?: number;
  dailyReset?: number;
  weeklyReset?: number;
  /** The account's email; a team id goes with it. */
  account?: string;
};

/** A GetUserStatus reply: the plan status, among fields of other kinds the reader must skip. */
function userStatus(plan: Plan | null): Response {
  const planStatus = plan && [
    ...message(1, [...number(1, 17), ...(plan.name ? text(2, plan.name) : [])]),
    ...message(2, number(1, 1_794_534_043)),
    ...number(8, 7),
    ...(plan.dailyLeft === undefined ? [] : number(14, plan.dailyLeft)),
    ...(plan.weeklyLeft === undefined ? [] : number(15, plan.weeklyLeft)),
    ...(plan.dailyReset === undefined ? [] : number(17, plan.dailyReset)),
    ...(plan.weeklyReset === undefined ? [] : number(18, plan.weeklyReset)),
  ];
  const body = message(1, [
    ...text(3, "someone"),
    ...(plan?.account ? [...text(5, `team-of-${plan.account}`), ...text(7, plan.account)] : []),
    ...FIXED_WIDTH_FIELDS,
    ...(planStatus ? message(13, planStatus) : []),
  ]);
  return new Response(Uint8Array.from(body));
}

const PRO: Plan = {
  name: "Pro",
  dailyLeft: 80,
  weeklyLeft: 63,
  dailyReset: DAILY_RESET,
  weeklyReset: WEEKLY_RESET,
};

describe("Devin provider", () => {
  const world = useProviderWorld();

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  it.each([
    ["no login", []],
    ["only an API key login", [devinLogin("a", { type: "api", key: TOKEN })]],
    ["a login whose token is not a Devin session token", [devinLogin("a", { access: "other" })]],
  ])("is not configured with %s", async (_name, logins) => {
    world.storeLogins(logins);
    const http = fakeHttp(() => userStatus(PRO));

    await expect(devinProvider.isAvailable({} as never)).resolves.toBe(false);
    await expect(fetchRows(devinProvider)).resolves.toEqual({
      rows: [],
      error: { code: "not_configured" },
      debug: [],
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("reads the daily and weekly quota with the stored login's token", async () => {
    world.storeLogins([devinLogin("cred_1")]);
    const http = fakeHttp(() => userStatus(PRO));

    await expect(devinProvider.isAvailable({} as never)).resolves.toBe(true);
    const fetched = await fetchRows(devinProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["devin.daily", "Pro", "Daily", "day", 80, "2026-11-15T08:00:00.000Z"],
      ["devin.weekly", "Pro", "Weekly", "week", 63, "2026-11-22T08:00:00.000Z"],
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.rowLogins).toEqual(["cred_1", "cred_1"]);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0] ?? [];
    expect(url).toBe(DEFAULT_URL);
    expect(init?.method).toBe("POST");
    expect(requestHeader(init, "Content-Type")).toBe("application/proto");
    expect(requestHeader(init, "Connect-Protocol-Version")).toBe("1");
    // The token travels in the request body, never in a header.
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toContain(TOKEN);
    expect(JSON.stringify(init?.headers)).not.toContain(TOKEN);
  });

  it.each(["Max", "max"])("shows only the weekly quota on the %s plan", async (name) => {
    world.storeLogins([devinLogin("cred_1")]);
    fakeHttp(() => userStatus({ ...PRO, name, dailyLeft: 99, dailyReset: WEEKLY_RESET }));

    const fetched = await fetchRows(devinProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["devin.weekly", name, "Weekly", "week", 63, "2026-11-22T08:00:00.000Z"],
    ]);
  });

  it.each([
    [
      "a used-up window (no percent, only a reset time)",
      { name: "Pro", weeklyLeft: 40, dailyReset: DAILY_RESET, weeklyReset: WEEKLY_RESET },
      [
        ["devin.daily", "Pro", "Daily", "day", 0, "2026-11-15T08:00:00.000Z"],
        ["devin.weekly", "Pro", "Weekly", "week", 40, "2026-11-22T08:00:00.000Z"],
      ],
    ],
    [
      "a window without a reset time",
      { name: "Pro", dailyLeft: 100, weeklyLeft: 100 },
      [
        ["devin.daily", "Pro", "Daily", "day", 100, null],
        ["devin.weekly", "Pro", "Weekly", "week", 100, null],
      ],
    ],
    [
      "a plan without a name",
      { weeklyLeft: 12, weeklyReset: WEEKLY_RESET },
      [["devin.weekly", null, "Weekly", "week", 12, "2026-11-22T08:00:00.000Z"]],
    ],
  ])("reads %s", async (_name, plan, rows) => {
    world.storeLogins([devinLogin("cred_1")]);
    fakeHttp(() => userStatus(plan));

    expect(rowSummary((await fetchRows(devinProvider)).rows)).toEqual(rows);
  });

  it("gives each login its own rows, named after its plan", async () => {
    world.storeLogins([
      devinLogin("cred_1", { access: `${TOKEN}-1` }, { label: "Work", active: 1 }),
      devinLogin("cred_2", { access: `${TOKEN}-2` }, { label: "Home" }),
    ]);
    fakeHttp((_url, init) =>
      userStatus(
        new TextDecoder().decode(init.body as Uint8Array).includes(`${TOKEN}-1`)
          ? { ...PRO, name: "Max", account: "work@example.com" }
          : { ...PRO, account: "home@example.com" },
      ),
    );

    const fetched = await fetchRows(devinProvider);

    expect(
      rowSummary(fetched.rows).map(([id, account, , , value]) => [id, account, value]),
    ).toEqual([
      ["devin.weekly", "Work (Max)", 63],
      ["devin.daily", "Home (Pro)", 80],
      ["devin.weekly", "Home (Pro)", 63],
    ]);
  });

  it("shows an account once when it is signed in twice, from the login OpenCode uses", async () => {
    world.storeLogins([
      devinLogin("cred_old", { access: `${TOKEN}-1` }, { label: "Devin" }),
      devinLogin("cred_new", { access: `${TOKEN}-2` }, { label: "Devin 2", active: 1 }),
    ]);
    const http = fakeHttp(() => userStatus({ ...PRO, name: "Max", account: "me@example.com" }));

    const fetched = await fetchRows(devinProvider);

    expect(
      rowSummary(fetched.rows).map(([id, account, , , value]) => [id, account, value]),
    ).toEqual([["devin.weekly", "Devin 2 (Max)", 63]]);
    expect(fetched.rowLogins).toEqual(["cred_new"]);
    expect(http).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetched)).not.toContain("me@example.com");
  });

  it("keeps a failed login beside a working one", async () => {
    world.storeLogins([
      devinLogin("cred_1", { access: `${TOKEN}-1` }, { label: "Work", active: 1 }),
      devinLogin("cred_2", { access: `${TOKEN}-2` }, { label: "Home" }),
    ]);
    fakeHttp((_url, init) =>
      new TextDecoder().decode(init.body as Uint8Array).includes(`${TOKEN}-1`)
        ? userStatus({ ...PRO, account: "work@example.com" })
        : new Response("denied", { status: 401 }),
    );

    const fetched = await fetchRows(devinProvider);

    expect(fetched.rows.map((row) => row.id)).toEqual(["devin.daily", "devin.weekly"]);
    expect(fetched.error).toMatchObject({ code: "login_expired", status: 401 });
  });

  it("asks the tenant's own API server when the login names one", async () => {
    world.storeLogins([
      devinLogin("cred_1", { metadata: { apiServerUrl: "https://tenant.example.com/" } }),
    ]);
    const http = fakeHttp(() => userStatus(PRO));

    await fetchRows(devinProvider);

    expect(http.mock.calls.map(([url]) => url)).toEqual([
      "https://tenant.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    ]);
  });

  it.each([
    "http://tenant.example.com",
    "https://user:pass@tenant.example.com",
    "https://tenant.example.com/path",
    "https://tenant.example.com/?x=1",
    "not a url",
  ])("never sends the token to %s", async (apiServerUrl) => {
    world.storeLogins([devinLogin("cred_1", { metadata: { apiServerUrl } })]);
    const http = fakeHttp(() => userStatus(PRO));

    await fetchRows(devinProvider);

    expect(http.mock.calls.map(([url]) => url)).toEqual([DEFAULT_URL]);
  });

  it.each([
    [401, "login_expired"],
    [403, "login_expired"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ])("reports HTTP %i as %s without the token", async (status, code) => {
    world.storeLogins([devinLogin("cred_1")]);
    fakeHttp(() => new Response(`{"message":"rejected ${TOKEN}"}`, { status }));

    const fetched = await fetchRows(devinProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code, status });
    expect(JSON.stringify(fetched)).not.toContain(TOKEN);
  });

  it.each([
    ["no plan status", () => userStatus(null), "no_data"],
    ["a plan without quota windows", () => userStatus({ name: "Enterprise" }), "no_data"],
    ["a reply that is cut short", () => new Response(Uint8Array.from([10, 40, 1])), "bad_response"],
    ["a percent above 100", () => userStatus({ ...PRO, weeklyLeft: 250 }), "bad_response"],
    [
      "a reset time out of range",
      () => userStatus({ ...PRO, weeklyReset: Number.MAX_SAFE_INTEGER }),
      "bad_response",
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
      "network",
    ],
  ])("reports %s", async (_name, reply, code) => {
    world.storeLogins([devinLogin("cred_1")]);
    fakeHttp(reply);

    const fetched = await fetchRows(devinProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code });
  });

  it.each([
    ["devin/claude-opus-5-5", undefined, true],
    ["openai/gpt-5", undefined, false],
    ["anything", "devin", true],
    ["devin/claude-opus-5-5", "openai", false],
  ])("matches the model %s with provider %s: %s", (model, currentProviderID, expected) => {
    const context = currentProviderID
      ? { enabledProviders: "auto" as const, currentProviderID }
      : undefined;
    expect(devinProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });
});
