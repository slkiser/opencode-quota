import type { QuotaToastConfig } from "./types.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
  SessionTokensData,
} from "./entries.js";
import type { SessionTokenError } from "./quota-status.js";

import { fetchSessionTokensForDisplay } from "./session-tokens.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { getProviders } from "../providers/registry.js";
import { getAnthropicNoDataMessage } from "../providers/anthropic.js";

const LIVE_LOCAL_USAGE_PROVIDER_IDS = new Set(["qwen-code", "alibaba-coding-plan", "cursor"]);

export type SessionModelMeta = {
  modelID?: string;
  providerID?: string;
};

export type QuotaRequestContext = {
  sessionID?: string;
  sessionMeta?: SessionModelMeta;
};

export type QuotaRenderData = {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
};

export type ProviderFetchCacheEntry = {
  timestamp: number;
  result?: QuotaProviderResult;
  inFlight?: Promise<QuotaProviderResult>;
};

export type ProviderFetchCacheStore = Map<string, ProviderFetchCacheEntry>;

export type QuotaRenderSelection = {
  isAutoMode: boolean;
  providers: QuotaProvider[];
  filtered: QuotaProvider[];
  ctx: QuotaProviderContext;
  currentModel?: string;
  currentProviderID?: string;
  filteringByCurrentSelection: boolean;
};

export type QuotaAvailability = {
  provider: QuotaProvider;
  ok: boolean;
};

async function getProviderAvailability(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
}): Promise<QuotaAvailability> {
  try {
    return {
      provider: params.provider,
      ok: await params.provider.isAvailable(params.ctx),
    };
  } catch {
    return {
      provider: params.provider,
      ok: false,
    };
  }
}

export type CollectQuotaRenderDataResult = {
  selection: QuotaRenderSelection | null;
  availability: QuotaAvailability[];
  active: QuotaProvider[];
  attemptedAny: boolean;
  hasExplicitProviderIssues: boolean;
  data: QuotaRenderData | null;
  sessionTokenError?: SessionTokenError;
};

type QuotaFormatStyle = NonNullable<QuotaProviderContext["config"]["formatStyle"]>;

function buildQuotaProviderContext(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  currentModel?: string;
  currentProviderID?: string;
  formatStyle?: QuotaFormatStyle;
}): QuotaProviderContext {
  const { client, config, currentModel, currentProviderID, formatStyle } = params;

  return {
    client,
    config: {
      googleModels: config.googleModels,
      anthropicBinaryPath: config.anthropicBinaryPath,
      alibabaCodingPlanTier: config.alibabaCodingPlanTier,
      cursorPlan: config.cursorPlan,
      cursorIncludedApiUsd: config.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
      formatStyle: formatStyle ?? config.formatStyle,
      onlyCurrentModel: config.onlyCurrentModel,
      currentModel,
      currentProviderID,
    },
  };
}

export function matchesQuotaProviderCurrentSelection(params: {
  provider: QuotaProvider;
  currentModel?: string;
  currentProviderID?: string;
}): boolean {
  if (params.provider.id === "cursor" && isCursorProviderId(params.currentProviderID)) {
    return true;
  }
  if (!params.currentModel) return false;
  return params.provider.matchesCurrentModel
    ? params.provider.matchesCurrentModel(params.currentModel)
    : true;
}

export async function resolveQuotaRenderSelection(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  request?: QuotaRequestContext;
  formatStyle?: QuotaFormatStyle;
}): Promise<QuotaRenderSelection | null> {
  const { client, config, request, formatStyle } = params;
  if (!config.enabled) return null;

  const allProviders = getProviders();
  const isAutoMode = config.enabledProviders === "auto";
  const providers = isAutoMode
    ? allProviders
    : allProviders.filter((provider) => config.enabledProviders.includes(provider.id));
  if (!isAutoMode && providers.length === 0) return null;

  let currentModel: string | undefined;
  let currentProviderID: string | undefined;
  if (config.onlyCurrentModel && request?.sessionMeta) {
    currentModel = request.sessionMeta.modelID;
    currentProviderID = request.sessionMeta.providerID;
  }

  const ctx = buildQuotaProviderContext({
    client,
    config,
    currentModel,
    currentProviderID,
    formatStyle,
  });

  const filteringByCurrentSelection =
    config.onlyCurrentModel && Boolean(currentModel || isCursorProviderId(currentProviderID));
  const filtered = filteringByCurrentSelection
    ? providers.filter((provider) =>
        matchesQuotaProviderCurrentSelection({ provider, currentModel, currentProviderID }),
      )
    : providers;

  return {
    isAutoMode,
    providers,
    filtered,
    ctx,
    currentModel,
    currentProviderID,
    filteringByCurrentSelection,
  };
}

