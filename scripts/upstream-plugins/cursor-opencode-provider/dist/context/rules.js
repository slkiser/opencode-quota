import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { opencodeConfigFileNames, opencodeGlobalConfigDirs, opencodeProjectConfigDirs } from "./paths.js";
async function exists(file) {
    try {
        await stat(file);
        return true;
    }
    catch {
        return false;
    }
}
async function readJsonConfig(dir) {
    for (const name of opencodeConfigFileNames()) {
        const file = path.join(dir, name);
        if (!(await exists(file)))
            continue;
        try {
            const raw = await readFile(file, "utf-8");
            // Match strings first so comment markers inside URLs/plugin specifiers
            // survive. Remove comments before trailing commas (which may precede one).
            const uncommented = raw.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('"') ? token : " ");
            const stripped = uncommented.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : "");
            return JSON.parse(stripped);
        }
        catch {
            return {};
        }
    }
    return {};
}
/** Same truthy rule as OpenCode's Flag.OPENCODE_DISABLE_PROJECT_CONFIG. */
export function isProjectConfigDisabled() {
    const value = process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase();
    return value === "true" || value === "1";
}
function mergeConfig(base, overlay) {
    return {
        ...base,
        ...overlay,
        instructions: [...(base.instructions ?? []), ...(overlay.instructions ?? [])],
        plugin: [...new Set([...(base.plugin ?? []), ...(overlay.plugin ?? [])])],
        plugins: [...new Set([...(base.plugins ?? []), ...(overlay.plugins ?? [])])],
        mcp: { ...(base.mcp ?? {}), ...(overlay.mcp ?? {}) },
        permission: overlay.permission ?? base.permission,
    };
}
/**
 * Merged `opencode.json` / `opencode.jsonc` for MCP server ids, plugin lists,
 * and interaction guidance. Instruction file bodies are not collected here.
 */
export async function loadMergedConfig(workspaceRoot) {
    const globalConfig = await readJsonConfig(opencodeGlobalConfigDirs()[0] ?? "");
    if (isProjectConfigDisabled())
        return mergeConfig({}, globalConfig);
    // The bridge supplies native project config roots for an unchanged plugin:
    // The active host's project config directories are supplied by the path bridge; OpenCode defaults to .opencode.
    // Later roots have higher precedence, matching the host's native ordering.
    let projectConfig = await readJsonConfig(workspaceRoot);
    for (const configDir of opencodeProjectConfigDirs(workspaceRoot)) {
        projectConfig = mergeConfig(projectConfig, await readJsonConfig(configDir));
    }
    return mergeConfig(globalConfig, projectConfig);
}
