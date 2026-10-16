import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { opencodeGlobalConfigDirs, opencodeProjectConfigDirs } from "./paths.js";
async function listLocalPlugins(dir) {
    try {
        await stat(dir);
    }
    catch {
        return [];
    }
    const out = [];
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return [];
    }
    entries.sort();
    for (const name of entries) {
        if (!/\.(m?[jt]s)$/.test(name))
            continue;
        const full = path.join(dir, name);
        out.push({ id: name.replace(/\.(m?[jt]s)$/, ""), source: "local", path: full });
    }
    return out;
}
/** OpenCode plugins from config + local plugin directories (metadata only). */
export async function collectPlugins(workspaceRoot, config) {
    const out = [];
    const seen = new Set();
    for (const id of [...(config.plugin ?? []), ...(config.plugins ?? [])]) {
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, source: "npm" });
    }
    for (const configDir of opencodeProjectConfigDirs(workspaceRoot)) {
        for (const p of await listLocalPlugins(path.join(configDir, "plugins"))) {
            if (seen.has(p.id))
                continue;
            seen.add(p.id);
            out.push(p);
        }
    }
    for (const configDir of opencodeGlobalConfigDirs()) {
        for (const p of await listLocalPlugins(path.join(configDir, "plugins"))) {
            if (seen.has(p.id))
                continue;
            seen.add(p.id);
            out.push(p);
        }
    }
    return out;
}
