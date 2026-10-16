import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { trace } from "../debug.js";
/** Structural host-path capability installed before an unchanged provider loads. */
export const HOST_PATH_BRIDGE = Symbol.for("opencode.host.path-bridge");
function pathBridge() {
    const value = globalThis[HOST_PATH_BRIDGE];
    if (!value || typeof value !== "object")
        return undefined;
    const bridge = value;
    return typeof bridge.projectConfigDirs === "function" && typeof bridge.globalConfigDirs === "function"
        ? bridge
        : undefined;
}
function openCodeGlobalDataDir(env = process.env) {
    if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0) {
        return path.join(env.XDG_DATA_HOME, "opencode");
    }
    return path.join(resolveHome(env), ".local", "share", "opencode");
}
function openCodeGlobalCacheDir(env = process.env) {
    return path.join(xdgCacheHome(env), "opencode");
}
function bridgeGlobalDataDir() {
    const value = pathBridge()?.globalDataDir?.();
    return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined;
}
/**
 * The plan file of a session: OpenCode's own `Session.plan` location
 * (`<worktree>/.opencode/plans` in a VCS project, else `<data>/plans`, named
 * `<created>-<slug>.md`), which its plan agent and `plan_exit` use. An injected
 * host path bridge owns host paths, so with one installed only its `planFile`
 * defines the location.
 */
export function hostPlanFilePath(input, env = process.env) {
    const bridge = pathBridge();
    if (bridge) {
        if (typeof bridge.planFile !== "function")
            return undefined;
        const value = bridge.planFile(input);
        return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined;
    }
    const slug = input.slug.trim();
    if (!slug || slug.includes("/") || slug.includes("\\") || slug.startsWith("."))
        return undefined;
    if (!Number.isSafeInteger(input.created) || input.created <= 0)
        return undefined;
    const base = input.vcs
        ? path.join(path.resolve(input.worktree), ".opencode", "plans")
        : path.join(openCodeGlobalDataDir(env), "plans");
    return path.join(base, `${input.created}-${slug}.md`);
}
function bridgeGlobalCacheDir() {
    const value = pathBridge()?.globalCacheDir?.();
    return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined;
}
export function opencodeProjectConfigDirs(workspaceRoot) {
    return pathBridge()?.projectConfigDirs(path.resolve(workspaceRoot)) ?? [
        path.join(path.resolve(workspaceRoot), ".opencode"),
    ];
}
export function opencodeGlobalConfigDirs() {
    return pathBridge()?.globalConfigDirs() ?? [opencodeGlobalConfigDir()];
}
export function opencodeConfigFileNames() {
    return pathBridge()?.configFileNames?.length
        ? [...pathBridge().configFileNames]
        : ["opencode.json", "opencode.jsonc"];
}
/** Explicit host cache root (e.g. Effect v2 `Path.cache`, or `createCursor({ cacheDir })`). */
let hostCacheDirOverride;
function resolveHome(env = process.env) {
    return env.HOME || env.USERPROFILE || homedir();
}
function xdgCacheHome(env = process.env) {
    if (env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0)
        return env.XDG_CACHE_HOME;
    return path.join(resolveHome(env), ".cache");
}
/**
 * Pin the process-wide cache root. Highest precedence for {@link opencodeGlobalCacheDir}.
 * Use for host-injected `Path.cache` or an explicit `createCursor({ cacheDir })`.
 */
export function setHostCacheDirOverride(dir) {
    hostCacheDirOverride = dir && dir.length > 0 ? path.resolve(dir) : undefined;
}
export function getHostCacheDirOverride() {
    return hostCacheDirOverride;
}
/** Resolve the native OpenCode cache root when no host bridge is installed. */
export function resolveHostCacheDir(env = process.env) {
    return bridgeGlobalCacheDir() ?? openCodeGlobalCacheDir(env);
}
function xdgConfigHome(env = process.env) {
    if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0)
        return env.XDG_CONFIG_HOME;
    return path.join(resolveHome(env), ".config");
}
/**
 * Native OpenCode global config dir: `$XDG_CONFIG_HOME/opencode`, otherwise
 * `~/.config/opencode` — OpenCode's `Global.Path.config` (`xdg-basedir`
 * `xdgConfig`, `packages/core/src/global.ts`), the same in 1.x and 2.0.
 */
export function opencodeGlobalConfigDir(env = process.env) {
    return path.join(xdgConfigHome(env), "opencode");
}
/**
 * Host global cache dir for Cursor project metadata + model/version caches.
 *
 * Precedence:
 * 1. {@link setHostCacheDirOverride} / `createCursor({ cacheDir })` (host `Path.cache`)
 * 2. An injected structural host path bridge
 * 3. Native OpenCode XDG defaults ({@link resolveHostCacheDir})
 */
