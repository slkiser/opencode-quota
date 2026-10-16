/**
 * Z.ai and Zhipu through their public `fetch`: a key in the environment or stored logins, and
 * fake HTTP replies.
 */

import { describe, expect, it } from "vite-plus/test";

import { zaiProvider, zhipuProvider } from "../src/providers/glm-coding-plan.js";
import {
  fakeHttp,
  fetchRows,
  keyLogin,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const FIVE_HOUR_RESET = "2026-01-01T03:00:00.000Z";
const WEEKLY_RESET = "2026-01-05T00:00:00.000Z";

const VENDORS = [
  {
    id: "zai",
    label: "Z.ai",
    provider: zaiProvider,
    keyEnv: "ZAI_API_KEY",
    integrationId: "zai-coding-plan",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
    matchingModels: ["zai/glm-4.5", "glm/glm-4.5", "anthropic/glm-4"],
    nonMatchingModels: ["openai/gpt-5"],
  },
  {
    id: "zhipu",
    label: "Zhipu",
    provider: zhipuProvider,
    keyEnv: "ZHIPU_API_KEY",
    integrationId: "zhipu-coding-plan",
    url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
    matchingModels: ["zhipu/glm-4.5", "zhipu-coding-plan/glm-4.5", "glm-coding-plan/glm-4.5"],
    nonMatchingModels: ["zai/glm-4.5", "glm/glm-4.5", "openai/gpt-5"],
  },
] as const;

function limitsReply(limits: unknown) {
  return { code: 0, msg: "ok", success: true, data: { level: "pro", limits } };
}

function credit(fields: Record<string, number>) {
  return { type: "CREDIT_LIMIT", unit: 3, ...fields };
}

const world = useProviderWorld();

describe.each(VENDORS)("$label coding plan", (vendor) => {
  async function fetchWithKey(reply: unknown) {
    process.env[vendor.keyEnv] = "secret-key";
    const http = fakeHttp(() => reply);
    return { http, fetched: await fetchRows(vendor.provider) };
  }

  function errorLines(debug: Array<{ key: string; value: string }>) {
    return debug.filter((item) => item.key === "error").map((item) => item.value);
  }

  it("reads the 5h, weekly and MCP windows: a later one wins, daily limits are left out", async () => {
    const { http, fetched } = await fetchWithKey(
      limitsReply([
        { type: "TOKENS_LIMIT", unit: 4, percentage: 10, nextResetTime: Date.parse(WEEKLY_RESET) },
        { type: "TOKENS_LIMIT", unit: 3, percentage: 120 },
        { type: "TOKENS_LIMIT", unit: 6, percentage: 70, nextResetTime: Date.parse(WEEKLY_RESET) },
        { type: "TIME_LIMIT", unit: 9, percentage: 10, nextResetTime: -1 },
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          percentage: 20,
          nextResetTime: Date.parse(FIVE_HOUR_RESET) + 0.4,
        },
      ]),
    );

    expect(rowSummary(fetched.rows)).toEqual([
      [`${vendor.id}.five_hour`, null, "5h", "five_hour", 80, FIVE_HOUR_RESET],
      [`${vendor.id}.weekly`, null, "Weekly", "week", 30, WEEKLY_RESET],
      [`${vendor.id}.mcp`, null, "MCP", "mcp", 90, null],
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toContainEqual({
      key: "five_hour_remaining",
      value: `80% reset_at=${FIVE_HOUR_RESET}`,
    });
    expect(http.mock.calls.map(([url]) => String(url))).toEqual([vendor.url]);
    const [, init] = http.mock.calls[0] ?? [];
    expect(requestHeader(init, "Authorization")).toBe("secret-key");
    expect(requestHeader(init, "User-Agent")).toBe("OpenCode-Quota-Toast/1.0");
  });

  it.each([
    ["exact credit values", credit({ usage: 12_000, currentValue: 569, percentage: 4 }), 95],
    ["no current value", credit({ usage: 12_000, percentage: 4 }), 96],
    ["zero usage", credit({ usage: 0, currentValue: 569, percentage: 11 }), 89],
    ["credit use above the limit", credit({ usage: 100, currentValue: 150, percentage: 25 }), 0],
    [
      "a token limit",
      { ...credit({ usage: 12_000, currentValue: 569, percentage: 4 }), type: "TOKENS_LIMIT" },
      96,
    ],
  ])("gives the 5h percent of %s", async (_name, limit, expected) => {
    const { fetched } = await fetchWithKey(limitsReply([limit]));

    expect(fetched.rows.map((row) => row.percentRemaining)).toEqual([expected]);
  });

  it.each([
    [
      "an HTTP error",
      new Response('\u001b[31m{"msg":"down"}', { status: 500 }),
      `${vendor.label} API error 500: {"msg":"down"}`,
    ],
    ["limits that are not a list", limitsReply({}), "Invalid quota data"],
    [
      "a credit limit whose percentage is no number",
      limitsReply([
        { ...credit({ usage: 100, currentValue: 10 }), percentage: { toString: null } },
      ]),
      "Cannot convert object to primitive value",
    ],
  ])("with %s shows no rows and its error", async (_name, reply, error) => {
    const { fetched } = await fetchWithKey(reply);

    expect(fetched.rows).toEqual([]);
    expect(errorLines(fetched.debug)).toEqual([`${vendor.label}: ${error}`]);
  });

  it("without a key is not configured and sends nothing", async () => {
    const http = fakeHttp(() => {
      throw new Error("no request expected");
    });

    const fetched = await fetchRows(vendor.provider);

    expect(fetched).toMatchObject({ rows: [], error: { code: "not_configured" } });
    expect(http).not.toHaveBeenCalled();
  });

  it("queries each stored key and shows a key it cannot use as an error", async () => {
    world.storeLogins([
      keyLogin("work", vendor.integrationId, " ", { label: "Work", active: 1, updated: 2 }),
      keyLogin("home", vendor.integrationId, "home-key", { label: "Home", updated: 1 }),
    ]);
    const http = fakeHttp(() => limitsReply([{ type: "TOKENS_LIMIT", unit: 6, percentage: 70 }]));

    const fetched = await fetchRows(vendor.provider);

    expect(rowSummary(fetched.rows)).toEqual([
      [`${vendor.id}.weekly`, "Home", "Weekly", "week", 30, null],
    ]);
    expect(errorLines(fetched.debug)).toEqual([
      `[${vendor.label} Work] (active): ${vendor.label} auth entry present but key is empty`,
    ]);
    expect(http.mock.calls.map(([, init]) => requestHeader(init, "Authorization"))).toEqual([
      "home-key",
    ]);
  });

  it.each<[string, readonly string[], "env" | "broken" | null, boolean]>([
    ["with a key", [vendor.id], "env", true],
    // A key it cannot use stays available so fetch can show its error.
    ["with a stored key it cannot use", [vendor.id], "broken", true],
    ["without a key", [vendor.id], null, false],
    ["for another OpenCode provider", ["openai"], "env", false],
  ])("%s is available: %s", async (_name, providerIds, key, expected) => {
    if (key === "env") process.env[vendor.keyEnv] = "secret-key";
    if (key === "broken") world.storeLogins([keyLogin("broken", vendor.integrationId, " ")]);

    await expect(
      vendor.provider.isAvailable(createProviderAvailabilityContext({ providerIds })),
    ).resolves.toBe(expected);
  });

  it("matches its own models", () => {
    for (const model of vendor.matchingModels) {
      expect(vendor.provider.matchesCurrentModel?.(model), model).toBe(true);
    }
    for (const model of vendor.nonMatchingModels) {
      expect(vendor.provider.matchesCurrentModel?.(model), model).toBe(false);
    }
  });
});

describe("GLM reply envelopes", () => {
  it.each([
    [
      { code: 500, msg: "\u001b[31mcurrent user has no coding plan", success: false },
      "current user has no coding plan",
    ],
    [{ code: 401 }, "Z.ai API error 401"],
    [{ success: false }, "Z.ai API error"],
  ])("Z.ai shows the error a 200 reply %j reports", async (reply, error) => {
    process.env.ZAI_API_KEY = "secret-key";
    fakeHttp(() => reply);

    const fetched = await fetchRows(zaiProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.debug).toContainEqual({ key: "error", value: `Z.ai: ${error}` });
  });

  it("allows Z.ai top-level limits but keeps Zhipu to data.limits", async () => {
    process.env.ZAI_API_KEY = "secret-key";
    process.env.ZHIPU_API_KEY = "secret-key";
    fakeHttp(() => ({
      code: 0,
      success: true,
      limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 25 }],
    }));

    const zai = await fetchRows(zaiProvider);
    const zhipu = await fetchRows(zhipuProvider);

    expect(rowSummary(zai.rows)).toEqual([["zai.weekly", null, "Weekly", "week", 75, null]]);
    expect(zhipu.rows).toEqual([]);
    expect(zhipu.debug).toContainEqual({ key: "error", value: "Zhipu: Invalid quota data" });
  });
});