function makeProviderFetchCacheKey(providerId: string, ctx: QuotaProviderContext): string {
  const formatStyle = ctx.config.formatStyle ?? "classic";
  const googleModels = ctx.config.googleModels.join(",");
  const alibabaCodingPlanTier = ctx.config.alibabaCodingPlanTier;
  const cursorPlan = ctx.config.cursorPlan;
  const cursorIncludedApiUsd = ctx.config.cursorIncludedApiUsd ?? "";
  const cursorBillingCycleStartDay = ctx.config.cursorBillingCycleStartDay ?? "";
  const onlyCurrentModel = ctx.config.onlyCurrentModel ? "yes" : "no";
  const currentModel = ctx.config.currentModel ?? "";
  const currentProviderID = ctx.config.currentProviderID ?? "";
  const anthropicBinaryPath = ctx.config.anthropicBinaryPath ?? "";
  return `${providerId}|formatStyle=${formatStyle}|anthropicBinaryPath=${anthropicBinaryPath}|googleModels=${googleModels}|alibabaTier=${alibabaCodingPlanTier}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}`;
}

async function fetchProviderWithCache(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  providerFetchCache: ProviderFetchCacheStore;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs, providerFetchCache } = params;

  if (LIVE_LOCAL_USAGE_PROVIDER_IDS.has(provider.id)) {
    return await provider.fetch(ctx);
  }

  const cacheKey = makeProviderFetchCacheKey(provider.id, ctx);
  const now = Date.now();
  const existing = providerFetchCache.get(cacheKey);

  if (existing?.result && existing.timestamp > 0 && ttlMs > 0 && now - existing.timestamp < ttlMs) {
    return existing.result;
  }

  if (existing?.inFlight) {
    return existing.inFlight;
  }

  const promise = (async () => {
    try {
      const result = await provider.fetch(ctx);
      if (result.attempted) {
        providerFetchCache.set(cacheKey, { timestamp: Date.now(), result });
      } else {
        providerFetchCache.delete(cacheKey);
      }
      return result;
    } catch (error) {
      providerFetchCache.delete(cacheKey);
      throw error;
    }
  })();

  providerFetchCache.set(cacheKey, {
    timestamp: existing?.timestamp ?? 0,
    result: existing?.result,
    inFlight: promise,
  });

  return promise;
}

function makeProviderFetchFailure(provider: QuotaProvider): QuotaProviderResult {
  return {
    attempted: true,
    entries: [],
    errors: [
      {
        label: getQuotaProviderDisplayLabel(provider.id),
        message: "Failed to read quota data",
      },
    ],
  };
}

export async function fetchProviderResults(params: {
  providers: QuotaProvider[];
  ctx: QuotaProviderContext;
  ttlMs: number;
  providerFetchCache: ProviderFetchCacheStore;
}): Promise<QuotaProviderResult[]> {
  const settled = await Promise.allSettled(
    params.providers.map((provider) =>
      fetchProviderWithCache({
        provider,
        ctx: params.ctx,
        ttlMs: params.ttlMs,
        providerFetchCache: params.providerFetchCache,
      }),
    ),
  );

  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : makeProviderFetchFailure(params.providers[index]!),
  );
}

function getExplicitNoDataMessage(provider: QuotaProvider): string {
  if (provider.id === "cursor") {
    return "No local usage yet";
  }
  if (provider.id === "anthropic") {
    return getAnthropicNoDataMessage();
  }
  return "Not configured";
}

function shouldSurfaceNoDataMessage(params: {
  provider: QuotaProvider;
  result: QuotaProviderResult;
  isAutoMode: boolean;
  activeProviderCount: number;
}): boolean {
  const { provider, result, isAutoMode, activeProviderCount } = params;
  if (result.attempted || result.entries.length > 0 || result.errors.length > 0) {
    return false;
  }

  if (!isAutoMode) {
    return true;
  }

  return activeProviderCount === 1 && (provider.id === "anthropic" || provider.id === "cursor");
}

