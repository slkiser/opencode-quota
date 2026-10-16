import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
} from "../src/providers/minimax-coding-plan.js";
import {
  fakeHttp,
  fetchRows,
  keyLogin,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

const world = useProviderWorld();

const NOW = "2026-10-10T00:00:00.000Z";
const IN_ONE_HOUR = "2026-10-10T01:00:00.000Z";
const IN_ONE_DAY = "2026-10-11T00:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["Date"] });
});

/** One model of the reply; its 5-hour window resets in an hour, its weekly one in a day. */
function model(name: string, fields: Record<string, number>) {
  return { model_name: name, remains_time: 3_600_000, weekly_remains_time: 86_400_000, ...fields };
}

/** A successful reply listing these models. */
function remainsReply(models: unknown[]) {
  return { model_remains: models, base_resp: { status_code: 0, status_msg: "success" } };
}

/** 5h: 1200 of 1500, weekly: 3000 of 15000. Whether a count is used or left depends on the endpoint. */
const COUNTS_MODEL = model("MiniMax-M*", {
  current_interval_total_count: 1500,
  current_interval_usage_count: 1200,
  current_weekly_total_count: 15_000,
  current_weekly_usage_count: 3000,
});

const ENDPOINTS = [
  {
    endpoint: "international",
    provider: minimaxCodingPlanProvider,
    envVar: "MINIMAX_CODING_PLAN_API_KEY",
    integrationId: "minimax-coding-plan",
    url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    name: "MiniMax Token Plan",
    // The international count is what is left.
    fiveHour: "80 (300 request of 1500 request)",
    weekly: "20 (12000 request of 15000 request)",
  },
  {
    endpoint: "China",
    provider: minimaxChinaCodingPlanProvider,
    envVar: "MINIMAX_CHINA_CODING_PLAN_API_KEY",
    integrationId: "minimax-china-coding-plan",
    url: "https://api.minimaxi.com/v1/token_plan/remains",
    name: "MiniMax Token Plan (CN)",
    // The China count is what is used.
    fiveHour: "20 (1200 request of 1500 request)",
    weekly: "80 (3000 request of 15000 request)",
  },
] as const;

