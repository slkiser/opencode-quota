import { createHash } from "node:crypto";
import {
  canonicalizeNineRouterProviders,
  serializeNineRouterProviderSelection,
} from "../lib/config.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  fetchNineRouterAccounts,
  fetchNineRouterUsage,
  type NineRouterAccount,
  type NineRouterUsageWindow,
  resolveNineRouterConfig,
} from "../lib/nine-router.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { attemptedResult, notAttemptedResult } from "./result-helpers.js";

const ACCOUNTING = {
  resultType: "rate_limit",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const USAGE_CONCURRENCY = 4;
const UUID_LABEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function accountLabel(account: NineRouterAccount, index: number): string {
  for (const value of [account.displayName, account.name]) {
    const label = value?.trim();
    if (
      label &&
      !label.includes("@") &&
      !UUID_LABEL.test(label) &&
      label.toLowerCase() !== account.id.toLowerCase()
    ) {
      return label;
    }
  }
  if (account.email?.includes("@")) {
    const [local, domain] = account.email.split("@", 2);
    return `${local.slice(0, 3)}..${domain}`;
  }
  return `Account ${index + 1}`;
}

function accountProvider(account: NineRouterAccount, providers: readonly string[]): string | null {
  return account.provider || (providers.length === 1 ? (providers[0] ?? null) : null);
}

async function mapAtMostFour<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(USAGE_CONCURRENCY, values.length) }, worker));
  return results;
}

export const nineRouterProvider: QuotaProvider = {
  id: "9router",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return resolveNineRouterConfig().success;
  },

  cacheIdentity(ctx: QuotaProviderContext): string {
    const resolved = resolveNineRouterConfig();
    const key = process.env.OPENCODE_NINEROUTER_API_KEY?.trim();
    if (!resolved.success || !key) return "";
    const providers = serializeNineRouterProviderSelection(ctx.config.nineRouter.providers);
    const display = ctx.config.nineRouter.display.trim().toLowerCase();
    return `root_sha256=${digest(`9router:root:${resolved.root}`)};key_sha256=${digest(`9router:key:${key}`)};providers_sha256=${digest(`9router:providers:${providers}`)};display_sha256=${digest(`9router:display:${display}`)}`;
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "9router");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const config = resolveNineRouterConfig();
    if (!config.success) return notAttemptedResult();
    const selection = canonicalizeNineRouterProviders(ctx.config.nineRouter.providers);
    const providers = selection.filter((provider) => provider !== "all");
    if (selection.length > 0 && providers.length === 0) return attemptedResult([], []);

    let accountResults: Array<Awaited<ReturnType<typeof fetchNineRouterAccounts>> | null>;
    try {
      accountResults =
        providers.length === 0
          ? [await fetchNineRouterAccounts(config)]
          : await mapAtMostFour(providers, async (provider) => {
              try {
                return await fetchNineRouterAccounts(config, provider);
              } catch {
                return null;
              }
            });
    } catch {
      return attemptedResult([], []);
    }

    const accountIds = new Set<string>();
    const accounts: NineRouterAccount[] = [];
    for (const accountResult of accountResults) {
      if (!accountResult?.success) continue;
      for (const account of accountResult.accounts) {
        if (accountIds.has(account.id)) continue;
        accountIds.add(account.id);
        accounts.push(account);
      }
    }

    const outcomes = await mapAtMostFour(accounts, async (account, index) => {
      try {
        return {
          account,
          index,
          usage: await fetchNineRouterUsage(config, account.id, ctx.config.requestTimeoutMs),
        };
      } catch {
        return { account, index, usage: { success: false as const, error: "unavailable" } };
      }
    });
    const entries: QuotaToastEntry[] = [];
    const labels = new Map<string, number>();
    const windowsByKey = new Map<string, NineRouterUsageWindow[]>();

    for (const outcome of outcomes) {
      if (!outcome.usage.success || outcome.usage.windows.length === 0) continue;
      const provider = accountProvider(outcome.account, providers);
      if (!provider) continue;
      const baseLabel = accountLabel(outcome.account, outcome.index);
      const labelKey = `${provider}\u0000${baseLabel}`;
      const count = (labels.get(labelKey) ?? 0) + 1;
      labels.set(labelKey, count);
      const displayLabel = count === 1 ? baseLabel : `${baseLabel} (${count})`;

      if (ctx.config.nineRouter.display === "unified") {
        for (const window of outcome.usage.windows) {
          const key = `${provider}\u0000${window.kind}`;
          const contributors = windowsByKey.get(key) ?? [];
          contributors.push(window);
          windowsByKey.set(key, contributors);
        }
        continue;
      }

      const sourceId = digest(`9router:connection:${provider}:${outcome.account.id}`);
      for (const window of outcome.usage.windows) {
        entries.push({
          accounting: { ...ACCOUNTING, sourceId },
          name: `${provider} / ${displayLabel} ${window.kind}`,
          group: `${provider} / ${displayLabel}`,
          label: `${window.kind}:`,
          percentRemaining: window.percentRemaining,
          resetTimeIso: window.resetTimeIso,
        });
      }
    }

    for (const [key, contributors] of windowsByKey) {
      const [provider, windowKind] = key.split("\u0000", 2);
      if (!provider || !windowKind) continue;
      const resets = contributors
        .map((contributor) => contributor.resetTimeIso)
        .filter((resetTimeIso): resetTimeIso is string => resetTimeIso !== undefined)
        .sort();
      entries.push({
        accounting: { ...ACCOUNTING, sourceId: digest(`9router:unified:${provider}`) },
        name: `nineRouter (${provider}) ${windowKind}`,
        group: `nineRouter (${provider})`,
        label: `${windowKind}:`,
        percentRemaining:
          contributors.reduce((sum, contributor) => sum + contributor.percentRemaining, 0) /
          contributors.length,
        ...(resets[0] ? { resetTimeIso: resets[0] } : {}),
      });
    }
    return attemptedResult(entries, []);
  },
};
