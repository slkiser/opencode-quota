import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import { createQuotaStore } from "../src/core/store.js";
import { anthropicApiProvider } from "../src/providers/anthropic-api.js";
import { errorWords } from "../src/view/row-facts.js";
import { fakeHttp, requestHeader, useProviderWorld } from "./helpers/provider-fetch.js";

useProviderWorld();
const context = { config: {} } as never;
const apiOrg = (uuid = "org-one", name = "One") => ({ uuid, name, capabilities: ["api"] });
const cookie = "fake-console-session-cookie";
beforeEach(() => {
  process.env.ANTHROPIC_CONSOLE_COOKIE = cookie;
  delete process.env.ANTHROPIC_CONSOLE_ORGANIZATION;
});
afterEach(() => {
  vi.unstubAllGlobals();
});
async function fetchCredits(payload: unknown, organizations: unknown = [apiOrg()]) {
  const http = fakeHttp((url) => (url.endsWith("/api/organizations") ? organizations : payload));
  const result = rowsFromProviderResult("anthropic-api", await anthropicApiProvider.fetch(context));
  return { ...result, http };
}
it.each([
  [{ amount: 1842, currency: "USD" }, "18.42"],
  [{ amount: 0, currency: "USD" }, "0.00"],
  [{ amount: 12505, currency: "EUR", balance: { credits: { exponent: 1 } } }, "1250.5"],
  [{ amount: 12505, currency: "JPY", balance: { credits: { exponent: 0 } } }, "12505"],
  [
    { amount: "9007199254740993", currency: "USD", balance: { credits: { exponent: 4 } } },
    "900719925474.0993",
  ],
])("scales minor currency units %j to %s", async (payload, expected) => {
  const result = await fetchCredits(payload);
  expect(result.rows[0]?.amount).toEqual({
    decimal: expected,
    unit: { kind: "currency", code: payload.currency },
  });
  expect(result.error).toBeUndefined();
});
it.each([
  null,
  {},
  { amount: null },
  { amount: "bad" },
  { amount: 1.2 },
  { amount: Number.MAX_SAFE_INTEGER + 1 },
  { amount: 1, balance: { credits: { exponent: -1 } } },
])("never invents a zero for %j", async (payload) => {
  const result = await fetchCredits({ currency: "USD", ...payload });
  expect(result.rows[0]?.amount).toBeUndefined();
  expect(result.rows[0]?.text).toBe("No data");
});
it("opts in only through the manual cookie, retaining sessionKey alone", async () => {
  delete process.env.ANTHROPIC_CONSOLE_COOKIE;
  expect(await anthropicApiProvider.isAvailable(context)).toBe(false);
  process.env.ANTHROPIC_CONSOLE_COOKIE = `Cookie: other=ignored; sessionKey=${cookie}`;
  const { http } = await fetchCredits({ amount: 1842, currency: "USD" });
  for (const [, init] of http.mock.calls) {
    expect(requestHeader(init, "Cookie")).toBe(`sessionKey=${cookie}`);
    expect(init.redirect).toBe("manual");
  }
});
it.each(["", "other=value", "sessionKey=x; sessionKey=y", "sessionKey=x\r\nother=y"])(
  "rejects invalid cookies without a request",
  async (raw) => {
    process.env.ANTHROPIC_CONSOLE_COOKIE = raw;
    const result = await fetchCredits({ amount: 10, currency: "USD" });
    expect(result.http).not.toHaveBeenCalled();
    expect(result.error?.code).toBe("not_configured");
  },
);
it.each([302, 401, 403])(
  "reports rejected sessions (HTTP %s) without exposing the cookie",
  async (status) => {
    fakeHttp(() => new Response(cookie, { status }));
    const result = rowsFromProviderResult(
      "anthropic-api",
      await anthropicApiProvider.fetch(context),
    );
    expect(result.error?.code).toBe("login_expired");
    expect(JSON.stringify(result)).not.toContain(cookie);
  },
);
it("redacts transport failures and distinguishes billing access denied", async () => {
  fakeHttp(() => {
    throw new Error(cookie);
  });
  expect(JSON.stringify(await anthropicApiProvider.fetch(context))).not.toContain(cookie);
  fakeHttp((url) =>
    url.endsWith("/api/organizations") ? [apiOrg()] : new Response(cookie, { status: 403 }),
  );
  const result = await anthropicApiProvider.fetch(context);
  expect(result.accounts[0]?.errors[0]?.message).toContain("billing access denied");
  expect(JSON.stringify(result)).not.toContain(cookie);
});
it("selects the sole API organization while ignoring chat organizations", async () => {
  const result = await fetchCredits({ amount: 1, currency: "USD" }, [
    { uuid: "chat", capabilities: ["chat"] },
    apiOrg(),
  ]);
  expect(result.http.mock.calls.map(([url]) => url)).toEqual([
    "https://platform.claude.com/api/organizations",
    "https://platform.claude.com/api/organizations/org-one/prepaid/credits",
  ]);
});
it.each([undefined, "missing", "Duplicate"])(
  "asks for an explicit unambiguous organization (%s)",
  async (selection) => {
    if (selection === undefined) delete process.env.ANTHROPIC_CONSOLE_ORGANIZATION;
    else process.env.ANTHROPIC_CONSOLE_ORGANIZATION = selection;
    const result = await fetchCredits({}, [apiOrg("one", "Duplicate"), apiOrg("two", "Duplicate")]);
    expect(result.http).toHaveBeenCalledOnce();
    expect(result.error?.code).toBe("not_configured");
    expect(errorWords({ name: "Claude API", error: result.error }, 0)).toBe(
      "Set ANTHROPIC_CONSOLE_ORGANIZATION",
    );
  },
);
it.each(["org-two", "Two"])(
  "selects an organization by UUID or exact name (%s)",
  async (selection) => {
    if (selection === undefined) delete process.env.ANTHROPIC_CONSOLE_ORGANIZATION;
    else process.env.ANTHROPIC_CONSOLE_ORGANIZATION = selection;
    const result = await fetchCredits({ amount: 10, currency: "USD" }, [
      apiOrg(),
      apiOrg("org-two", "Two"),
    ]);
    expect(result.http.mock.calls.at(-1)?.[0]).toContain("/org-two/prepaid/credits");
  },
);
it("retains last good data on failure but clears balances when cookie or organization changes", async () => {
  let failing = false;
  fakeHttp((url) =>
    failing
      ? new Response("expired", { status: 401 })
      : url.endsWith("/api/organizations")
        ? [apiOrg()]
        : { amount: 1842, currency: "USD" },
  );
  const policy = anthropicApiProvider.cachePolicy!;
  if (policy.kind !== "resolved-auth") throw new Error("Expected credential-scoped cache");
  const store = createQuotaStore({
    file: null,
    source: async () => ({
      minIntervalMs: 0,
      providers: [
        {
          id: "anthropic-api",
          label: "Claude API",
          identity: async () => ({
            key: (await policy.resolveIdentity(context)) ?? "none",
            persist: false,
          }),
          fetch: async () =>
            rowsFromProviderResult("anthropic-api", await anthropicApiProvider.fetch(context)),
        },
      ],
    }),
  });
  try {
    const first = (await store.refresh({ reason: "manual" })).providers[0]!;
    failing = true;
    const stale = (await store.refresh({ reason: "manual" })).providers[0]!;
    expect(stale.rows).toEqual(first.rows);
    expect(stale.error?.code).toBe("login_expired");
    process.env.ANTHROPIC_CONSOLE_COOKIE = "fake-new-cookie";
    expect((await store.refresh({ reason: "manual" })).providers[0]?.rows).toEqual([]);
    failing = false;
    expect((await store.refresh({ reason: "manual" })).providers[0]?.rows[0]?.amount?.decimal).toBe(
      "18.42",
    );
    process.env.ANTHROPIC_CONSOLE_ORGANIZATION = "another-org";
    expect((await store.refresh({ reason: "manual" })).providers[0]?.rows).toEqual([]);
  } finally {
    await store.dispose();
  }
});
