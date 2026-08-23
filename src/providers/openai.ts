/**
 * OpenAI (ChatGPT) provider wrapper.
 *
 * Native OpenCode OAuth remains supported. When the optional oc-codex-multi-auth
 * store is present, cached access tokens are queried independently and rendered
 * as separate OpenAI groups without refreshing or writing credentials.
 */

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import { mapWithConcurrency } from "../lib/map-with-concurrency.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  type OpenAIResult,
  queryOpenAIQuota,
  queryOpenAIQuotaForCredential,
  type ResolvedOpenAIOAuth,
  resolveOpenAIOAuth,
} from "../lib/openai.js";
import {
  hasOpenAIMultiAuthAccountsConfigured,
  inspectOpenAIMultiAuthPresence,
  type OpenAIMultiAuthAccount,
  readOpenAIMultiAuthAccounts,
} from "../lib/openai-multi-auth.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENAI_ACCOUNTING: AccountingMetadata = {
  resultType: "rate_limit",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

const MULTI_AUTH_CONCURRENCY = 3;

function buildOpenAIEntries(
  result: Extract<OpenAIResult, { success: true }>,
  group: string,
  sourceId?: string,
): QuotaToastEntry[] {
  return groupedPercentWindowEntries({
    group,
    accounting: {
      ...OPENAI_ACCOUNTING,
      ...(sourceId ? { sourceId } : {}),
    },
    windows: [
      { window: result.windows.hourly, suffix: "5h", label: "5h:" },
      { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
      { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
      { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
    ],
  });
}

function displayAccountLabel(label: string | undefined): string | undefined {
  const cleaned = label
    ?.replace(/\s+\(role:[^)]+\)/giu, "")
    .replace(/\s+\[id:[^\]]+\]/giu, "")
    .trim();
  return cleaned || undefined;
}

function accountLabel(account: OpenAIMultiAuthAccount): string {
  return displayAccountLabel(account.accountLabel) || `Account ${account.index + 1}`;
}

function multiAuthGroup(account: OpenAIMultiAuthAccount, providerLabel: string): string {
  const planLabel = providerLabel.match(/^OpenAI\s*\((.*)\)$/)?.[1]?.trim();
  return `OpenAI (${planLabel || accountLabel(account)})`;
}

function sameNativeAccount(
  native: Extract<ResolvedOpenAIOAuth, { state: "configured" }>,
  account: OpenAIMultiAuthAccount,
): boolean {
  if (native.accessToken === account.accessToken) return true;

  if (native.accountUserId && account.accountUserId) {
    return (
      native.accountUserId === account.accountUserId &&
      (!native.accountId || !account.accountId || native.accountId === account.accountId)
    );
  }

  if (native.accountId && account.accountId && native.accountId === account.accountId) {
    if (native.accountUserId || account.accountUserId) {
      return Boolean(
        native.email && account.email && native.email.toLowerCase() === account.email.toLowerCase(),
      );
    }
    return true;
  }

  return false;
}

function uniqueGroupName(group: string, used: Set<string>): string {
  if (!used.has(group)) {
    used.add(group);
    return group;
  }

  let suffix = 2;
  while (used.has(`${group} #${suffix}`)) suffix += 1;
  const unique = `${group} #${suffix}`;
  used.add(unique);
  return unique;
}

function ensureDistinctGroups(entries: QuotaToastEntry[]): QuotaToastEntry[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    if (!entry.group) return entry;
    const group = uniqueGroupName(entry.group, used);
    if (group === entry.group) return entry;
    const suffix = entry.name.startsWith(entry.group) ? entry.name.slice(entry.group.length) : "";
    return { ...entry, group, name: `${group}${suffix}` };
  });
}

