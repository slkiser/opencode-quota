/** Alibaba Token Plan as one module: the shared fake `bl` answers its usage, seat and auth commands. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import {
  clearAlibabaIdentityCacheForTests,
  ERROR_MESSAGES,
  NO_WINDOW_HINT,
} from "../src/lib/alibaba.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba.js";
import {
  AUTH_STATUS,
  exits,
  installCli,
  launch,
  PLATFORM,
  paths,
  replying,
  seatPage,
  SUPPORTED,
  useAlibabaCliFixture,
  WAITS,
} from "./helpers/alibaba-cli-fixture.js";
import { isLedgerRowKey } from "./helpers/provider-assertions.js";
import { rowSummary } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("node:child_process", () =>
  import("./helpers/alibaba-cli-fixture.js").then((fixture) => fixture.mockChildProcess()),
);

// The identity is mocked so the test reads the principal it was given, not a digest of the key.
const identityMocks = vi.hoisted(() => ({
  deriveIdentity: vi.fn(async (params: unknown) => `rai1_${JSON.stringify(params)}`),
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  deriveResolvedAuthIdentity: identityMocks.deriveIdentity,
}));

const RESET = "2024-05-01T20:53:20.000Z";

useAlibabaCliFixture();

beforeEach(() => {
  // `bl auth status` is memoised per process, so each case must start from its own reply.
  clearAlibabaIdentityCacheForTests();
  identityMocks.deriveIdentity.mockClear();
});

/** The provider's fetch, with the ledger-row-key check every provider fetch shares. */
async function fetchTokenPlan(requestTimeoutMs = 5_000) {
  const fetched = rowsFromProviderResult(
    "alibaba-token-plan",
    await alibabaTokenPlanProvider.fetch({
      workspaceRoot: paths.project,
      locationDirectory: paths.project,
      // The provider takes the user's timeout only when the settings say one is set.
      config: { requestTimeoutMs, requestTimeoutMsConfigured: true },
    } as never),
  );
  for (const row of fetched.rows) {
    expect(
      isLedgerRowKey("alibaba-token-plan", row.id.slice("alibaba-token-plan".length + 1)),
      row.id,
    ).toBe(true);
  }
  return fetched;
}

function seatJson(name: string, equity?: Record<string, number>): Record<string, unknown> {
  return { Status: "NORMAL", AccountName: name, ...(equity ? { EquityList: [equity] } : {}) };
}

const SEAT_RESET = new Date(1_792_742_400_000).toISOString();
const SEAT_CYCLE_START = new Date(1_790_150_400_000).toISOString();
const TEAM_LEAD_EQUITY = {
  CycleTotalValue: 250_000,
  CycleSurplusValue: 170_000,
  CycleStartTime: Date.parse(SEAT_CYCLE_START),
  CycleEndTime: Date.parse(SEAT_RESET),
};
const TEAM_LEAD = seatJson("team-lead", TEAM_LEAD_EQUITY);
const TEAM_LEAD_ROW = [
  "alibaba-token-plan.team.team_lead",
  "team-lead",
  "Credits",
  "month",
  "68 (80000 credit of 250000 credit)",
  SEAT_RESET,
];

const IDENTITY_CONTEXT = {
  workspaceRoot: "/home/user/project",
  config: { requestTimeoutMs: 5_000 },
};

function identityPolicy() {
  const policy = alibabaTokenPlanProvider.cachePolicy;
  if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");
  return policy;
}

