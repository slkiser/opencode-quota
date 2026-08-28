import { getAnthropicNoDataMessage } from "../providers/anthropic.js";
import { getProviders } from "../providers/registry.js";
import type { LoadConfigMeta } from "./config.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
  SessionTokensData,
} from "./entries.js";
import { cloneQuotaToastEntry } from "./entries.js";
import {
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderShape,
} from "./provider-metadata.js";
import { projectQuotaProviderResults } from "./quota-accounting-projection.js";
import type { QuotaFormatStyle } from "./quota-format-style.js";
import { createQuotaProviderRuntimeContext } from "./quota-runtime-context.js";
import { fetchQuotaProviderResult } from "./quota-state.js";
import type { SessionTokenError } from "./quota-status.js";
import { retainQuotaTelemetryProviders } from "./quota-telemetry.js";
import {
  createRuntimeProviderIdResolver,
  type RuntimeProviderIdResolver,
} from "./runtime-provider-ids.js";
import { fetchSessionTokensForDisplay } from "./session-tokens.js";
import type { QuotaToastConfig } from "./types.js";

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

export type QuotaRenderSelection = {
  isAutoMode: boolean;
  providers: QuotaProvider[];
  filtered: QuotaProvider[];
  ctx: QuotaProviderContext;
  currentModel?: string;
  currentProviderID?: string;
  filteringByCurrentSelection: boolean;
  waitingForCurrentSelection: boolean;
};

export type QuotaAvailability = {
  provider: QuotaProvider;
  ok: boolean;
  error?: boolean;
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
      error: true,
    };
  }
}

export async function collectConcreteEnabledProviderIds(params: {
  providers: QuotaProvider[];
  ctx: QuotaProviderContext;
  enabledProviders: string[] | "auto";
}): Promise<string[]> {
  const candidates =
    params.enabledProviders === "auto"
      ? params.providers
      : params.providers.filter((provider) => params.enabledProviders.includes(provider.id));

  const availability = await Promise.all(
    candidates.map((provider) => getProviderAvailability({ provider, ctx: params.ctx })),
  );

  return availability.filter((item) => item.ok).map((item) => item.provider.id);
}

export type CollectQuotaRenderDataResult = {
  selection: QuotaRenderSelection | null;
  availability: QuotaAvailability[];
  active: QuotaProvider[];
  /** Unprojected provider results for stateful observers such as reset detection. */
  providerResults: QuotaStatusLiveProbe[];
  attemptedAny: boolean;
  hasExplicitProviderIssues: boolean;
  data: QuotaRenderData | null;
  allWindowsData?: QuotaRenderData | null;
  /** Pre-computed singleWindow-projected data. Only present when includeAllWindowsData=true and root style is allWindows. */
  singleWindowData?: QuotaRenderData | null;
  sessionTokenError?: SessionTokenError;
};

export type QuotaStatusLiveProbe = {
  providerId: string;
  result: QuotaProviderResult;
};

export function matchesQuotaProviderCurrentSelection(params: {
  provider: QuotaProvider;
  currentModel?: string;
  currentProviderID?: string;
  enabledProviders?: string[] | "auto";
  quotaProviders?: QuotaToastConfig["quotaProviders"];
}): boolean {
  const matchesCurrentModel = (model: string): boolean =>
    params.provider.matchesCurrentModel
      ? params.provider.matchesCurrentModel(model, {
          enabledProviders: params.enabledProviders ?? "auto",
          ...(params.quotaProviders ? { quotaProviders: params.quotaProviders } : {}),
          ...(params.currentProviderID ? { currentProviderID: params.currentProviderID } : {}),
        })
      : true;

  if (params.provider.id === "quota-providers") {
    if (params.currentModel) return matchesCurrentModel(params.currentModel);
    if (!params.currentProviderID) return false;

    return Boolean(
      params.quotaProviders?.some(
        (source) => source.providerId === params.currentProviderID && source.modelIds === undefined,
      ),
    );
  }

  if (params.currentProviderID) {
    const explicitId = params.currentProviderID.trim().toLowerCase();
    const catalogShape = getQuotaProviderShape(explicitId);
    if (catalogShape?.id === explicitId) return params.provider.id === catalogShape.id;

    const runtimeCandidates = getQuotaProviderIdsForRuntimeId(explicitId);
    if (runtimeCandidates.length === 1) return params.provider.id === runtimeCandidates[0];
    if (runtimeCandidates.length > 1) {
      if (!runtimeCandidates.some((candidate) => candidate === params.provider.id)) {
        return false;
      }
      if (!params.currentModel || !params.provider.matchesCurrentModel) return false;

      const qualifiedModel = params.currentModel.toLowerCase().startsWith(`${explicitId}/`)
        ? params.currentModel
        : `${explicitId}/${params.currentModel}`;
      return matchesCurrentModel(qualifiedModel);
    }

    return false;
  }

  return params.currentModel ? matchesCurrentModel(params.currentModel) : false;
}

