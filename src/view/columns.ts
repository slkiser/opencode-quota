/**
 * Terminal columns: how wide text shows in a terminal, and cutting or padding text to a width
 * without splitting a character. East Asian wide characters and emoji take two columns;
 * control, format and combining characters on their own take none.
 */

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
/** East Asian Wide and Fullwidth blocks: Hangul Jamo, CJK, kana, Hangul, fullwidth forms. */
const WIDE =
  /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
const EMOJI = /\p{Emoji_Presentation}|\uFE0F/u;
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Mn}\p{Me}]+$/u;

function graphemeColumns(grapheme: string): number {
  if (INVISIBLE.test(grapheme)) return 0;
  return WIDE.test(grapheme) || EMOJI.test(grapheme) ? 2 : 1;
}

export function columnsOf(text: string): number {
  let columns = 0;
  for (const { segment } of GRAPHEMES.segment(text)) columns += graphemeColumns(segment);
  return columns;
}

/** The longest start of `text` that fits in `width` columns. */
export function sliceColumns(text: string, width: number): string {
  let slice = "";
  let columns = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    columns += graphemeColumns(segment);
    if (columns > width) break;
    slice += segment;
  }
  return slice;
}

/** `text` cut to `width` columns, ending in "…" when cut. */
export function truncateColumns(text: string, width: number): string {
  if (columnsOf(text) <= width) return text;
  return width <= 0 ? "" : `${sliceColumns(text, width - 1)}…`;
}

/** `text` with spaces after it up to `width` columns (never cut). */
export function padEndColumns(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - columnsOf(text)));
}

/** `text` with spaces before it up to `width` columns (never cut). */
export function padStartColumns(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - columnsOf(text))) + text;
}
