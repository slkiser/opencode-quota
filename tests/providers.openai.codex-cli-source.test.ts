/**
 * The OpenAI provider's optional Codex CLI quota source.
 *
 * OpenCode 2's "Sign in with ChatGPT" login has no ChatGPT quota (#316): its token is scoped to
 * api.openai.com, which ChatGPT's usage endpoint rejects. The Codex CLI's own sign-in is a
 * different OAuth client whose token that endpoint accepts, so it is a second source of the same
 * numbers. It is opt-in, it is a separate account, and the CLI's credentials are only read.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { readCodexCliLogin } from "../src/lib/codex-cli.js";
import { openaiProvider } from "../src/providers/openai.js";
import { fakeHttp, fetchRows, requestHeader, useProviderWorld } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const world = useProviderWorld();

const CODEX_HOME = join(world.root, "codex-home");
const AUTH_PATH = join(CODEX_HOME, "auth.json");

/** A JWT with the claims the plugin reads; the signature is not checked. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

const ACCOUNT_ID = "a893eba4-26b4-49dc-9496-2f56390a09f7";

/** A Codex CLI sign-in whose access token is valid for an hour. */
function codexAuthFile(expiresInSeconds = 3600) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
        "https://api.openai.com/auth": {
          chatgpt_account_id: ACCOUNT_ID,
          chatgpt_plan_type: "plus",
        },
      }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
      refresh_token: "codex-refresh-token",
      account_id: ACCOUNT_ID,
    },
    last_refresh: new Date().toISOString(),
  };
}

/** OpenCode 2's "Sign in with ChatGPT": a token ChatGPT's usage endpoint rejects. */
function tokenSharingLogin() {
  world.storeLogins([
    {
      id: "cred_openai",
      integrationId: "openai",
      label: "default",
      active: 1,
      updated: 1,
      value: {
        type: "oauth",
        methodID: "chatgpt-token-sharing",
        access: "opencode-token",
        refresh: "opencode-refresh",
        expires: Date.now() + 3_600_000,
        metadata: { clientID: "oaiapp_test", scopes: ["chatgpt.tokens.use.direct"] },
      },
    },
  ]);
}

/** ChatGPT's usage reply: a 5h window with 42% left and a weekly one with 80% left. */
function usageReply() {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 58, limit_window_seconds: 18_000, reset_at: 1_767_236_400 },
      secondary_window: {
        used_percent: 20,
        limit_window_seconds: 604_800,
        reset_at: 1_767_236_400,
      },
    },
  };
}

beforeEach(() => {
  process.env.CODEX_HOME = CODEX_HOME;
  mkdirSync(CODEX_HOME, { recursive: true });
});