describe.each(ENDPOINTS)("MiniMax $endpoint", (endpoint) => {
  const { provider, envVar, integrationId, url, name } = endpoint;
  const id = provider.id;

  it("asks its own endpoint with the env key and reads the counts its way", async () => {
    process.env[envVar] = "env-key";
    const http = fakeHttp(() => remainsReply([COUNTS_MODEL]));

    const fetched = await fetchRows(provider);

    expect(http).toHaveBeenCalledOnce();
    const [requestUrl, init] = http.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(url);
    expect(requestHeader(init, "Authorization")).toBe("Bearer env-key");
    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.five_hour`, null, "5h", "five_hour", endpoint.fiveHour, IN_ONE_HOUR],
      [`${id}.weekly`, null, "Weekly", "week", endpoint.weekly, IN_ONE_DAY],
    ]);
  });

  it("shows only the percent left for a new-plan `general` row without counts", async () => {
    process.env[envVar] = "env-key";
    fakeHttp(() =>
      remainsReply([
        model("general", {
          current_interval_remaining_percent: 86,
          current_weekly_remaining_percent: 90,
        }),
      ]),
    );

    const fetched = await fetchRows(provider);

    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.five_hour`, null, "5h", "five_hour", 86, IN_ONE_HOUR],
      [`${id}.weekly`, null, "Weekly", "week", 90, IN_ONE_DAY],
    ]);
  });

  it.each([
    {
      reply: () => new Response("\u001b[31mUnauthorized\nretry later\u001b[0m", { status: 401 }),
      code: "login_expired",
      message: "MiniMax API error 401: Unauthorized retry later",
    },
    {
      reply: () => ({ base_resp: { status_code: 1002, status_msg: "rate limit exceeded" } }),
      code: "rate_limited",
      message: "MiniMax API error: rate limit exceeded",
    },
    {
      reply: () => ({ base_resp: { status_code: 2049, status_msg: "Invalid API key" } }),
      code: "login_expired",
      message: "MiniMax API error: Invalid API key",
    },
    {
      reply: () => ({ base_resp: { status_code: 1004, status_msg: "login fail: bad secret" } }),
      code: "login_expired",
      message: "MiniMax API error: login fail: bad secret",
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
        ? remainsReply([model("general", { current_interval_remaining_percent: 40 })])
        : new Response("Unauthorized", { status: 401 }),
    );

    const fetched = await fetchRows(provider);

    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.five_hour`, "Work", "5h", "five_hour", 40, IN_ONE_HOUR],
    ]);
    expect(fetched.rowLogins).toEqual(["work"]);
    // The broken login comes first, so its error is the one shown.
    expect(fetched.error?.code).toBe("not_configured");
    expect(fetched.debug.filter((item) => item.key === "error")).toEqual([
      { key: "error", value: `[${name} Broken]: MiniMax auth entry present but key is empty` },
      { key: "error", value: `[${name} Home]: MiniMax API error 401: Unauthorized` },
    ]);
  });
});

describe("MiniMax model choice", () => {
  beforeEach(() => {
    process.env.MINIMAX_CODING_PLAN_API_KEY = "env-key";
  });

  it.each([
    {
      name: "the `MiniMax-M*` row when it reports quota",
      models: [
        model("MiniMax-M2.7", {
          current_interval_total_count: 100,
          current_interval_usage_count: 2,
        }),
        model("MiniMax-M*", {
          current_interval_total_count: 100,
          current_interval_usage_count: 90,
        }),
      ],
      value: "90 (10 request of 100 request)",
    },
    {
      name: "the coding model with the least left, never video",
      models: [
        model("MiniMax-M*", { current_interval_total_count: 0, current_interval_usage_count: 0 }),
        model("MiniMax-M2.7", {
          current_interval_total_count: 100,
          current_interval_usage_count: 60,
        }),
        model("MiniMax-M2.7-highspeed", {
          current_interval_total_count: 100,
          current_interval_usage_count: 30,
        }),
        model("video", { current_interval_total_count: 100, current_interval_usage_count: 1 }),
      ],
      value: "30 (70 request of 100 request)",
    },
  ])("shows $name", async ({ models, value }) => {
    fakeHttp(() => remainsReply(models));

    const fetched = await fetchRows(minimaxCodingPlanProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["minimax-coding-plan.five_hour", null, "5h", "five_hour", value, IN_ONE_HOUR],
    ]);
  });

  it.each([
    { provider: minimaxCodingPlanProvider, envVar: "MINIMAX_CODING_PLAN_API_KEY", percents: [70] },
    {
      provider: minimaxChinaCodingPlanProvider,
      envVar: "MINIMAX_CHINA_CODING_PLAN_API_KEY",
      percents: [],
    },
  ])(
    "$provider.id reads a percent beside zero counts on a coding model: $percents",
    async ({ provider, envVar, percents }) => {
      process.env[envVar] = "env-key";
      fakeHttp(() =>
        remainsReply([
          model("MiniMax-M*", {
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            current_interval_remaining_percent: 70,
          }),
        ]),
      );

      const fetched = await fetchRows(provider);

      expect(fetched.error).toBeUndefined();
      expect(fetched.rows.map((row) => row.percentRemaining)).toEqual(percents);
    },
  );
});

describe("MiniMax availability and models", () => {
  it.each([
    {
      name: "international with its key",
      provider: minimaxCodingPlanProvider,
      runtimeIds: ["minimax-coding-plan"],
      envVar: "MINIMAX_CODING_PLAN_API_KEY",
      enabledProviders: "auto",
      available: true,
    },
    {
      name: "international without a key",
      provider: minimaxCodingPlanProvider,
      runtimeIds: ["minimax-coding-plan"],
      envVar: undefined,
      enabledProviders: "auto",
      available: false,
    },
    {
      name: "China on the shared `minimax` id in auto mode",
      provider: minimaxChinaCodingPlanProvider,
      runtimeIds: ["minimax"],
      envVar: "MINIMAX_CHINA_CODING_PLAN_API_KEY",
      enabledProviders: "auto",
      available: false,
    },
    {
      name: "China on the shared `minimax` id when enabled by name",
      provider: minimaxChinaCodingPlanProvider,
      runtimeIds: ["minimax"],
      envVar: "MINIMAX_CHINA_CODING_PLAN_API_KEY",
      enabledProviders: ["minimax-china-coding-plan"],
      available: true,
    },
  ])("is available for $name: $available", async (testCase) => {
    if (testCase.envVar) process.env[testCase.envVar] = "env-key";
    const ctx = {
      config: { enabledProviders: testCase.enabledProviders },
      resolveRuntimeProviderIds: async () => new Set(testCase.runtimeIds),
    };

    await expect(testCase.provider.isAvailable(ctx as never)).resolves.toBe(testCase.available);
  });

  it.each([
    ["minimax/MiniMax-M2.7", undefined, true, false],
    ["minimax-cn/MiniMax-M2.7", undefined, false, true],
    ["minimax/MiniMax-M2.7", { enabledProviders: ["minimax-china-coding-plan"] }, true, true],
    ["minimax/Hailuo-02", undefined, false, false],
  ])("matches the model %s (%j): international %s, China %s", (model, context, intl, china) => {
    expect(minimaxCodingPlanProvider.matchesCurrentModel?.(model, context as never)).toBe(intl);
    expect(minimaxChinaCodingPlanProvider.matchesCurrentModel?.(model, context as never)).toBe(
      china,
    );
  });
});
