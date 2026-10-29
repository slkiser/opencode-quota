/**
 * The providers as the store needs them: which ones the server settings turn on and which of
 * those are available, how to ask each one, and who it is signed in as. Every read takes the
 * settings the host holds now, so a settings change applies to the next snapshot or refresh.
 */
import { createHmac, randomBytes } from "node:crypto";
import type {
  QuotaProvider,
  QuotaProviderCacheContext,
  QuotaProviderContext,
} from "../lib/entries.js";
import {
  getQuotaProviderDisplayLabel,
  isLiveLocalUsageProviderId,
} from "../lib/provider-metadata.js";
import { exportProviderFromCheck } from "../lib/quota-export.js";
import {
  cloneQuotaProviders,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  selectEligibleQuotaProviderDefinitions,
} from "../lib/quota-providers.js";
import {
  deriveResolvedAuthIdentity,
  isResolvedAuthIdentityKeyDurable,
} from "../lib/resolved-auth-identity.js";
import { createRuntimeProviderIdResolver } from "../lib/runtime-provider-ids.js";
import { getProviders } from "../providers/registry.js";
import type { LoadedSettings, Settings } from "../settings/index.js";
import { offProviderId } from "../settings/schema.js";
import { rowsFromProviderResult } from "./rows.js";
import { matchesQuotaProviderCurrentSelection } from "./selection.js";
import type { CheckForExport, ProviderIdentity, StoreProvider, StoreSource } from "./store.js";
import type { SessionModel } from "./types.js";

export type ProviderSourceHost = {
  /** OpenCode's provider list, for availability and model checks. */
  client: QuotaProviderContext["client"];
  /** The project folder quota is computed for. */
  workspaceRoot: string;
  /** The folder OpenCode runs the session in; see `QuotaProviderContext.locationDirectory`. */
  locationDirectory: string;
  /** The server settings now. */
  settings: () => LoadedSettings;
  /** The registered providers in display order; `getProviders()` when absent. */
  providers?: () => readonly QuotaProvider[];
};

/** The settings the server reads besides the providers themselves. */
export type ServerSettings = {
  waitForQuotaReset: boolean;
  /** The export file, written after each snapshot change when on. */
  export: { enabled: boolean; path: string };
  /** Quota gauges through the host's OpenTelemetry MeterProvider. */
  telemetry: boolean;
};

/** The start of every row id of the custom definition `definitionId`. */
export function customRowPrefix(definitionId: string): string {
  return `${QUOTA_PROVIDERS_AGGREGATE_ID}.custom.${definitionId}.`;
}

/** The host's registered providers. */
export function registeredProviders(host: ProviderSourceHost): readonly QuotaProvider[] {
  return host.providers ? host.providers() : getProviders();
}

/** All registered providers except the ids switched off, with custom mapped to its registry id. */
function registryProviderIds(
  providers: readonly QuotaProvider[],
  off: Settings["providers"]["off"],
): string[] {
  return providers.map((provider) => provider.id).filter((id) => !off.includes(offProviderId(id)));
}

/** What every provider reads from the settings when it checks its quota. */
export function providerContext(
  host: ProviderSourceHost,
  loaded: LoadedSettings = host.settings(),
  model?: SessionModel,
): QuotaProviderContext {
  const { settings, fromFile } = loaded;
  const { anthropic, cursor, opencode } = settings.providers;
  return {
    client: host.client,
    resolveRuntimeProviderIds: createRuntimeProviderIdResolver(host.client),
    workspaceRoot: host.workspaceRoot,
    locationDirectory: host.locationDirectory,
    config: {
      anthropicBinaryPath: anthropic.binaryPath,
      cursorPlan: cursor.plan,
      cursorIncludedApiUsd: cursor.includedApiUsd ?? undefined,
      cursorBillingCycleStartDay: cursor.billingCycleStartDay ?? undefined,
      opencodeMonthlyLimit: opencode.monthlyLimitUsd ?? undefined,
      requestTimeoutMs: settings.providers.checking.requestTimeoutMs,
      requestTimeoutMsConfigured: fromFile.includes("providers.checking.requestTimeoutMs"),
      enabledProviders: registryProviderIds(registeredProviders(host), settings.providers.off),
      automaticDiscovery: true,
      quotaProviders: cloneQuotaProviders(settings.providers.custom),
      currentModel: model?.id,
      currentProviderID: model?.providerID,
    },
  };
}