function hasCurrentQuotaSelection(params: {
  currentModel?: string;
  currentProviderID?: string;
}): boolean {
  return Boolean(params.currentModel || params.currentProviderID);
}

export async function resolveQuotaRenderSelection(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  request?: QuotaRequestContext;
  configMeta?: Pick<LoadConfigMeta, "settingSources">;
  providers?: QuotaProvider[];
  resolveRuntimeProviderIds?: RuntimeProviderIdResolver;
}): Promise<QuotaRenderSelection | null> {
  const { client, config, request } = params;
  let currentModel: string | undefined;
  let currentProviderID: string | undefined;
  if (config.onlyCurrentModel && request?.sessionMeta) {
    currentModel = request.sessionMeta.modelID;
    currentProviderID = request.sessionMeta.providerID;
  }

  const ctx = createQuotaProviderRuntimeContext({
    client,
    config,
    configMeta: params.configMeta,
    resolveRuntimeProviderIds:
      params.resolveRuntimeProviderIds ?? createRuntimeProviderIdResolver(client),
    session: {
      sessionMeta: {
        modelID: currentModel,
        providerID: currentProviderID,
      },
    },
  });
  if (!config.enabled) return null;

  const allProviders = params.providers ?? getProviders();
  const isAutoMode = config.enabledProviders === "auto";
  const providers = isAutoMode
    ? allProviders
    : allProviders.filter((provider) => config.enabledProviders.includes(provider.id));
  if (!isAutoMode && providers.length === 0) {
    retainQuotaTelemetryProviders({
      token: ctx.config.telemetryToken,
      providerIds: [],
    });
    return null;
  }

  const hasCurrentSelection = hasCurrentQuotaSelection({ currentModel, currentProviderID });
  const filteringByCurrentSelection = config.onlyCurrentModel && hasCurrentSelection;
  const waitingForCurrentSelection = config.onlyCurrentModel && !hasCurrentSelection;
  const filtered = filteringByCurrentSelection
    ? providers.filter((provider) =>
        matchesQuotaProviderCurrentSelection({
          provider,
          currentModel,
          currentProviderID,
          enabledProviders: config.enabledProviders,
          quotaProviders: config.quotaProviders,
        }),
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
    waitingForCurrentSelection,
  };
}

async function fetchProviderWithCache(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs } = params;

  return fetchQuotaProviderResult({
    provider,
    ctx,
    ttlMs,
    bypassCache: params.bypassCache,
  });
}

function makeProviderFetchFailure(provider: QuotaProvider): QuotaProviderResult {
  return {
    attempted: true,
    entries: [],
    errors: [
      {
        label: getQuotaProviderDisplayLabel(provider.id),
        message: "Failed to read quota data",
        retryable: true,
      },
    ],
  };
}