describe("alibaba-token-plan provider", () => {
  it("is available from explicit selection or recognized runtime presence, never from the PATH", async () => {
    const selected = createProviderAvailabilityContext({
      providerIds: ["alibaba-token-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(selected)).resolves.toBe(SUPPORTED);

    const codingPlanOnly = createProviderAvailabilityContext({
      providerIds: ["alibaba", "alibaba-coding-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(codingPlanOnly)).resolves.toBe(false);

    const runtime = createProviderAvailabilityContext({
      configOverrides: { currentProviderID: "alibaba-token-plan" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(runtime)).resolves.toBe(SUPPORTED);

    const model = createProviderAvailabilityContext({
      configOverrides: { currentModel: "alibaba-token-plan/qwen3" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(model)).resolves.toBe(SUPPORTED);
  });

  it.each([
    ["alibaba-token-plan/qwen3", "alibaba-token-plan", true],
    ["alibaba/qwen3-coder", "alibaba", false],
    ["alibaba-coding-plan/qwen3", "alibaba-coding-plan", false],
    ["alibaba-token-plan/qwen3", undefined, true],
    ["alibaba/qwen3-coder", undefined, false],
  ])("matchesCurrentModel(%s, provider %s) -> %s", (model, currentProviderID, expected) => {
    const context = currentProviderID ? ({ currentProviderID } as never) : undefined;
    expect(alibabaTokenPlanProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });

  it.runIf(SUPPORTED)("never runs a bl from inside the project folder", async () => {
    installCli({ usage: replying({ per1MonthPercentage: 0.4 }) }, join(paths.project, "bin"));

    const fetched = await fetchTokenPlan();

    expect(fetched.rows).toEqual([]);
    expect(fetched.debug).toContainEqual({ key: "failure_kind", value: "executable_not_found" });
  });

  it.runIf(SUPPORTED).each([
    [
      "the monthly window, with its reset",
      { usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }) },
      [["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "monthly" }],
    ],
    [
      "the monthly window without a reset time",
      { usage: replying({ per1MonthPercentage: 0.5 }) },
      [["alibaba-token-plan.personal", "personal", "Monthly", "month", 50, null]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "monthly" }],
    ],
    [
      "a signed-in reply with no window, left blank rather than reported",
      { usage: replying({}) },
      [],
      undefined,
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "windows", value: "(none)" },
        { key: "window_hint", value: NO_WINDOW_HINT },
      ],
    ],
    [
      "a missing CLI, failing both commands",
      undefined,
      [],
      { code: "local_tool" },
      [
        { key: "cli_available", value: "false" },
        PLATFORM,
        { key: "failure_kind", value: "executable_not_found" },
        { key: "seat_failure_kind", value: "executable_not_found" },
        {
          key: "error",
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.executable_not_found}`,
        },
        { key: "error_kind", value: "local_tool" },
        {
          key: "error",
          value: `Alibaba Token Plan (team): ${ERROR_MESSAGES.executable_not_found}`,
        },
        { key: "error_kind", value: "local_tool" },
      ],
    ],
    [
      "an expired console sign-in, leaving the seats alone",
      { usage: exits(3) },
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        {
          key: "error",
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.not_authenticated}`,
        },
        { key: "error_kind", value: "login_expired" },
      ],
    ],
    [
      "the CLI's own reason for a rejected call, with the exit code as the error kind",
      {
        usage: {
          kind: "fails",
          code: 1,
          body: { error: { code: 1, message: "COMMON-2001 - the reply was rejected" } },
        },
      },
      [],
      { code: "provider_error" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "nonzero_exit" },
        {
          key: "error",
          value: "Alibaba Token Plan (personal): COMMON-2001 - the reply was rejected",
        },
        { key: "error_kind", value: "provider_error" },
      ],
    ],
    [
      "an expired sign-in whose words do not say so, decided by the exit code",
      {
        usage: {
          kind: "fails",
          code: 3,
          body: { error: { code: 3, message: "the session token was refused" } },
        },
      },
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        {
          key: "error",
          value: "Alibaba Token Plan (personal): the session token was refused",
        },
        { key: "error_kind", value: "login_expired" },
      ],
    ],
    [
      "a timeout",
      { usage: WAITS },
      [],
      { code: "timeout" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "timeout" },
        {
          key: "error",
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.timeout}`,
        },
        { key: "error_kind", value: "timeout" },
      ],
    ],
  ])("shows %s", async (name, script, rows, error, debug) => {
    if (script !== undefined) installCli(script);

    const fetched = await fetchTokenPlan(name === "a timeout" ? 300 : undefined);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    if (error) expect(fetched.error).toMatchObject(error);
    else expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual(debug);
  });

  it.runIf(SUPPORTED)(
    "gives the monthly row a start a calendar month before its reset",
    async () => {
      installCli({
        usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      });

      const fetched = await fetchTokenPlan();

      // The reply says when the month resets; its cycle is anchored on that day, so the start is
      // the same day a calendar month back.
      expect(fetched.rows[0]?.windowStartedAt).toBe("2024-04-01T20:53:20.000Z");
    },
  );

  it.runIf(SUPPORTED)("clamps the monthly start to the last day of a shorter month", async () => {
    installCli({
      usage: replying({
        per1MonthPercentage: 0.6,
        per1MonthResetTime: Date.parse("2024-03-31T00:00:00.000Z"),
      }),
    });

    const fetched = await fetchTokenPlan();

    // February 2024 has no 31st, so the start lands on the last day it has.
    expect(fetched.rows[0]?.windowStartedAt).toBe("2024-02-29T00:00:00.000Z");
  });

  it.runIf(SUPPORTED)(
    "shows a team seat row with the account name as its own account name",
    async () => {
      installCli({ seats: replying(seatPage([TEAM_LEAD])) });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
      expect(fetched.rows[0]?.account).toBe("team-lead");
      expect(fetched.rows[0]?.id).toBe("alibaba-token-plan.team.team_lead");
      // A personal reply with no window is an absence, so the seats stand alone and nothing fails.
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "windows", value: "(none)" },
        { key: "window_hint", value: NO_WINDOW_HINT },
        { key: "seat_windows", value: "credits" },
      ]);
    },
  );

  it.runIf(SUPPORTED)("shows both the personal window and the team seats", async () => {
    installCli({
      usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      seats: replying(seatPage([TEAM_LEAD])),
    });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([
      ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
      TEAM_LEAD_ROW,
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "monthly" },
      { key: "seat_windows", value: "credits" },
    ]);
  });

  it.runIf(SUPPORTED)("keeps a seat row whose cycle total is 0, through its amount", async () => {
    installCli({
      seats: replying(seatPage([seatJson("zero", { CycleTotalValue: 0, CycleSurplusValue: 0 })])),
    });

    const fetched = await fetchTokenPlan();

    // No percentage (the total is 0), but `amount` carries the surplus, so the row survives.
    expect(rowSummary(fetched.rows)).toEqual([
      [
        "alibaba-token-plan.team.zero",
        "zero",
        "Credits",
        "month",
        "0 credit (0 credit of 0 credit)",
        null,
      ],
    ]);
  });

  it.runIf(SUPPORTED)(
    "keeps a seat reporting a cycle total but no usage, with text instead of a dropped row",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("no-surplus", {
              CycleTotalValue: 250_000,
              CycleEndTime: Date.parse(SEAT_RESET),
            }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      // A limit alone is not a row value; without the text this row is dropped as `no value`.
      expect(fetched.rows.map((row) => [row.id, row.text, row.limit?.decimal])).toEqual([
        ["alibaba-token-plan.team.no_surplus", "no usage reported", "250000"],
      ]);
      expect(fetched.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
    },
  );

  // A CN team names its seats in Chinese; a slug drops every non-ASCII character, so the key is a
  // digest of the name rather than the name's position in the list.
  it.runIf(SUPPORTED)(
    "keeps a seat whose name is not plain ASCII, keying a name digest and texting the raw name",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("张三", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
            seatJson("John Doe", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
        ["alibaba-token-plan.team.seat_1d841bc0", "张三"],
        ["alibaba-token-plan.team.john_doe", "John Doe"],
      ]);
      expect(fetched.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
    },
  );

  it.runIf(SUPPORTED)(
    "keys a seat by its name, not its position, so a reorder keeps the same row",
    async () => {
      const seats = (names: readonly string[]) =>
        replying(
          seatPage(
            names.map((name) => seatJson(name, { CycleTotalValue: 100, CycleSurplusValue: 40 })),
          ),
        );
      const idsByAccount = (rows: readonly { account?: string; id: string }[]) =>
        Object.fromEntries(rows.map((row) => [row.account, row.id]));

      installCli({ seats: seats(["张三", "李四"]) });
      const first = await fetchTokenPlan();
      installCli({ seats: seats(["李四", "张三"]) });
      const second = await fetchTokenPlan();

      // Each name keeps its own key however the reply orders the seats.
      expect(idsByAccount(second.rows)).toEqual(idsByAccount(first.rows));
    },
  );

  it.runIf(SUPPORTED)(
    "keeps two seats that slug alike, giving each a name digest so neither id is shared",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("John Doe", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
            seatJson("John-Doe", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
        ["alibaba-token-plan.team.john_doe_6cea57c2", "John Doe"],
        ["alibaba-token-plan.team.john_doe_7679aa58", "John-Doe"],
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "drops the second of two identically named seats, as a repeated row",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("team-lead", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
            seatJson("team-lead", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      expect(fetched.rows.map((row) => row.id)).toEqual(["alibaba-token-plan.team.team_lead"]);
      expect(fetched.debug.filter((item) => item.key === "dropped_row")).toEqual([
        { key: "dropped_row", value: "alibaba-token-plan.team.team_lead: repeated row" },
      ]);
    },
  );

  it.runIf(SUPPORTED)("keeps the personal row when only the seat command fails", async () => {
    installCli({
      usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      seats: exits(3),
    });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([
      ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
    ]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "monthly" },
      { key: "seat_failure_kind", value: "seat_not_authenticated" },
      {
        key: "error",
        value: `Alibaba Token Plan (team): ${ERROR_MESSAGES.seat_not_authenticated}`,
      },
      { key: "error_kind", value: "login_expired" },
    ]);
  });

  it.runIf(SUPPORTED)("keeps the team seats when only the personal command fails", async () => {
    installCli({ usage: exits(3), seats: replying(seatPage([TEAM_LEAD])) });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "failure_kind", value: "not_authenticated" },
      { key: "seat_windows", value: "credits" },
      { key: "error", value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.not_authenticated}` },
      { key: "error_kind", value: "login_expired" },
    ]);
  });

  it.runIf(SUPPORTED)(
    "leaves out the personal account an AK/SK-only user never set up",
    async () => {
      installCli({
        usage: exits(3),
        seats: replying(seatPage([TEAM_LEAD])),
        auth: replying(AUTH_STATUS.seatOnly),
      });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        { key: "seat_windows", value: "credits" },
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "gives a seat row the cycle's start, so its window has an exact span",
    async () => {
      installCli({ seats: replying(seatPage([TEAM_LEAD])) });

      const fetched = await fetchTokenPlan();

      // A month-long window has no fixed length, so the pace of a row needs the start it reports.
      expect(fetched.rows[0]?.windowStartedAt).toBe(SEAT_CYCLE_START);
      expect(fetched.rows[0]?.resetsAt).toBe(SEAT_RESET);
    },
  );

  it.runIf(SUPPORTED)("leaves out the team account a console-only user never set up", async () => {
    installCli({
      usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      seats: exits(3),
      auth: replying(AUTH_STATUS.consoleOnly),
    });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([
      ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "monthly" },
      { key: "seat_failure_kind", value: "seat_not_authenticated" },
    ]);
  });

  // `bl auth status` is memoised for 60 s while each command runs live, so a marker can lag the
  // command it describes: a half it calls absent may still have answered with rows.
  it.runIf(SUPPORTED)(
    "shows the personal window a stale identity read called the console half absent",
    async () => {
      installCli({
        usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
        auth: replying(AUTH_STATUS.seatOnly),
      });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([
        ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
      ]);
      expect(fetched.error).toBeUndefined();
    },
  );

  it.runIf(SUPPORTED)(
    "shows the team seats a stale identity read called the OpenAPI half absent",
    async () => {
      installCli({
        seats: replying(seatPage([TEAM_LEAD])),
        auth: replying(AUTH_STATUS.consoleOnly),
      });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
      expect(fetched.error).toBeUndefined();
    },
  );

  it.runIf(SUPPORTED)(
    "still reports both halves when the account names neither credential",
    async () => {
      // A read that failed looks the same to a provider that cannot tell absence from failure.
      installCli({ usage: exits(3), seats: exits(3), auth: replying(AUTH_STATUS.neither) });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([]);
      expect(fetched.error).toMatchObject({ code: "login_expired" });
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        { key: "seat_failure_kind", value: "seat_not_authenticated" },
        {
          key: "error",
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.not_authenticated}`,
        },
        { key: "error_kind", value: "login_expired" },
        {
          key: "error",
          value: `Alibaba Token Plan (team): ${ERROR_MESSAGES.seat_not_authenticated}`,
        },
        { key: "error_kind", value: "login_expired" },
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "keys the account on the access key id, so a replaced console token keeps the slot",
    async () => {
      installCli({ auth: replying(AUTH_STATUS.both) });

      await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);

      // A key id does not rotate, so the slot survives the console token being replaced.
      expect(identityMocks.deriveIdentity).toHaveBeenCalledWith({
        providerId: "alibaba-token-plan",
        principal: { kind: "stable-id", value: "LTAI...k9Pw" },
      });
    },
  );

  it.runIf(SUPPORTED)(
    "falls back to the console token when the CLI reports no access key id",
    async () => {
      installCli({ auth: replying(AUTH_STATUS.consoleOnly) });

      await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);

      expect(identityMocks.deriveIdentity).toHaveBeenCalledWith({
        providerId: "alibaba-token-plan",
        principal: { kind: "credential", value: "9f2c...d41a" },
      });
    },
  );

  it.runIf(SUPPORTED)(
    "keeps the account when the console token rotates, and moves it when the account does",
    async () => {
      const principalFor = async (markers: Record<string, unknown>) => {
        installCli({ auth: replying(markers) });
        clearAlibabaIdentityCacheForTests();
        identityMocks.deriveIdentity.mockClear();
        await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);
        return identityMocks.deriveIdentity.mock.calls[0]?.[0];
      };

      const original = await principalFor(AUTH_STATUS.both);
      // The CLI replaces the console token when it expires; the account behind it does not move.
      expect(await principalFor({ ...AUTH_STATUS.both, console: { masked: "rotated" } })).toEqual(
        original,
      );
      expect(await principalFor({ ...AUTH_STATUS.both, api_key: { masked: "other" } })).toEqual(
        original,
      );
      expect(
        await principalFor({ ...AUTH_STATUS.both, openapi: { access_key_id: "other" } }),
      ).not.toEqual(original);
    },
  );

  it.runIf(SUPPORTED)(
    "has no identity without a credential, so the store keeps the rows in memory only",
    async () => {
      installCli({ auth: replying(AUTH_STATUS.neither) });

      await expect(
        identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never),
      ).resolves.toBeNull();
      expect(identityMocks.deriveIdentity).not.toHaveBeenCalled();
    },
  );

  it.runIf(SUPPORTED)(
    "reads `bl auth status` once for a fetch and the identity together, through the same memo",
    async () => {
      const log = join(paths.root, "auth-status.log");
      installCli({ auth: replying(AUTH_STATUS.both, log) });

      await fetchTokenPlan();
      await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);

      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["auth status"]);
    },
  );

  // The seam: the provider spawns through its own `runAlibabaTokenPlanProcess`, so a row appears
  // only after the declared document travelled argv, pipes, parsers and arithmetic.
  it.runIf(SUPPORTED)(
    "drives the provider's own process runner from the declared replies",
    async () => {
      installCli({
        usage: replying({ per1MonthPercentage: 0.25, per1MonthResetTime: Date.parse(RESET) }),
      });

      const fetched = await fetchTokenPlan();

      const commands = launch.calls.map((call) => call.args.join(" ")).sort();
      expect(commands).toEqual(
        [
          "usage token-plan --output json",
          "token-plan list-seats --status NORMAL --query-assigned true --page-size 100 --output json",
          "auth status --output json",
        ].sort(),
      );
      for (const call of launch.calls) {
        expect(call.options.shell).toBe(false);
        expect(call.options.detached).toBe(true);
        expect(call.options.env?.PATH).toContain(join(paths.root, "bin"));
      }
      // Only the provider's runner attaches a stdout reader, so a pipe with one is the runner reading
      // the declared chunks. The POSIX path spawns a real `bl`, so there are no fake pipes to check.
      if (process.platform === "win32") {
        expect(launch.pipes.every((pipe) => pipe.listenerCount("data") === 1)).toBe(true);
      }

      // 0.25 used is 75% left: the arithmetic ran on the faked chunks, unmodified.
      expect(rowSummary(fetched.rows)).toEqual([
        ["alibaba-token-plan.personal", "personal", "Monthly", "month", 75, RESET],
      ]);
    },
  );
});
