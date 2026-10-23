import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __resetOpenCodeGoNotSubscribedForTests,
  opencodeGoProvider,
} from "../src/providers/opencode-go.js";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
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
const NO_PROJECT_CTX = { config: {}, locationDirectory: NO_PROJECT_DIRECTORY } as never;

beforeEach(() => {
  __resetOpenCodeGoNotSubscribedForTests();
});

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CONSOLE_SERVER = "https://console.example.test";
const CONSOLE_STATUS_URL = `${CONSOLE_SERVER}/api/go/status`;

/** The Go API's reply: offset reset times, and a rate-limited weekly window (all used). */
const USAGE_REPLY = {
  usage: {
    rolling: { status: "ok", percent: 12.5, resetsAt: "2026-10-10T12:30:00Z" },
    weekly: { status: "rate-limited", percent: 42, resetsAt: "2026-10-12T18:00:00+02:00" },
    monthly: { status: "ok", percent: 80, resetsAt: "2026-11-01T00:00:00-04:00" },
  },
};
const USAGE_ROWS = [
  ["opencode-go.five_hour", null, "5h", "five_hour", 87.5, "2026-10-10T12:30:00.000Z"],
  ["opencode-go.weekly", null, "Weekly", "week", 0, "2026-10-12T16:00:00.000Z"],
  ["opencode-go.monthly", null, "Monthly", "month", 20, "2026-11-01T04:00:00.000Z"],
];

/** The Console's Go meters: string microcents, a spent zero limit, the plan end as fallback reset. */
const CONSOLE_REPLY = {
  access: {
    endsAt: "2026-11-02T12:00:00Z",
    meters: {
      fiveHour: { limitMicroCents: 1000, usedMicroCents: "250", resetsAt: "2026-10-10T15:00:00Z" },
      week: { limitMicroCents: 0, usedMicroCents: 5 },
      month: { limitMicroCents: 1000, usedMicroCents: 500, resetsAt: "2026-11-01T00:00:00Z" },
    },
  },
};
const CONSOLE_ROWS = [
  ["opencode-go.five_hour", null, "5h", "five_hour", 75, "2026-10-10T15:00:00.000Z"],
  ["opencode-go.weekly", null, "Weekly", "week", 0, "2026-11-02T12:00:00.000Z"],
  ["opencode-go.monthly", null, "Monthly", "month", 50, "2026-11-01T00:00:00.000Z"],
];

const NOT_SUBSCRIBED_DETAIL = { key: "opencode_go_state", value: "not_subscribed" };

/** The Go API's answer for a key without a Go plan. */
function notSubscribedReply() {
  const body = { type: "error", error: { type: "EntitlementError", message: "Go required." } };
  return new Response(JSON.stringify(body), { status: 403 });
}

/** The Console sign-in as `opencode auth login opencode` stores it, with `value` fields changed. */
function consoleLogin(value: Record<string, unknown> = {}): CredentialDatabaseRow {
  return {
    id: "console",
    integrationId: "opencode",
    active: 1,
    updated: 1,
    value: {
      type: "oauth",
      access: "console-access",
      refresh: "console-refresh",
      expires: Date.parse("2099-01-01T00:00:00Z"),
      metadata: { orgID: "wrk_1", server: CONSOLE_SERVER },
      ...value,
    },
  };
}

/** The Authorization header of each request made so far. */
function authorizations(http: ReturnType<typeof fakeHttp>) {
  return http.mock.calls.map(([, init]) => requestHeader(init, "Authorization"));
}