export async function fetchProviderResults(params: {
  providers: QuotaProvider[];
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult[]> {
  const settled = await Promise.allSettled(
    params.providers.map((provider) =>
      fetchProviderWithCache({
        provider,
        ctx: params.ctx,
        ttlMs: params.ttlMs,
        bypassCache: params.bypassCache,
      }),
    ),
  );

  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : makeProviderFetchFailure(params.providers[index]!),
  );
}

export async function collectQuotaStatusLiveProbes(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  request?: QuotaRequestContext;
  configMeta?: Pick<LoadConfigMeta, "settingSources">;
  providers: QuotaProvider[];
  resolveRuntimeProviderIds?: RuntimeProviderIdResolver;
}): Promise<QuotaStatusLiveProbe[]> {
  if (params.providers.length === 0) {
    return [];
  }

  let currentModel: string | undefined;
  let currentProviderID: string | undefined;
  if (params.config.onlyCurrentModel && params.request?.sessionMeta) {
    currentModel = params.request.sessionMeta.modelID;
    currentProviderID = params.request.sessionMeta.providerID;
  }

  const ctx = createQuotaProviderRuntimeContext({
    client: params.client,
    config: params.config,
    configMeta: params.configMeta,
    resolveRuntimeProviderIds:
      params.resolveRuntimeProviderIds ?? createRuntimeProviderIdResolver(params.client),
    session: {
      sessionMeta: {
        modelID: currentModel,
        providerID: currentProviderID,
      },
    },
  });

  const resultsByProviderId = new Map<string, Promise<QuotaProviderResult>>();
  const results = await Promise.all(
    params.providers.map((provider) => {
      let result = resultsByProviderId.get(provider.id);
      if (!result) {
        result = fetchProviderWithCache({
          provider,
          ctx,
          ttlMs: 0,
          bypassCache: true,
        }).catch(() => makeProviderFetchFailure(provider));
        resultsByProviderId.set(provider.id, result);
      }
      return result;
    }),
  );

  return params.providers.map((provider, index) => ({
    providerId: provider.id,
    result: {
      ...results[index]!,
      entries: results[index]!.entries.map(cloneQuotaToastEntry),
      errors: results[index]!.errors.map((error) => ({ ...error })),
      ...(results[index]!.statusDetails
        ? { statusDetails: results[index]!.statusDetails!.map((detail) => ({ ...detail })) }
        : {}),
      ...(results[index]!.rawDetails
        ? { rawDetails: results[index]!.rawDetails!.map((detail) => ({ ...detail })) }
        : {}),
      ...(results[index]!.presentation
        ? { presentation: { ...results[index]!.presentation } }
        : {}),
    },
  }));
}

function getExplicitNoDataMessage(provider: QuotaProvider): string {
  if (provider.id === "cursor") {
    return "No local usage yet";
  }
  if (provider.id === "anthropic") {
    return getAnthropicNoDataMessage();
  }
  if (provider.id === "opencode-go") {
    return "Not subscribed";
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
  if (result.notApplicable) {
    return false;
  }
  if (result.attempted || result.entries.length > 0 || result.errors.length > 0) {
    return false;
  }

  if (!isAutoMode) {
    return true;
  }

  return activeProviderCount === 1 && (provider.id === "anthropic" || provider.id === "cursor");
}

function buildExplicitProviderIssues(params: {
  selection: QuotaRenderSelection;
  availability: QuotaAvailability[];
  active: QuotaProvider[];
  enabled: boolean;
  onlyCurrentModel: boolean;
}): QuotaToastError[] {
  if (!params.enabled || params.selection.isAutoMode) return [];

  const filteredIds = new Set(params.selection.filtered.map((provider) => provider.id));
  const activeIds = new Set(params.active.map((provider) => provider.id));
  const availabilityById = new Map(
    params.availability.map((item) => [item.provider.id, item.ok] as const),
  );
  const errors: QuotaToastError[] = [];

  for (const provider of params.selection.providers) {
    if (activeIds.has(provider.id)) continue;

    if (!filteredIds.has(provider.id)) {
      const detail =
        params.onlyCurrentModel && params.selection.currentModel
          ? `current model: ${params.selection.currentModel}`
          : "filtered";
      errors.push({
        kind: "intentional-filter",
        label: getQuotaProviderDisplayLabel(provider.id),
        message: `Skipped (${detail})`,
      });
      continue;
    }

    if (availabilityById.get(provider.id) === false) {
      errors.push({
        label: getQuotaProviderDisplayLabel(provider.id),
        message: "Unavailable (not detected)",
      });
    }
  }

  return errors;
}

function packageQuotaRenderData(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
}): QuotaRenderData | null {
  if (params.entries.length === 0 && params.errors.length === 0 && !params.sessionTokens) {
    return null;
  }
  return {
    entries: params.entries,
    errors: params.errors,
    sessionTokens: params.sessionTokens,
  };
}

