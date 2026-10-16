import { readdir, stat } from "node:fs/promises";
import path from "node:path";
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo"]);
/**
 * Shallow project layout for RequestContext.project_layouts.
 * Caps depth and entries to keep the payload small.
 */
export async function collectProjectLayout(workspaceRoot, opts = {}) {
    const maxDepth = opts.maxDepth ?? 2;
    const maxEntries = opts.maxEntries ?? 80;
    return walk(path.resolve(workspaceRoot), 0, maxDepth, maxEntries);
}
async function walk(dir, depth, maxDepth, maxEntries) {
    const node = {
        abs_path: dir,
        children_dirs: [],
        children_files: [],
        children_were_processed: depth < maxDepth,
        num_files: 0,
    };
    if (depth >= maxDepth)
        return node;
    let names;
    try {
        names = await readdir(dir);
    }
    catch {
        node.children_were_processed = false;
        return node;
    }
    names.sort();
    let count = 0;
    for (const name of names) {
        if (count >= maxEntries)
            break;
        if (name.startsWith(".") && name !== ".opencode" && name !== ".claude" && name !== ".agents")
            continue;
        if (SKIP.has(name))
            continue;
        const full = path.join(dir, name);
        let st;
        try {
            st = await stat(full);
        }
        catch {
            continue;
        }
        count++;
        if (st.isDirectory()) {
            node.children_dirs.push(await walk(full, depth + 1, maxDepth, maxEntries));
        }
        else {
            node.children_files.push({ name });
            node.num_files++;
        }
    }
    return node;
}
