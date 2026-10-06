import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgyAccounts } from "../src/lib/google-agy.js";
import { resolveGeminiCliAccounts } from "../src/lib/google-gemini-cli.js";
import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  createIntegrationCredentialSource,
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  getCredentialDatabasePaths,
  getCredentialSourceDiagnostics,
  notifyCredentialsChanged,
  readAuthFile,
  readAuthFileCached,
  readCredentialRows,
  scrubCredentialErrorText,
  selectConnectionCredentialRows,
} from "../src/lib/opencode-auth.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";

const unbinds: Array<() => void> = [];

afterEach(() => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  clearReadAuthFileCacheForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function bindFakeIntegration(
  credentials: FakeCredential[],
  options?: Parameters<typeof createFakeIntegration>[1],
) {
  const integration = createFakeIntegration(credentials, options);
  unbinds.push(bindCredentialSource(createIntegrationCredentialSource(integration as never)));
  return integration;
}

function oauthCredential(
  integrationId: string,
  id: string,
  overrides: Partial<FakeCredential> = {},
): FakeCredential {
  return {
    integrationId,
    id,
    label: "default",
    registered: true,
    method: "oauth",
    value: {
      type: "oauth",
      methodID: "device",
      refresh: `${id}-refresh`,
      access: `${id}-access`,
      expires: 10,
    },
    ...overrides,
  };
}

function keyCredential(
  integrationId: string,
  id: string,
  overrides: Partial<FakeCredential> = {},
): FakeCredential {
  return {
    integrationId,
    id,
    label: "default",
    registered: true,
    method: "key",
    value: { type: "key", key: `${id}-key` },
    ...overrides,
  };
}

function resolvedIds(integration: ReturnType<typeof createFakeIntegration>): string[] {
  return integration.connection.resolve.mock.calls.map(([connection]) =>
    connection.type === "credential" ? connection.id : `env:${connection.name}`,
  );
}

describe("OpenCode auth reader", () => {
  it.each([
    ["OpenAI", "OpenAI (Pro)", "default", true, "[OpenAI] (Pro)"],
    ["OpenAI", "OpenAI (Pro)", "SEPD", true, "[OpenAI SEPD] (Pro)"],
    ["Copilot", "Copilot (business)", "sita", true, "[Copilot sita] (business)"],
    ["xAI", "xAI SuperGrok", "personal", true, "[xAI personal] (SuperGrok)"],
    ["OpenAI", "OpenAI (Pro)", "  ", true, "[OpenAI] (Pro)"],
    ["OpenAI", "OpenAI (Pro)", "openai", true, "[OpenAI] (Pro)"],
    // OpenCode 2 labels credentials imported from auth.json "OAuth" or "API key".
    ["OpenAI", "OpenAI (Pro)", "OAuth", true, "[OpenAI] (Pro)"],
    ["Copilot", "Copilot (individual)", "OAuth", true, "[Copilot] (individual)"],
    ["Z.ai", "Z.ai", "API key", true, "[Z.ai]"],
    ["MiniMax", "MiniMax", "api key", true, "[MiniMax]"],
    ["Kimi Code", "Kimi Code", "API key", true, "[Kimi Code]"],
  ])("formats %s credential aliases as %s", (providerName, fallbackName, label, active, expected) => {
    expect(
      formatCredentialDisplayNames(providerName, [
        {
          row: { id: "credential", integrationId: providerName, label, active, value: {} },
          fallbackName,
        },
      ]),
    ).toEqual([expected]);
  });

  it("marks no login when the provider has only one, active or not", () => {
    for (const active of [true, false]) {
      expect(
        formatCredentialDisplayNames("OpenAI", [
          {
            row: { id: "a", integrationId: "openai", label: "Work", active, value: {} },
            fallbackName: "OpenAI (Pro)",
          },
        ]),
      ).toEqual(["[OpenAI Work] (Pro)"]);
    }
  });

  it("numbers duplicate custom aliases without numbering default credentials", () => {
    expect(
      formatCredentialDisplayNames("OpenAI", [
        {
          row: { id: "a", integrationId: "openai", label: "SEPD", active: true, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
        {
          row: { id: "b", integrationId: "openai", label: "SEPD", active: false, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
        {
          row: { id: "c", integrationId: "openai", label: "default", active: false, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
      ]),
    ).toEqual(["[OpenAI SEPD] (Pro) (active)", "[OpenAI SEPD 2] (Pro)", "[OpenAI] (Pro)"]);
  });

  it("opts unnamed accounts into the existing duplicate-alias numbering convention", () => {
    expect(
      formatCredentialDisplayNames("OpenAI", [
        {
          row: { id: "a", integrationId: "openai", label: "API key", active: true, value: {} },
          fallbackName: "OpenAI",
          numberUnnamed: true,
        },
        {
          row: { id: "b", integrationId: "openai", label: "default", active: false, value: {} },
          fallbackName: "OpenAI",
          numberUnnamed: true,
        },
        {
          row: { id: "c", integrationId: "openai", label: "  ", active: false, value: {} },
          fallbackName: "OpenAI",
          numberUnnamed: true,
        },
        {
          row: { id: "d", integrationId: "openai", label: "OAuth", active: false, value: {} },
          fallbackName: "OpenAI (Pro)",
        },
      ]),
    ).toEqual(["[OpenAI] (active)", "[OpenAI 2]", "[OpenAI 3]", "[OpenAI] (Pro)"]);
  });

  it.each([
    {
      labels: ["API key", "default", "2"],
      expected: ["[OpenAI] (active)", "[OpenAI 3]", "[OpenAI 2]"],
    },
    {
      labels: ["2", "API key", "default"],
      expected: ["[OpenAI 2] (active)", "[OpenAI]", "[OpenAI 3]"],
    },
    {
      labels: ["API key", "default", " 2 ", "3", "OAuth"],
      expected: ["[OpenAI] (active)", "[OpenAI 4]", "[OpenAI 2]", "[OpenAI 3]", "[OpenAI 5]"],
    },
    {
      labels: ["Work", "Work", "Work 2", "API key"],
      expected: ["[OpenAI Work] (active)", "[OpenAI Work 3]", "[OpenAI Work 2]", "[OpenAI]"],
    },
  ])("reserves explicit aliases before numbering opted-in accounts ($labels)", ({
    labels,
    expected,
  }) => {
    expect(
      formatCredentialDisplayNames(
        "OpenAI",
        labels.map((label, index) => ({
          row: { id: `${index}`, integrationId: "openai", label, active: index === 0, value: {} },
          fallbackName: "OpenAI",
          numberUnnamed: true,
        })),
      ),
    ).toEqual(expected);
  });

  it("preserves naming without the unnamed-account numbering opt-in", () => {
    expect(
      formatCredentialDisplayNames(
        "Z.ai",
        ["API key", "default", "2", "Work", "Work", "Work 2"].map((label, index) => ({
          row: { id: `${index}`, integrationId: "zai", label, active: index === 0, value: {} },
          fallbackName: "Z.ai",
        })),
      ),
    ).toEqual([
      "[Z.ai] (active)",
      "[Z.ai]",
      "[Z.ai 2]",
      "[Z.ai Work]",
      "[Z.ai Work 2]",
      "[Z.ai Work 2]",
    ]);
  });

  it("keeps a named connection next to an imported generic one", () => {
    expect(
      formatCredentialDisplayNames("Z.ai", [
        {
          row: { id: "a", integrationId: "zai", label: "Work", active: true, value: {} },
          fallbackName: "Z.ai",
        },
        {
          row: { id: "b", integrationId: "zai", label: "API key", active: false, value: {} },
          fallbackName: "Z.ai",
        },
      ]),
    ).toEqual(["[Z.ai Work] (active)", "[Z.ai]"]);
  });

  it("reports the credential database path and honors OPENCODE_DB", () => {
    const dataHome = join(tmpdir(), "opencode-quota-auth-paths");
    vi.stubEnv("XDG_DATA_HOME", dataHome);

    expect(getCredentialDatabasePaths()).toEqual([join(dataHome, "opencode", "opencode.db")]);

    vi.stubEnv("OPENCODE_DB", "custom.db");
    expect(getCredentialDatabasePaths()).toEqual([join(dataHome, "opencode", "custom.db")]);
  });
});

describe("integration credential source", () => {
  it("reads every connection of a registered id in OpenCode order, values flattened", async () => {
    bindFakeIntegration([
      oauthCredential("openai", "cred_personal", {
        label: "Personal",
        value: {
          type: "oauth",
          methodID: "chatgpt-browser",
          refresh: "personal-refresh",
          access: "personal-access",
          expires: 20,
          metadata: { accountID: "acct_1" },
        },
      }),
      oauthCredential("openai", "cred_work", { label: "Work" }),
      keyCredential("deepseek", "cred_deepseek", {
        value: { type: "key", key: "deepseek-key", metadata: { region: "eu" } },
      }),
    ]);

    await expect(readCredentialRows(["openai", "deepseek"])).resolves.toEqual([
      {
        id: "cred_personal",
        integrationId: "openai",
        label: "Personal",
        active: true,
        value: {
          accountID: "acct_1",
          type: "oauth",
          methodID: "chatgpt-browser",
          refresh: "personal-refresh",
          access: "personal-access",
          expires: 20,
          metadata: { accountID: "acct_1" },
        },
      },
      {
        id: "cred_work",
        integrationId: "openai",
        label: "Work",
        active: false,
        value: {
          type: "oauth",
          methodID: "device",
          refresh: "cred_work-refresh",
          access: "cred_work-access",
          expires: 10,
        },
      },
      {
        id: "cred_deepseek",
        integrationId: "deepseek",
        label: "default",
        // The connection active("deepseek") reports, so its row is the active one.
        active: true,
        value: { region: "eu", type: "api", key: "deepseek-key", metadata: { region: "eu" } },
      },
    ]);
  });

  it("keeps request-id order across integrations", async () => {
    bindFakeIntegration([
      oauthCredential("openai", "cred_openai"),
      oauthCredential("github-copilot", "cred_copilot"),
    ]);

    expect((await readCredentialRows(["github-copilot", "openai"])).map((row) => row.id)).toEqual([
      "cred_copilot",
      "cred_openai",
    ]);
    await expect(readCredentialRows([])).resolves.toEqual([]);
  });

  it("reads an id OpenCode has not registered through active()", async () => {
    const integration = bindFakeIntegration([
      oauthCredential("openai", "cred_openai"),
      oauthCredential("codex", "cred_codex_newest", { registered: false }),
      oauthCredential("codex", "cred_codex_older", { registered: false }),
    ]);

    expect((await readCredentialRows(["openai", "codex"])).map((row) => row.id)).toEqual([
      "cred_openai",
      "cred_codex_newest",
    ]);
    expect(integration.list).toHaveBeenCalledOnce();
    // Listed ids look up active() too, to know which connection to star.
    expect(integration.connection.active.mock.calls).toEqual([["openai"], ["codex"]]);
    expect(integration.get).not.toHaveBeenCalled();
  });

  it("skips env connections, which are not stored logins", async () => {
    const integration = bindFakeIntegration([keyCredential("openrouter", "cred_openrouter")], {
      envNames: { openrouter: "OPENROUTER_API_KEY", deepseek: "DEEPSEEK_API_KEY" },
    });

    expect((await readCredentialRows(["openrouter", "deepseek"])).map((row) => row.id)).toEqual([
      "cred_openrouter",
    ]);
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toBeNull();
    expect(resolvedIds(integration)).toEqual(["cred_openrouter"]);
  });

  it("checks the connection method before resolving", async () => {
    const integration = bindFakeIntegration([
      keyCredential("opencode-go", "cred_go"),
      oauthCredential("opencode", "cred_console"),
      keyCredential("opencode", "cred_workspace"),
    ]);

    expect(
      (await readCredentialRows(["opencode-go", "opencode"], { methods: ["key"] })).map(
        (row) => row.id,
      ),
    ).toEqual(["cred_go", "cred_workspace"]);
    // The Go key read never resolves (and so never refreshes) the Console sign-in.
    expect(resolvedIds(integration)).toEqual(["cred_go", "cred_workspace"]);

    expect(
      (await readCredentialRows(["opencode"], { methods: ["oauth"] })).map((row) => row.id),
    ).toEqual(["cred_console"]);
  });

  it("reads one active connection per id with firstOnly and never lists", async () => {
    const integration = bindFakeIntegration([
      oauthCredential("openai", "cred_active"),
      oauthCredential("openai", "cred_inactive"),
      keyCredential("deepseek", "cred_deepseek"),
      oauthCredential("codex", "cred_codex", { registered: false }),
    ]);

    expect(
      (await readCredentialRows(["openai", "deepseek", "codex"], { firstOnly: true })).map(
        (row) => row.id,
      ),
    ).toEqual(["cred_active", "cred_deepseek", "cred_codex"]);
    expect(integration.list).not.toHaveBeenCalled();
    expect(integration.connection.active.mock.calls).toEqual([["openai"], ["deepseek"], ["codex"]]);
    expect(resolvedIds(integration)).toEqual(["cred_active", "cred_deepseek", "cred_codex"]);

    // A mismatched active connection yields nothing and is not resolved.
    await expect(
      readCredentialRows(["deepseek"], { firstOnly: true, methods: ["oauth"] }),
    ).resolves.toEqual([]);
    expect(resolvedIds(integration)).toHaveLength(3);
  });

  it("reads each id's active login when list() fails, until list() works again", async () => {
    const integration = bindFakeIntegration([
      oauthCredential("openai", "cred_active"),
      oauthCredential("openai", "cred_inactive"),
    ]);
    integration.list.mockRejectedValueOnce(new Error("Credential value failed to decode"));

    expect((await readCredentialRows(["openai"])).map((row) => row.id)).toEqual(["cred_active"]);
    expect(getCredentialSourceDiagnostics().lastListError).toEqual({
      at: expect.any(Number),
      detail: "Credential value failed to decode",
    });

    expect((await readCredentialRows(["openai"])).map((row) => row.id)).toEqual([
      "cred_active",
      "cred_inactive",
    ]);
    expect(getCredentialSourceDiagnostics().lastListError).toBeUndefined();
  });

  it("stars the connection active() reports for each id, not the first row", async () => {
    const integration = bindFakeIntegration(
      [
        oauthCredential("codex", "cred_codex", { registered: false }),
        oauthCredential("chatgpt", "cred_chatgpt_1"),
        oauthCredential("chatgpt", "cred_chatgpt_2"),
      ],
      { envNames: { openai: "OPENAI_API_KEY" } },
    );

    const rows = await readCredentialRows(["openai", "codex", "chatgpt"]);
    expect(rows.map((row) => [row.id, row.active])).toEqual([
      // A fallback id's row is the one active("codex") returned.
      ["cred_codex", true],
      // active("chatgpt") stars the listed row it selects, per id.
      ["cred_chatgpt_1", true],
      ["cred_chatgpt_2", false],
    ]);
    // An id with only an env connection has no listed row to look active() up for.
    expect(integration.connection.active.mock.calls).toEqual([["codex"], ["chatgpt"]]);
  });

  it("stars the second listed row when active() selects it over the first", async () => {
    const integration = bindFakeIntegration([
      oauthCredential("github-copilot", "cred_copilot_first", { label: "First" }),
      oauthCredential("github-copilot", "cred_copilot_second", { label: "Second" }),
    ]);
    integration.connection.active.mockResolvedValueOnce({
      type: "credential",
      id: "cred_copilot_second",
      label: "Second",
      method: "oauth",
    });

    const rows = await readCredentialRows(["github-copilot"], { methods: ["oauth"] });
    expect(rows.map((row) => [row.id, row.active])).toEqual([
      ["cred_copilot_first", false],
      ["cred_copilot_second", true],
    ]);
  });

  it("does not mark the OAuth row active when the active login is a key", async () => {
    const integration = bindFakeIntegration([
      keyCredential("openai", "cred_openai_key"),
      oauthCredential("openai", "cred_openai_oauth"),
    ]);

    // The unfiltered rows identify the key as the login OpenCode uses.
    const rows = await readCredentialRows(["openai"]);
    expect(rows.map((row) => [row.id, row.active])).toEqual([
      ["cred_openai_key", true],
      ["cred_openai_oauth", false],
    ]);

    // The OAuth-only read keeps its row in place but leaves the mark on the key.
    const oauthRows = await readCredentialRows(["openai"], { methods: ["oauth"] });
    expect(oauthRows.map((row) => [row.id, row.active])).toEqual([["cred_openai_oauth", false]]);
    expect(resolvedIds(integration).slice(-1)).toEqual(["cred_openai_oauth"]);
  });

  it("marks no listed row active when the active lookup fails, keeping every row", async () => {
    const integration = bindFakeIntegration([
      oauthCredential("openai", "cred_openai_first", { label: "First" }),
      oauthCredential("openai", "cred_openai_second", { label: "Second" }),
    ]);
    integration.connection.active.mockRejectedValueOnce(new Error("database is locked"));

    // The failed lookup only drops the mark: no row is starred in another's place,
    // and every listed row still resolves as usual.
    const rows = await readCredentialRows(["openai"]);
    expect(rows.map((row) => [row.id, row.active])).toEqual([
      ["cred_openai_first", false],
      ["cred_openai_second", false],
    ]);
    expect(rows.map((row) => row.resolveError)).toEqual([undefined, undefined]);
    expect(getCredentialSourceDiagnostics().failures).toEqual([]);

    // A later read with a working lookup stars the selected row again.
    const retried = await readCredentialRows(["openai"]);
    expect(retried.map((row) => [row.id, row.active])).toEqual([
      ["cred_openai_first", true],
      ["cred_openai_second", false],
    ]);
  });

  it("keeps a failed login in place and resolves it again only after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const failing = oauthCredential("openai", "cred_failing", {
      label: "Work",
      resolveError: "Token refresh failed: 400",
    });
    const integration = bindFakeIntegration([failing, oauthCredential("openai", "cred_ok")]);

    const rows = await readCredentialRows(["openai"], { methods: ["oauth"] });
    expect(rows).toEqual([
      {
        id: "cred_failing",
        integrationId: "openai",
        label: "Work",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: Token refresh failed: 400",
      },
      expect.objectContaining({ id: "cred_ok", active: false }),
    ]);
    // First row still wins: the failed active login is not replaced by the next one.
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toEqual({
      openai: { type: "oauth", resolveError: "refresh_failed: Token refresh failed: 400" },
    });
    expect(getCredentialSourceDiagnostics().failures).toEqual([
      {
        integrationId: "openai",
        connectionId: "cred_failing",
        label: "Work",
        category: "refresh_failed",
        detail: "Token refresh failed: 400",
        at: 1_000_000,
      },
    ]);
    const failingResolves = () =>
      resolvedIds(integration).filter((id) => id === "cred_failing").length;
    expect(failingResolves()).toBe(1);

    vi.setSystemTime(1_000_000 + 59_999);
    await readCredentialRows(["openai"]);
    expect(failingResolves()).toBe(1);

    vi.setSystemTime(1_000_000 + 60_000);
    await readCredentialRows(["openai"]);
    expect(failingResolves()).toBe(2);

    failing.resolveError = undefined;
    vi.setSystemTime(1_000_000 + 120_000);
    const recovered = await readCredentialRows(["openai"]);
    expect(recovered[0]).toMatchObject({
      id: "cred_failing",
      value: { access: "cred_failing-access" },
    });
    expect(recovered[0]?.resolveError).toBeUndefined();
    expect(getCredentialSourceDiagnostics().failures).toEqual([]);
  });

  it("forgets failed logins when OpenCode reports a credential change", async () => {
    const integration = bindFakeIntegration([
      oauthCredential("xai", "cred_xai", { resolveError: "refresh rejected" }),
    ]);

    await readCredentialRows(["xai"]);
    await readCredentialRows(["xai"]);
    expect(resolvedIds(integration)).toEqual(["cred_xai"]);

    notifyCredentialsChanged();
    expect(getCredentialSourceDiagnostics().failures).toEqual([]);
    await readCredentialRows(["xai"]);
    expect(resolvedIds(integration)).toEqual(["cred_xai", "cred_xai"]);
  });

  it("reports an empty resolve as a failed login", async () => {
    const integration = bindFakeIntegration([keyCredential("deepseek", "cred_deepseek")]);
    integration.connection.resolve.mockResolvedValueOnce(undefined);

    await expect(readCredentialRows(["deepseek"])).resolves.toEqual([
      {
        id: "cred_deepseek",
        integrationId: "deepseek",
        label: "default",
        active: true,
        value: { type: "api" },
        resolveError: "resolve_empty: OpenCode returned no login",
      },
    ]);
  });

  it("reports a failed active() as a failed row of that id until active() works again", async () => {
    const integration = bindFakeIntegration([oauthCredential("openai", "cred_openai")]);
    integration.connection.active.mockRejectedValueOnce(new Error("database is locked"));

    await expect(readCredentialRows(["openai"], { firstOnly: true })).resolves.toEqual([
      {
        id: "openai",
        integrationId: "openai",
        label: "",
        active: true,
        value: { type: "oauth" },
        resolveError: "active_failed: database is locked",
      },
    ]);
    expect(getCredentialSourceDiagnostics().failures).toEqual([
      expect.objectContaining({
        integrationId: "openai",
        connectionId: "openai",
        category: "active_failed",
        detail: "database is locked",
      }),
    ]);

    integration.connection.active.mockRejectedValueOnce(new Error("database is locked"));
    await expect(
      readCredentialRows(["opencode-go"], { firstOnly: true, methods: ["key"] }),
    ).resolves.toEqual([expect.objectContaining({ value: { type: "api" } })]);

    expect((await readCredentialRows(["openai"], { firstOnly: true }))[0]?.id).toBe("cred_openai");
    expect(
      getCredentialSourceDiagnostics().failures.map((failure) => failure.connectionId),
    ).toEqual(["opencode-go"]);
  });

  it("shares one resolve per connection between concurrent reads", async () => {
    const integration = bindFakeIntegration([oauthCredential("openai", "cred_openai")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    integration.connection.resolve.mockImplementationOnce(async () => {
      await gate;
      return { type: "oauth", methodID: "device", refresh: "r", access: "shared", expires: 1 };
    });

    const reads = Promise.all([
      readCredentialRows(["openai"]),
      readCredentialRows(["openai"], { firstOnly: true }),
    ]);
    await vi.waitFor(() => expect(integration.connection.resolve).toHaveBeenCalledOnce());
    // Let the second read reach the shared resolve before the first one finishes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const [fanOut, firstOnly] = await reads;

    expect(integration.connection.resolve).toHaveBeenCalledOnce();
    expect(fanOut[0]?.value.access).toBe("shared");
    expect(firstOnly[0]?.value.access).toBe("shared");
  });

  it("never stores or shows a token from OpenCode's error text", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
    const opaque = "sk_live_0123456789abcdefghijklmnopqrstuv";
    const integration = bindFakeIntegration([
      oauthCredential("openai", "cred_openai", {
        resolveError: `refresh failed\n for ${jwt} using \u001b[31m${opaque}`,
      }),
    ]);
    integration.list.mockRejectedValueOnce(new Error(`bad row ${opaque}`));

    const rows = await readCredentialRows(["openai"]);
    const diagnostics = JSON.stringify(getCredentialSourceDiagnostics());

    expect(rows[0]?.resolveError).toBe(
      "refresh_failed: refresh failed for [redacted] using [redacted]",
    );
    for (const text of [rows[0]?.resolveError ?? "", diagnostics]) {
      expect(text).not.toContain(jwt);
      expect(text).not.toContain(opaque);
      expect(text).not.toContain(opaque.slice(-24));
    }
  });

  it("scrubs error text to one short line before cutting it to length", () => {
    expect(scrubCredentialErrorText("a\nb\tc\u0007")).toBe("a b c");
    const cut = scrubCredentialErrorText(`${"x ".repeat(55)}${"t".repeat(40)}`);
    expect(cut).toBe(`${"x ".repeat(55)}[redacted]`.slice(0, 120));
    expect(cut).not.toContain("tttt");
  });

  it("reads no login and warns once while no source is bound", async () => {
    vi.resetModules();
    const unboundReader = await import("../src/lib/opencode-auth.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(unboundReader.readCredentialRows(["openai"])).resolves.toEqual([]);
    await expect(unboundReader.readAuthFile({ integrationIds: ["openai"] })).resolves.toBeNull();
    await expect(
      unboundReader.readAuthFileCached({ maxAgeMs: 0, integrationIds: ["openai"] }),
    ).resolves.toBeNull();

    expect(warn.mock.calls).toEqual([["[opencode-quota] credential source is not bound"]]);
    expect(unboundReader.getCredentialSourceDiagnostics()).toEqual({
      state: "unbound",
      failures: [],
    });
    warn.mockRestore();
  });

  it("reads through the last binding and unbinds only its own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = createFakeIntegration([keyCredential("deepseek", "cred_first")]);
    const second = createFakeIntegration([keyCredential("deepseek", "cred_second")]);
    const unbindFirst = bindCredentialSource(createIntegrationCredentialSource(first as never));
    const unbindSecond = bindCredentialSource(createIntegrationCredentialSource(second as never));

    expect((await readCredentialRows(["deepseek"]))[0]?.id).toBe("cred_second");
    unbindFirst();
    expect((await readCredentialRows(["deepseek"]))[0]?.id).toBe("cred_second");
    expect(getCredentialSourceDiagnostics()).toMatchObject({
      state: "bound",
      kind: "opencode-integration-api",
    });
    unbindSecond();
    unbindSecond();
    await expect(readCredentialRows(["deepseek"])).resolves.toEqual([]);
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
    warn.mockRestore();
  });
});

describe("readAuthFile and readAuthFileCached", () => {
  it("maps the first login of each requested id, metadata on top", async () => {
    bindFakeIntegration([
      oauthCredential("github-copilot", "cred_copilot", {
        value: {
          type: "oauth",
          methodID: "device",
          access: "copilot-access",
          refresh: "copilot-access",
          expires: 0,
          metadata: { enterpriseUrl: "example.ghe.com" },
        },
      }),
      keyCredential("deepseek", "cred_deepseek", { value: { type: "key", key: "deepseek-key" } }),
      oauthCredential("openai", "cred_openai_active"),
      oauthCredential("openai", "cred_openai_inactive"),
    ]);

    await expect(
      readAuthFile({ integrationIds: ["github-copilot", "deepseek", "openai"] }),
    ).resolves.toEqual({
      "github-copilot": expect.objectContaining({
        access: "copilot-access",
        enterpriseUrl: "example.ghe.com",
      }),
      deepseek: { type: "api", key: "deepseek-key" },
      openai: expect.objectContaining({ access: "cred_openai_active-access" }),
    });
    await expect(readAuthFile({ integrationIds: ["xai"] })).resolves.toBeNull();
  });

  it("caches auth maps per sorted id list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const openai = oauthCredential("openai", "cred_openai");
    bindFakeIntegration([openai, keyCredential("deepseek", "cred_deepseek")]);

    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai", "deepseek"] }),
    ).resolves.toMatchObject({ openai: { access: "cred_openai-access" } });
    openai.value = { type: "oauth", access: "rotated-access" };

    // Same ids in another order hit the same cache entry.
    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek", "openai"] }),
    ).resolves.toMatchObject({ openai: { access: "cred_openai-access" } });
    // A different id list has its own entry and reads fresh.
    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai"] }),
    ).resolves.toEqual({ openai: { type: "oauth", access: "rotated-access" } });
    // Once time moves on, maxAgeMs 0 re-reads the first entry too.
    vi.setSystemTime(1_000_001);
    await expect(
      readAuthFileCached({ maxAgeMs: 0, integrationIds: ["openai", "deepseek"] }),
    ).resolves.toMatchObject({ openai: { access: "rotated-access" } });
  });

  it("leaves out an active login of another method without resolving it", async () => {
    const integration = bindFakeIntegration([
      keyCredential("opencode-go", "cred_go"),
      oauthCredential("opencode", "cred_console"),
    ]);

    await expect(
      readAuthFile({ integrationIds: ["opencode-go", "opencode"], methods: ["key"] }),
    ).resolves.toEqual({ "opencode-go": { type: "api", key: "cred_go-key" } });
    // The Go key lookup never resolves (and so never refreshes) the Console sign-in.
    expect(resolvedIds(integration)).toEqual(["cred_go"]);
    expect(integration.list).not.toHaveBeenCalled();
  });

  it("caches auth maps per method filter as well as per id list", async () => {
    const integration = bindFakeIntegration([oauthCredential("opencode", "cred_console")]);

    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["opencode"], methods: ["key"] }),
    ).resolves.toBeNull();
    // Same ids without a filter have their own entry, so the sign-in is read.
    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["opencode"] }),
    ).resolves.toMatchObject({ opencode: { access: "cred_console-access" } });
    // The key-only entry stays cached and empty.
    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["opencode"], methods: ["key"] }),
    ).resolves.toBeNull();
    expect(resolvedIds(integration)).toEqual(["cred_console"]);
  });

  it("drops cached auth maps when OpenCode reports a credential change", async () => {
    const openai = oauthCredential("openai", "cred_openai");
    bindFakeIntegration([openai]);

    await readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai"] });
    openai.value = { type: "oauth", access: "switched-access" };
    notifyCredentialsChanged();

    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai"] }),
    ).resolves.toEqual({ openai: { type: "oauth", access: "switched-access" } });
  });

  it("does not cache a read that was in flight when the logins changed", async () => {
    const openaiRow = (access: string) => ({
      id: "cred_openai",
      integrationId: "openai",
      label: "default",
      active: true,
      value: { type: "oauth", access },
    });
    let releaseOldRead!: (rows: ReturnType<typeof openaiRow>[]) => void;
    let rows = new Promise<ReturnType<typeof openaiRow>[]>((resolve) => {
      releaseOldRead = resolve;
    });
    unbinds.push(bindCredentialSource({ kind: "opencode-integration-api", readRows: () => rows }));

    const oldRead = readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai"] });
    notifyCredentialsChanged();
    releaseOldRead([openaiRow("old-access")]);
    await expect(oldRead).resolves.toEqual({ openai: { type: "oauth", access: "old-access" } });
    rows = Promise.resolve([openaiRow("new-access")]);

    await expect(
      readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["openai"] }),
    ).resolves.toEqual({ openai: { type: "oauth", access: "new-access" } });
  });

  it("shares one in-flight read per id list", async () => {
    bindFakeIntegration([
      keyCredential("deepseek", "cred_deepseek", { value: { type: "key", key: "deepseek-key" } }),
    ]);

    const [first, second] = await Promise.all([
      readAuthFileCached({ maxAgeMs: 0, integrationIds: ["deepseek"] }),
      readAuthFileCached({ maxAgeMs: 0, integrationIds: ["deepseek"] }),
    ]);
    expect(first).toEqual({ deepseek: { type: "api", key: "deepseek-key" } });
    expect(second).toBe(first);
  });

  it("adds resolveError to the auth entry of a failed row only", () => {
    const row = {
      id: "openai",
      integrationId: "openai",
      label: "default",
      active: true,
      value: { type: "oauth", access: "token" },
    };
    expect(credentialRowAuthEntry(row)).toBe(row.value);
    expect(
      credentialRowAuthEntry({
        ...row,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 400",
      }),
    ).toEqual({ type: "oauth", resolveError: "refresh_failed: HTTP 400" });
  });
});

