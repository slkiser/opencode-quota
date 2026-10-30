/** Alibaba Coding Plan from the shared fake `bl`: one console command, rows from the windows it reports. */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import { clearAlibabaIdentityCacheForTests, ERROR_MESSAGES } from "../src/lib/alibaba.js";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba.js";
import {
  exits,
  installCli,
  launch,
  PLATFORM,
  paths,
  replying,
  SUPPORTED,
  useAlibabaCliFixture,
} from "./helpers/alibaba-cli-fixture.js";
import { isLedgerRowKey } from "./helpers/provider-assertions.js";
import { rowSummary } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("node:child_process", () =>
  import("./helpers/alibaba-cli-fixture.js").then((fixture) => fixture.mockChildProcess()),
);

useAlibabaCliFixture();

beforeEach(() => {
  // `bl auth status` is memoised per process, so each case must start from its own reply.
  clearAlibabaIdentityCacheForTests();
});

const FIVE_HOUR_RESET = "2026-08-04T15:00:00.000Z";
const WEEKLY_RESET = "2026-08-09T00:00:00.000Z";
const MONTHLY_RESET = "2026-09-01T00:00:00.000Z";

/** The CLI's own reply shape, invented values: the three windows and the plan tier. */
const USAGE = {
  instanceType: "pro",
  per5Hour: {
    usedQuota: 38,
    totalQuota: 100,
    percentage: 0.38,
    resetTime: Date.parse(FIVE_HOUR_RESET),
  },
  perWeek: {
    usedQuota: 500,
    totalQuota: 1000,
    percentage: 0.5,
    resetTime: Date.parse(WEEKLY_RESET),
  },
  perBillMonth: {
    usedQuota: 950,
    totalQuota: 1000,
    percentage: 0.95,
    resetTime: Date.parse(MONTHLY_RESET),
  },
};

const USAGE_ROWS = [
  [
    "alibaba-coding-plan.five_hour",
    null,
    "5h",
    "five_hour",
    "62 (38 request of 100 request)",
    FIVE_HOUR_RESET,
  ],
  [
    "alibaba-coding-plan.weekly",
    null,
    "Weekly",
    "week",
    "50 (500 request of 1000 request)",
    WEEKLY_RESET,
  ],
  [
    "alibaba-coding-plan.monthly",
    null,
    "Monthly",
    "month",
    "5 (950 request of 1000 request)",
    MONTHLY_RESET,
  ],
];

/** The provider's fetch, rows and accounts both: one call, with the shared ledger-row-key check. */
async function fetchCodingPlan(requestTimeoutMs = 5_000) {
  const result = await alibabaCodingPlanProvider.fetch({
    workspaceRoot: paths.project,
    config: { requestTimeoutMs, requestTimeoutMsConfigured: true },
  } as never);
  const fetched = rowsFromProviderResult("alibaba-coding-plan", result);
  for (const row of fetched.rows) {
    expect(
      isLedgerRowKey("alibaba-coding-plan", row.id.slice("alibaba-coding-plan".length + 1)),
      row.id,
    ).toBe(true);
  }
  return { ...fetched, accounts: result.accounts };
}

describe("alibaba-coding-plan provider", () => {
  it("is available from explicit selection or an Alibaba model, never from the PATH", async () => {
    const selected = createProviderAvailabilityContext({
      providerIds: ["alibaba-coding-plan"],
    });
    await expect(alibabaCodingPlanProvider.isAvailable(selected)).resolves.toBe(SUPPORTED);

    const other = createProviderAvailabilityContext({ providerIds: ["openai"] });
    await expect(alibabaCodingPlanProvider.isAvailable(other)).resolves.toBe(false);

    const model = createProviderAvailabilityContext({
      configOverrides: { currentModel: "alibaba/qwen3-coder-plus" },
    });
    await expect(alibabaCodingPlanProvider.isAvailable(model)).resolves.toBe(SUPPORTED);
  });

  it.each([
    ["alibaba/qwen3-coder", undefined, true],
    ["alibaba-cn/qwen3-coder", undefined, true],
    ["openai/gpt-5", undefined, false],
    ["anything", "alibaba-coding-plan", true],
    ["anything", "alibaba-coding-plan-cn", true],
    ["anything", "alibaba", true],
    ["alibaba/qwen3-coder", "alibaba-token-plan", false],
  ])("matchesCurrentModel(%s, provider %s) -> %s", (model, currentProviderID, expected) => {
    const context = currentProviderID ? ({ currentProviderID } as never) : undefined;
    expect(alibabaCodingPlanProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });

  it.runIf(SUPPORTED)(
    "shows the three windows as request rows, without the plan tier",
    async () => {
      installCli({ codingPlan: replying(USAGE) });

      const fetched = await fetchCodingPlan();

      expect(rowSummary(fetched.rows)).toEqual(USAGE_ROWS);
      // The plan tier is not a quota window, so it names no account: the Token Plan names none either.
      expect(fetched.rows.map((row) => row.account)).toEqual([undefined, undefined, undefined]);
      expect(fetched.accounts.map((account) => account.name)).toEqual(["Alibaba Coding Plan"]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "windows", value: "five_hour,weekly,monthly" },
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "gives a window its start, so its span is exact, and a billing month a calendar month back",
    async () => {
      installCli({ codingPlan: replying(USAGE) });

      const fetched = await fetchCodingPlan();

      // A 5-hour and a 7-day window have a known length, so the start is the refresh minus it.
      expect(fetched.rows.map((row) => row.windowStartedAt)).toEqual([
        new Date(Date.parse(FIVE_HOUR_RESET) - 5 * 60 * 60_000).toISOString(),
        new Date(Date.parse(WEEKLY_RESET) - 7 * 24 * 60 * 60_000).toISOString(),
        // A billing month has no length to subtract, but its cycle is anchored on the day it
        // resets, so the start is the same day a calendar month back.
        "2026-08-01T00:00:00.000Z",
      ]);
    },
  );

  it.runIf(SUPPORTED)("stays silent when the account has no Coding Plan", async () => {
    // The CLI prints `{}` and exits 0 for an account without a Coding Plan subscription.
    installCli({ codingPlan: replying({}) });

    const fetched = await fetchCodingPlan();

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toBeUndefined();
    // An answer, not missing data: the store clears a lapsed plan's rows without an error.
    expect(fetched.empty).toBe(true);
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "(none)" },
    ]);
  });

  it.runIf(SUPPORTED)("runs the Coding Plan command, then the shared identity read", async () => {
    installCli({ codingPlan: replying(USAGE) });

    await fetchCodingPlan();

    // The fixture clears the memoised identity read, so the read is always here.
    const commands = launch.calls.map((call) => call.args.join(" ")).sort();
    expect(commands).toEqual(
      ["auth status --output json", "usage coding-plan --output json"].sort(),
    );
  });

  it.runIf(SUPPORTED)("reports an expired console session as a sign-in failure", async () => {
    installCli({ codingPlan: exits(3) });

    const fetched = await fetchCodingPlan();

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "failure_kind", value: "not_authenticated" },
      {
        key: "error",
        value: `Alibaba Coding Plan: ${ERROR_MESSAGES.not_authenticated}`,
      },
      { key: "error_kind", value: "login_expired" },
    ]);
  });
});