describe("the Codex CLI quota source", () => {
  it("is off unless the settings ask for it", async () => {
    tokenSharingLogin();
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile()));
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows(openaiProvider);

    expect(http).not.toHaveBeenCalled();
    expect(fetched.rows.map((row) => row.id)).toEqual(["openai.status"]);
  });

  it("reports the Codex CLI's quota as its own account", async () => {
    tokenSharingLogin();
    const auth = codexAuthFile();
    writeFileSync(AUTH_PATH, JSON.stringify(auth));
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows(openaiProvider, { openaiCodexCliSource: true });

    expect(http).toHaveBeenCalledTimes(1);
    expect(String(http.mock.calls[0]?.[0])).toBe("https://chatgpt.com/backend-api/wham/usage");
    const init = http.mock.calls[0]?.[1];
    expect(requestHeader(init, "Authorization")).toBe(`Bearer ${auth.tokens.access_token}`);
    expect(requestHeader(init, "ChatGPT-Account-Id")).toBe(ACCOUNT_ID);

    // The Codex CLI's numbers are their own account, never the OpenCode login's.
    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["openai.status", undefined],
      ["openai.status", "Codex CLI"],
      ["openai.five_hour", "Codex CLI"],
      ["openai.weekly", "Codex CLI"],
    ]);
    expect(fetched.rows.find((row) => row.id === "openai.five_hour")?.percentRemaining).toBe(42);
    expect(fetched.rows.find((row) => row.id === "openai.weekly")?.percentRemaining).toBe(80);
  });

  it("says so when there is no Codex CLI sign-in", async () => {
    tokenSharingLogin();
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows(openaiProvider, { openaiCodexCliSource: true });

    expect(http).not.toHaveBeenCalled();
    expect(fetched.error?.detail).toMatch(/No Codex CLI sign-in found/);
  });

  it("says so when the Codex CLI sign-in has expired", async () => {
    tokenSharingLogin();
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile(-3600)));
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows(openaiProvider, { openaiCodexCliSource: true });

    expect(http).not.toHaveBeenCalled();
    expect(fetched.error?.detail).toMatch(/Codex CLI sign-in has expired/);
  });

  it("never changes the Codex CLI's credentials", async () => {
    tokenSharingLogin();
    const auth = codexAuthFile();
    writeFileSync(AUTH_PATH, JSON.stringify(auth));
    fakeHttp(() => usageReply());

    await fetchRows(openaiProvider, { openaiCodexCliSource: true });

    expect(JSON.parse(readFileSync(AUTH_PATH, "utf8"))).toEqual(auth);
  });

  it("reads the Codex CLI's own sign-in, with its account and plan", async () => {
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile()));

    const login = await readCodexCliLogin();

    expect(login.state).toBe("configured");
    if (login.state !== "configured") return;
    expect(login.accountId).toBe(ACCOUNT_ID);
    expect(login.planType).toBe("plus");
  });

  it("keeps the OpenCode login's own quota when it has one", async () => {
    world.storeLogins([
      {
        id: "cred_openai",
        integrationId: "openai",
        label: "default",
        active: 1,
        updated: 1,
        value: {
          type: "oauth",
          methodID: "chatgpt-browser",
          access: "legacy-token",
          refresh: "legacy-refresh",
          expires: Date.now() + 3_600_000,
        },
      },
    ]);
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile()));
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows(openaiProvider, { openaiCodexCliSource: true });

    // The legacy login already reports a number, so the CLI's is not asked for.
    expect(http).toHaveBeenCalledTimes(1);
    expect(requestHeader(http.mock.calls[0]?.[1], "Authorization")).toBe("Bearer legacy-token");
    expect(fetched.rows.some((row) => row.id === "openai.five_hour")).toBe(true);
    expect(fetched.rows.some((row) => row.account === "Codex CLI")).toBe(false);
  });
});

describe("the Codex CLI sign-in file", () => {
  it("is missing when there is none", async () => {
    expect(await readCodexCliLogin()).toEqual({ state: "missing" });
  });

  it("is missing when it holds no token", async () => {
    writeFileSync(AUTH_PATH, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }));
    expect(await readCodexCliLogin()).toEqual({ state: "missing" });
  });

  it("is missing when it cannot be read as JSON", async () => {
    writeFileSync(AUTH_PATH, "not json");
    expect(await readCodexCliLogin()).toEqual({ state: "missing" });
  });

  it("is expired when its token has expired", async () => {
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile(-3600)));
    const login = await readCodexCliLogin();
    expect(login.state).toBe("expired");
  });
});

describe("the Codex CLI source's availability", () => {
  it("does not make OpenAI available on its own", async () => {
    world.storeLogins([]);
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile()));
    const ctx = createProviderAvailabilityContext({ providerIds: [] });
    expect(await openaiProvider.isAvailable(ctx)).toBe(false);
  });

  it("makes OpenAI available when the source is on and the CLI is signed in", async () => {
    world.storeLogins([]);
    writeFileSync(AUTH_PATH, JSON.stringify(codexAuthFile()));
    const ctx = createProviderAvailabilityContext({
      providerIds: [],
      configOverrides: { openaiCodexCliSource: true },
    });
    expect(await openaiProvider.isAvailable(ctx)).toBe(true);
  });
});
