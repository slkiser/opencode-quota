// The provider flow shared by Google AGY and Gemini CLI (src/providers/google-oauth-provider.ts),
// through the real providers with logins in a temp `opencode.db`, a fake companion plugin in
// OpenCode's package cache, and fake HTTP.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { agyCompanion, geminiCliCompanion } from "../src/lib/google-companion-credentials.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
} from "../src/lib/opencode-auth.js";
import { __resetResolvedAuthIdentityForTests } from "../src/lib/resolved-auth-identity.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { fakeHttp, fetchRows, requestHeader, useProviderWorld } from "./helpers/provider-fetch.js";

const world = useProviderWorld();
const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";

const PROVIDERS = [
  {
    name: "Google AGY",
    integrationId: "google-agy",
    provider: googleAgyProvider,
    companion: {
      resolver: agyCompanion,
      packageName: "@anthonyhaussman/opencode-agy-auth",
      constants: "AGY",
    },
    /** A quota answer with one bucket holding `fields`. */
    quota: (fields: Record<string, unknown> = {}) => ({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ window: "WEEKLY", remainingFraction: 0.7, ...fields }],
        },
      ],
    }),
    rowId: "google-agy.gemini.weekly",
  },
  {
    name: "Gemini CLI",
    integrationId: "google-gemini-cli",
    provider: googleGeminiCliProvider,
    companion: {
      resolver: geminiCliCompanion,
      packageName: "opencode-gemini-auth",
      constants: "GEMINI",
    },
    quota: (fields: Record<string, unknown> = {}) => ({
      buckets: [{ modelId: "gemini-2.5", remainingFraction: 0.7, ...fields }],
    }),
    rowId: "google-gemini-cli.model.2_5",
  },
] as const;

type Flavor = (typeof PROVIDERS)[number];

beforeEach(() => {
  agyCompanion.clearCacheForTests();
  geminiCliCompanion.clearCacheForTests();
});

afterEach(() => {
  __resetResolvedAuthIdentityForTests();
});

/**
 * Installs the flavor's companion plugin in OpenCode's package cache, with its OAuth client or,
 * when `compatible` is false, without it. Returns the constants file.
 */
function installCompanion(flavor: Flavor, compatible = true): string {
  const { packageName, constants } = flavor.companion;
  return world.writeCacheFile(
    `node_modules/${packageName}/src/constants.ts`,
    compatible
      ? `export const ${constants}_CLIENT_ID = "client-id";\nexport const ${constants}_CLIENT_SECRET = "client-secret";\n`
      : "export const UNRELATED = 1;\n",
  );
}

/** A stored login whose access token is still valid, so no token refresh is needed. */
function googleLogin(
  flavor: Flavor,
  id: string,
  fields: { label?: string; updated?: number; refresh?: string } = {},
): CredentialDatabaseRow {
  return {
    id,
    integrationId: flavor.integrationId,
    label: fields.label ?? id,
    active: null,
    updated: fields.updated ?? 1,
    value: {
      type: "oauth",
      refresh: fields.refresh ?? `refresh-${id}|project-${id}`,
      access: `access-${id}`,
      expires: Date.now() + 3_600_000,
    },
  };
}

function errorDebug(fetched: { debug: Array<{ key: string; value: string }> }): string[] {
  return fetched.debug.filter((detail) => detail.key === "error").map((detail) => detail.value);
}