describe("selectConnectionCredentialRows", () => {
  const row = (id: string, integrationId: string, key: string) => ({
    id,
    integrationId,
    label: "default",
    active: false,
    value: { type: "key", key },
  });

  it("prefers native rows over alias rows holding the same credential", () => {
    const rows = [
      row("alias", "opencode", "workspace-key"),
      row("native", "opencode-go", "workspace-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "native",
    ]);
  });

  it("falls back to alias rows when no native row exists", () => {
    const rows = [row("alias", "opencode", "workspace-key")];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "alias",
    ]);
  });

  it("collapses alias rows into native rows with the same credential value", () => {
    const rows = [
      row("go-1", "opencode-go", "workspace-key"),
      row("zen", "opencode", "workspace-key"),
      row("go-2", "opencode-go", "other-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "go-1",
      "go-2",
    ]);
  });

  it("collapses exact duplicates within the primary integration", () => {
    const rows = [
      row("first", "opencode-go", "workspace-key"),
      row("second", "opencode-go", "workspace-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "first",
    ]);
  });

  it("treats property order in stored credential values as insignificant", () => {
    const rows = [
      row("first", "opencode-go", "workspace-key"),
      {
        ...row("second", "opencode-go", "workspace-key"),
        value: { key: "workspace-key", type: "key" },
      },
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "first",
    ]);
  });

  it("keeps distinct credentials as separate connections", () => {
    const rows = [
      row("personal", "opencode-go", "personal-key"),
      row("work", "opencode-go", "work-key"),
    ];

    expect(selectConnectionCredentialRows(rows, "opencode-go").map((row) => row.id)).toEqual([
      "personal",
      "work",
    ]);
  });

  it("keeps two failed logins apart although both hold only { type }", () => {
    const failed = (id: string) => ({
      id,
      integrationId: "opencode-go",
      label: "default",
      active: false,
      value: { type: "api" },
      resolveError: "refresh_failed: HTTP 500",
    });

    expect(
      selectConnectionCredentialRows(
        [failed("cred_personal"), failed("cred_work"), failed("cred_work")],
        "opencode-go",
      ).map((row) => row.id),
    ).toEqual(["cred_personal", "cred_work"]);
  });
});

