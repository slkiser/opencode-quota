import type { QuotaToastConfig } from "./types.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderPresentation,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
  SessionTokensData,
} from "./entries.js";
import type { SessionTokenError } from "./quota-status.js";
import type { QuotaFormatStyle } from "./quota-format-style.js";

import { isPercentEntry } from "./entries.js";
import { fetchSessionTokensForDisplay } from "./session-tokens.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { fetchQuotaProviderResult } from "./quota-state.js";
import {
  DEFAULT_QUOTA_FORMAT_STYLE,
  getQuotaFormatStyleDefinition,
} from "./quota-format-style.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { getProviders } from "../providers/registry.js";
import { getAnthropicNoDataMessage } from "../providers/anthropic.js";

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

export type CollectQuotaRenderDataResult = {
  selection: QuotaRenderSelection | null;
  availability: QuotaAvailability[];
  active: QuotaProvider[];
  attemptedAny: boolean;
  hasExplicitProviderIssues: boolean;
  data: QuotaRenderData | null;
  sessionTokenError?: SessionTokenError;
};

export type QuotaStatusLiveProbe = {
  providerId: string;
  result: QuotaProviderResult;
};

function buildQuotaProviderContext(params: {
  client: QuotaProviderContext["client"];
  config: QuotaToastConfig;
  currentModel?: string;
  currentProviderID?: string;
}): QuotaProviderContext {
  const { client, config, currentModel, currentProviderID } = params;

  return {
    client,
    config: {
      googleModels: config.googleModels,
      anthropicBinaryPath: config.anthropicBinaryPath,
      alibabaCodingPlanTier: config.alibabaCodingPlanTier,
      cursorPlan: config.cursorPlan,
      cursorIncludedApiUsd: config.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
      opencodeGoWindows: config.opencodeGoWindows,
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
  if (!params.currentModel && params.currentProviderID) {
    if (params.provider.id === params.currentProviderID) {
      return true;
    }
    if (params.provider.id === "cursor" && isCursorProviderId(params.currentProviderID)) {
      return true;
    }
  }
  if (!params.currentModel) return false;
  return params.provider.matchesCurrentModel
    ? params.provider.matchesCurrentModel(params.currentModel)
    : true;
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
  providers?: QuotaProvider[];
}): Promise<QuotaRenderSelection | null> {
  const { client, config, request } = params;
  if (!config.enabled) return null;

  const allProviders = params.providers ?? getProviders();
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
  });

  const hasCurrentSelection = hasCurrentQuotaSelection({ currentModel, currentProviderID });
  const filteringByCurrentSelection = config.onlyCurrentModel && hasCurrentSelection;
  const waitingForCurrentSelection = config.onlyCurrentModel && !hasCurrentSelection;
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
  formatStyle?: QuotaFormatStyle;
  providers: QuotaProvider[];
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

  const ctx = buildQuotaProviderContext({
    client: params.client,
    config: params.config,
    currentModel,
    currentProviderID,
  });

  const results = await fetchProviderResults({
    providers: params.providers,
    ctx,
    ttlMs: 0,
    bypassCache: true,
  });

  return params.providers.map((provider, index) => ({
    providerId: provider.id,
    result: {
      ...results[index]!,
      entries: projectProviderResultToStyle(
        results[index]!,
        params.formatStyle ?? DEFAULT_QUOTA_FORMAT_STYLE,
      ),
      errors: results[index]!.errors.map((error) => ({ ...error })),
      ...(results[index]!.presentation
        ? { presentation: { ...results[index]!.presentation } }
        : {}),
    },
  }));
}

function stripSingleWindowEntryMeta(
  entry: QuotaToastEntry,
  showRight: boolean,
): QuotaToastEntry {
  const { group: _group, label: _label, ...withoutGroupLabel } = entry;
  if (showRight) {
    return { ...withoutGroupLabel };
  }

  const { right: _right, ...withoutRight } = withoutGroupLabel;
  return { ...withoutRight };
}