export async function collectQuotaRenderData(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  request?: QuotaRequestContext;
  providerFetchCache: ProviderFetchCacheStore;
  surfaceExplicitProviderIssues: boolean;
  formatStyle?: QuotaFormatStyle;
}): Promise<CollectQuotaRenderDataResult> {
  const selection = await resolveQuotaRenderSelection(params);
  if (!selection) {
    return {
      selection: null,
      availability: [],
      active: [],
      attemptedAny: false,
      hasExplicitProviderIssues: false,
      data: null,
    };
  }

  const availability = await Promise.all(
    selection.filtered.map((provider) =>
      getProviderAvailability({
        provider,
        ctx: selection.ctx,
      }),
    ),
  );

  const active = availability.filter((item) => item.ok).map((item) => item.provider);
  if (active.length === 0) {
    const errors: QuotaToastError[] = [];
    let hasExplicitProviderIssues = false;

    if (params.surfaceExplicitProviderIssues && !selection.isAutoMode) {
      const filteredIds = new Set(selection.filtered.map((provider) => provider.id));
      const availabilityById = new Map(
        availability.map((item) => [item.provider.id, item.ok] as const),
      );

      for (const provider of selection.providers) {
        if (!filteredIds.has(provider.id)) {
          const detail =
            params.config.onlyCurrentModel && selection.currentModel
              ? `current model: ${selection.currentModel}`
              : "filtered";
          errors.push({
            label: getQuotaProviderDisplayLabel(provider.id),
            message: `Skipped (${detail})`,
          });
          hasExplicitProviderIssues = true;
          continue;
        }

        if (availabilityById.get(provider.id) === false) {
          errors.push({
            label: getQuotaProviderDisplayLabel(provider.id),
            message: "Unavailable (not detected)",
          });
          hasExplicitProviderIssues = true;
        }
      }
    }

    return {
      selection,
      availability,
      active,
      attemptedAny: false,
      hasExplicitProviderIssues,
      data: errors.length > 0 ? { entries: [], errors } : null,
    };
  }

  const results = await fetchProviderResults({
    providers: active,
    ctx: selection.ctx,
    ttlMs: params.config.minIntervalMs,
    providerFetchCache: params.providerFetchCache,
  });

  const entries = results.flatMap((result) => result.entries) as QuotaToastEntry[];
  const errors = results.flatMap((result) => result.errors);
  const attemptedAny = results.some((result) => result.attempted);

  let hasExplicitProviderIssues = false;

  for (let index = 0; index < active.length; index++) {
    const provider = active[index];
    const result = results[index];
    if (
      provider &&
      result &&
      shouldSurfaceNoDataMessage({
        provider,
        result,
        isAutoMode: selection.isAutoMode,
        activeProviderCount: active.length,
      })
    ) {
      errors.push({
        label: getQuotaProviderDisplayLabel(provider.id),
        message: getExplicitNoDataMessage(provider),
      });
      if (!selection.isAutoMode) {
        hasExplicitProviderIssues = true;
      }
    }
  }

  if (params.surfaceExplicitProviderIssues && !selection.isAutoMode) {
    const filteredIds = new Set(selection.filtered.map((provider) => provider.id));
    const activeIds = new Set(active.map((provider) => provider.id));
    const availabilityById = new Map(
      availability.map((item) => [item.provider.id, item.ok] as const),
    );

    for (const provider of selection.providers) {
      if (activeIds.has(provider.id)) continue;

      if (!filteredIds.has(provider.id)) {
        const detail =
          params.config.onlyCurrentModel && selection.currentModel
            ? `current model: ${selection.currentModel}`
            : "filtered";
        errors.push({
          label: getQuotaProviderDisplayLabel(provider.id),
          message: `Skipped (${detail})`,
        });
        hasExplicitProviderIssues = true;
        continue;
      }

      if (availabilityById.get(provider.id) === false) {
        errors.push({
          label: getQuotaProviderDisplayLabel(provider.id),
          message: "Unavailable (not detected)",
        });
        hasExplicitProviderIssues = true;
      }
    }
  }

  let sessionTokens: SessionTokensData | undefined;
  let sessionTokenError: SessionTokenError | undefined;
  if (params.config.showSessionTokens && params.request?.sessionID) {
    const sessionTokenResult = await fetchSessionTokensForDisplay({
      enabled: params.config.showSessionTokens,
      sessionID: params.request.sessionID,
    });
    sessionTokens = sessionTokenResult.sessionTokens;
    sessionTokenError = sessionTokenResult.error;
  }

  const data =
    entries.length === 0 && errors.length === 0 && !sessionTokens
      ? null
      : { entries, errors, sessionTokens };

  return {
    selection,
    availability,
    active,
    attemptedAny,
    hasExplicitProviderIssues,
    data,
    sessionTokenError,
  };
}
