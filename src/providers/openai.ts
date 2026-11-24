/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import type { DebugDetail } from "../core/types.js";
import { readCodexCliAuth } from "../lib/codex-cli-auth.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import {
  type OpenAILogin,
  type OpenAIOAuthLogin,
  type OpenAIResult,
  openaiLoginsIdentity,
  queryOpenAIQuota,
  readOpenAIAuthCached,
  readOpenAILogins,
} from "../lib/openai.js";
import type { CredentialRow } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import {
  type AccountResult,
  FIVE_HOUR,
  failedAccount,
  fetchError,
  fetchEachLogin,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  WEEKLY,
  windowRows,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

/**
 * OpenCode 2's "Sign in with ChatGPT" login. Its token is scoped to
 * api.openai.com, and ChatGPT's usage endpoint rejects it with HTTP 401
 * `no_matching_rule` (#316), so it gets a status row instead of a request.
 */
const TOKEN_SHARING_METHOD_ID = "chatgpt-token-sharing";

function isTokenSharingLogin(row: CredentialRow): boolean {
  return row.value.methodID === TOKEN_SHARING_METHOD_ID;
}

/** Whether any stored login is a Sign in with ChatGPT one, which is what needs the CLI file. */
function hasTokenSharingLogin(logins: readonly OpenAILogin[]): boolean {
  return logins.some(({ row }) => isTokenSharingLogin(row));
}

/** A row that says why a login has no ChatGPT quota number. */
function statusRow(text: string): ProviderRow {
  return {
    key: "status",
    label: "Status",
    type: "status",
    method: "local_estimation",
    authority: "locally_derived",
    prominence: "primary",
    text,
  };
}

const TOKEN_SHARING_STATUS = "ChatGPT quota unavailable for Sign in with ChatGPT";

/**
 * The Codex CLI's sign-in, as a login this provider can query. OpenCode's token-sharing login
 * cannot read ChatGPT quota (#316); the CLI's token can, so it stands in for the numbers - the
 * source is named in `/quota_status`, and its account is checked before use.
 */
type CodexCliFallback =
  | {
      state: "configured";
      login: Extract<OpenAIOAuthLogin, { state: "configured" }>;
      location: string;
    }
  | { state: "missing"; location: string }
  | { state: "unavailable"; detail: string; location: string };

async function codexCliLogin(): Promise<CodexCliFallback> {
  const auth = await readCodexCliAuth();
  if (auth.state === "not-found") return { state: "missing", location: auth.location };
  if (auth.state === "unavailable") {
    return { state: "unavailable", detail: auth.detail, location: auth.location };
  }
  return {
    state: "configured",
    location: auth.location,
    login: {
      state: "configured",
      sourceKey: "codex",
      accessToken: auth.accessToken,
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
      ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
    },
  };
}

/** `/quota_status` lines for the Codex CLI sign-in the token-sharing fallback used. */
function codexCliStatusDetails(
  cli: CodexCliFallback,
  accountMatch: "same" | "different" | "unknown",
): DebugDetail[] {
  // Always name the file that was looked at, so "no quota" answers "was the CLI even searched?".
  return statusDetailsFromRecord({
    codex_cli_state: cli.state,
    codex_cli_sign_in: cli.location,
    codex_cli_account: accountMatch,
    codex_cli_expires_at:
      cli.state === "configured" && cli.login.expiresAt
        ? new Date(cli.login.expiresAt).toISOString()
        : "(none)",
  });
}

/** Whether the CLI sign-in may answer for this login: a different account never may. */
function accountsMatch(
  loginAccount: string | undefined,
  cliAccount: string | undefined,
): "same" | "different" | "unknown" {
  if (!loginAccount || !cliAccount) return "unknown";
  return loginAccount === cliAccount ? "same" : "different";
}

/** A rejected or expired CLI sign-in needs `codex login`; a network failure does not. */
function isAuthFailure(result: OpenAIResult): boolean {
  if (result.success) return false;
  if (result.error === "Token expired") return true;
  return result.facts?.status === 401 || result.facts?.status === 403;
}

/**
 * Active is per integration: keep the session's active login first, then
 * other active logins, preserving source order within each set. Without the
 * session's login, an active OAuth login (which has quota numbers) goes before
 * an active API key (which only has a status).
 */
function sortActiveLoginsFirst(
  logins: readonly OpenAILogin[],
  currentIntegrationId: string | undefined,
): OpenAILogin[] {
  return [...logins].sort(({ row: left }, { row: right }) => {
    const activeOrder = Number(right.active) - Number(left.active);
    if (activeOrder !== 0 || !left.active) return activeOrder;
    const sessionOrder =
      Number(right.integrationId === currentIntegrationId) -
      Number(left.integrationId === currentIntegrationId);
    if (sessionOrder !== 0) return sessionOrder;
    return Number(left.value.type === "api") - Number(right.value.type === "api");
  });
}

/** The ChatGPT account id of a resolved login, when it carries one. */
function loginAccountId(login: OpenAIOAuthLogin | undefined): string | undefined {
  return login?.state === "configured" ? login.accountId : undefined;
}

function tokenStatus({ row, oauth: login }: OpenAILogin): string {
  if (row.value.type === "api") return row.resolveError !== undefined ? "failed" : "api key";
  if (!login) return "(none)";
  if (login.state === "failed") return "failed";
  return login.expiresAt && login.expiresAt < Date.now() ? "expired" : "valid";
}

/**
 * Status details of the login OpenCode marks active. A row it did not mark
 * active (e.g. an env-selected connection or a failed active lookup) is never
 * reported as the active one.
 */
function activeLoginStatusDetails(logins: readonly OpenAILogin[]): DebugDetail[] {
  const active = logins.find(({ row }) => row.active);
  if (!active) {
    // With stored logins but none marked active, which one OpenCode uses is unknown.
    const value = logins.length > 0 ? "unknown" : "(none)";
    return statusDetailsFromRecord({
      auth_configured: logins.length > 0 ? "true" : "false",
      auth_source: value,
      auth_method: value,
      token_status: value,
      token_expires_at: value,
    });
  }
  const { row: activeRow, oauth: login } = active;
  const isKey = activeRow.value.type === "api";
  const expiresAt = login?.state === "configured" ? login.expiresAt : undefined;
  return statusDetailsFromRecord({
    auth_configured: isKey || login ? "true" : "false",
    auth_source: isKey ? activeRow.integrationId : (login?.sourceKey ?? "(none)"),
    // OpenCode 2's sign-in method, e.g. chatgpt-token-sharing ("Sign in with ChatGPT").
    auth_method: typeof activeRow.value.methodID === "string" ? activeRow.value.methodID : "(none)",
    token_status: tokenStatus(active),
    token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
  });
}

const CODE_REVIEW = { key: "code_review", label: "Code review", window: "code_review" } as const;

function quotaWindowRows(result: Extract<OpenAIResult, { success: true }>): ProviderRow[] {
  const rows = windowRows([
    { slot: FIVE_HOUR, value: result.windows.hourly },
    { slot: WEEKLY, value: result.windows.weekly },
    { slot: MONTHLY, value: result.windows.monthly },
    { slot: CODE_REVIEW, value: result.windows.codeReview },
  ]);
  const credits = result.credits;
  if (!credits) return rows;
  rows.push({
    key: "codex_credits",
    label: "Codex credits",
    type: "balance",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...(credits.unlimited === true
      ? { text: "Unlimited credits" }
      : credits.balance !== undefined
        ? { amount: { decimal: credits.balance, unit: { kind: "count", unit: "credit" } } }
        : { text: "No data" }),
  });
  return rows;
}

/**
 * Without any listed login, OpenCode can still report an active OpenAI
 * sign-in (one its connection list does not show), so query that one.
 */
async function fetchActiveLoginQuota(
  requestTimeoutMs: number | undefined,
): Promise<{ attempted: boolean; accounts: AccountResult[] }> {
  const auth = await readOpenAIAuthCached();
  if (auth.state === "none") return { attempted: false, accounts: [] };
  const result = await queryOpenAIQuota({ requestTimeoutMs, auth });
  if (!result.success) {
    return { attempted: true, accounts: [failedAccount("OpenAI", result.error, result.facts)] };
  }
  return {
    attempted: true,
    accounts: [{ name: result.label, rows: quotaWindowRows(result), errors: [] }],
  };
}

export const openaiProvider: QuotaProvider = {
  id: "openai",
  cachePolicy: {
    kind: "resolved-auth",
    resolveIdentity: async (ctx) => {
      const logins = await readOpenAILogins();
      // Only a token-sharing login reads the Codex CLI file, and only when the user turned that
      // source on, so only then can it change these rows.
      const codexCli =
        ctx?.config?.openaiCodexCliSource && hasTokenSharingLogin(logins)
          ? await codexCliLogin()
          : null;
      const cliLogin = codexCli?.state === "configured" ? codexCli.login : undefined;
      return openaiLoginsIdentity(
        logins,
        cliLogin ? { accessToken: cliLogin.accessToken, accountId: cliLogin.accountId } : null,
      );
    },
  },

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    if (await isCanonicalProviderAvailable({ ctx, providerId: "openai", fallbackOnError: true })) {
      return true;
    }
    // Without an OpenAI alias, an OAuth sign-in or a stored API key counts.
    return (await readOpenAILogins()).some(({ row, oauth }) => oauth || row.value.type === "api");
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const currentIntegrationId =
      ctx.config?.currentProviderID ??
      resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config?.currentModel ?? "" })
        ?.providerId;
    const logins = sortActiveLoginsFirst(await readOpenAILogins(), currentIntegrationId);
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    // Read once per fetch: only a token-sharing login needs it, and only when the user turned the
    // source on. A login that never falls back must not touch another credential file.
    const codexCliOn = ctx.config?.openaiCodexCliSource === true;
    // The status lines describe the first token-sharing login, the one OpenCode uses when it is
    // the active one; a second such login gets its own rows but not its own account verdict.
    const tokenSharing = logins.find(({ row }) => isTokenSharingLogin(row));
    const needsCodexCli = tokenSharing !== undefined;
    const codexCli = codexCliOn && needsCodexCli ? await codexCliLogin() : null;
    const cliAccount = codexCli?.state === "configured" ? codexCli.login.accountId : undefined;
    const accountMatch = accountsMatch(loginAccountId(tokenSharing?.oauth), cliAccount);
    // Names span every stored account (OAuth and API key) so numbering and the
    // `(active)` marker match the accounts OpenCode actually holds.
    const accounts = await fetchEachLogin({
      providerName: "OpenAI",
      logins,
      numberUnnamed: (row) => row.value.type === "api",
      async fetchLogin({ row, oauth: login }) {
        if (isTokenSharingLogin(row)) {
          if (!codexCli || codexCli.state === "missing") {
            return { rows: [statusRow(TOKEN_SHARING_STATUS)], errors: [] };
          }
          if (codexCli.state === "unavailable") {
            const detail = sanitizeSingleLineDisplaySnippet(codexCli.detail, 120);
            return { rows: [statusRow(`${TOKEN_SHARING_STATUS}: ${detail}`)], errors: [] };
          }
          // Never attribute another account's limits to this login.
          if (accountsMatch(loginAccountId(login), codexCli.login.accountId) === "different") {
            return {
              rows: [
                statusRow(
                  "ChatGPT quota unavailable: the Codex CLI sign-in belongs to a different ChatGPT account. Run `codex login` to switch it.",
                ),
              ],
              errors: [],
            };
          }
          const result = await queryOpenAIQuota({ requestTimeoutMs, auth: codexCli.login });
          if (!result.success) {
            return {
              rows: [],
              errors: [
                fetchError(
                  `${result.error} (Codex CLI sign-in ${codexCli.location}${
                    isAuthFailure(result) ? "; run `codex login` to renew it" : ""
                  })`,
                  result.facts,
                ),
              ],
            };
          }
          // These are the CLI sign-in's numbers, even when it looks like the same account, so the
          // account name says so ("[OpenAI] (Codex CLI, Plus)"; the plan stays when known).
          const plan = result.label.replace(/^OpenAI\s*\(?/u, "").replace(/\)$/u, "");
          return {
            rows: quotaWindowRows(result),
            errors: [],
            fallbackName: `OpenAI (Codex CLI${plan ? `, ${plan}` : ""})`,
          };
        }
        if (row.value.type === "api") {
          if (row.resolveError !== undefined) {
            return {
              rows: [],
              errors: [{ message: `OpenAI API key could not be read: ${row.resolveError}` }],
            };
          }
          // ChatGPT's usage endpoint only accepts OAuth credentials, so an API-key
          // account reports its lack of ChatGPT quota instead of a quota number.
          return { rows: [statusRow("ChatGPT quota unavailable for API key")], errors: [] };
        }
        if (!login) return null;
        const result = await queryOpenAIQuota({
          requestTimeoutMs,
          auth: login,
          loginLabel: row.label,
        });
        if (!result.success) return { rows: [], errors: [fetchError(result.error, result.facts)] };
        return { rows: quotaWindowRows(result), errors: [], fallbackName: result.label };
      },
    });

    const debug = [
      ...activeLoginStatusDetails(logins),
      ...(codexCli ? codexCliStatusDetails(codexCli, accountMatch) : []),
      // Switched off: say the source exists, but never name or read the file.
      ...(!codexCliOn && needsCodexCli ? statusDetailsFromRecord({ codex_cli_state: "off" }) : []),
    ];
    if (accounts.length > 0) return { attempted: true, accounts, debug };
    return { ...(await fetchActiveLoginQuota(requestTimeoutMs)), debug };
  },
};