describe.each(PROVIDERS)("$name provider", (flavor) => {
  const { name, provider } = flavor;

  it.each([
    ["a login and the companion plugin", true, true, true],
    ["no login", false, false, true],
    ["no companion plugin", false, true, false],
  ])("is available with %s: %s", async (_case, expected, withLogin, withCompanion) => {
    if (withLogin) world.storeLogins([googleLogin(flavor, "work")]);
    if (withCompanion) installCompanion(flavor);

    await expect(provider.isAvailable({ client: {} } as never)).resolves.toBe(expected);
  });

  it("is not set up without a login", async () => {
    installCompanion(flavor);
    const http = fakeHttp(() => flavor.quota());

    expect(await fetchRows(provider)).toMatchObject({
      rows: [],
      error: { code: "not_configured" },
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("queries every login without deduping duplicate aliases", async () => {
    installCompanion(flavor);
    world.storeLogins([
      googleLogin(flavor, "one", { label: "Work", updated: 2 }),
      googleLogin(flavor, "two", { label: "Work", updated: 1 }),
    ]);
    const http = fakeHttp(() => flavor.quota());

    const fetched = await fetchRows(provider);

    expect(http.mock.calls.map(([, init]) => requestHeader(init, "Authorization")).sort()).toEqual([
      "Bearer access-one",
      "Bearer access-two",
    ]);
    expect(fetched.rows.map((row) => [row.id, row.account, row.percentRemaining])).toEqual([
      [flavor.rowId, "Work", 70],
      [flavor.rowId, "Work 2", 70],
    ]);
    expect(fetched.rowLogins).toEqual(["one", "two"]);
  });

  it("shows a failed quota request as the login's error", async () => {
    installCompanion(flavor);
    world.storeLogins([googleLogin(flavor, "work")]);
    fakeHttp(() => new Response("{}", { status: 500 }));

    const fetched = await fetchRows(provider);

    expect(fetched.rows).toEqual([]);
    expect(errorDebug(fetched)).toEqual([`[${name} work]: ${name} quota API error: 500`]);
  });

  it("passes the request timeout only when the user configured it", async () => {
    installCompanion(flavor);
    world.storeLogins([googleLogin(flavor, "work")]);
    fakeHttp(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return flavor.quota();
    });

    const configured = await fetchRows(provider, {
      requestTimeoutMs: 20,
      requestTimeoutMsConfigured: true,
    });
    expect(errorDebug(configured)).toEqual([`[${name} work]: API timeout`]);

    // Not configured: Google's own, longer timeout applies.
    const unconfigured = await fetchRows(provider, { requestTimeoutMs: 20 });
    expect(unconfigured.rows.map((row) => row.id)).toEqual([flavor.rowId]);
  });

  it("reports auth and companion state in status details", async () => {
    const companionPath = installCompanion(flavor, false);
    world.storeLogins([googleLogin(flavor, "work", { refresh: "refresh-token" })]);

    const { debug } = await fetchRows(provider);

    expect(debug).toEqual([
      { key: "auth_state", value: "invalid" },
      { key: "auth_source", value: flavor.integrationId },
      { key: "account_count", value: "1" },
      { key: "valid_account_count", value: "0" },
      { key: "companion_package_state", value: "invalid" },
      { key: "companion_package_path", value: companionPath },
      { key: "auth_error", value: `${name} OAuth auth is missing a refresh token or project id` },
      {
        key: "companion_error",
        value: `Installed ${flavor.companion.packageName} package is incompatible`,
      },
    ]);
  });

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "keeps the remembered rows apart per companion client and login list",
    async () => {
      const policy = provider.cachePolicy;
      if (policy.kind !== "resolved-auth") throw new Error("expected a resolved-auth policy");
      const identity = () => policy.resolveIdentity({ config: {} } as never, {} as never);
      world.storeLogins([googleLogin(flavor, "work")]);

      // Without the companion's OAuth client the rows are not remembered.
      await expect(identity()).resolves.toBeNull();

      installCompanion(flavor);
      flavor.companion.resolver.clearCacheForTests();
      const one = await identity();
      expect(one).toEqual(expect.any(String));
      await expect(identity()).resolves.toBe(one);

      world.storeLogins([googleLogin(flavor, "work"), googleLogin(flavor, "home")]);
      await expect(identity()).resolves.not.toBe(one);
    },
  );
});

describe("Google AGY rows", () => {
  it.each([
    [
      "each model family and window",
      {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { window: "FIVE_HOUR", remainingFraction: 0.25 },
              { window: "WEEKLY", remainingFraction: 0.58, resetTime: "2026-06-22T00:00:00Z" },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              { window: "FIVE_HOUR", remainingFraction: 0.9 },
              { window: "WEEKLY", remainingFraction: 1 },
            ],
          },
        ],
      },
      [
        ["google-agy.gemini.weekly", "Gemini Weekly", "week", 58, "2026-06-22T00:00:00.000Z"],
        ["google-agy.gemini.five_hour", "Gemini 5h", "five_hour", 25, undefined],
        ["google-agy.claude_gpt.weekly", "Claude/GPT Weekly", "week", 100, undefined],
        ["google-agy.claude_gpt.five_hour", "Claude/GPT 5h", "five_hour", 90, undefined],
      ],
    ],
    [
      "a summary without groups",
      { buckets: [{ window: "WEEKLY", remainingFraction: 0.58 }] },
      [["google-agy.quota_summary.weekly", "Quota Summary Weekly", "week", 58, undefined]],
    ],
  ])("gives %s of one login its own row", async (_case, reply, rows) => {
    installCompanion(PROVIDERS[0]);
    world.storeLogins([googleLogin(PROVIDERS[0], "work")]);
    fakeHttp(() => reply);

    const fetched = await fetchRows(googleAgyProvider);

    expect(
      fetched.rows.map((row) => [
        row.id,
        row.label,
        row.window,
        row.percentRemaining,
        row.resetsAt,
      ]),
    ).toEqual(rows);
    expect(new Set(fetched.rows.map((row) => row.account))).toEqual(new Set(["work"]));
  });

  it.each([
    ["google-agy/gpt-4", true],
    ["opencode-agy-auth/gpt-4", true],
    ["google-agy-auth/gpt-4", true],
    ["google/claude-opus", false],
  ])("matches the Google AGY runtime ids: %s → %s", (model, expected) => {
    expect(googleAgyProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});

describe("Gemini CLI rows", () => {
  it("keys the quality tiers and other models", async () => {
    installCompanion(PROVIDERS[1]);
    world.storeLogins([googleLogin(PROVIDERS[1], "work")]);
    fakeHttp(() => ({
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.2, resetTime: "2026-01-01T12:00:00Z" },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.5 },
        { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.1 },
        { modelId: "gemini-3-daily", remainingFraction: 0.3 },
      ],
    }));

    const fetched = await fetchRows(googleGeminiCliProvider);

    expect(fetched.rows.map((row) => [row.id, row.label, row.window ?? null])).toEqual([
      ["google-gemini-cli.pro", "Pro", null],
      ["google-gemini-cli.flash", "Flash", null],
      ["google-gemini-cli.flash_lite", "Flash Lite", null],
      ["google-gemini-cli.model.3_daily", "3 Daily", "day"],
    ]);
    expect(fetched.rows[0]?.resetsAt).toBe("2026-01-01T12:00:00Z");
  });

  it("shows a login OpenCode could not return as an error next to working ones, and keeps the rows in memory only", async () => {
    installCompanion(PROVIDERS[1]);
    PROVIDERS[1].companion.resolver.clearCacheForTests();
    const integration = createFakeIntegration([
      {
        integrationId: "google",
        id: "failed-id",
        label: "work@example.com",
        registered: true,
        method: "oauth",
        value: { type: "oauth" },
        resolveError: "HTTP 400",
      },
      {
        integrationId: "google-gemini-cli",
        id: "working-id",
        label: "home@example.com",
        registered: true,
        method: "oauth",
        value: {
          type: "oauth",
          refresh: "refresh-token|project-id",
          access: "access-home",
          expires: Date.now() + 3_600_000,
        },
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
    const http = fakeHttp(() => PROVIDERS[1].quota({ modelId: "gemini-2.5-pro" }));

    try {
      const fetched = await fetchRows(googleGeminiCliProvider);

      // Only the working login is queried.
      expect(http).toHaveBeenCalledOnce();
      expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
        ["google-gemini-cli.pro", "home@example.com"],
      ]);
      expect(fetched.rowLogins).toEqual(["working-id"]);
      expect(errorDebug(fetched)).toEqual([
        "[Gemini CLI [email]] (active): Gemini CLI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth login google`.",
      ]);
      const policy = googleGeminiCliProvider.cachePolicy;
      if (policy.kind !== "resolved-auth") throw new Error("expected a resolved-auth policy");
      await expect(
        policy.resolveIdentity({ config: {} } as never, {} as never),
      ).resolves.toBeNull();
    } finally {
      unbind();
    }
  });

  it.each([
    ["google-gemini-cli/gemini-3-pro", true],
    ["gemini-cli/gemini-3-flash", true],
    ["google/gemini-2.5-pro", true],
    ["google/claude-opus", false],
    ["google/antigravity-gemini-3-pro", false],
  ])("matches Gemini CLI current model ids: %s → %s", (model, expected) => {
    expect(googleGeminiCliProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});

const TOKENS = { kind: "count", unit: "token" } as const;
const REQUESTS = { kind: "count", unit: "request" } as const;
const PLAIN = { kind: "count", unit: "unit" } as const;

describe("google remaining counts", () => {
  it.each([
    ["Google AGY", { remainingAmount: "1200" }, { decimal: "1200", unit: PLAIN }],
    ["Google AGY", {}, undefined],
    [
      "Gemini CLI",
      { remainingAmount: "1200", tokenType: "TOKENS" },
      { decimal: "1200", unit: TOKENS },
    ],
    [
      "Gemini CLI",
      { remainingAmount: "0042", tokenType: "requests" },
      { decimal: "42", unit: REQUESTS },
    ],
    ["Gemini CLI", { remainingAmount: "1234567" }, { decimal: "1234567", unit: PLAIN }],
    [
      "Gemini CLI",
      { remainingAmount: "12.5", tokenType: "TOKENS" },
      { decimal: "12.5", unit: TOKENS },
    ],
    ["Google AGY", { remainingAmount: "007.250" }, { decimal: "7.25", unit: PLAIN }],
    ["Gemini CLI", { tokenType: "TOKENS" }, undefined],
  ])("%s %j keeps the count", async (name, fields, remaining) => {
    const flavor = PROVIDERS.find((candidate) => candidate.name === name);
    if (!flavor) throw new Error(`no provider ${name}`);
    installCompanion(flavor);
    world.storeLogins([googleLogin(flavor, "work")]);
    fakeHttp(() => flavor.quota(fields));

    const fetched = await fetchRows(flavor.provider);

    expect(fetched.rows.map((row) => row.remaining)).toEqual([remaining]);
  });
});
