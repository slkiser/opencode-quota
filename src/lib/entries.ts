/**
 * The provider interface and what a provider is given. Providers return the row contract
 * (`ProviderFetchResult`, see `providers/contract.ts`).
 */
import type { ProviderFetchResult } from "../providers/contract.js";
import type { CursorQuotaPlan } from "./cursor-pricing.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import type { ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { RuntimeProviderIdResolver } from "./runtime-provider-ids.js";

/** When the current fixed quota window started, as its provider reports it. */
export interface FixedWindowProjectionEvidence {
  startedAtIso: string;
}

export interface QuotaProviderMatchContext {
  enabledProviders: string[] | "auto";
  automaticDiscovery?: boolean;
  quotaProviders?: QuotaProviderDefinition[];
  currentProviderID?: string;
}

export interface QuotaProviderContext {
  client: {
    config: {
      providers: () => Promise<{ data?: { providers: Array<{ id: string }> } }>;
    };
  };
  resolveRuntimeProviderIds: RuntimeProviderIdResolver;
  /**
   * The project folder quota is computed for: the git root of the OpenCode location, or the
   * location itself. The terminal command computes quota for the home folder.
   */
  workspaceRoot: string;
  /**
   * The folder OpenCode runs the session in: OpenCode's config files that count are found from
   * here upward. The terminal command uses the folder it runs in.
   */
  locationDirectory: string;
  config: {
    anthropicBinaryPath?: string;
    cursorPlan: CursorQuotaPlan;
    cursorIncludedApiUsd?: number;
    cursorBillingCycleStartDay?: number;
    opencodeMonthlyLimit?: number;
    requestTimeoutMs?: number;
    /** True when the settings file sets providers.checking.requestTimeoutMs (not its default). */
    requestTimeoutMsConfigured?: boolean;
    onlyCurrentModel?: boolean;
    currentModel?: string;
    currentProviderID?: string;
    /** The registered providers not turned off in the settings. */
    enabledProviders: string[];
    /** The list filters automatic discovery, rather than explicitly enrolling providers. */
    automaticDiscovery?: boolean;
    quotaProviders?: QuotaProviderDefinition[];
  };
}

export interface QuotaProviderCacheContext {
  runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[];
}

export type QuotaProviderCachePolicy =
  | { kind: "account-neutral" }
  | { kind: "uncached" }
  | {
      kind: "resolved-auth";
      resolveIdentity: (
        ctx: QuotaProviderContext,
        cacheContext: QuotaProviderCacheContext,
      ) => Promise<ResolvedAuthIdentity | null>;
      /** Separates memory-only entries of credential sources that expose no account identity. */
      resolveScope?: (ctx: QuotaProviderContext) => Promise<string>;
    };

export interface QuotaProvider {
  /** Stable id used by config.enabledProviders */
  id: string;

  /** Best-effort availability check (no network if possible) */
  isAvailable: (ctx: QuotaProviderContext) => Promise<boolean>;

  /** Fetch quota as the row contract. */
  fetch: (
    ctx: QuotaProviderContext,
    cacheContext?: QuotaProviderCacheContext,
  ) => Promise<ProviderFetchResult>;

  /**
   * Shared-cache safety policy: how the store tells the signed-in accounts apart. Every
   * provider names its own; account-neutral caching must be explicit.
   */
  cachePolicy: QuotaProviderCachePolicy;

  /** Optional provider match for onlyCurrentModel filtering */
  matchesCurrentModel?: (model: string, context?: QuotaProviderMatchContext) => boolean;
}