describe("Google companion credentials written by OpenCode 2", () => {
  it("parses the opencode-gemini-auth 2.x and AGY alpha OAuth rows", async () => {
    bindFakeIntegration([
      // opencode-gemini-auth 2.0.1: `gemini-cli` method on OpenCode 2's `google` integration.
      oauthCredential("google", "cred_gemini", {
        label: "user@example.com",
        value: {
          type: "oauth",
          methodID: "gemini-cli",
          refresh: "gemini-refresh|gemini-project|",
          access: "gemini-access",
          expires: 50,
          metadata: { email: "user@example.com" },
        },
      }),
      // @anthonyhaussman/opencode-agy-auth 1.2.11-alpha.0: `oauth` method on `google-agy`,
      // registered only while that plugin is loaded.
      oauthCredential("google-agy", "cred_agy", {
        label: "OAuth",
        registered: false,
        value: {
          type: "oauth",
          methodID: "oauth",
          refresh: "agy-refresh|agy-project|agy-managed-project",
          access: "agy-access",
          expires: 60,
        },
      }),
    ]);
    const auth = await readAuthFile({ integrationIds: ["google", "google-agy"] });

    expect(resolveGeminiCliAccounts(auth)).toEqual([
      {
        sourceKey: "google",
        refreshToken: "gemini-refresh",
        projectId: "gemini-project",
        email: "user@example.com",
        accessToken: "gemini-access",
        expiresAt: 50,
      },
    ]);
    expect(resolveAgyAccounts(auth)).toEqual([
      {
        sourceKey: "google-agy",
        refreshToken: "agy-refresh",
        projectId: "agy-managed-project",
        accessToken: "agy-access",
        expiresAt: 60,
      },
    ]);
  });
});
