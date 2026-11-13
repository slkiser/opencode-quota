import { expect, it } from "vite-plus/test";

import { commandCodeProvider as provider } from "../src/providers/command-code.js";
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
const BASE = "https://api.commandcode.ai/alpha";
const FIVE = { used: 25, cap: 100, resetAt: Date.parse("2026-11-13T18:00:00Z") };
const WEEK = { used: 120, cap: 200, resetAt: Date.parse("2026-11-20T00:00:00Z") };
const CREDITS = {
  credits: { monthlyCredits: 123 },
  windowLimits: { fiveHour: FIVE, weekly: WEEK },
};
const ctx = { locationDirectory: NO_PROJECT_DIRECTORY, config: {} };

function storedKey() {
  world.storeLogins([keyLogin("command", "commandcode", "fixture-key")]);
}

it.each([null, { id: "org /?&" }])("reads both rows for account org=%j", async (org) => {
  storedKey();
  const http = fakeHttp((url) => (url.includes("whoami") ? { success: true, org } : CREDITS));
  await expect(provider.isAvailable(ctx as never)).resolves.toBe(true);
  const fetched = await fetchRows(provider);
  expect(fetched.error).toBeUndefined();
  expect(rowSummary(fetched.rows)).toEqual([
    ["commandcode.five_hour", null, "5h", "five_hour", 75, "2026-11-13T18:00:00.000Z"],
    ["commandcode.weekly", null, "Weekly", "week", 40, "2026-11-20T00:00:00.000Z"],
  ]);
  expect(fetched.rowLogins).toEqual(["command", "command"]);
  expect(http.mock.calls.map(([url]) => String(url))).toEqual([
    `${BASE}/whoami?limits=1`,
    `${BASE}/billing/credits${org ? "?orgId=org+%2F%3F%26" : ""}`,
  ]);
  for (const [, init] of http.mock.calls) {
    expect(requestHeader(init, "Authorization")).toBe("Bearer fixture-key");
    expect(requestHeader(init, "Accept")).toBe("application/json");
    expect(init?.method ?? "GET").toBe("GET");
  }
});

it("hides without a key even when OpenCode lists Command Code, and sends nothing", async () => {
  const http = fakeHttp(() => CREDITS);
  await expect(
    provider.isAvailable({
      ...ctx,
      resolveRuntimeProviderIds: async () => new Set(["commandcode"]),
    } as never),
  ).resolves.toBe(false);
  expect((await fetchRows(provider)).error?.code).toBe("not_configured");
  expect(http).not.toHaveBeenCalled();
});

it.each([401, 403])("reports a sign-in error for HTTP %s at either endpoint", async (status) => {
  storedKey();
  for (const endpoint of ["whoami", "credits"]) {
    const http = fakeHttp((url) =>
      url.includes(endpoint) ? new Response("Denied", { status }) : { success: true, org: null },
    );
    const fetched = await fetchRows(provider);
    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "login_expired", status });
    expect(http).toHaveBeenCalledTimes(endpoint === "whoami" ? 1 : 2);
  }
});

it.each([undefined, null, 0])("omits a window with cap=%s", async (cap) => {
  storedKey();
  fakeHttp((url) =>
    url.includes("whoami")
      ? { success: true, org: null }
      : {
          windowLimits: { fiveHour: { ...FIVE, cap }, weekly: WEEK },
        },
  );
  const fetched = await fetchRows(provider);
  expect(fetched.error).toBeUndefined();
  expect(fetched.rows.map((row) => row.id)).toEqual(["commandcode.weekly"]);
});

it.each([
  { endpoint: "whoami", reply: () => new Response("{broken") },
  { endpoint: "credits", reply: () => new Response("{broken") },
  { endpoint: "whoami", reply: () => ({ success: true, org: {} }) },
  { endpoint: "credits", reply: () => ({ credits: {} }) },
  { endpoint: "credits", reply: () => ({ windowLimits: { fiveHour: { cap: 1 } } }) },
  {
    endpoint: "credits",
    reply: () => ({ windowLimits: { fiveHour: { ...FIVE, resetAt: 1e20 } } }),
  },
])("reports a contract error for malformed $endpoint reply %#", async ({ endpoint, reply }) => {
  storedKey();
  fakeHttp((url) => (url.includes(endpoint) ? reply() : { success: true, org: null }));
  const fetched = await fetchRows(provider);
  expect(fetched.rows).toEqual([]);
  expect(fetched.error?.code).toBe("bad_response");
});

it.each(["whoami", "credits"])(
  "redacts echoed keys from %s failures and debug",
  async (endpoint) => {
    storedKey();
    fakeHttp((url) =>
      url.includes(endpoint)
        ? new Response("rejected fixture-key", { status: 403 })
        : { success: true, org: null },
    );
    const fetched = await fetchRows(provider);
    expect(JSON.stringify(fetched)).not.toContain("fixture-key");
    expect(JSON.stringify(fetched.debug)).toContain("[redacted]");
  },
);

it("uses the environment key before saved logins", async () => {
  storedKey();
  process.env.CMD_API_KEY = "env-fixture-key";
  const http = fakeHttp((url) => (url.includes("whoami") ? { success: true, org: null } : CREDITS));
  expect((await fetchRows(provider)).rows).toHaveLength(2);
  expect(http).toHaveBeenCalledTimes(2);
  for (const [, init] of http.mock.calls) {
    expect(requestHeader(init, "Authorization")).toBe("Bearer env-fixture-key");
  }
});