/** The providers that serve `model`, by the settings in `ctx`. */
function providerIdsForModel(
  providers: readonly QuotaProvider[],
  ctx: QuotaProviderContext,
  model: SessionModel,
): string[] {
  return providers
    .filter((provider) =>
      matchesQuotaProviderCurrentSelection({
        provider,
        currentModel: model.id,
        currentProviderID: model.providerID,
        enabledProviders: ctx.config.enabledProviders,
        automaticDiscovery: ctx.config.automaticDiscovery,
        quotaProviders: ctx.config.quotaProviders,
      }),
    )
    .map((provider) => provider.id);
}

/** OpenCode's provider ids; none when its list can't be read. */
async function openCodeProviderIds(ctx: QuotaProviderContext): Promise<ReadonlySet<string>> {
  try {
    return await ctx.resolveRuntimeProviderIds();
  } catch {
    return new Set();
  }
}

/**
 * The custom definitions (rows `customRowPrefix(id)`) that serve `model`; without OpenCode's
 * provider list none can be matched to a model.
 */
function customDefinitionIdsForModel(
  ctx: QuotaProviderContext,
  availableProviderIds: ReadonlySet<string>,
  model: SessionModel,
): string[] {
  return selectEligibleQuotaProviderDefinitions({
    definitions: ctx.config.quotaProviders ?? [],
    availableProviderIds,
    onlyCurrentModel: true,
    currentModel: model.id,
    currentProviderID: model.providerID,
  }).map((definition) => definition.id);
}

