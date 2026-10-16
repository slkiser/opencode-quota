/**
 * Who a provider is signed in as covers every login it checks: a login added, switched or
 * swapped shows at the next check after a login change, instead of waiting out the check
 * interval. Through the store, with the real providers, a temp `opencode.db` and fake HTTP.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadProviderSource } from "../src/core/provider-source.js";
import { createQuotaStore } from "../src/core/store.js";
import type { QuotaSnapshot } from "../src/core/types.js";
import { geminiCliCompanion } from "../src/lib/google-companion-credentials.js";
import { __resetResolvedAuthIdentityForTests } from "../src/lib/resolved-auth-identity.js";
import { getProviders } from "../src/providers/registry.js";
import { defaultSettings } from "../src/settings/index.js";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import { fakeHttp, keyLogin, requestHeader, useProviderWorld } from "./helpers/provider-fetch.js";

const world = useProviderWorld();

afterEach(() => {
  __resetResolvedAuthIdentityForTests();
});

type Vendor = {
  providerId: string;
  /** What the provider needs besides its logins. */
  setup?: () => void;
  login: (id: string, token: string, updated: number) => CredentialDatabaseRow;
  /** The token a request was made with. */
  token: (init: RequestInit) => string | null;
  /** The answer for one login's token. */
  reply: (url: string) => unknown;
};

function bearerToken(init: RequestInit): string | null {
  return requestHeader(init, "Authorization")?.replace(/^Bearer /u, "") ?? null;
}

/** A vendor whose logins are API keys stored under `integrationId`. */
function keyVendor(providerId: string, integrationId: string, reply: unknown): Vendor {
  return {
    providerId,
    login: (id, token, updated) => keyLogin(id, integrationId, token, { label: id, updated }),
    token: bearerToken,
    reply: () => reply,
  };
}

const VENDORS: Vendor[] = [
  {
    providerId: "copilot",
    login: (id, token, updated) => ({
      id,
      integrationId: "github-copilot",
      label: id,
      active: null,
      updated,
      value: { type: "oauth", access: token, refresh: token },
    }),
    token: (init) => requestHeader(init, "Authorization")?.replace(/^token /u, "") ?? null,
    reply: () => ({
      copilot_plan: "pro",
      quota_snapshots: {
        premium_interactions: { entitlement: 300, quota_remaining: 150, percent_remaining: 50 },
      },
    }),
  },
  {
    providerId: "anthropic",
    login: (id, token, updated) => ({
      id,
      integrationId: "anthropic",
      label: id,
      active: null,
      updated,
      value: { type: "oauth", access: token, refresh: token, expires: Date.now() + 3_600_000 },
    }),
    token: bearerToken,
    reply: () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
  },
  {
    providerId: "openai",
    login: (id, token, updated) => ({
      id,
      integrationId: "openai",
      label: id,
      active: null,
      updated,
      value: { type: "oauth", access: token, refresh: `${token}-refresh` },
    }),
    token: bearerToken,
    reply: () => ({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
    }),
  },
  {
    providerId: "xai",
    login: (id, token, updated) => ({
      id,
      integrationId: "xai",
      label: id,
      active: null,
      updated,
      value: { type: "oauth", access: token },
    }),
    token: bearerToken,
    reply: (url) =>
      url.includes("billing")
        ? { config: { creditUsagePercent: 10, currentPeriod: { type: "WEEKLY" } } }
        : { subscriptions: [] },
  },
  {
    providerId: "google-gemini-cli",
    setup: () => {
      world.writeCacheFile(
        "node_modules/opencode-gemini-auth/src/constants.ts",
        'export const GEMINI_CLIENT_ID = "client-id";\nexport const GEMINI_CLIENT_SECRET = "client-secret";\n',
      );
      geminiCliCompanion.clearCacheForTests();
    },
    login: (id, token, updated) => ({
      id,
      integrationId: "google-gemini-cli",
      label: id,
      active: null,
      updated,
      value: {
        type: "oauth",
        refresh: `refresh-${token}|project-${token}`,
        access: token,
        expires: Date.now() + 3_600_000,
      },
    }),
    token: bearerToken,
    reply: () => ({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.5 }] }),
  },
  keyVendor("kimi-code-plan-global", "kimi-code-plan-global", {
    usage: { limit: 100, used: 50 },
  }),
  keyVendor("deepseek", "deepseek", {
    balance_infos: [{ currency: "USD", total_balance: "1.00" }],
  }),
  keyVendor("ollama-cloud", "ollama-cloud", { purchased: { balance_usd: 5 } }),
];

