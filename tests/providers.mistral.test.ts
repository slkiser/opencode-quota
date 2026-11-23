import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mistralProvider } from "../src/providers/mistral.js";
import {
  fakeHttp,
  fetchRows,
  keyLogin,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

const world = useProviderWorld();
const RESET = "2026-12-01T00:00:00Z";
const budget = {
  vibe_budget: { usage_percentage: 20, initial_budget: 150, currency: "USD", reset_at: RESET },
  api_budget: { usage_percentage: 60, initial_budget: 15, currency: "USD", reset_at: RESET },
  usage_percentage: 60,
  initial_budget: 15,
  currency: "USD",
  reset_at: RESET,
};

afterEach(() => vi.unstubAllGlobals());

function responses(planType: string, planName: string, body: unknown = budget) {
  return fakeHttp((url) =>
    url.endsWith("/api/vibe/whoami") ? { plan_type: planType, plan_name: planName } : body,
  );
}

describe("Mistral AI provider", () => {
  it.each([
    ["CHAT", "EDU", "mistral.vibe_budget", "Vibe", "Vibe budget", 80, "150"],
    ["api", "INDIVIDUAL", "mistral.api_budget", "API", "API budget", 40, "15"],
    ["CHAT", "FREE", "mistral.vibe_budget", "Vibe", "Vibe budget", 80, "150"],
    ["API", "TEAM", "mistral.api_budget", "API", "API budget", 40, "15"],
  ])("selects %s %s budget only", async (planType, planName, id, account, label, left, limit) => {
    process.env.MISTRAL_API_KEY = "sk-mistral-test";
    const http = responses(planType, planName);
    const fetched = await fetchRows(mistralProvider);

    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual([
      [id, account, label, "month", `${left} (? of ${limit} USD)`, "2026-12-01T00:00:00.000Z"],
    ]);
    expect(fetched.rows[0]).toMatchObject({ type: "budget", method: "remote_api" });
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      "https://console.mistral.ai/api/vibe/whoami",
      "https://api.mistral.ai/v1/billing/budget",
    ]);
    expect(http.mock.calls.map(([, init]) => requestHeader(init, "Authorization"))).toEqual([
      "Bearer sk-mistral-test",
      "Bearer sk-mistral-test",
    ]);
  });

  it("does not fall back to the top-level or opposite plan budget", async () => {
    process.env.MISTRAL_API_KEY = "sk-test";
    responses("CHAT", "EDU", { api_budget: budget.api_budget, initial_budget: 15 });
    const fetched = await fetchRows(mistralProvider);
    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "no_data" });
  });

  it("rejects unknown plan types instead of guessing from the top-level budget", async () => {
    process.env.MISTRAL_API_KEY = "sk-test";
    responses("OTHER", "EDU");
    const fetched = await fetchRows(mistralProvider);
    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toBeDefined();
  });

  it("reads stored keys independently and identifies each plan", async () => {
    world.storeLogins([
      keyLogin("student", "mistral", "key-student"),
      keyLogin("team", "mistral", "key-team"),
    ]);
    const http = fakeHttp((_url, init) => {
      const team = requestHeader(init, "Authorization") === "Bearer key-team";
      return _url.endsWith("/whoami")
        ? { plan_type: team ? "API" : "CHAT", plan_name: team ? "TEAM" : "EDU" }
        : budget;
    });
    const fetched = await fetchRows(mistralProvider);
    expect(fetched.rows.map((row) => [row.id, row.account, row.limit?.decimal]).sort()).toEqual([
      ["mistral.api_budget", "API", "15"],
      ["mistral.vibe_budget", "Vibe", "150"],
    ]);
    expect(fetched.rowLogins?.sort()).toEqual(["student", "team"]);
    expect(http).toHaveBeenCalledTimes(4);
  });

  it("reports a failed identity request without querying an ambiguous budget", async () => {
    process.env.MISTRAL_API_KEY = "sk-test";
    const http = fakeHttp(() => new Response("denied", { status: 401 }));
    const fetched = await fetchRows(mistralProvider);
    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "login_expired", status: 401 });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
