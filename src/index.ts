import "@opentui/solid/preload";

export type { MiniMaxResult, MiniMaxResultEntry } from "./lib/types.js";

const { default: plugin } = await import("./tui-v2.js");

export default plugin;
