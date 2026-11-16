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

/** The 5-hour and weekly ratios, as the live API sends them (ratios are fractions). */
const LIVE_REPLY = {
  usages: {
    limit_5h: { used_ratio: 0.0201, reset_time: "2026-11-15T13:37:17Z" },
    limit_7d: { used_ratio: 0.004, reset_time: "2026-11-21T08:37:17Z" },
  },
};

/** Only the weekly ratio, `usedRatio` of the window spent. */
function weeklyReply(usedRatio: number) {
  return { usages: { limit_7d: { used_ratio: usedRatio } } };
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

  it("asks its own endpoint with the env key and shows the 5h ratio before the weekly one", async () => {
    process.env[envVar] = "env-key";
    const http = fakeHttp(() => LIVE_REPLY);

    const fetched = await fetchRows(provider);

    expect(http).toHaveBeenCalledOnce();
    const [requestUrl, init] = http.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(url);
    expect(requestHeader(init, "Authorization")).toBe("Bearer env-key");
    expect(fetched.error).toBeUndefined();
    // 0.0201 used is 97.99% left, 0.004 used is 99.6% left, both rounded to whole percent.
    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.limit.5h`, null, "5 Hour", "five_hour", 98, "2026-11-15T13:37:17.000Z"],
      [`${id}.weekly`, null, "Weekly", "week", 100, "2026-11-21T08:37:17.000Z"],
    ]);
    // The Code share is inside the monthly pool, so it is a detail and not a row.
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
        ? weeklyReply(0.1)
        : new Response("Unauthorized", { status: 401 }),
    );

    const fetched = await fetchRows(provider);

    expect(rowSummary(fetched.rows)).toEqual([
      [`${id}.weekly`, "Work", "Weekly", "week", 90, null],
    ]);
    expect(fetched.rowLogins).toEqual(["work"]);
    // The broken login comes first, so its error is the one shown.
    expect(fetched.error?.code).toBe("not_configured");
    expect(fetched.debug.filter((item) => item.key === "error")).toEqual([
      { key: "error", value: `[${name} Broken]: Kimi auth entry present but key is empty` },
      { key: "error", value: `[${name} Home]: Kimi API error 401: Unauthorized` },
    ]);
    // The Code share is inside the monthly pool, so it is a detail and not a row.
  });

  it("shows a stored login that is not a key as its one error, without a request", async () => {
    world.storeLogins([
      { id: "oauth", integrationId, active: null, updated: 1, value: { type: "oauth" } },
    ]);
    const http = fakeHttp(() => weeklyReply(0.1));
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
    const http = fakeHttp(() => weeklyReply(0.1));

    const fetched = await fetchRows(provider);

    expect(http).toHaveBeenCalledOnce();
    expect(requestHeader(http.mock.calls[0]?.[1], "Authorization")).toBe("Bearer env-key");
    expect(rowSummary(fetched.rows)).toEqual([[`${id}.weekly`, null, "Weekly", "week", 90, null]]);
    expect(fetched.rowLogins).toBeUndefined();
  });
});

describe("Kimi Code reply parsing", () => {
  beforeEach(() => {
    process.env.KIMI_GLOBAL_API_KEY = "env-key";
    vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00Z"), toFake: ["Date"] });
  });

  it("shows the monthly pool as one row, and the Code share as a debug detail", async () => {
    fakeHttp(() => ({
      ...LIVE_REPLY,
      usages: {
        ...LIVE_REPLY.usages,
        limit_month_total: { used_ratio: 0.15, reset_time: "2026-11-01T00:00:00Z" },
        limit_month_code: { used_ratio: 0.05, reset_time: "2026-11-01T00:00:00Z" },
      },
    }));

    const fetched = await fetchRows(kimiCodePlanGlobalProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      [
        "kimi-code-plan-global.limit.5h",
        null,
        "5 Hour",
        "five_hour",
        98,
        "2026-11-15T13:37:17.000Z",
      ],
      ["kimi-code-plan-global.weekly", null, "Weekly", "week", 100, "2026-11-21T08:37:17.000Z"],
      [
        "kimi-code-plan-global.limit.monthly_total",
        null,
        "Monthly",
        "month",
        85,
        "2026-11-01T00:00:00.000Z",
      ],
    ]);
    // The Code share is inside the monthly pool, so it is a detail and not a row.
    expect(fetched.debug).toContainEqual({ key: "monthly_code_ratio", value: "0.05" });
  });

  it.each([
    ["invalid", undefined],
    [NaN, undefined],
    [-0.2, 100],
    [1.2, 0],
  ])("skips or clamps the usage ratio %s", async (used_ratio, remaining) => {
    fakeHttp(() => ({ usages: { limit_month_total: { used_ratio } } }));
    const fetched = await fetchRows(kimiCodePlanGlobalProvider);
    expect(fetched.rows.map((row) => row.percentRemaining)).toEqual(
      remaining === undefined ? [] : [remaining],
    );
  });

  it("reports the structure error when there is no usage ratio", async () => {
    fakeHttp(() => ({ usages: {} }));

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
    fakeHttp(() => weeklyReply(0.25));

    const global = await fetchRows(kimiCodePlanGlobalProvider);
    const cn = await fetchRows(kimiCodePlanCnProvider);

    expect(global.error).toEqual({ code: "not_configured" });
    expect(rowSummary(cn.rows)).toEqual([
      ["kimi-code-plan-cn.weekly", null, "Weekly", "week", 75, null],
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