/** The accounts the one provider shows, in order. */
function accounts(snapshot: QuotaSnapshot): Array<string | undefined> {
  return [...new Set(snapshot.providers[0]?.rows.map((row) => row.account))];
}

/** A store over the one provider, every other provider switched off. */
function storeFor(providerId: string) {
  const settings = defaultSettings();
  // No Claude CLI: only the OpenCode logins count.
  settings.providers.anthropic.binaryPath = join(world.configDir, "no-claude");
  settings.providers.off = getProviders()
    .map(({ id }) => (id === "quota-providers" ? "custom" : id))
    .filter((id) => id !== providerId);
  const loaded = {
    path: "settings.jsonc",
    exists: true,
    settings,
    issues: [],
    fromFile: [],
    notRead: [],
  };
  // OpenCode lists the provider, as it does once one of its logins exists.
  const client = {
    config: { providers: async () => ({ data: { providers: [{ id: providerId }] } }) },
  };
  const host = { client, workspaceRoot: world.configDir, settings: () => loaded };
  return createQuotaStore({
    source: () => loadProviderSource(host),
    file: join(world.configDir, "snapshot-v6.json"),
    log: () => {},
  });
}

describe.each(VENDORS)("$providerId login list", (vendor) => {
  /** The tokens of the requests made so far. */
  function recordTokens(): string[] {
    const tokens: string[] = [];
    fakeHttp((url, init) => {
      const token = vendor.token(init);
      if (token) tokens.push(token);
      return vendor.reply(url);
    });
    vendor.setup?.();
    return tokens;
  }

  it("checks a login added after the last check at the next login change", async () => {
    const tokens = recordTokens();
    world.storeLogins([vendor.login("work", "token-work", 2)]);
    const store = storeFor(vendor.providerId);

    const first = await store.refresh({ reason: "manual" });
    expect(accounts(first)).toEqual([expect.stringContaining("work")]);

    world.storeLogins([
      vendor.login("work", "token-work", 2),
      vendor.login("home", "token-home", 1),
    ]);
    store.invalidateIdentity();
    const second = await store.refresh({ reason: "poll" });
    await store.dispose();

    expect(tokens).toContain("token-home");
    expect(accounts(second)).toEqual([
      expect.stringContaining("work"),
      expect.stringContaining("home"),
    ]);
  });

  it("checks again when two logins swap their tokens", async () => {
    const tokens = recordTokens();
    world.storeLogins([vendor.login("work", "token-a", 2), vendor.login("home", "token-b", 1)]);
    const store = storeFor(vendor.providerId);
    await store.refresh({ reason: "manual" });
    tokens.length = 0;

    world.storeLogins([vendor.login("work", "token-b", 2), vendor.login("home", "token-a", 1)]);
    store.invalidateIdentity();
    await store.refresh({ reason: "poll" });
    await store.dispose();

    expect(tokens).toEqual(expect.arrayContaining(["token-a", "token-b"]));
  });
});

it("checks again when a config key is removed and a stored login holds the same key", async () => {
  const apiKey = (key?: string) =>
    world.writeConfigFile(
      "opencode.json",
      JSON.stringify({ providers: { deepseek: { settings: { apiKey: key } } } }),
    );
  fakeHttp(() => ({ balance_infos: [{ currency: "USD", total_balance: "1.00" }] }));
  apiKey("same-key");
  world.storeLogins([keyLogin("work", "deepseek", "same-key", { label: "work" })]);
  const store = storeFor("deepseek");
  const fromConfig = await store.refresh({ reason: "manual" });

  apiKey(undefined);
  store.invalidateIdentity();
  const fromLogin = await store.refresh({ reason: "poll" });
  await store.dispose();

  expect([accounts(fromConfig), accounts(fromLogin)]).toEqual([[undefined], ["work"]]);
});
