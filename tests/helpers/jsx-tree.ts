/**
 * Reading what a TUI component draws. A test stubs `React.createElement` so JSX builds plain
 * `{ type, props }` nodes; these helpers find nodes and read their text.
 */

export type Node = { type: unknown; props: Record<string, any> };

/** Every `text` node of a JSX tree as one line, its spans joined. */
export function textLines(node: unknown): string[] {
  const strings = (child: unknown): string =>
    Array.isArray(child)
      ? child.map(strings).join("")
      : typeof child === "string" || typeof child === "number"
        ? String(child)
        : child && typeof child === "object"
          ? strings((child as Node).props?.children)
          : "";
  if (Array.isArray(node)) return node.flatMap(textLines);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  if (element.type === "text") return [strings(element.props.children)];
  return textLines(element.props?.children);
}

export function findAll(node: unknown, match: (node: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [...(match(element) ? [element] : []), ...findAll(element.props?.children, match)];
}

/** The text lines with runs of spaces as one space, so layout tweaks don't break the checks. */
export function words(node: unknown): string[] {
  return textLines(node).map((line) => line.replace(/\s+/gu, " ").trim());
}

/** The labels of the active choices: the tab, Cost or Tokens, the range (without its ›), Model or Day. */
export function activeLabels(node: unknown): string[] {
  return findAll(node, (item) => item.type === "text" && item.props.fg === "selected").map((item) =>
    (textLines(item)[0] ?? "").trim().replace(/^› /u, ""),
  );
}

/** A line on a node that a click uses: its text is `text` (a list's chosen item has › before it). */
export function clickable(tree: unknown, text: string): Node {
  return findAll(
    tree,
    (node) =>
      typeof node.props?.onMouseUp === "function" &&
      textLines(node).join("").trim().replace(/^› /u, "") === text,
  )[0]!;
}

/** The lines of the window's Settings line with this setting path (or id). */
export function settingLine(tree: unknown, id: string): Node[] {
  return findAll(tree, (node) => node.props?.id === `quota-settings.${id}`);
}

/** The theme tokens the TUI reads, each a name a test can look for. */
export const THEME = {
  text: {
    base: "text",
    muted: "muted",
    action: { primary: { focused: "action", selected: "selected" } },
    feedback: {
      success: { base: "green" },
      warning: { base: "yellow" },
      error: { base: "red" },
      info: { base: "blue" },
    },
  },
  hue: { accent: { 500: "accent" } },
  background: { action: { primary: { focused: "action-bg" } }, raised: { high: "raised" } },
  border: { base: "border" },
};
