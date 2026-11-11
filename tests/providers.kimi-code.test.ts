import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { kimiCodePlanCnProvider, kimiCodePlanGlobalProvider } from "../src/providers/kimi-code.js";
import { NO_PROJECT_DIRECTORY } from "./helpers/opencode-folders.js";
import {
  fakeHttp,
  fetchRows,
  keyLogin,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

const world = useProviderWorld();

/** The weekly usage and one 5-hour limit, numbers as strings the way the API sends them. */
const USAGE_REPLY = {
  usage: { limit: "100", used: "45", remaining: "55", resetTime: "2026-10-16T15:36:21.718434Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "22", remaining: "78", resetTime: "2026-10-10T16:36:21Z" },
    },
  ],
};

/** Monthly ratios alongside the detailed 5h window, whose value wins over the aggregate. */
const MONTHLY_REPLY = {
  limits: USAGE_REPLY.limits,
  usages: {
    limit_5h: { used_ratio: 1, reset_time: "2026-10-10T17:00:00Z" },
    limit_month_total: { used_ratio: 0.0795, reset_time: "2026-11-01T00:00:00Z" },
    limit_month_code: { used_ratio: 0, reset_time: "2026-11-01T00:00:00Z" },
  },
};

/** Only the weekly usage, with `used` of 100 spent. */
function weeklyReply(used: number) {
  return { usage: { limit: 100, used } };
}

const REGIONS = [
  {
    region: "global",
    provider: kimiCodePlanGlobalProvider,
    envVar: "KIMI_GLOBAL_API_KEY",
    integrationId: "kimi-code-plan-global",
    url: "https://api.kimi.ai/coding/v1/usages",
    name: "Kimi Code",
  },
  {
    region: "CN",
    provider: kimiCodePlanCnProvider,
    envVar: "KIMI_CN_API_KEY",
    integrationId: "kimi-code-plan-cn",
    url: "https://api.kimi.com/coding/v1/usages",
    name: "Kimi Code (CN)",
  },
] as const;

