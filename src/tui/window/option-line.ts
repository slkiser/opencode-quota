/**
 * The window's selectable lines (Settings and Plugin) and the rules every tab follows for them:
 * ↑↓ select the next line and scroll past the first or last one; space, enter or a click use a
 * line; ←/→ or ‹ › change it.
 */
import type { RGBA } from "@opentui/core";

/** A line ↑↓ select: ‹ value › steps through values, value ▸ runs a button; some take typing. */
export type OptionLine = {
  id: string;
  /** A heading above the line, which starts a group. */
  group?: string;
  /** A blank line above the line, between blocks of one group. */
  gap?: boolean;
  title: string;
  value: () => string;
  cycle?: (delta: number) => void;
  run?: () => void;
  typed?: Typed;
  note?: () => string;
  /** The note in the warning color. */
  warning?: boolean;
  /** A second muted line under the value. */
  detail?: string;
  /** Nesting under the line above: 1 for a provider's settings under its tick. */
  depth?: number;
  /** A tick box ([x] or [ ] in its title): no ‹ ›, a click on the title flips it too. */
  tick?: boolean;
  swatches?: () => RGBA[];
};

/** What a line takes when you type into it (e, or a double-click). */
export type Typed = { placeholder: string; hint: string; apply: (text: string) => void };

/**
 * Space, enter or a click on the value: run the line's button, else its next value. "type" when
 * it has neither and takes typing instead.
 */
export function activateLine(line: OptionLine): "type" | undefined {
  if (line.run) line.run();
  else if (line.cycle) line.cycle(1);
  else return "type";
  return undefined;
}

/** ←/→ or ‹ ›: the line's previous (-1) or next (+1) value; nothing on a button. */
export function stepLine(line: OptionLine, delta: number): void {
  line.cycle?.(delta);
}

/**
 * ↑↓ from line `index` of `count` (-1 for none selected): the line to select, or undefined past
 * the first or last line (or without lines), where the window scrolls instead.
 */
export function stepSelection(count: number, index: number, delta: number): number | undefined {
  const next = index + delta;
  return count > 0 && next >= 0 && next < count ? next : undefined;
}
