/** @jsxImportSource @opentui/solid */
/**
 * A list down the left of the quota window's tab body: Usage's ranges and Layout's pages. The
 * chosen item has "›" before it and is bold, on the raised background across the list; a muted
 * line runs down the list's right side. The "›" starts in the window title's column and the
 * labels 2 columns in. Both lists have one width, the longest label of either and a space, so
 * the line and the body stay put between Usage and Layout. A click picks an item. On a short
 * window the list ends at the window's bottom line instead of drawing over it.
 */
import { RGBA, TextAttributes } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { WindowTheme } from "./shell.js";

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
/** Each label starts this far in; the chosen one has "› " there. */
const RAIL_INDENT = 2;
/** The longest label of either list: Usage's "This session". */
export const RAIL_LABEL_WIDTH = 12;
/** The list's width: a label's indent, the longest label and a space before the line. */
const RAIL_WIDTH = RAIL_INDENT + RAIL_LABEL_WIDTH + 1;
/** The muted line at the list's right. */
const LINE_WIDTH = 1;

/** An item of the list: what it picks, its label and its element id. */
export type RailItem<Key extends string> = { key: Key; label: string; id: string };

/** What the list takes left of the content: the list, the line after it and `gap` columns. */
export function railRoom(gap: number): number {
  return RAIL_WIDTH + LINE_WIDTH + gap;
}

export function Rail<Key extends string>(props: {
  items: ReadonlyArray<RailItem<Key>>;
  chosen: Key;
  theme: WindowTheme;
  /** Columns between the line and the content. */
  gap: number;
  pick: (key: Key) => void;
}): JSX.Element {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={RAIL_WIDTH + LINE_WIDTH}
      marginRight={props.gap}
      overflow="hidden"
      border={["right"]}
      borderStyle="single"
      borderColor={props.theme.text.muted}
    >
      {props.items.map((item) => {
        const chosen = item.key === props.chosen;
        const marker = chosen ? "› " : " ".repeat(RAIL_INDENT);
        return (
          <text
            id={item.id}
            fg={chosen ? props.theme.text.action.primary.selected : props.theme.text.muted}
            bg={chosen ? props.theme.background.raised.high : TRANSPARENT}
            attributes={chosen ? TextAttributes.BOLD : TextAttributes.NONE}
            wrapMode="none"
            flexShrink={0}
            selectable={false}
            onMouseUp={() => props.pick(item.key)}
          >
            {`${marker}${item.label}`.padEnd(RAIL_WIDTH)}
          </text>
        );
      })}
    </box>
  );
}
