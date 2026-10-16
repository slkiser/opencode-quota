import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readAlibabaCodingPlanQuotaState } from "../src/lib/alibaba-coding-plan-local-quota.js";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba-coding-plan.js";
import { fetchRows, keyLogin, rowSummary, useProviderWorld } from "./helpers/provider-fetch.js";

vi.mock("../src/lib/alibaba-coding-plan-local-quota.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/alibaba-coding-plan-local-quota.js")>()),
  readAlibabaCodingPlanQuotaState: vi.fn(),
}));

const NOW = Date.parse("2026-02-24T12:00:00.000Z");
const HOUR = 3_600_000;
const world = useProviderWorld();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  // One request an hour ago, one two days ago.
  vi.mocked(readAlibabaCodingPlanQuotaState).mockResolvedValue({
    version: 1,
    recent: [NOW - 48 * HOUR, NOW - HOUR],
    updatedAt: NOW,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const FIVE_HOUR_RESET = new Date(NOW + 4 * HOUR).toISOString();
const WEEKLY_RESET = new Date(NOW + 5 * 24 * HOUR).toISOString();
const MONTHLY_RESET = new Date(NOW + 28 * 24 * HOUR).toISOString();

function windows(account: string, limits: [number, number, number]) {
  const [fiveHour, weekly, monthly] = limits;
  // The percent left rounds to 100 for so few requests.
  const value = (used: number, limit: number) => `100 (${used} request of ${limit} request)`;
  return [
    [
      "alibaba-coding-plan.five_hour",
      account,
      "5h",
      "five_hour",
      value(1, fiveHour),
      FIVE_HOUR_RESET,
    ],
    ["alibaba-coding-plan.weekly", account, "Weekly", "week", value(2, weekly), WEEKLY_RESET],
    ["alibaba-coding-plan.monthly", account, "Monthly", "month", value(2, monthly), MONTHLY_RESET],
  ];
}

const TUNING = {
  quotaProviders: [
    {
      id: "alibaba-coding-plan",
      providerId: "alibaba-coding-plan",
      label: "alibaba-coding-plan",
      mode: "local-estimate",
      windows: [
        { id: "five-hour", label: "5h", type: "rolling", durationMinutes: 300, requestLimit: 2000 },
        {
          id: "weekly",
          label: "Weekly",
          type: "rolling",
          durationMinutes: 10080,
          requestLimit: 10000,
        },
        {
          id: "monthly",
          label: "Monthly",
          type: "rolling",
          durationMinutes: 43200,
          requestLimit: 20000,
        },
      ],
    },
  ],
};

describe("alibaba-coding-plan provider", () => {
  it.each([
    [
      "an environment key, on the Lite limits",
      { env: "env-key" },
      {},
      windows("Lite", [1200, 9000, 18000]),
    ],
    [
      "a stored login without a tier, on the Lite limits",
      { login: { key: "dashscope-key" } },
      {},
      windows("Lite", [1200, 9000, 18000]),
    ],
    [
      "a stored Pro login",
      { login: { key: "dashscope-key", tier: "pro" } },
      {},
      windows("Pro", [6000, 45000, 90000]),
    ],
    [
      "configured request limits",
      { login: { key: "dashscope-key", tier: "pro" } },
      TUNING,
      windows("Pro", [2000, 10000, 20000]),
    ],
    [
      "switched-off request limits, on the tier's own limits",
      { login: { key: "dashscope-key", tier: "pro" } },
      { quotaProviders: [{ ...TUNING.quotaProviders[0], enabled: false }] },
      windows("Pro", [6000, 45000, 90000]),
    ],
  ])("estimates the windows for %s", async (_name, setup, config, rows) => {
    if ("env" in setup) process.env.ALIBABA_API_KEY = setup.env;
    if ("login" in setup) {
      const { key, ...fields } = setup.login;
      world.storeLogins([
        { ...keyLogin("ali-id", "alibaba", key), value: { type: "api", key, ...fields } },
      ]);
    }

    const fetched = await fetchRows(alibabaCodingPlanProvider, config);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual(rows);
  });

  it.each([
    ["no key", [], { code: "not_configured" }, undefined],
    [
      "an empty key",
      [keyLogin("ali-id", "alibaba-coding-plan", "   ")],
      { code: "not_configured" },
      "Alibaba Coding Plan auth entry present but key is empty",
    ],
    [
      "an unknown tier",
      [
        {
          ...keyLogin("ali-id", "alibaba", "dashscope-key"),
          value: { type: "api", key: "dashscope-key", tier: "max" },
        },
      ],
      { code: "not_configured" },
      "Unsupported Alibaba Coding Plan tier: max",
    ],
  ])("shows %s without estimating", async (_name, logins, error, message) => {
    world.storeLogins(logins);

    const fetched = await fetchRows(alibabaCodingPlanProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject(error);
    if (message) {
      expect(fetched.debug).toContainEqual({
        key: "error",
        value: `Alibaba Coding Plan: ${message}`,
      });
    }
    expect(readAlibabaCodingPlanQuotaState).not.toHaveBeenCalled();
  });

  it.each([
    ["alibaba/qwen3-coder", undefined, true],
    ["alibaba-cn/qwen3-coder", undefined, true],
    ["openai/gpt-5", undefined, false],
    ["anything", "alibaba", true],
    ["anything", "alibaba-coding-plan", true],
    ["alibaba/qwen3-coder", "alibaba-token-plan", false],
  ])("matchesCurrentModel(%s, provider %s) -> %s", (model, currentProviderID, expected) => {
    const context = currentProviderID ? ({ currentProviderID } as never) : undefined;
    expect(alibabaCodingPlanProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });
});