describe("OpenCode Go with the Console sign-in", () => {
  it("reads the Go meters from the login's Console server, scoped to its org", async () => {
    world.storeLogins([consoleLogin()]);
    const http = fakeHttp(() => CONSOLE_REPLY);

    const fetched = await fetchRows(opencodeGoProvider);

    expect(http).toHaveBeenCalledOnce();
    const [requestUrl, init] = http.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(CONSOLE_STATUS_URL);
    expect(requestHeader(init, "Authorization")).toBe("Bearer console-access");
    expect(requestHeader(init, "x-org-id")).toBe("wrk_1");
    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual(CONSOLE_ROWS);
    expect(fetched.rowLogins).toEqual(["console:go", "console:go", "console:go"]);
  });

  it.each([
    {
      name: "a Console 404 means no Go plan, and the API key is not asked",
      login: consoleLogin(),
      consoleStatus: 404,
      apiKey: true,
      rows: [],
      errorCode: undefined,
      detail: NOT_SUBSCRIBED_DETAIL,
    },
    {
      name: "a Console 500 falls back to the API key",
      login: consoleLogin(),
      consoleStatus: 500,
      apiKey: true,
      rows: USAGE_ROWS,
      errorCode: undefined,
      detail: { key: "console_error", value: "OpenCode Console API error 500 (/api/go/status)" },
    },
    {
      name: "a Console 500 without an API key is Go's error",
      login: consoleLogin(),
      consoleStatus: 500,
      apiKey: false,
      rows: [],
      errorCode: "provider_error",
      detail: {
        key: "error",
        value: "OpenCode Go: OpenCode Console API error 500 (/api/go/status)",
      },
    },
    {
      name: "an expired sign-in uses the API key",
      login: consoleLogin({ expires: 1 }),
      consoleStatus: 500,
      apiKey: true,
      rows: USAGE_ROWS,
      errorCode: undefined,
      detail: { key: "console_auth_state", value: "expired" },
    },
    {
      name: "an expired sign-in without an API key says sign in again, as Zen does",
      login: consoleLogin({ expires: 1 }),
      consoleStatus: 500,
      apiKey: false,
      rows: [],
      errorCode: "login_expired",
      detail: {
        key: "error",
        value:
          "OpenCode Go: OpenCode Console sign-in failed: the sign-in expired. Run `opencode auth login opencode`.",
      },
    },
    {
      name: "a sign-in without a token is Go's error when there is no API key",
      login: consoleLogin({ access: "" }),
      consoleStatus: 500,
      apiKey: false,
      rows: [],
      errorCode: "not_configured",
      detail: {
        key: "error",
        value:
          "OpenCode Go: OpenCode Console sign-in failed: OpenCode Console credential has no access token. Run `opencode auth login opencode`.",
      },
    },
  ])("$name", async ({ login, consoleStatus, apiKey, rows, errorCode, detail }) => {
    world.storeLogins([login]);
    if (apiKey) process.env.OPENCODE_API_KEY = "go-key";
    fakeHttp((url) =>
      url === CONSOLE_STATUS_URL ? new Response("{}", { status: consoleStatus }) : USAGE_REPLY,
    );

    const fetched = await fetchRows(opencodeGoProvider);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    expect(fetched.error?.code).toBe(errorCode);
    expect(fetched.debug).toContainEqual(detail);
  });
});

