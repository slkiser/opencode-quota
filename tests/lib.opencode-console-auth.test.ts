import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  resolveOpenCodeConsoleAuth,
} from "../src/lib/opencode-console-auth.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";

const unbinds: Array<() => void> = [];

afterEach(() => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  clearReadAuthFileCacheForTests();
});

function bindConsoleLogins(credentials: FakeCredential[]) {
  const integration = createFakeIntegration(credentials);
  unbinds.push(bindCredentialSource(createIntegrationCredentialSource(integration as never)));
  return integration;
}

function consoleLogin(
  value: Record<string, unknown>,
  overrides: Partial<FakeCredential> = {},
): FakeCredential {
  return {
    integrationId: "opencode",
    id: "cred_console",
    label: "default",
    registered: true,
    method: value.type === "key" ? "key" : "oauth",
    value,
    ...overrides,
  };
}

/** A device-flow Console sign-in. */
function deviceLogin(
  value: Record<string, unknown> = {},
  overrides: Partial<FakeCredential> = {},
): FakeCredential {
  return consoleLogin(
    {
      type: "oauth",
      methodID: "device",
      refresh: "console-refresh",
      access: "console-access",
      expires: Date.now() + 60_000,
      ...value,
    },
    overrides,
  );
}

describe("OpenCode Console credential reader", () => {
  it("returns none without console credentials", async () => {
    bindConsoleLogins([]);
    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({ state: "none" });
  });

  it("resolves the configured console credential with org metadata", async () => {
    const expires = Date.now() + 60_000;
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "server",
        access: "console-access",
        refresh: "console-refresh",
        expires,
        metadata: {
          accountID: "acc_1",
          email: "ran@example.com",
          orgID: "wrk_1",
          orgName: "WSC Sports",
        },
      }),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "configured",
      credential: {
        accessToken: "console-access",
        refreshToken: "console-refresh",
        expiresAt: expires,
        accountId: "acc_1",
        orgId: "wrk_1",
        orgName: "WSC Sports",
        email: "ran@example.com",
        server: undefined,
      },
    });
  });

  it("keeps the Console server the sign-in belongs to", async () => {
    bindConsoleLogins([deviceLogin({ metadata: { server: "https://console.example.test" } })]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "configured",
      credential: { server: "https://console.example.test" },
    });
  });

  it("reports expired console credentials", async () => {
    bindConsoleLogins([
      deviceLogin({ expires: Date.now() - 60_000, metadata: { orgID: "wrk_1" } }),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({ state: "expired" });
  });

  it.each([
    [deviceLogin({ access: "  ", expires: 0 }), "OpenCode Console credential has no access token"],
    // A login OpenCode could not return (for example a failed refresh).
    [deviceLogin({ expires: 0 }, { resolveError: "HTTP 401" }), "refresh_failed: HTTP 401"],
  ])("reports an invalid sign-in (%#)", async (login, error) => {
    bindConsoleLogins([login]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({ state: "invalid", error });
  });

  it("ignores a key-shaped active opencode login", async () => {
    bindConsoleLogins([
      consoleLogin({ type: "key", key: "workspace-key" }, { id: "cred_workspace" }),
      deviceLogin({}, { id: "cred_console_inactive" }),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "none",
      reason: "not_oauth",
    });
  });

  it("uses the active sign-in and resolves no other login", async () => {
    const integration = bindConsoleLogins([
      deviceLogin({ access: "cred_active-access", metadata: { orgID: "wrk_active" } }, { id: "a" }),
      deviceLogin({ access: "cred_other-access", metadata: { orgID: "wrk_other" } }, { id: "b" }),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "configured",
      credential: { accessToken: "cred_active-access", orgId: "wrk_active" },
    });
    expect(integration.list).not.toHaveBeenCalled();
    expect(integration.connection.resolve).toHaveBeenCalledOnce();
  });
});

describe("Console request helpers", () => {
  it("uses the login's server, else the default Console server", () => {
    expect(consoleBaseUrl({ accessToken: "a", server: "https://console.example.test" })).toBe(
      "https://console.example.test",
    );
    expect(consoleBaseUrl({ accessToken: "a" })).toBe("https://opencode.ai/console");
  });

  it("sends the bearer token, and the org only when the login has one", () => {
    expect(consoleHeaders({ accessToken: "console-access", orgId: "wrk_1" })).toEqual({
      Authorization: "Bearer console-access",
      Accept: "application/json",
      "x-org-id": "wrk_1",
    });
    expect(consoleHeaders({ accessToken: "console-access" })).toEqual({
      Authorization: "Bearer console-access",
      Accept: "application/json",
    });
  });
});