export async function collectQuotaRenderData(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  request?: QuotaRequestContext;
  surfaceExplicitProviderIssues: boolean;
  formatStyle?: QuotaFormatStyle;
  configMeta?: Pick<LoadConfigMeta, "settingSources">;
  bypassProviderCache?: boolean;
  providers?: QuotaProvider[];
  includeAllWindowsData?: boolean;
  resolveRuntimeProviderIds?: RuntimeProviderIdResolver;
}): Promise<CollectQuotaRenderDataResult> {
  const resolveRuntimeProviderIds =
    params.resolveRuntimeProviderIds ?? createRuntimeProviderIdResolver(params.client);
  const selection = await resolveQuotaRenderSelection({ ...params, resolveRuntimeProviderIds });
  if (!selection) {
    return {
      selection: null,
      availability: [],
      active: [],
      providerResults: [],
      attemptedAny: false,
      hasExplicitProviderIssues: false,
      data: null,
    };
  }

  if (selection.waitingForCurrentSelection) {
    retainQuotaTelemetryProviders({
      token: selection.ctx.config.telemetryToken,
      providerIds: [],
    });
    return {
      selection,
      availability: [],
      active: [],
      providerResults: [],
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
  retainQuotaTelemetryProviders({
    token: selection.ctx.config.telemetryToken,
    providerIds: active.map((provider) => provider.id),
  });
  const explicitProviderIssues = buildExplicitProviderIssues({
    selection,
    availability,
    active,
    enabled: params.surfaceExplicitProviderIssues,
    onlyCurrentModel: params.config.onlyCurrentModel,
  });
  if (active.length === 0) {
    return {
      selection,
      availability,
      active,
      providerResults: [],
      attemptedAny: false,
      hasExplicitProviderIssues: explicitProviderIssues.length > 0,
      data: packageQuotaRenderData({ entries: [], errors: explicitProviderIssues }),
    };
  }

  const results = await fetchProviderResults({
    providers: active,
    ctx: selection.ctx,
    ttlMs: params.config.minIntervalMs,
    bypassCache: params.bypassProviderCache,
  });

  const style = params.formatStyle ?? params.config.formatStyle;
  const entries = projectQuotaProviderResults(results, style, params.config.accountingDetail);
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
    } else if (provider && result?.notApplicable && params.config.showNotApplicableProviders) {
      errors.push({
        kind: "intentional-filter",
        label: getQuotaProviderDisplayLabel(provider.id),
        message: getExplicitNoDataMessage(provider),
      });
    }
  }

  errors.push(...explicitProviderIssues);
  hasExplicitProviderIssues ||= explicitProviderIssues.length > 0;

  let sessionTokens: SessionTokensData | undefined;
  let sessionTokenError: SessionTokenError | undefined;
  if (params.config.showSessionTokens && params.request?.sessionID) {
    const sessionTokenResult = await fetchSessionTokensForDisplay({
      enabled: params.config.showSessionTokens,
      sessionID: params.request.sessionID,
      scope: params.config.sessionTokenScope,
    });
    sessionTokens = sessionTokenResult.sessionTokens;
    sessionTokenError = sessionTokenResult.error;
  }

  const data = packageQuotaRenderData({ entries, errors, sessionTokens });

  let allWindowsData: QuotaRenderData | null | undefined;
  let singleWindowData: QuotaRenderData | null | undefined;
  if (params.includeAllWindowsData) {
    const allWindowsEntries =
      style === "allWindows"
        ? entries
        : projectQuotaProviderResults(results, "allWindows", params.config.accountingDetail);
    allWindowsData = packageQuotaRenderData({
      entries: allWindowsEntries,
      errors: [...errors],
      sessionTokens,
    });

    if (style === "allWindows") {
      singleWindowData = packageQuotaRenderData({
        entries: projectQuotaProviderResults(
          results,
          "singleWindow",
          params.config.accountingDetail,
        ),
        errors: [...errors],
        sessionTokens,
      });
    }
  }

  return {
    selection,
    availability,
    active,
    providerResults: active.map((provider, index) => ({
      providerId: provider.id,
      result: results[index]!,
    })),
    attemptedAny,
    hasExplicitProviderIssues,
    data,
    allWindowsData,
    singleWindowData,
    sessionTokenError,
  };
}
