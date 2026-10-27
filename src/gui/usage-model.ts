/**
 * What the usage window's Cost and Tokens views show, from a `UsageReport`: the question to ask
 * for the chosen range and sessions, the big total, the provider lines with their shares, the
 * daily chart split by provider, the totals by token kind, the "by type" bar, and the breakdown
 * by model, provider or day. Pure.
 *
 * With a provider picked, every number is that provider's: its models' tokens and cost, with
 * shares of its own total. The report's cache savings cover every provider, so they show only
 * without a pick. A provider's color is its place in the report's providers, so it keeps its
 * color whatever the pick.
 */
import type { UsageRange } from "../core/usage-ranges.js";
import type { UsageByType, UsageModelRow, UsageQuery, UsageReport } from "../core/usage.js";
import { parseCalendarDate } from "../lib/calendar-date.js";
import { type CacheHit, cacheHit } from "../view/format.js";
import { breakdownModels, usageProviderName } from "../view/usage.js";

export type UsageMode = "cost" | "tokens";
/** Which sessions count: all of them, the session on screen, or it with its subagents. */
export type UsageScope = "all" | "session" | "tree";
export type UsageBreakdown = "model" | "provider" | "day";
/** The ranges the window offers, in order ("session" is a scope here). */
export type WindowRange = Exclude<UsageRange, "session">;

export const WINDOW_RANGES: readonly WindowRange[] = [
  "today",
  "24h",
  "7d",
  "30d",
  "90d",
  "all",
  "between",
];

/** How many series colors the window has; later providers share the last ("other") one. */
export const SERIES_COLORS = 6;

export type UsageChoice = {
  range: WindowRange;
  scope: UsageScope;
  /** The session on screen, for the session scopes. */
  sessionID?: string;
  /** Local dates like "2026-10-01", for "between". */
  from: string;
  to: string;
};

/**
 * The question for `choice`; undefined when it can't be asked: a session scope without a session,
 * or "between" without two dates in order. A session scope counts the whole session.
 */
export function usageQuery(choice: UsageChoice): UsageQuery | undefined {
  if (choice.scope !== "all") {
    if (!choice.sessionID) return undefined;
    const query: UsageQuery = { range: "session", sessionID: choice.sessionID };
    return choice.scope === "session" ? { ...query, subagents: false } : query;
  }
  if (choice.range !== "between") return { range: choice.range };
  const { from, to } = choice;
  if (!parseCalendarDate(from) || !parseCalendarDate(to) || to < from) return undefined;
  return { range: "between", from, to };
}

export type ProviderLine = {
  providerID: string;
  name: string;
  /** Its series color, 0 to `SERIES_COLORS` - 1. */
  color: number;
  costUsd: number;
  tokens: number;
  /** Its share of the view's total in the mode. */
  share: number;
  sessions: number;
  /** Its processed tokens of models without a price. */
  unpricedTokens: number;
};

export type TokenTotals = {
  processed: number;
  cachedInput: number;
  uncachedInput: number;
  output: number;
};

export type ChartSeries = { providerID: string; name: string; color: number; values: number[] };

/** A stacked chart: one value per day for each series, first series at the bottom. */
export type ChartData = { dates: string[]; series: ChartSeries[] };

export type UsageView = {
  mode: UsageMode;
  /** The big number: cost or processed tokens. */
  total: number;
  costUsd: number;
  sessions: number;
  providers: ProviderLine[];
  tokens: TokenTotals;
  byType: UsageByType;
  /** Undefined with a provider picked (the report's savings cover every provider). */
  cacheSavingsUsd?: number;
  /** The share of processed tokens without a price. */
  unpricedShare: number;
  chart: ChartData;
};

export type BreakdownRow = {
  /** The model's key ("provider\nmodel") for a model row, which opens its details. */
  key: string;
  name: string;
  /** Its series color, for model and provider rows. */
  color?: number;
  /** Cost or tokens, as the mode counts. */
  value: number;
  costUsd: number;
  tokens: number;
  share: number;
  /** False when all its tokens come from models without a price. */
  priced: boolean;
  /** Model rows only. */
  cache?: CacheHit;
};

