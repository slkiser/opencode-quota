import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import type { QuotaRow } from "../src/core/types.js";
import { type CredentialRow, readCredentialRows } from "../src/lib/opencode-auth.js";
import { openaiProvider } from "../src/providers/openai.js";
import { fakeHttp, requestHeader } from "./helpers/provider-fetch.js";

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));

const readRows = vi.mocked(readCredentialRows);
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const homes: string[] = [];

/** "Sign in with ChatGPT": the login whose token ChatGPT's usage endpoint rejects (#316). */
function sharingRow(accessToken = "opencode-token"): CredentialRow {
  return {
    id: "sharing-id",
    integrationId: "openai",
    label: "OpenAI",
    active: true,
    value: { type: "oauth", methodID: "chatgpt-token-sharing", access: accessToken },
  } as CredentialRow;
}

/** A token shaped like a JWT, so its claims can be read without a real signature. */
function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

function accountToken(accountId: string): string {
  return jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

/** Stubs `CODEX_HOME`, with an `auth.json` for `tokens` when given. */
function codexHome(tokens?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  homes.push(home);
  vi.stubEnv("CODEX_HOME", home);
  if (tokens) writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens }));
  return home;
}

/** ChatGPT's usage reply: a 5h window with 42% left plus a week with 90% left. */
function usageReply() {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 58, limit_window_seconds: 18_000, reset_at: 1_767_236_400 },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 604_800,
        reset_at: 1_767_840_000,
      },
    },
  };
}

async function fetchRows(rows: readonly CredentialRow[]) {
  readRows.mockResolvedValueOnce([...rows]);
  return rowsFromProviderResult(
    "openai",
    await openaiProvider.fetch({ config: {} } as never),
    NOW_MS,
  );
}

/** id, percent left or the row's text. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [row.id, row.percentRemaining ?? row.text]);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
  readRows.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("OpenAI quota from the Codex CLI sign-in", () => {
  it("queries ChatGPT with the CLI token when the OpenCode login is Sign in with ChatGPT", async () => {
    codexHome({ access_token: "cli-token", account_id: "acct-cli" });
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows([sharingRow()]);

    expect(summary(fetched.rows)).toEqual([
      ["openai.five_hour", 42],
      ["openai.weekly", 90],
    ]);
    expect(http.mock.calls.map(([, init]) => requestHeader(init, "Authorization"))).toEqual([
      "Bearer cli-token",
    ]);
    // The source is named, so the numbers are not read as the OpenCode login's own.
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "codex_cli_state", value: "configured" },
        { key: "codex_cli_sign_in", value: join(homes[0]!, "auth.json") },
        // Neither token here names an account, so sameness cannot be shown.
        { key: "codex_cli_account", value: "unknown" },
      ]),
    );
  });

  it("keeps the status row when no Codex CLI sign-in exists", async () => {
    codexHome();
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows([sharingRow()]);

    expect(summary(fetched.rows)).toEqual([
      ["openai.status", "ChatGPT quota unavailable for Sign in with ChatGPT"],
    ]);
    expect(http).not.toHaveBeenCalled();
    // The search itself is reported, so "no numbers" answers "was the CLI looked at?".
    expect(fetched.debug).toEqual(
      expect.arrayContaining([{ key: "codex_cli_state", value: "missing" }]),
    );
  });

  it("refuses the CLI sign-in when it belongs to another ChatGPT account", async () => {
    codexHome({ access_token: "cli-token", account_id: "acct-cli" });
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows([sharingRow(accountToken("acct-opencode"))]);

    expect(summary(fetched.rows)).toEqual([
      [
        "openai.status",
        "ChatGPT quota unavailable: the Codex CLI sign-in belongs to a different ChatGPT account. Run `codex login` to switch it.",
      ],
    ]);
    expect(http).not.toHaveBeenCalled();
  });

  it("uses the CLI sign-in when both logins name the same account", async () => {
    codexHome({ access_token: "cli-token", account_id: "acct-shared" });
    fakeHttp(() => usageReply());

    const fetched = await fetchRows([sharingRow(accountToken("acct-shared"))]);

    expect(summary(fetched.rows)).toEqual([
      ["openai.five_hour", 42],
      ["openai.weekly", 90],
    ]);
  });

  it("names the command that renews a rejected CLI sign-in", async () => {
    codexHome({ access_token: "stale-token", account_id: "acct-cli" });
    fakeHttp(
      () => new Response(JSON.stringify({ error: { code: "no_matching_rule" } }), { status: 401 }),
    );

    const fetched = await fetchRows([sharingRow()]);

    expect(fetched.rows).toEqual([]);
    expect(JSON.stringify(fetched.error)).toContain("codex login");
  });

  it("reports a Codex CLI file that cannot be used instead of querying", async () => {
    const home = codexHome();
    writeFileSync(join(home, "auth.json"), "{ not json");
    const http = fakeHttp(() => usageReply());

    const fetched = await fetchRows([sharingRow()]);

    expect(summary(fetched.rows)).toEqual([
      [
        "openai.status",
        expect.stringContaining("ChatGPT quota unavailable for Sign in with ChatGPT"),
      ],
    ]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("OpenAI cache identity with the Codex CLI fallback", () => {
  it("changes when the CLI sign-in switches to another account", async () => {
    readRows.mockResolvedValue([sharingRow()]);
    const home = codexHome({ access_token: "token-a", account_id: "acct-a" });
    const identity = (openaiProvider.cachePolicy as { resolveIdentity: () => Promise<unknown> })
      .resolveIdentity;

    const first = await identity();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "token-b", account_id: "acct-b" } }),
    );
    const second = await identity();
    // The same file again: an unchanged sign-in must not cool the cache on every refresh.
    const third = await identity();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(third).toBe(second);
  });
});