describe.each(REGIONS)("Kimi Code $region", ({ provider, envVar, integrationId, url, name }) => {
  const id = provider.id;

  it("asks its own endpoint with the env key and shows the weekly usage and each limit", async () => {
    process.env[envVar] = "env-key";
    const http = fakeHttp(() => USAGE_REPLY);

    const fetched = await fetchRows(provider);

    expect(http).toHaveBeenCalledOnce();
    const [requestUrl, init] = http.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(url);
    expect(requestHeader(init, "Authorization")).toBe("Bearer env-key");
    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.weekly`, null, "Weekly limit", "week", 55, "2026-10-16T15:36:21.718Z"],
      [`${id}.limit.5h`, null, "5h limit", "five_hour", 78, "2026-10-10T16:36:21.000Z"],
    ]);
  });

  it("shows both monthly quotas without duplicating or overriding the detailed 5h limit", async () => {
    process.env[envVar] = "env-key";
    const http = fakeHttp(() => MONTHLY_REPLY);

    const fetched = await fetchRows(provider);

    expect(http).toHaveBeenCalledOnce();
    const [requestUrl, init] = http.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(url);
    expect(requestHeader(init, "Authorization")).toBe("Bearer env-key");
    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.limit.5h`, null, "5h limit", "five_hour", 78, "2026-10-10T16:36:21.000Z"],
      [`${id}.limit.month_total`, null, "Monthly total", "month", 92, "2026-11-01T00:00:00.000Z"],
      [`${id}.limit.month_code`, null, "Monthly code", "month", 100, "2026-11-01T00:00:00.000Z"],
    ]);
    for (const row of fetched.rows.slice(1)) {
      expect(row).toMatchObject({
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
      });
      expect(row.used).toBeUndefined();
      expect(row.limit).toBeUndefined();
    }
  });

  it("keeps monthly quotas attached to each stored login", async () => {
    world.storeLogins([
      keyLogin("work", integrationId, "work-key", { label: "Work", updated: 2 }),
      keyLogin("home", integrationId, "home-key", { label: "Home", updated: 1 }),
    ]);
    const http = fakeHttp((_url, init) => ({
      usages: {
        limit_month_total: {
          used_ratio: requestHeader(init, "Authorization") === "Bearer work-key" ? 1 : 0,
        },
        limit_month_code: {
          used_ratio: requestHeader(init, "Authorization") === "Bearer work-key" ? 0.25 : 0.5,
        },
      },
    }));

    const fetched = await fetchRows(provider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.limit.month_total`, "Work", "Monthly total", "month", 0, null],
      [`${id}.limit.month_code`, "Work", "Monthly code", "month", 75, null],
      [`${id}.limit.month_total`, "Home", "Monthly total", "month", 100, null],
      [`${id}.limit.month_code`, "Home", "Monthly code", "month", 50, null],
    ]);
    expect(fetched.rowLogins).toEqual(["work", "work", "home", "home"]);
    expect(http).toHaveBeenCalledTimes(2);
    expect(
      http.mock.calls.map(([requestUrl, init]) => [
        String(requestUrl),
        requestHeader(init, "Authorization"),
      ]),
    ).toEqual([
      [url, "Bearer work-key"],
      [url, "Bearer home-key"],
    ]);
  });

  it.each([
    {
      reply: () => new Response("Unauthorized", { status: 401 }),
      code: "login_expired",
      message: "Kimi API error 401: Unauthorized",
    },
    {
      reply: () => ({ message: "hello", code: 0 }),
      code: "bad_response",
      message: "Unexpected response structure (keys: message, code)",
    },
  ])("shows $code for: $message", async ({ reply, code, message }) => {
    process.env[envVar] = "env-key";
    fakeHttp(reply);

    const fetched = await fetchRows(provider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe(code);
    expect(fetched.debug).toContainEqual({ key: "error", value: `${name}: ${message}` });
  });

  it("queries each stored key as its own account, a broken login first", async () => {
    world.storeLogins([
      keyLogin("work", integrationId, "work-key", { label: "Work", updated: 3 }),
      keyLogin("home", integrationId, "home-key", { label: "Home", updated: 2 }),
      keyLogin("broken", integrationId, "", { label: "Broken", updated: 1 }),
    ]);
    fakeHttp((_url, init) =>
      requestHeader(init, "Authorization") === "Bearer work-key"
        ? weeklyReply(10)
        : new Response("Unauthorized", { status: 401 }),
    );

    const fetched = await fetchRows(provider);

    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.weekly`, "Work", "Weekly limit", "week", 90, null],
    ]);
    expect(fetched.rowLogins).toEqual(["work"]);
    // The broken login comes first, so its error is the one shown.
    expect(fetched.error?.code).toBe("not_configured");
    expect(fetched.debug.filter((item) => item.key === "error")).toEqual([
      { key: "error", value: `[${name} Broken]: Kimi auth entry present but key is empty` },
      { key: "error", value: `[${name} Home]: Kimi API error 401: Unauthorized` },
    ]);
  });

  it("shows a stored login that is not a key as its one error, without a request", async () => {
    world.storeLogins([
      { id: "oauth", integrationId, active: null, updated: 1, value: { type: "oauth" } },
    ]);
    const http = fakeHttp(() => weeklyReply(10));
    const ctx = {
      config: {},
      locationDirectory: NO_PROJECT_DIRECTORY,
      resolveRuntimeProviderIds: async () => new Set([id]),
    };

    await expect(provider.isAvailable(ctx as never)).resolves.toBe(true);
    const fetched = await fetchRows(provider);

    expect(http).not.toHaveBeenCalled();
    expect(fetched.rows).toEqual([]);
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "invalid" },
        { key: "error", value: `${name}: Unsupported Kimi auth type: "oauth"` },
      ]),
    );
  });

  it("asks only the env key when keys are also stored", async () => {
    process.env[envVar] = "env-key";
    world.storeLogins([keyLogin("work", integrationId, "work-key", { label: "Work" })]);
    const http = fakeHttp(() => weeklyReply(10));

    const fetched = await fetchRows(provider);

    expect(http).toHaveBeenCalledOnce();
    expect(requestHeader(http.mock.calls[0]?.[1], "Authorization")).toBe("Bearer env-key");
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.weekly`, null, "Weekly limit", "week", 90, null],
    ]);
    expect(fetched.rowLogins).toBeUndefined();
  });
});

describe("Kimi Code reply parsing", () => {
  beforeEach(() => {
    process.env.KIMI_GLOBAL_API_KEY = "env-key";
    vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00Z"), toFake: ["Date"] });
  });

  it.each([
    {
      name: "used worked out from the limit and what remains",
      reply: { usage: { limit: "100", remaining: "30" } },
      rows: [["kimi-code-plan-global.weekly", null, "Weekly limit", "week", 30, null]],
    },
    {
      name: "a reset given in seconds from now",
      reply: { usage: { limit: 100, used: 50, reset_in: 3600 } },
      rows: [
        [
          "kimi-code-plan-global.weekly",
          null,
          "Weekly limit",
          "week",
          50,
          "2026-10-10T13:00:00.000Z",
        ],
      ],
    },
    {
      name: "a named limit wrapped in `data`",
      reply: { data: { limits: [{ name: "Daily limit", limit: 10, used: 10 }] } },
      rows: [["kimi-code-plan-global.limit.daily", null, "Daily limit", "day", 0, null]],
    },
  ])("reads $name", async ({ reply, rows }) => {
    fakeHttp(() => reply);

    const fetched = await fetchRows(kimiCodePlanGlobalProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual(rows);
  });
});

describe("Kimi Code monthly reply parsing", () => {
  const id = "kimi-code-plan-global";
  const monthlyRows = [
    [`${id}.limit.month_total`, null, "Monthly total", "month", 92, "2026-11-01T00:00:00.000Z"],
    [`${id}.limit.month_code`, null, "Monthly code", "month", 100, "2026-11-01T00:00:00.000Z"],
  ];
  const fiveHourRow = [
    `${id}.limit.5h`,
    null,
    "5h limit",
    "five_hour",
    78,
    "2026-10-10T16:36:21.000Z",
  ];

  beforeEach(() => {
    process.env.KIMI_GLOBAL_API_KEY = "env-key";
  });

  it.each([
    {
      name: "wrapped monthly quotas",
      reply: { data: MONTHLY_REPLY },
      rows: [fiveHourRow, ...monthlyRows],
    },
    {
      name: "monthly quotas without legacy fields",
      reply: { usages: MONTHLY_REPLY.usages },
      rows: monthlyRows,
    },
    {
      name: "weekly, detailed and monthly quotas together",
      reply: { ...USAGE_REPLY, usages: MONTHLY_REPLY.usages },
      rows: [
        [`${id}.weekly`, null, "Weekly limit", "week", 55, "2026-10-16T15:36:21.718Z"],
        fiveHourRow,
        ...monthlyRows,
      ],
    },
    {
      name: "only the total monthly quota",
      reply: { usages: { limit_month_total: MONTHLY_REPLY.usages.limit_month_total } },
      rows: [monthlyRows[0]],
    },
    {
      name: "only the code monthly quota",
      reply: { usages: { limit_month_code: MONTHLY_REPLY.usages.limit_month_code } },
      rows: [monthlyRows[1]],
    },
    {
      name: "reversed API keys with an unknown quota",
      reply: {
        usages: {
          limit_month_code: MONTHLY_REPLY.usages.limit_month_code,
          limit_other: { used_ratio: 1 },
          limit_month_total: MONTHLY_REPLY.usages.limit_month_total,
        },
      },
      rows: monthlyRows,
    },
    {
      name: "nested monthly quotas take precedence over top-level ones",
      reply: {
        usages: { limit_month_total: { used_ratio: 1 } },
        data: { usages: MONTHLY_REPLY.usages },
      },
      rows: monthlyRows,
    },
    {
      name: "top-level monthly quotas alongside nested legacy fields",
      reply: { data: { limits: USAGE_REPLY.limits }, usages: MONTHLY_REPLY.usages },
      rows: [fiveHourRow, ...monthlyRows],
    },
  ])("reads $name", async ({ reply, rows }) => {
    fakeHttp(() => reply);

    const fetched = await fetchRows(kimiCodePlanGlobalProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual(rows);
  });

  it.each([
    { ratio: 0, remaining: 100 },
    { ratio: 1, remaining: 0 },
    { ratio: 0.0795, remaining: 92 },
    { ratio: "0.25", remaining: 75 },
    { ratio: " 0.25 ", remaining: 75 },
    { ratio: -0.5, remaining: 100 },
    { ratio: 1.5, remaining: 0 },
    { ratio: -Number.MAX_VALUE, remaining: 100 },
    { ratio: Number.MAX_VALUE, remaining: 0 },
  ])("converts ratio $ratio to $remaining% remaining", async ({ ratio, remaining }) => {
    fakeHttp(() => ({ usages: { limit_month_total: { used_ratio: ratio } } }));

    const fetched = await fetchRows(kimiCodePlanGlobalProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.limit.month_total`, null, "Monthly total", "month", remaining, null],
    ]);
  });

  it.each(
    [undefined, null, true, false, "", " ", "abc", "NaN", "Infinity", "-Infinity", [], [0], {}].map(
      (ratio) => ({ ratio }),
    ),
  )("ignores invalid ratio $ratio without losing other windows", async ({ ratio }) => {
    fakeHttp(() => ({
      limits: USAGE_REPLY.limits,
      usages: {
        limit_month_total: { used_ratio: ratio },
        limit_month_code: MONTHLY_REPLY.usages.limit_month_code,
      },
    }));

    const fetched = await fetchRows(kimiCodePlanGlobalProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([fiveHourRow, monthlyRows[1]]);
  });

  it.each([undefined, null, [], 42, "bad", true].map((entry) => ({ entry })))(
    "ignores malformed monthly entry $entry independently",
    async ({ entry }) => {
      fakeHttp(() => ({
        usages: {
          limit_month_total: entry,
          limit_month_code: MONTHLY_REPLY.usages.limit_month_code,
        },
      }));

      const fetched = await fetchRows(kimiCodePlanGlobalProvider);

      expect(fetched.error).toBeUndefined();
      expect(rowSummary(fetched.rows)).toEqual([monthlyRows[1]]);
    },
  );

  it.each([undefined, null, "", "not a date", 123])(
    "keeps a valid monthly ratio without a usable reset time %j",
    async (resetTime) => {
      fakeHttp(() => ({
        usages: { limit_month_total: { used_ratio: 1, reset_time: resetTime } },
      }));

      const fetched = await fetchRows(kimiCodePlanGlobalProvider);

      expect(fetched.error).toBeUndefined();
      expect(rowSummary(fetched.rows)).toEqual([
        [`${id}.limit.month_total`, null, "Monthly total", "month", 0, null],
      ]);
    },
  );

  it.each([undefined, null, [], 42, "bad", true].map((usages) => ({ usages })))(
    "preserves legacy quotas with malformed usages $usages",
    async ({ usages }) => {
      fakeHttp(() => ({ ...USAGE_REPLY, usages }));

      const fetched = await fetchRows(kimiCodePlanGlobalProvider);

      expect(fetched.error).toBeUndefined();
      expect(rowSummary(fetched.rows)).toEqual([
        [`${id}.weekly`, null, "Weekly limit", "week", 55, "2026-10-16T15:36:21.718Z"],
        fiveHourRow,
      ]);
    },
  );

  it.each([
    {},
    { limit_month_total: { used_ratio: "bad" } },
    { limit_unknown: { used_ratio: 0 } },
    { limit_5h: { used_ratio: 0 } },
  ])("keeps bad_response when usages has no usable quota: %j", async (usages) => {
    fakeHttp(() => ({ usages }));

    const fetched = await fetchRows(kimiCodePlanGlobalProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe("bad_response");
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Kimi Code: Unexpected response structure (keys: usages)",
    });
  });
});

