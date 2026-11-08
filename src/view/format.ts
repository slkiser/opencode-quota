/**
 * Words and numbers every quota and usage surface shows: percents, reset times, bars, amounts,
 * money, token and request counts, and shares. Pure functions, shared by the TUI, the Web text and
 * the CLI.
 * Locale-aware money, token and request counts, shares and dates use the selected interface language.
 */
import type { Pace } from "../core/pace.js";
import type { Amount, QuotaRow, SessionTokens, Words } from "../core/types.js";
import { intlLocale, resolveUiLocale, translate } from "../i18n.js";
import type { Settings } from "../settings/schema.js";
import { columnsOf, padEndColumns, sliceColumns } from "./columns.js";

function intl(locale: string): string {
  return intlLocale(resolveUiLocale(locale, locale));
}

function uiWord(locale: string, key: string): string {
  return translate(resolveUiLocale(locale, locale), key);
}

/** "$1,234.56", "$0.00", and "<$0.01" for an amount above 0 that would show as $0.00. */
export function formatUsd(usd: number, locale = "en-US"): string {
  const format = new Intl.NumberFormat(intl(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const text = format.format(usd);
  return usd > 0 && text === format.format(0) ? `<${format.format(0.01)}` : text;
}

/** Whole below 1,000, then always three significant digits: "950", "12.3K", "8.00M", "13.4B". */
export function formatTokens(count: number, locale = "en-US"): string {
  const whole = Math.round(count);
  return whole < 1000
    ? new Intl.NumberFormat(intl(locale), { maximumFractionDigits: 0 }).format(whole)
    : new Intl.NumberFormat(intl(locale), {
        notation: "compact",
        minimumSignificantDigits: 3,
        maximumSignificantDigits: 3,
      }).format(whole);
}

/** A rounded, grouped integer count (never compacted like a token amount). */
export function formatCount(count: number, locale = "en-US"): string {
  return new Intl.NumberFormat(intl(locale), { maximumFractionDigits: 0 }).format(
    Math.round(count),
  );
}

/** A 0..1 share with one decimal: "92.5%", "5.0%", "100.0%"; "<0.1%" above 0; "0%" for 0. */
export function formatShare(share: number, locale = "en-US"): string {
  const format = new Intl.NumberFormat(intl(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (share === 0) return new Intl.NumberFormat(intl(locale), { style: "percent" }).format(0);
  const text = format.format(share);
  return share > 0 && text === format.format(0) ? `<${format.format(0.001)}` : text;
}

/** The words until the server sends its own (docs/v6-build.local.md §5). */
export const DEFAULT_WORDS: Words = {
  percent: "left",
  reset: "smart",
  resetDecimals: 1,
  rowNames: "short",
  detail: "summary",
  onlyCurrentModel: false,
  sessionTokens: "current",
};

/** The word after a percent ("left", "used", or "" for the bare style). */
export function percentWord(words: Words, locale = "en-US"): string {
  if (words.percent === "bare") return "";
  if (words.percent === "used") return uiWord(locale, "format.used");
  return uiWord(locale, words.percent === "remaining" ? "format.remaining" : "format.left");
}

/** A raw percent left as a whole number from 0 to 100. */
function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * The share every surface shows: the percent left as the row has it, or the percent used when
 * `words.percent` is "used". Bars, marks and percents read it, so the number and the bar agree.
 */
export function shownPercent(words: Words, percentRemaining: number): number {
  const left = clampPercent(percentRemaining);
  return words.percent === "used" ? 100 - left : left;
}

/**
 * Where a row's even-use mark sits on its bar, in percent from the left: as the row has it, or
 * turned around when `words.percent` is "used", so the mark reads like the bar's fill.
 */
export function shownEvenLeft(words: Words, evenLeft: number): number {
  return words.percent === "used" ? 100 - evenLeft : evenLeft;
}

/** "58% left", "42% used", or "58%" without the word. */
export function percentText(
  words: Words,
  percentRemaining: number,
  withWord: boolean,
  locale = "en-US",
): string {
  const value = shownPercent(words, percentRemaining);
  const number = new Intl.NumberFormat(intl(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);
  const suffix = withWord ? percentWord(words, locale) : "";
  return suffix ? `${number} ${suffix}` : number;
}

/** The reset styles that are a time alone: every one but "percent", which adds the window's time share. */
export type DurationStyle = Exclude<Words["reset"], "percent">;

/**
 * docs/v6-plan.local.md §4.7. Zero units are dropped in every style; the past is "now".
 * "smart" rounds to the nearest: a day or more in days with one decimal ("4.5d"), from 12 hours
 * in whole hours ("23h"), below that like "exact" ("11h 35m"). A time that rounds to 24 hours
 * is "1.0d".
 */
export function formatDuration(
  ms: number,
  style: DurationStyle,
  decimals: number,
  locale = "en-US",
): string {
  if (!(ms > 0)) return uiWord(locale, "format.now");
  const chinese = resolveUiLocale(locale, locale) === "zh-Hans";
  const units = chinese
    ? { day: "天", hour: "小时", minute: "分钟" }
    : { day: "d", hour: "h", minute: "m" };
  const decimal = (value: number) =>
    new Intl.NumberFormat(intl(locale), {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  const minutes = Math.ceil(ms / 60_000);
  if (style === "smart" && minutes >= 720) {
    const hours = Math.round(minutes / 60);
    return hours < 24
      ? `${hours}${units.hour}`
      : `${decimal(Math.round(minutes / 144) / 10)}${units.day}`;
  }
  if (style === "decimal") {
    return minutes >= 1440
      ? `${decimal(minutes / 1440)}${units.day}`
      : `${decimal(minutes / 60)}${units.hour}`;
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  let parts = [
    days && `${days}${units.day}`,
    hours && `${hours}${units.hour}`,
    rest && `${rest}${units.minute}`,
  ].filter((part): part is string => Boolean(part));
  if (style === "short") parts = parts.slice(0, days ? 2 : 1);
  return parts.join(chinese || style === "compact" ? "" : " ");
}

/** A time in its largest unit ("28d", "2h", "40m"); "now" for the past. The "percent" reset style uses it. */
export function largestUnit(ms: number, locale = "en-US"): string {
  if (!(ms > 0)) return uiWord(locale, "format.now");
  const minutes = Math.ceil(ms / 60_000);
  const chinese = resolveUiLocale(locale, locale) === "zh-Hans";
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}${chinese ? "天" : "d"}`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}${chinese ? "小时" : "h"}`;
  return `${minutes}${chinese ? "分钟" : "m"}`;
}

export type BarShape = Settings["layout"]["bar"];

const BAR_CHARACTERS: Record<Exclude<BarShape, "none">, [string, string]> = {
  blocks: ["█", "░"],
  shades: ["▓", "░"],
  line: ["━", "─"],
  squares: ["■", "□"],
  dots: ["●", "○"],
};

/** A bar in two parts (filled, empty), so each can have its own color; `percentRemaining` is the share the bar shows. */
export function barParts(
  shape: BarShape,
  percentRemaining: number,
  width: number,
): [string, string] {
  if (shape === "none" || width <= 0) return ["", ""];
  const [full, empty] = BAR_CHARACTERS[shape];
  const filled = Math.round((clampPercent(percentRemaining) / 100) * width);
  return [full.repeat(filled), empty.repeat(width - filled)];
}

/**
 * The cell of a bar `width` cells wide where even use would be (the ┃ even-use mark): `evenLeft` is the
 * percent even use leaves now (`core/pace.ts`).
 */
export function evenUseCell(evenLeft: number, width: number): number {
  return Math.max(0, Math.min(width - 1, Math.round((evenLeft / 100) * width)));
}

export type Level = "good" | "warning" | "low";
export type Thresholds = { warningBelow: number; lowBelow: number };

/** Plenty left, getting low, or almost out; "almost out" wins where both would. */
export function levelOf(percentRemaining: number, thresholds: Thresholds): Level {
  const left = clampPercent(percentRemaining);
  if (left < thresholds.lowBelow) return "low";
  return left < thresholds.warningBelow ? "warning" : "good";
}

/**
 * The level for a pace: "good" at or under even use, "warning" up to 5 points faster, "low"
 * faster than that. At a window's start even use leaves about 100%, so an untouched limit is
 * on track; it reads as good, not as a warning. Before a tenth of the window has passed, one
 * burst of use reads as fast, so a fast pace gives no level and the row keeps the share-left
 * colors: a nearly used-up limit is still "low" then.
 */
export function paceLevel(pace: Pace, percentRemaining: number): Level | undefined {
  if (pace.kind === "spare") return "good";
  if (pace.kind === "on_track") {
    return clampPercent(percentRemaining) >= pace.evenLeft ? "good" : "warning";
  }
  return pace.early ? undefined : "low";
}

/**
 * The level a row's bar shows: with `levelBy` "pace", its level by pace when it has one; else
 * the level of its percent left.
 */
export function barLevel(
  colors: Thresholds & { levelBy: Settings["colors"]["levelBy"] },
  percentRemaining: number,
  paceLevel?: Level,
): Level {
  return colors.levelBy === "pace" && paceLevel ? paceLevel : levelOf(percentRemaining, colors);
}

function groupDigits(integer: string, locale: string): string {
  const separator =
    new Intl.NumberFormat(intl(locale)).formatToParts(1000).find((part) => part.type === "group")
      ?.value ?? ",";
  return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
}

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(intl(locale)).formatToParts(1.1).find((part) => part.type === "decimal")
      ?.value ?? "."
  );
}

/**
 * "$12.40", "12.40 EUR", "1 request", "1,200 requests", "30 nano". A count unit is one word
 * ("request"); it is plural for every number but 1, and the plain "unit" is not shown.
 */
export function amountText(amount: Amount, locale = "en-US"): string {
  const { unit } = amount;
  if (unit.kind === "currency") {
    const value = Number(amount.decimal);
    const [integer = "0", cents = "00"] = Math.abs(value).toFixed(2).split(".");
    const money = `${groupDigits(integer, locale)}${decimalSeparator(locale)}${cents}`;
    if (unit.code === "USD") {
      return new Intl.NumberFormat(intl(locale), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    }
    const sign = value < 0 ? "-" : "";
    return resolveUiLocale(locale, locale) === "en"
      ? `${sign}${money} ${unit.code}`
      : `${sign}${unit.code} ${money}`;
  }
  const [integer = "0", fraction] = amount.decimal.replace(/^-/u, "").split(".");
  const sign = amount.decimal.startsWith("-") ? "-" : "";
  const number = `${sign}${groupDigits(integer, locale)}${fraction ? `${decimalSeparator(locale)}${fraction}` : ""}`;
  if (unit.kind === "custom") return `${number} ${unit.symbol}`;
  if (unit.unit === "unit") return number;
  const singular = new Intl.PluralRules(intl(locale)).select(Number(amount.decimal)) === "one";
  return `${number} ${singular || resolveUiLocale(locale, locale) === "zh-Hans" ? unit.unit : `${unit.unit}s`}`;
}

/** The value of a row without a percent: its text, amount, used/limit, or yes/no. */
export function rowValueText(row: QuotaRow, locale = "en-US"): string {
  if (row.text !== undefined) return row.text;
  if (row.amount) {
    const amount = amountText(row.amount, locale);
    if (row.type === "balance") return `${amount} ${uiWord(locale, "format.left")}`;
    return row.type === "usage" ? `${amount} ${uiWord(locale, "format.used")}` : amount;
  }
  if (row.remaining) return `${amountText(row.remaining, locale)} ${uiWord(locale, "format.left")}`;
  if (row.used && row.limit)
    return `${amountText(row.used, locale)}/${amountText(row.limit, locale)}`;
  if (row.used) return `${amountText(row.used, locale)} ${uiWord(locale, "format.used")}`;
  if (row.flag !== undefined)
    return uiWord(locale, row.flag ? "format.enabled" : "format.disabled");
  return "";
}

/** "12.3K (1.20K) in · 2.10K out", with cached input only when it is non-zero. */
export function sessionTokensText(tokens: SessionTokens, locale = "en-US"): string {
  const cached = tokens.cachedInput > 0 ? ` (${formatTokens(tokens.cachedInput, locale)})` : "";
  return `${formatTokens(tokens.input, locale)}${cached} ${uiWord(locale, "format.in")} · ${formatTokens(tokens.output, locale)} ${uiWord(locale, "format.out")}`;
}

/** A model's cache hit can be low once it read this many input tokens. */
const LOW_CACHE_MIN_INPUT_TOKENS = 200_000;
/** A cache hit below this share is low. */
const LOW_CACHE_HIT_BELOW = 0.5;
export const LOW_CACHE_MARK = "⚠";

/** A model's input tokens by kind: new input, cache reads and cache writes. */
export type InputTokens = { input: number; cacheRead: number; cacheWrite: number };

/** The share of a model's input tokens read from the cache. */
export type CacheHit = {
  /** Cache reads ÷ all input tokens. */
  share: number;
  /** Whole percents, rounded down so a low cache hit never reads "50%": "35%". */
  text: string;
  /** At least 200K input tokens: enough to tell a good cache hit from a low one. */
  judged: boolean;
  /** Judged, and less than half of the input tokens read from the cache. */
  low: boolean;
};

/**
 * The cache hit of `tokens`; undefined without input tokens, or without cache reads and cache
 * writes (the provider reports no cache numbers).
 */
export function cacheHit(tokens: InputTokens, locale = "en-US"): CacheHit | undefined {
  const allInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (allInput <= 0 || tokens.cacheRead + tokens.cacheWrite <= 0) return undefined;
  const share = tokens.cacheRead / allInput;
  const judged = allInput >= LOW_CACHE_MIN_INPUT_TOKENS;
  return {
    share,
    text: new Intl.NumberFormat(intl(locale), {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(Math.floor((tokens.cacheRead * 100) / allInput) / 100),
    judged,
    low: judged && share < LOW_CACHE_HIT_BELOW,
  };
}

/**
 * `text` cut to `width` terminal columns with "…" ("Copilot…", not "Copilot …"), else padded
 * to it. Wide characters count two columns and are never split.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const cut = columnsOf(text) > width ? `${sliceColumns(text, width - 1).trimEnd()}…` : text;
  return padEndColumns(cut, width);
}