export function opencodeGlobalCacheDir() {
    if (hostCacheDirOverride)
        return hostCacheDirOverride;
    return resolveHostCacheDir();
}
/** Native OpenCode global data root. */
export function opencodeGlobalDataDir(env = process.env) {
    return openCodeGlobalDataDir(env);
}
/** Host-portable durable data root; falls back to native OpenCode. */
export function hostGlobalDataDir(env = process.env) {
    return bridgeGlobalDataDir() ?? openCodeGlobalDataDir(env);
}
/** Entrypoint plan directories, newest last (see {@link setNativePlansDir}). */
const nativePlansDirs = [];
/**
 * Select the entrypoint's native OpenCode plan directory. OpenCode 2.0 sets its
 * Plan directory ({@link opencode2PlanDir}); OpenCode 1.x keeps the default.
 * The returned disposer removes only this selection, so an older plugin setup
 * disposed after a newer one leaves the newer selection in place. `undefined`
 * removes all.
 */
export function setNativePlansDir(dir) {
    if (!dir) {
        nativePlansDirs.length = 0;
        return () => { };
    }
    const entry = { dir: path.resolve(dir) };
    nativePlansDirs.push(entry);
    return () => {
        const index = nativePlansDirs.lastIndexOf(entry);
        if (index >= 0)
            nativePlansDirs.splice(index, 1);
    };
}
/**
 * OpenCode 2.0's Plan directory: `<home>/.opencode/plan`, where its Plan agent
 * may write plan files (home is `OPENCODE_TEST_HOME`, else the OS home).
 */
export function opencode2PlanDir(env = process.env) {
    return path.join(env.OPENCODE_TEST_HOME ?? homedir(), ".opencode", "plan");
}
/**
 * Directory for a new plan file when the session's own plan file
 * ({@link hostPlanFilePath}) is not known.
 *
 * An injected host path bridge owns host paths: `<globalDataDir()>/plans`.
 * Otherwise the native OpenCode location of the running entrypoint: OpenCode
 * 2.0's Plan directory, or OpenCode 1.x's no-VCS `Session.plan` base
 * (`<data>/plans`).
 */
export function hostPlansDir(_workspaceRoot, env = process.env) {
    const bridged = bridgeGlobalDataDir();
    if (bridged)
        return path.join(bridged, "plans");
    return nativePlansDirs[nativePlansDirs.length - 1]?.dir ?? path.join(openCodeGlobalDataDir(env), "plans");
}
/**
 * Cursor-compatible path slug (`/workspace/a/b` → `workspace-a-b`).
 * Used for per-workspace metadata under the host cache.
 */
export function slugifyWorkspacePath(workspaceRoot) {
    const resolved = path.resolve(workspaceRoot);
    return resolved
        .replace(/[^a-zA-Z0-9]/g, "-")
        .split("-")
        .filter(Boolean)
        .join("-");
}
/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `<host-cache>/projects/<slug>/` under the resolved OpenCode/host cache root.
 *
 * This is what Cursor's RequestContextEnv.project_folder / MCP
 * workspace_project_dir point at — agent-tools, terminals, transcripts, etc.
 * Must NOT be the git workspace, or those dumps land in the repo.
 */
export function opencodeProjectDir(workspaceRoot) {
    const projectsRoot = path.join(opencodeGlobalCacheDir(), "projects");
    const slug = slugifyWorkspacePath(workspaceRoot);
    let dir = path.join(projectsRoot, slug);
    // Mirror Cursor's long-path guard so nested agent-tools paths stay usable.
    if (dir.length > 92) {
        const hash = createHash("sha256").update(dir).digest("hex").slice(0, 7);
        dir = `${dir.slice(0, Math.min(84, dir.length))}-${hash}`;
    }
    return dir;
}
/** Ensure {@link opencodeProjectDir} exists (mode 0o700) and return it. */
export function ensureOpencodeProjectDir(workspaceRoot) {
    const resolved = path.resolve(workspaceRoot);
    const dir = opencodeProjectDir(resolved);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    trace(`project-dir: workspace=${resolved} slug=${slugifyWorkspacePath(resolved)} ` +
        `dir=${dir} cache_root=${opencodeGlobalCacheDir()} ` +
        `override=${hostCacheDirOverride ?? "(none)"} ` +
        `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"}`);
    return dir;
}