async function fetchMultiAuthQuota(
  ctx: QuotaProviderContext,
  accounts: OpenAIMultiAuthAccount[],
  usedGroups: Set<string>,
): Promise<QuotaProviderResult> {
  const accountResults = await mapWithConcurrency(
    accounts,
    MULTI_AUTH_CONCURRENCY,
    async (account) => {
      if (!account.accessToken) {
        return {
          account,
          result: {
            success: false as const,
            error: "Cached access token unavailable; refresh this account in oc-codex-multi-auth.",
          },
        };
      }

      const result = await queryOpenAIQuotaForCredential(
        {
          accessToken: account.accessToken,
          accountId: account.accountId,
          accountUserId: account.accountUserId,
          expiresAt: account.expiresAt,
          email: account.email,
        },
        { requestTimeoutMs: ctx.config?.requestTimeoutMs },
      );
      return { account, result };
    },
  );

  const entries: QuotaToastEntry[] = [];
  const errors: QuotaToastError[] = [];

  for (const { account, result } of accountResults) {
    if (!result.success) {
      errors.push({ label: `OpenAI (${accountLabel(account)})`, message: result.error });
      continue;
    }

    const group = uniqueGroupName(multiAuthGroup(account, result.label), usedGroups);
    entries.push(...buildOpenAIEntries(result, group, account.sourceId));
  }

  const presence = await inspectOpenAIMultiAuthPresence();
  return withStatusDetails(
    attemptedResult(entries, errors),
    statusDetailsFromRecord({
      auth_source: "oc-codex-multi-auth",
      multi_auth_state: presence.state,
      multi_auth_accounts: String(presence.enabledAccountCount),
      multi_auth_cached_access_tokens: String(presence.cachedAccessTokenCount),
    }),
  );
}

async function fetchNativeOpenAIQuota(
  ctx: QuotaProviderContext,
  auth: ResolvedOpenAIOAuth,
): Promise<QuotaProviderResult> {
  const result = await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
  const providerResult = mapNullableProviderResult(result, {
    errorLabel: "OpenAI",
    onSuccess: (success) =>
      attemptedResult(buildOpenAIEntries(success, success.label), [], {
        singleWindowDisplayName: success.label,
      }),
  });
  const configured = auth.state === "configured";
  const expiresAt = configured ? auth.expiresAt : undefined;

  return withStatusDetails(
    providerResult,
    statusDetailsFromRecord({
      auth_configured: configured ? "true" : "false",
      auth_source: configured ? auth.sourceKey : "(none)",
      token_status: !configured
        ? "(none)"
        : expiresAt && expiresAt < Date.now()
          ? "expired"
          : "valid",
      token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
      account_email: configured && auth.email ? sanitizeDisplayText(auth.email) : "(none)",
      account_id: configured && auth.accountId ? sanitizeDisplayText(auth.accountId) : "(none)",
    }),
  );
}

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) return true;
    if (await hasOpenAIMultiAuthAccountsConfigured()) return true;
    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = resolveOpenAIOAuth(await readAuthFileCached({ maxAgeMs: 5_000 }));
    const multiAuthAccounts = await readOpenAIMultiAuthAccounts();
    if (!multiAuthAccounts?.length) return fetchNativeOpenAIQuota(ctx, auth);

    const nativePromise = fetchNativeOpenAIQuota(ctx, auth);
    const distinctAccounts =
      auth.state === "configured"
        ? multiAuthAccounts.filter((account) => !sameNativeAccount(auth, account))
        : multiAuthAccounts;
    const usedGroups = new Set<string>();
    const [native, multi] = await Promise.all([
      nativePromise,
      fetchMultiAuthQuota(ctx, distinctAccounts, usedGroups),
    ]);

    if (distinctAccounts.length === 0) return native;

    return {
      attempted: native.attempted || multi.attempted,
      entries: ensureDistinctGroups([...native.entries, ...multi.entries]),
      errors: [...native.errors, ...multi.errors],
      statusDetails: [...(native.statusDetails ?? []), ...(multi.statusDetails ?? [])],
    };
  },
};
