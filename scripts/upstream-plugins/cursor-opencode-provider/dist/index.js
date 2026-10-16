import { createSdk } from "./plugin-core.js";
import { CursorPlugin } from "./plugin.js";
export function createCursor(options) {
    return createSdk(options);
}
export { CursorPlugin };
export default CursorPlugin;
// Keep root runtime exports plugin-safe. OpenCode's legacy plugin loader
// treats package-root exports as potential plugins, so extra public runtime
// APIs belong on subpaths such as "cursor-opencode-provider/errors".
//
// CursorPluginV2 is NOT re-exported here — see plugin-v2.ts.
// OpenCode's legacy plugin loader (getLegacyPlugins) iterates all exports
// and calls getServerPlugin on each; the v2 define() return is not a
// function, causing "Plugin export is not a function". Load it via
// the separate "cursor-opencode-provider/plugin/v2" export path.