const TYPES = ["input", "cacheRead", "cacheWrite", "output"] as const;

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function emptyByType(): UsageByType {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function sumByType(rows: readonly UsageByType[]): UsageByType {
  const sum = emptyByType();
  for (const row of rows) for (const type of TYPES) sum[type] += row[type];
  return sum;
}

/** A model's key: unique in a report. */
export function modelKey(model: Pick<UsageModelRow, "providerID" | "modelID">): string {
  return `${model.providerID}\n${model.modelID}`;
}

/** Each provider's series color, by its place in the report. */
export function providerColors(report: UsageReport): Map<string, number> {
  return new Map(
    report.providers.map((row, index) => [row.providerID, Math.min(index, SERIES_COLORS - 1)]),
  );
}

/** The providers the views can filter by, in the report's order: [id, name]. */
export function usageProviders(report: UsageReport): Array<[string, string]> {
  return report.providers.map((row) => [
    row.providerID,
    usageProviderName(row.providerID, report.providerNames),
  ]);
}

function modelsOf(report: UsageReport, providerID: string | undefined): UsageModelRow[] {
  return report.models.filter((row) => providerID === undefined || row.providerID === providerID);
}

/** The day-by-day values of `models` over the report's days. */
function dailyValues(report: UsageReport, models: UsageModelRow[], mode: UsageMode): number[] {
  const byDate = new Map<string, number>();
  for (const model of models) {
    for (const day of model.days) {
      const value = mode === "cost" ? day.costUsd : day.tokens;
      byDate.set(day.date, (byDate.get(day.date) ?? 0) + value);
    }
  }
  return report.days.map((day) => byDate.get(day.date) ?? 0);
}

/** The chart of `models`, one series per provider, the biggest at the bottom. */
export function chartOf(report: UsageReport, models: UsageModelRow[], mode: UsageMode): ChartData {
  const colors = providerColors(report);
  const series = report.providers
    .map((row) => row.providerID)
    .filter((id) => models.some((model) => model.providerID === id))
    .map((id) => ({
      providerID: id,
      name: usageProviderName(id, report.providerNames),
      color: colors.get(id) ?? SERIES_COLORS - 1,
      values: dailyValues(
        report,
        models.filter((model) => model.providerID === id),
        mode,
      ),
    }));
  return { dates: report.days.map((day) => day.date), series };
}

/** The view of `report` in `mode`; with `providerID`, of that provider only. */
export function usageView(
  report: UsageReport,
  mode: UsageMode,
  providerID: string | undefined,
): UsageView {
  const models = modelsOf(report, providerID);
  const colors = providerColors(report);
  const tokensByType = sumByType(models.map((model) => model.tokensByType));
  const costByType = sumByType(models.map((model) => model.costByType));
  const costUsd = models.reduce((sum, model) => sum + model.costUsd, 0);
  const processed = models.reduce((sum, model) => sum + model.tokens, 0);
  const unpriced = models.reduce((sum, model) => sum + model.unpricedTokens, 0);
  const total = mode === "cost" ? costUsd : processed;
  const picked = report.providers.filter(
    (row) => providerID === undefined || row.providerID === providerID,
  );
  // The report lists most cost first; in tokens, most tokens first.
  const rows = mode === "cost" ? picked : [...picked].sort((a, b) => b.tokens - a.tokens);
  return {
    mode,
    total,
    costUsd,
    sessions: providerID === undefined ? report.totals.sessions : (rows[0]?.sessions ?? 0),
    providers: rows.map((row) => ({
      providerID: row.providerID,
      name: usageProviderName(row.providerID, report.providerNames),
      color: colors.get(row.providerID) ?? SERIES_COLORS - 1,
      costUsd: row.costUsd,
      tokens: row.tokens,
      share: share(mode === "cost" ? row.costUsd : row.tokens, total),
      sessions: row.sessions,
      unpricedTokens: row.unpricedTokens,
    })),
    tokens: {
      processed,
      cachedInput: tokensByType.cacheRead,
      uncachedInput: tokensByType.input + tokensByType.cacheWrite,
      output: tokensByType.output,
    },
    byType: mode === "cost" ? costByType : tokensByType,
    ...(providerID === undefined ? { cacheSavingsUsd: report.totals.cacheSavingsUsd } : {}),
    unpricedShare: share(unpriced, processed),
    chart: chartOf(report, models, mode),
  };
}

/** A model's name, with its provider when more than one provider serves that model id. */
function modelName(report: UsageReport, model: UsageModelRow): string {
  const providers = report.models.filter((row) => row.modelID === model.modelID).length;
  return providers > 1 ? `${model.providerID}/${model.modelID}` : model.modelID;
}

/**
 * The breakdown's rows: models and providers most first in the mode, days newest first and
 * only those with tokens. Shares are of the view's total.
 */
export function breakdownRows(
  report: UsageReport,
  mode: UsageMode,
  by: UsageBreakdown,
  providerID: string | undefined,
): BreakdownRow[] {
  const view = usageView(report, mode, providerID);
  const valueOf = (row: { costUsd: number; tokens: number }) =>
    mode === "cost" ? row.costUsd : row.tokens;
  if (by === "model") {
    const colors = providerColors(report);
    return breakdownModels(report, mode)
      .filter((model) => providerID === undefined || model.providerID === providerID)
      .map((model) => {
        const cache = cacheHit(model.tokensByType);
        return {
          key: modelKey(model),
          name: modelName(report, model),
          color: colors.get(model.providerID) ?? SERIES_COLORS - 1,
          value: valueOf(model),
          costUsd: model.costUsd,
          tokens: model.tokens,
          share: share(valueOf(model), view.total),
          priced: model.priced,
          ...(cache ? { cache } : {}),
        };
      });
  }
  if (by === "provider") {
    return view.providers.map((row) => ({
      key: row.providerID,
      name: row.name,
      color: row.color,
      value: valueOf(row),
      costUsd: row.costUsd,
      tokens: row.tokens,
      share: row.share,
      priced: !(row.tokens > 0 && row.unpricedTokens >= row.tokens),
    }));
  }
  const models = modelsOf(report, providerID);
  const costs = dailyValues(report, models, "cost");
  const tokens = dailyValues(report, models, "tokens");
  // A day is priced when a model used tokens with a price on it.
  const pricedDates = new Set(
    models.flatMap((model) =>
      model.days.filter((day) => day.priced && day.tokens > 0).map((day) => day.date),
    ),
  );
  return report.days
    .map((day, index) => {
      const row = { costUsd: costs[index] ?? 0, tokens: tokens[index] ?? 0 };
      return {
        key: day.date,
        name: day.date,
        value: valueOf(row),
        ...row,
        share: share(valueOf(row), view.total),
        priced: pricedDates.has(day.date),
      };
    })
    .filter((row) => row.tokens > 0)
    .reverse();
}

export type ModelDetail = {
  model: UsageModelRow;
  name: string;
  providerName: string;
  color: number;
  /** Its share of the view's total in the mode (the provider's, with one picked). */
  share: number;
  /** Cost per million processed tokens; undefined without a price or tokens. */
  perMillionUsd?: number;
  cache?: CacheHit;
  chart: ChartData;
};

/** The model popup's numbers for the model with `key`; undefined when the report lacks it. */
export function modelDetail(
  report: UsageReport,
  mode: UsageMode,
  key: string,
  providerID: string | undefined,
): ModelDetail | undefined {
  const model = report.models.find((row) => modelKey(row) === key);
  if (!model) return undefined;
  const view = usageView(report, mode, providerID);
  const cache = cacheHit(model.tokensByType);
  return {
    model,
    name: modelName(report, model),
    providerName: usageProviderName(model.providerID, report.providerNames),
    color: providerColors(report).get(model.providerID) ?? SERIES_COLORS - 1,
    share: share(mode === "cost" ? model.costUsd : model.tokens, view.total),
    ...(model.priced && model.tokens > 0
      ? { perMillionUsd: (model.costUsd / model.tokens) * 1_000_000 }
      : {}),
    ...(cache ? { cache } : {}),
    chart: chartOf(report, [model], mode),
  };
}

/** The top of a chart's value axis: the smallest 1, 2 or 5 times a power of ten at or above `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = max / power;
  const nice = step <= 1 ? 1 : step <= 2 ? 2 : step <= 5 ? 5 : 10;
  return nice * power;
}

/** The highest stacked total of any day. */
export function chartMax(chart: ChartData): number {
  return Math.max(
    0,
    ...chart.dates.map((_, index) =>
      chart.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
    ),
  );
}

/** The by-type parts as shares of their sum, in the order input, cache read, cache write, output. */
export function typeShares(
  byType: UsageByType,
): Array<{ type: (typeof TYPES)[number]; value: number; share: number }> {
  const sum = TYPES.reduce((total, type) => total + byType[type], 0);
  return TYPES.map((type) => ({ type, value: byType[type], share: share(byType[type], sum) }));
}
