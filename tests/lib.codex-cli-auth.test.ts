import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { codexCliAuthPath, readCodexCliAuth } from "../src/lib/codex-cli-auth.js";

const homes: string[] = [];

/** A temp `CODEX_HOME`; with `content`, an `auth.json` inside it. */
function codexHome(content?: string): string {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  homes.push(home);
  if (content !== undefined) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), content);
  }
  return home;
}

/** A token shaped like a JWT, so its `exp` can be read without a real signature. */
function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Codex CLI sign-in", () => {
  it("reads the access token, account and expiry from $CODEX_HOME/auth.json", async () => {
    const accessToken = jwt({ exp: 1_767_236_400 });
    const home = codexHome(
      JSON.stringify({ tokens: { access_token: accessToken, account_id: "acct-1" } }),
    );

    await expect(readCodexCliAuth({ CODEX_HOME: home })).resolves.toEqual({
      state: "configured",
      location: join(home, "auth.json"),
      accessToken,
      accountId: "acct-1",
      expiresAt: 1_767_236_400_000,
    });
  });

  it("keeps the token when the file names no account", async () => {
    const home = codexHome(JSON.stringify({ tokens: { access_token: "plain-token" } }));

    await expect(readCodexCliAuth({ CODEX_HOME: home })).resolves.toEqual({
      state: "configured",
      location: join(home, "auth.json"),
      accessToken: "plain-token",
    });
  });

  it("reports a missing file as not found", async () => {
    const home = codexHome();

    await expect(readCodexCliAuth({ CODEX_HOME: home })).resolves.toEqual({
      state: "not-found",
      location: join(home, "auth.json"),
    });
  });

  it("reports a file that is not JSON", async () => {
    const home = codexHome("{ not json");

    const auth = await readCodexCliAuth({ CODEX_HOME: home });

    expect(auth.state).toBe("unavailable");
    expect(auth.state === "unavailable" ? auth.detail : "").toContain("not valid JSON");
  });

  it("reports a file without an access token", async () => {
    const home = codexHome(JSON.stringify({ tokens: { account_id: "acct-1" } }));

    const auth = await readCodexCliAuth({ CODEX_HOME: home });

    expect(auth.state).toBe("unavailable");
    expect(auth.state === "unavailable" ? auth.detail : "").toContain("no access token");
  });

  it("defaults to ~/.codex/auth.json without CODEX_HOME", () => {
    expect(codexCliAuthPath({})).toBe(join(homedir(), ".codex", "auth.json"));
  });
});