describe("Kimi Code regions", () => {
  it("reads a key stored under the legacy `kimi` id for CN only", async () => {
    world.storeLogins([keyLogin("legacy", "kimi", "legacy-key")]);
    fakeHttp(() => weeklyReply(25));

    const global = await fetchRows(kimiCodePlanGlobalProvider);
    const cn = await fetchRows(kimiCodePlanCnProvider);

    expect(global.error).toEqual({ code: "not_configured" });
    expect(rowSummary(cn.rows)).toEqual([
      ["kimi-code-plan-cn.weekly", null, "Weekly limit", "week", 75, null],
    ]);
    expect(cn.rowLogins).toEqual(["legacy"]);
  });

  it.each([
    { name: "the runtime has no Kimi provider", runtimeIds: [], env: true, available: false },
    { name: "an env key", runtimeIds: ["kimi-code-plan-global"], env: true, available: true },
    { name: "no key", runtimeIds: ["kimi-code-plan-global"], env: false, available: false },
  ])("is available with $name: $available", async ({ runtimeIds, env, available }) => {
    if (env) process.env.KIMI_GLOBAL_API_KEY = "env-key";
    const ctx = {
      config: {},
      locationDirectory: NO_PROJECT_DIRECTORY,
      resolveRuntimeProviderIds: async () => new Set(runtimeIds),
    };

    await expect(kimiCodePlanGlobalProvider.isAvailable(ctx as never)).resolves.toBe(available);
  });

  it("is available with a broken stored login, so its error can show", async () => {
    world.storeLogins([keyLogin("broken", "kimi-code-plan-cn", "")]);
    const ctx = {
      config: {},
      locationDirectory: NO_PROJECT_DIRECTORY,
      resolveRuntimeProviderIds: async () => new Set(["kimi-code-plan-cn"]),
    };

    await expect(kimiCodePlanCnProvider.isAvailable(ctx as never)).resolves.toBe(true);
  });

  it.each([
    ["kimi-code-plan-global/k3", true, false],
    ["kimi-code-plan-cn/k3", false, true],
    ["kimi/k3", false, true],
    ["kimi-k2", false, false],
  ])("matches the model %s: global %s, CN %s", (model, global, cn) => {
    expect(kimiCodePlanGlobalProvider.matchesCurrentModel?.(model)).toBe(global);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.(model)).toBe(cn);
  });
});
