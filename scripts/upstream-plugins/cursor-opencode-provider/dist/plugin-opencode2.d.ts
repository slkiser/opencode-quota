import { CursorPlugin } from "./plugin.js";
import type { Plugin2 } from "./opencode2/types.js";
declare const plugin: Plugin2 & {
    server: typeof CursorPlugin;
};
export default plugin;
