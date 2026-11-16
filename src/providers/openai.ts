/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import type { DebugDetail } from "../core/types.js";
import { readCodexCliSource, queryCodexCliQuota } from "../lib/codex-cli.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import {
  type OpenAILogin,
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
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
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

/**
 * The Codex CLI's own sign-in, when the settings ask for it. It is a separate account, named
 * for its source, so its numbers are never read as the OpenCode login's.
 */
const CODEX_CLI_ACCOUNT = "OpenAI (Codex CLI)";

/**
 * The Codex CLI's quota, when `providers.openai.codexCliSource` is on.
 *
 * It is only asked for when OpenCode's own login has no quota number to show, so a login that
 * already reports one (the legacy Codex sign-ins do) is not answered twice.
 */
async function fetchCodexCliQuota(
  ctx: QuotaProviderContext,
  accounts: readonly AccountResult[],
): Promise<{ accounts: AccountResult[]; debug: DebugDetail[] }> {
  if (!ctx.config?.openaiCodexCliSource) return { accounts: [], debug: [] };
  const alreadyReported = accounts.some((account) =>
    account.rows.some((row) => row.type === "quota"),
  );
  if (alreadyReported) return { accounts: [], debug: [] };

  const source = await readCodexCliSource();
  if (source.state !== "ready") {
    return {
      accounts: [failedAccount(CODEX_CLI_ACCOUNT, source.error)],
      debug: [{ key: "codex_cli_source", value: source.state }],
    };
  }
  const result = await queryCodexCliQuota({
    login: source.login,
    requestTimeoutMs: ctx.config?.requestTimeoutMs,
  });
  if (!result.success) {
    return {
      accounts: [failedAccount(CODEX_CLI_ACCOUNT, result.error, result.facts)],
      debug: [{ key: "codex_cli_source", value: "ready" }],
    };
  }
  return {
    accounts: [
      {
        name: CODEX_CLI_ACCOUNT,
        rows: [statusRow("Quota from the Codex CLI sign-in"), ...quotaWindowRows(result)],
        errors: [],
      },
    ],
    debug: [{ key: "codex_cli_source", value: "ready" }],
  };
}

export const openaiProvider: QuotaProvider = {
  id: "openai",
  cachePolicy: {
    kind: "resolved-auth",
    resolveIdentity: async (ctx) => {
      const identity = await openaiLoginsIdentity(await readOpenAILogins());
      if (!ctx.config?.openaiCodexCliSource) return identity;
      const source = await readCodexCliSource();
      if (source.state !== "ready") return identity;
      const codexIdentity = await deriveResolvedAuthIdentity({
        providerId: "openai",
        principal: { kind: "stable-id", value: `codex-cli:${source.login.accountId ?? "unknown"}` },
        qualifiers: ["codex-cli"],
      });
      if (!codexIdentity) return identity;
      if (!identity) return codexIdentity;
      return composeResolvedAuthIdentities({
        providerId: "openai",
        identities: [identity, codexIdentity],
      });
    },
  },

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    if (await isCanonicalProviderAvailable({ ctx, providerId: "openai", fallbackOnError: true })) {
      return true;
    }
    // Without an OpenAI alias, an OAuth sign-in or a stored API key counts.
    if ((await readOpenAILogins()).some(({ row, oauth }) => oauth || row.value.type === "api")) {
      return true;
    }
    // The Codex CLI's sign-in is a source of OpenAI quota too, when the settings ask for it.
    if (ctx.config?.openaiCodexCliSource) {
      const source = await readCodexCliSource();
      if (source.state !== "missing") return true;
    }
    return false;
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
    // Names span every stored account (OAuth and API key) so numbering and the
    // `(active)` marker match the accounts OpenCode actually holds.
    const accounts = await fetchEachLogin({
      providerName: "OpenAI",
      logins,
      numberUnnamed: (row) => row.value.type === "api",
      async fetchLogin({ row, oauth: login }) {
        if (isTokenSharingLogin(row)) {
          return {
            rows: [statusRow("ChatGPT quota unavailable for Sign in with ChatGPT")],
            errors: [],
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

    const debug = activeLoginStatusDetails(logins);
    const listed =
      accounts.length > 0
        ? { attempted: true, accounts }
        : await fetchActiveLoginQuota(requestTimeoutMs);
    const codex = await fetchCodexCliQuota(ctx, listed.accounts);
    return {
      ...listed,
      accounts: [...listed.accounts, ...codex.accounts],
      debug: [...debug, ...codex.debug],
    };
  },
};
