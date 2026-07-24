import type { LoadConfigMeta } from "./config.js";
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
import { getQuotaProviderDisplayLabel, normalizeQuotaProviderId } from "./provider-metadata.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { fetchQuotaProviderResult } from "./quota-state.js";
import { createQuotaProviderRuntimeContext } from "./quota-runtime-context.js";
import {
  createRuntimeProviderIdResolver,
  type RuntimeProviderIdResolver,
} from "./runtime-provider-ids.js";
import { DEFAULT_QUOTA_FORMAT_STYLE, getQuotaFormatStyleDefinition } from "./quota-format-style.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { getProviders } from "../providers/registry.js";
import { getAnthropicNoDataMessage } from "../providers/anthropic.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";

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
  if (params.currentModel) {
    return params.provider.matchesCurrentModel
      ? params.provider.matchesCurrentModel(params.currentModel, {
          enabledProviders: params.enabledProviders ?? "auto",
          ...(params.quotaProviders ? { quotaProviders: params.quotaProviders } : {}),
          ...(params.currentProviderID ? { currentProviderID: params.currentProviderID } : {}),
        })
      : true;
  }

  if (!params.currentProviderID) return false;

  if (params.provider.id === "quota-providers") {
    return Boolean(
      params.quotaProviders?.some(
        (source) => source.providerId === params.currentProviderID && source.modelIds === undefined,
      ),
    );
  }

  const normalizedCurrentProviderID = normalizeQuotaProviderId(params.currentProviderID);
  if (params.provider.id === normalizedCurrentProviderID) {
    return true;
  }
  return params.provider.id === "cursor" && isCursorProviderId(params.currentProviderID);
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

function stripSingleWindowEntryMeta(entry: QuotaToastEntry, showRight: boolean): QuotaToastEntry {
  const { group: _group, label: _label, ...withoutGroupLabel } = entry;
  if (showRight) {
    return { ...withoutGroupLabel };
  }

  const { right: _right, ...withoutRight } = withoutGroupLabel;
  return { ...withoutRight };
}

const SINGLE_WINDOW_PROJECTION_LABELS: Readonly<Record<QuotaWindowKind, string>> = {
  rpm: "RPM",
  five_hour: "5h",
  hour: "Hourly",
  week: "Weekly",
  day: "Daily",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

export function normalizeSingleWindowWindowLabel(value?: string): string | null {
  const kind = classifyQuotaWindowText(value ?? "");
  return kind ? SINGLE_WINDOW_PROJECTION_LABELS[kind] : null;
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
  const classicStrategy =
    legacyPresentation.classicStrategy === "preserve"
      ? legacyPresentation.classicStrategy
      : undefined;

  return {
    ...(singleWindowDisplayName ? { singleWindowDisplayName } : {}),
    ...(singleWindowShowRight ? { singleWindowShowRight } : {}),
    ...(classicStrategy ? { classicStrategy } : {}),
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

function selectSingleWindowEntries(entries: QuotaToastEntry[]): QuotaToastEntry[] {
  if (!entries.some((entry) => entry.accounting.sourceId !== undefined)) {
    const selected = selectSingleWindowEntry(entries);
    return selected ? [selected] : [];
  }

  const entriesBySource = new Map<string | undefined, QuotaToastEntry[]>();
  for (const entry of entries) {
    const sourceEntries = entriesBySource.get(entry.accounting.sourceId) ?? [];
    sourceEntries.push(entry);
    entriesBySource.set(entry.accounting.sourceId, sourceEntries);
  }

  return [...entriesBySource.values()].flatMap((sourceEntries) => {
    const selected = selectSingleWindowEntry(sourceEntries);
    return selected ? [selected] : [];
  });
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
  if (presentation?.classicStrategy === "preserve") {
    return entries.map((entry) => {
      const nameEntry = { ...entry, group: undefined };
      return renameSingleWindowEntry(
        stripSingleWindowEntryMeta(entry, presentation?.singleWindowShowRight ?? false),
        buildSingleWindowName({
          entry: nameEntry,
          singleWindowDisplayName: presentation.singleWindowDisplayName ?? entry.name,
        }),
      );
    });
  }
  return selectSingleWindowEntries(entries).map((selectedEntry) =>
    renameSingleWindowEntry(
      stripSingleWindowEntryMeta(selectedEntry, presentation?.singleWindowShowRight ?? false),
      buildSingleWindowName({
        entry: selectedEntry,
        singleWindowDisplayName: presentation?.singleWindowDisplayName,
      }),
    ),
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

function projectProviderResultsToStyle(
  results: QuotaProviderResult[],
  style: QuotaFormatStyle,
): QuotaToastEntry[] {
  return results.flatMap((result) => projectProviderResultToStyle(result, style));
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
  const entries = projectProviderResultsToStyle(results, style);
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
      style === "allWindows" ? entries : projectProviderResultsToStyle(results, "allWindows");
    allWindowsData = packageQuotaRenderData({
      entries: allWindowsEntries,
      errors: [...errors],
      sessionTokens,
    });

    if (style === "allWindows") {
      singleWindowData = packageQuotaRenderData({
        entries: projectProviderResultsToStyle(results, "singleWindow"),
        errors: [...errors],
        sessionTokens,
      });
    }
  }

  return {
    selection,
    availability,
    active,
    attemptedAny,
    hasExplicitProviderIssues,
    data,
    allWindowsData,
    singleWindowData,
    sessionTokenError,
  };
}