describe("OpenCode Go with an API key", () => {
  it("is not configured without a sign-in or a key, and asks nothing", async () => {
    const http = fakeHttp(() => USAGE_REPLY);

    const fetched = await fetchRows(opencodeGoProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toEqual({ code: "not_configured" });
    expect(http).not.toHaveBeenCalled();
  });

  it("asks the Go API with the env key and shows every window", async () => {
    process.env.OPENCODE_API_KEY = "go-key";
    const http = fakeHttp(() => USAGE_REPLY);

    const fetched = await fetchRows(opencodeGoProvider);

    expect(http).toHaveBeenCalledOnce();
    const [requestUrl, init] = http.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(GO_USAGE_URL);
    expect(requestHeader(init, "Authorization")).toBe("Bearer go-key");
    expect(fetched.error).toBeUndefined();
    expect(rowSummary(fetched.rows)).toEqual(USAGE_ROWS);
  });

  it.each([
    {
      reply: () => new Response("unavailable", { status: 503 }),
      code: "provider_error",
      message: "OpenCode Go API error 503: unavailable",
    },
    {
      reply: () => new Response('{"error":"forbidden"}', { status: 403 }),
      code: "provider_error",
      message: 'OpenCode Go API error 403: {"error":"forbidden"}',
    },
    {
      reply: () => new Response("bad key go-key", { status: 401 }),
      code: "login_expired",
      message: "OpenCode Go API error 401: bad key [redacted]",
    },
    {
      reply: () => ({
        usage: {
          ...USAGE_REPLY.usage,
          weekly: { status: "ok", percent: 1, resetsAt: "2026-10-12" },
        },
      }),
      code: "bad_response",
      message:
        "Invalid OpenCode Go API response: weekly resetsAt must be an offset-qualified ISO timestamp",
    },
  ])("shows $code for: $message", async ({ reply, code, message }) => {
    process.env.OPENCODE_API_KEY = "go-key";
    fakeHttp(reply);

    const fetched = await fetchRows(opencodeGoProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe(code);
    expect(fetched.debug).toContainEqual({ key: "error", value: `OpenCode Go: ${message}` });
    expect(JSON.stringify(fetched)).not.toContain("go-key");
  });

  it("does not ask again for a key without a Go plan, until the key changes", async () => {
    process.env.OPENCODE_API_KEY = "free-key";
    const http = fakeHttp(() => notSubscribedReply());

    for (const fetched of [
      await fetchRows(opencodeGoProvider),
      await fetchRows(opencodeGoProvider),
    ]) {
      expect(fetched.rows).toEqual([]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toContainEqual(NOT_SUBSCRIBED_DETAIL);
    }
    process.env.OPENCODE_API_KEY = "other-key";
    await fetchRows(opencodeGoProvider);
    process.env.OPENCODE_API_KEY = "free-key";
    await fetchRows(opencodeGoProvider);

    expect(authorizations(http)).toEqual([
      "Bearer free-key",
      "Bearer other-key",
      "Bearer free-key",
    ]);
  });

  it("asks again after the availability check found no key", async () => {
    process.env.OPENCODE_API_KEY = "free-key";
    const http = fakeHttp(() => notSubscribedReply());
    await fetchRows(opencodeGoProvider);

    delete process.env.OPENCODE_API_KEY;
    await expect(opencodeGoProvider.isAvailable(NO_PROJECT_CTX)).resolves.toBe(false);
    process.env.OPENCODE_API_KEY = "free-key";
    await fetchRows(opencodeGoProvider);

    expect(http).toHaveBeenCalledTimes(2);
  });
});

describe("OpenCode Go with stored keys", () => {
  it("queries each key as its own account: a broken login first, a key without Go hidden", async () => {
    world.storeLogins([
      keyLogin("work", "opencode-go", "work-key", { label: "Work", updated: 4 }),
      keyLogin("free", "opencode-go", "free-key", { label: "Free", updated: 3 }),
      keyLogin("down", "opencode-go", "down-key", { label: "Down", updated: 2 }),
      keyLogin("broken", "opencode-go", "", { label: "Broken", updated: 1 }),
    ]);
    fakeHttp((_url, init) => {
      const authorization = requestHeader(init, "Authorization");
      if (authorization === "Bearer free-key") return notSubscribedReply();
      if (authorization === "Bearer down-key") return new Response("unavailable", { status: 503 });
      return USAGE_REPLY;
    });

    const fetched = await fetchRows(opencodeGoProvider);

    expect(rowSummary(fetched.rows)).toEqual(
      USAGE_ROWS.map((row) => [row[0], "Work", ...row.slice(2)]),
    );
    expect(fetched.rowLogins).toEqual(["work", "work", "work"]);
    // The broken login comes first, so its error is the one shown.
    expect(fetched.error?.code).toBe("not_configured");
    expect(fetched.debug.filter((item) => item.key === "error")).toEqual([
      {
        key: "error",
        value: "[OpenCode Go Broken]: OpenCode Go auth entry present but key is empty",
      },
      { key: "error", value: "[OpenCode Go Down]: OpenCode Go API error 503: unavailable" },
    ]);
  });

  it.each([
    {
      name: "a key under both `opencode-go` and the legacy `opencode` id is one account",
      logins: [
        keyLogin("go", "opencode-go", "shared-key", { updated: 2 }),
        keyLogin("alias", "opencode", "shared-key", { updated: 1 }),
      ],
      login: "go",
    },
    {
      name: "a key under the legacy `opencode` id alone is used",
      logins: [keyLogin("alias", "opencode", "legacy-key")],
      login: "alias",
    },
  ])("$name", async ({ logins, login }) => {
    world.storeLogins(logins);
    const http = fakeHttp(() => USAGE_REPLY);

    const fetched = await fetchRows(opencodeGoProvider);

    expect(http).toHaveBeenCalledOnce();
    expect(fetched.rowLogins).toEqual([login, login, login]);
  });
});

describe("OpenCode Go availability and models", () => {
  it.each([
    { name: "a Console sign-in", logins: [consoleLogin()], apiKey: false, available: true },
    {
      name: "an expired sign-in",
      logins: [consoleLogin({ expires: 1 })],
      apiKey: false,
      available: true,
    },
    {
      name: "a sign-in without a token",
      logins: [consoleLogin({ access: "" })],
      apiKey: false,
      available: true,
    },
    { name: "an env key", logins: [], apiKey: true, available: true },
    {
      name: "only a broken stored key",
      logins: [keyLogin("broken", "opencode-go", "")],
      apiKey: false,
      available: false,
    },
    { name: "nothing", logins: [], apiKey: false, available: false },
  ])("is available with $name: $available", async ({ logins, apiKey, available }) => {
    world.storeLogins(logins);
    if (apiKey) process.env.OPENCODE_API_KEY = "go-key";
    const http = fakeHttp(() => USAGE_REPLY);

    await expect(opencodeGoProvider.isAvailable(NO_PROJECT_CTX)).resolves.toBe(available);
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    ["opencode-go/some-model", true],
    ["opencode-go-subscription/any", true],
    ["openai/gpt-4", false],
  ])("matches the model %s: %s", (model, expected) => {
    expect(opencodeGoProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
