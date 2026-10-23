import path from "node:path";
import { pathToFileURL } from "node:url";
import { opencodeGlobalConfigDirs } from "./context/paths.js";
import { createOpenCodeWebSearchTool, openCodeWebSearchTool } from "./web-search-tool.js";
import { createCursorImageSaveTool, cursorImageSaveTool } from "./image-save-tool.js";
/**
 * Classic plugin tools built with the host's own `tool()` helper when it can
 * be found. Lives outside `plugin.ts` because OpenCode 1.x calls every export
 * of a plugin module as a plugin (`getLegacyPlugins`), so that module may
 * export `CursorPlugin` only.
 */
export async function loadClassicTools(options = {}) {
    const configDir = options.configDirs?.[0] ?? opencodeGlobalConfigDirs()[0];
    const candidates = [
        ...(configDir
            ? [path.join(configDir, "node_modules", "@opencode-ai", "plugin", "dist", "index.js")]
            : []),
        "@opencode-ai/plugin",
    ];
    const importModule = options.importModule ?? ((specifier) => import(specifier));
    // The global config copy is the host-owned installation; bare import is a fallback.
    for (const candidate of candidates) {
        try {
            const specifier = path.win32.isAbsolute(candidate) && !path.isAbsolute(candidate)
                ? new URL(`file:///${candidate.replaceAll("\\", "/")}`).href
                : path.isAbsolute(candidate)
                    ? pathToFileURL(candidate).href
                    : candidate;
            const module = await importModule(specifier);
            if (typeof module.tool === "function" && module.tool.schema) {
                const factory = { tool: module.tool, schema: module.tool.schema };
                return {
                    webSearch: createOpenCodeWebSearchTool(factory),
                    imageSave: createCursorImageSaveTool(factory),
                };
            }
        }
        catch {
            // Try the next host-owned/normal resolution location.
        }
    }
    // `tool()` is an identity helper; the fallback definitions use plain JSON
    // Schema accepted by OpenCode's legacy registry when no Zod helper is present.
    return { webSearch: openCodeWebSearchTool, imageSave: cursorImageSaveTool };
}