function normalizeSingleWindowWindowLabel(value?: string): string | null {
  const lower = value?.trim().replace(/:+$/u, "").trim().toLowerCase() ?? "";
  if (!lower) return null;

  if (/\b(?:rpm|per minute|minute|minutes)\b/u.test(lower)) return "RPM";
  if (/\b(?:rolling|5h|5 h|5-hour|5 hour|five-hour|five hour)\b/u.test(lower)) return "5h";
  if (/\b(?:hourly|1h|1 h|1-hour|1 hour|hour)\b/u.test(lower)) return "Hourly";
  if (/\b(?:7d|7 d|7-day|7 day|weekly|week)\b/u.test(lower)) return "Weekly";
  if (/\b(?:daily|1d|1 d|1-day|1 day|day)\b/u.test(lower)) return "Daily";
  if (/\b(?:monthly|month)\b/u.test(lower)) return "Monthly";
  if (/\b(?:yearly|annual|annually|year)\b/u.test(lower)) return "Yearly";
  if (/\bmcp\b/u.test(lower)) return "MCP";

  return null;
}

function buildSingleWindowName(params: {
  entry: QuotaToastEntry;
  singleWindowDisplayName?: string;
}): string {
  const providerText =
    params.entry.group?.trim() ||
    params.singleWindowDisplayName?.trim() ||
    params.entry.name.trim() ||
    "";
  const provider = formatGroupedHeader(providerText);
  const windowLabel =
    normalizeSingleWindowWindowLabel(params.entry.label) ??
    normalizeSingleWindowWindowLabel(params.entry.name);

  return windowLabel ? `${provider} ${windowLabel}` : provider;
}

function renameSingleWindowEntry(entry: QuotaToastEntry, name: string): QuotaToastEntry {
  return { ...entry, name };
}

type LegacyQuotaProviderPresentation = QuotaProviderPresentation & {
  classicDisplayName?: string;
  classicShowRight?: boolean;
};

function normalizeSingleWindowPresentation(
  presentation: QuotaProviderResult["presentation"],
): QuotaProviderPresentation | undefined {
  if (!presentation) {
    return undefined;
  }

  const legacyPresentation = presentation as LegacyQuotaProviderPresentation;
  const singleWindowDisplayName =
    typeof legacyPresentation.singleWindowDisplayName === "string"
      ? legacyPresentation.singleWindowDisplayName
      : typeof legacyPresentation.classicDisplayName === "string"
        ? legacyPresentation.classicDisplayName
        : undefined;
  const singleWindowShowRight =
    typeof legacyPresentation.singleWindowShowRight === "boolean"
      ? legacyPresentation.singleWindowShowRight
      : typeof legacyPresentation.classicShowRight === "boolean"
        ? legacyPresentation.classicShowRight
        : false;

  return {
    ...(singleWindowDisplayName ? { singleWindowDisplayName } : {}),
    ...(singleWindowShowRight ? { singleWindowShowRight } : {}),
  };
}

function selectSingleWindowEntry(entries: QuotaToastEntry[]): QuotaToastEntry | undefined {
  let selectedPercentEntry: Extract<QuotaToastEntry, { percentRemaining: number }> | undefined;

  for (const entry of entries) {
    if (!isPercentEntry(entry)) {
      continue;
    }

    if (!selectedPercentEntry || entry.percentRemaining < selectedPercentEntry.percentRemaining) {
      selectedPercentEntry = entry;
    }
  }

  return selectedPercentEntry ?? entries[0];
}

function projectProviderResultToStyle(
  result: QuotaProviderResult,
  style: QuotaFormatStyle,
): QuotaToastEntry[] {
  const entries = result.entries.map((entry) => ({ ...entry }));
  const definition = getQuotaFormatStyleDefinition(style);
  if (definition.projection === "allWindows") {
    return entries;
  }

  const presentation = normalizeSingleWindowPresentation(result.presentation);
  const selectedEntry = selectSingleWindowEntry(entries);
  if (!selectedEntry) {
    return [];
  }

  return [
    renameSingleWindowEntry(
      stripSingleWindowEntryMeta(selectedEntry, presentation?.singleWindowShowRight ?? false),
      buildSingleWindowName({
        entry: selectedEntry,
        singleWindowDisplayName: presentation?.singleWindowDisplayName,
      }),
    ),
  ];
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
  surfaceExplicitProviderIssues: boolean;
  formatStyle?: QuotaFormatStyle;
  bypassProviderCache?: boolean;
  providers?: QuotaProvider[];
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

  if (selection.waitingForCurrentSelection) {
    return {
      selection,
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
    bypassCache: params.bypassProviderCache,
  });

  const style = params.formatStyle ?? params.config.formatStyle;
  const entries = results.flatMap((result) =>
    projectProviderResultToStyle(result, style),
  ) as QuotaToastEntry[];
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