/** The quota-providers aggregate needs the custom definitions OpenCode can serve right now. */
async function cacheContextFor(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderCacheContext> {
  if (provider.id !== QUOTA_PROVIDERS_AGGREGATE_ID) return {};
  return {
    runtimeEligibleQuotaProviders: selectEligibleQuotaProviderDefinitions({
      definitions: ctx.config.quotaProviders ?? [],
      availableProviderIds: await ctx.resolveRuntimeProviderIds(),
    }),
  };
}

/** The signed-in account per the provider's cache policy; null when it can't be told safely. */
async function accountIdentity(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  cacheContext: QuotaProviderCacheContext,
): Promise<string | null> {
  const policy = provider.cachePolicy;
  if (!policy || policy.kind === "uncached") return null;
  if (policy.kind === "account-neutral") return "account-neutral";
  try {
    return await policy.resolveIdentity(ctx, cacheContext);
  } catch {
    return null;
  }
}

/** Keys logins while the identity key can't be read; no account is saved then. */
const processLoginKey = randomBytes(32);

/**
 * Each login (a source id: an account number, a credential id, often an email) as an opaque id
 * keyed with the identity key (the install's protected key, or one held in memory where it
 * can't be protected), so the snapshot file and notice ids can't be matched against guessed
 * emails. Without that key no account identity exists either, so the store keeps such rows in
 * memory only, and a key of this process is enough.
 */
export async function keyedLogins(
  providerId: string,
  logins: readonly string[],
): Promise<string[]> {
  return Promise.all(
    logins.map(async (login) => {
      if (!login) return "";
      const keyed = await deriveResolvedAuthIdentity({
        providerId,
        principal: { kind: "stable-id", value: login },
        qualifiers: ["v6-row-login"],
      });
      return (
        keyed ??
        createHmac("sha256", processLoginKey)
          .update(JSON.stringify([providerId, login]))
          .digest("base64url")
      );
    }),
  );
}

function storeProvider(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  settingsKey: string,
): StoreProvider {
  return {
    id: provider.id,
    label: getQuotaProviderDisplayLabel(provider.id),
    // Cursor counts OpenCode's own history: cheap, and stale at once.
    ...(isLiveLocalUsageProviderId(provider.id) ? { minIntervalMs: 0 } : {}),
    async identity(): Promise<ProviderIdentity> {
      const account = await accountIdentity(provider, ctx, await cacheContextFor(provider, ctx));
      if (account === null) {
        const scope =
          provider.cachePolicy?.kind === "resolved-auth"
            ? await provider.cachePolicy.resolveScope?.(ctx)
            : undefined;
        return { key: scope ? `${scope}\u001f${settingsKey}` : settingsKey, persist: false };
      }
      // An account keyed in memory only is another one after a reload: its rows stay in memory.
      const persist =
        provider.cachePolicy.kind !== "resolved-auth" || isResolvedAuthIdentityKeyDurable();
      return { key: `${account}\u001f${settingsKey}`, persist };
    },
    async fetch() {
      const result = await provider.fetch(ctx, await cacheContextFor(provider, ctx));
      const fetched = rowsFromProviderResult(provider.id, result);
      const buildExportPart = (check: CheckForExport) =>
        exportProviderFromCheck({
          ...check,
          providerId: provider.id,
          label: getQuotaProviderDisplayLabel(provider.id),
          customDefinitions: ctx.config.quotaProviders ?? [],
          accounts: result.accounts,
        });
      if (!fetched.rowLogins) return { ...fetched, buildExportPart };
      return {
        ...fetched,
        rowLogins: await keyedLogins(provider.id, fetched.rowLogins),
        buildExportPart,
      };
    },
  };
}

/** The store's source: the enabled and available providers, with the settings now. */
export async function loadProviderSource(
  host: ProviderSourceHost,
  model?: SessionModel,
): Promise<StoreSource> {
  const loaded = host.settings();
  const providers = registeredProviders(host);
  const ctx = providerContext(host, loaded, model);
  // Resolve scopes even for unavailable or disabled providers: their absence must belong to
  // the same credential source as their rows. Settings changes keep that source's scope.
  const scopes = await Promise.all(
    providers.map(async (provider) => {
      if (provider.cachePolicy?.kind !== "resolved-auth") return undefined;
      const scope = await provider.cachePolicy.resolveScope?.(ctx);
      return scope === undefined ? undefined : [provider.id, scope];
    }),
  );
  const scoped = scopes.filter((scope) => scope !== undefined);
  const { enabledProviders } = ctx.config;
  const enabled = providers.filter((provider) => enabledProviders.includes(provider.id));
  const available = await Promise.all(
    enabled.map(async (provider) => {
      try {
        return await provider.isAvailable(ctx);
      } catch {
        return false;
      }
    }),
  );
  // A settings change that alters what a provider reports also changes its identity.
  const { config } = ctx;
  const settingsKey = JSON.stringify([
    config.anthropicBinaryPath ?? null,
    config.cursorPlan,
    config.cursorIncludedApiUsd ?? null,
    config.cursorBillingCycleStartDay ?? null,
    config.opencodeMonthlyLimit ?? null,
    config.quotaProviders ?? [],
  ]);
  const availableProviderIds = config.quotaProviders?.length
    ? await openCodeProviderIds(ctx)
    : new Set<string>();
  return {
    ...(scoped.length ? { scope: JSON.stringify(scoped) } : {}),
    providers: enabled
      .filter((_, index) => available[index])
      .map((provider) => storeProvider(provider, ctx, settingsKey)),
    minIntervalMs: loaded.settings.providers.checking.minIntervalMs,
    providerIdsForModel: (model) => providerIdsForModel(providers, ctx, model),
    // A custom definition's rows serve only the models the definition serves.
    rowPrefixesForModel: (model) => ({
      [QUOTA_PROVIDERS_AGGREGATE_ID]: customDefinitionIdsForModel(
        ctx,
        availableProviderIds,
        model,
      ).map(customRowPrefix),
    }),
  };
}

export async function loadServerSettings(host: ProviderSourceHost): Promise<ServerSettings> {
  const { settings } = host.settings();
  return {
    waitForQuotaReset: settings.providers.checking.waitForQuotaReset,
    export: { enabled: settings.system.exportFile, path: settings.system.exportPath },
    telemetry: settings.system.telemetry,
  };
}
