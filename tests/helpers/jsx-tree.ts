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
