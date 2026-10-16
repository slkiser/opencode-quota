/**
 * Words and numbers every quota and usage surface shows: percents, reset times, bars, amounts,
 * money, token counts and shares. Pure functions, shared by the TUI, the Web text and the CLI.
 * Money, token counts and shares are written the way T3 Code's usage page writes them, always
 * in US English, so the text is the same on every machine.
 */
import type { Amount, QuotaRow, SessionTokens, Words } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { columnsOf, padEndColumns, sliceColumns } from "./columns.js";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  minimumSignificantDigits: 3,
  maximumSignificantDigits: 3,
});

/** "$1,234.56", "$0.00", and "<$0.01" for an amount above 0 that would show as $0.00. */
export function formatUsd(usd: number): string {
  const text = USD.format(usd);
  return usd > 0 && text === "$0.00" ? "<$0.01" : text;
}

/** Whole below 1,000, then always three significant digits: "950", "12.3K", "8.00M", "13.4B". */
export function formatTokens(count: number): string {
  const whole = Math.round(count);
  return whole < 1000 ? String(whole) : COMPACT.format(whole);
}

/** A 0..1 share with one decimal: "92.5%", "5.0%", "100.0%"; "<0.1%" above 0; "0%" for 0. */
export function formatShare(share: number): string {
  if (share === 0) return "0%";
  const text = (share * 100).toFixed(1);
  return share > 0 && text === "0.0" ? "<0.1%" : `${text}%`;
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

const PERCENT_WORDS: Record<Words["percent"], string> = {
  left: "left",
  remaining: "remaining",
  bare: "",
  used: "used",
};

/** The word after a percent ("left", "used", or "" for the bare style). */
export function percentWord(words: Words): string {
  return PERCENT_WORDS[words.percent];
}

/** A raw percent left as a whole number from 0 to 100. */
function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** "58% left", "42% used", or "58%" without the word. */
export function percentText(words: Words, percentRemaining: number, withWord: boolean): string {
  const left = clampPercent(percentRemaining);
  const value = words.percent === "used" ? 100 - left : left;
  const word = withWord ? percentWord(words) : "";
  return word ? `${value}% ${word}` : `${value}%`;
}

/**
 * docs/v6-plan.local.md §4.7. Zero units are dropped in every style; the past is "now".
 * "smart" rounds to the nearest: a day or more in days with one decimal ("4.5d"), from 12 hours
 * in whole hours ("23h"), below that like "exact" ("11h 35m"). A time that rounds to 24 hours
 * is "1.0d".
 */
export function formatDuration(ms: number, style: Words["reset"], decimals: number): string {
  if (!(ms > 0)) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (style === "smart" && minutes >= 720) {
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours}h` : `${(Math.round(minutes / 144) / 10).toFixed(1)}d`;
  }
  if (style === "decimal") {
    return minutes >= 1440
      ? `${(minutes / 1440).toFixed(decimals)}d`
      : `${(minutes / 60).toFixed(decimals)}h`;
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  let parts = [days && `${days}d`, hours && `${hours}h`, rest && `${rest}m`].filter(
    (part): part is string => Boolean(part),
  );
  if (style === "short") parts = parts.slice(0, days ? 2 : 1);
  return parts.join(style === "compact" ? "" : " ");
}

export type BarShape = Settings["layout"]["bar"];

const BAR_CHARACTERS: Record<Exclude<BarShape, "none">, [string, string]> = {
  blocks: ["█", "░"],
  shades: ["▓", "░"],
  line: ["━", "─"],
  squares: ["■", "□"],
  dots: ["●", "○"],
};

/** A bar in two parts (left, used), so each can have its own color. */
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
 * The cell of a bar `width` cells wide where even use would be (the │ mark): `evenLeft` is the
 * percent even use leaves now (`core/pace.ts`).
 */
export function evenUseCell(evenLeft: number, width: number): number {
  return Math.max(0, Math.min(width - 1, Math.round((evenLeft / 100) * width)));
}

export type Level = "good" | "warning" | "low";
export type Thresholds = { warningBelow: number; lowBelow: number };

/** Plenty left, getting low, or almost out. */
export function levelOf(percentRemaining: number, thresholds: Thresholds): Level {
  const left = clampPercent(percentRemaining);
  if (left < thresholds.lowBelow) return "low";
  return left < thresholds.warningBelow ? "warning" : "good";
}

function groupDigits(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * "$12.40", "12.40 EUR", "1 request", "1,200 requests", "30 nano". A count unit is one word
 * ("request"); it is plural for every number but 1, and the plain "unit" is not shown.
 */
export function amountText(amount: Amount): string {
  const { unit } = amount;
  if (unit.kind === "currency") {
    const value = Number(amount.decimal);
    const sign = value < 0 ? "-" : "";
    const [integer = "0", cents = "00"] = Math.abs(value).toFixed(2).split(".");
    const money = `${groupDigits(integer)}.${cents}`;
    return unit.code === "USD" ? `${sign}$${money}` : `${sign}${money} ${unit.code}`;
  }
  const [integer = "0", fraction] = amount.decimal.replace(/^-/u, "").split(".");
  const sign = amount.decimal.startsWith("-") ? "-" : "";
  const number = `${sign}${groupDigits(integer)}${fraction ? `.${fraction}` : ""}`;
  if (unit.kind === "custom") return `${number} ${unit.symbol}`;
  if (unit.unit === "unit") return number;
  return `${number} ${integer === "1" && !fraction ? unit.unit : `${unit.unit}s`}`;
}

/** The value of a row without a percent: its text, amount, used/limit, or yes/no. */
export function rowValueText(row: QuotaRow): string {
  if (row.text !== undefined) return row.text;
  if (row.amount) {
    const amount = amountText(row.amount);
    if (row.type === "balance") return `${amount} left`;
    return row.type === "usage" ? `${amount} used` : amount;
  }
  if (row.remaining) return `${amountText(row.remaining)} left`;
  if (row.used && row.limit) return `${amountText(row.used)}/${amountText(row.limit)}`;
  if (row.used) return `${amountText(row.used)} used`;
  if (row.flag !== undefined) return row.flag ? "Enabled" : "Disabled";
  return "";
}

/** "12.3K in · 2.10K out". */
export function sessionTokensText(tokens: SessionTokens): string {
  return `${formatTokens(tokens.input)} in · ${formatTokens(tokens.output)} out`;
}

/** A model's cache hit can be low once it read this many input tokens. */
const LOW_CACHE_MIN_INPUT_TOKENS = 200_000;
/** A cache hit below this share is low. */
const LOW_CACHE_HIT_BELOW = 0.5;
/** Marks a low cache hit. */
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
export function cacheHit(tokens: InputTokens): CacheHit | undefined {
  const allInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (allInput <= 0 || tokens.cacheRead + tokens.cacheWrite <= 0) return undefined;
  const share = tokens.cacheRead / allInput;
  const judged = allInput >= LOW_CACHE_MIN_INPUT_TOKENS;
  return {
    share,
    text: `${Math.floor((tokens.cacheRead * 100) / allInput)}%`,
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
