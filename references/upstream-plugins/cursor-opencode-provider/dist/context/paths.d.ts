export type HostPathEnv = NodeJS.ProcessEnv;
/** Structural host-path capability installed before an unchanged provider loads. */
export declare const HOST_PATH_BRIDGE: unique symbol;
export type OpenCodePathBridge = {
    projectConfigDirs: (workspaceRoot: string) => string[];
    globalConfigDirs: () => string[];
    /** Optional host-owned durable data root; absent means native OpenCode defaults. */
    globalDataDir?: () => string;
    /** Optional host-owned cache root; absent means native OpenCode defaults. */
    globalCacheDir?: () => string;
    configFileNames?: string[];
    /**
     * Optional host plan file for a session (the host's own plan location, which
     * its `plan_exit` review reads). Absent on an installed bridge means the host
     * defines none; without a bridge OpenCode's own location applies.
     */
    planFile?: (input: {
        worktree: string;
        vcs: boolean;
        created: number;
        slug: string;
    }) => string | undefined;
};
/**
 * The plan file of a session: OpenCode's own `Session.plan` location
 * (`<worktree>/.opencode/plans` in a VCS project, else `<data>/plans`, named
 * `<created>-<slug>.md`), which its plan agent and `plan_exit` use. An injected
 * host path bridge owns host paths, so with one installed only its `planFile`
 * defines the location.
 */
export declare function hostPlanFilePath(input: {
    worktree: string;
    vcs: boolean;
    created: number;
    slug: string;
}, env?: HostPathEnv): string | undefined;
export declare function opencodeProjectConfigDirs(workspaceRoot: string): string[];
export declare function opencodeGlobalConfigDirs(): string[];
export declare function opencodeConfigFileNames(): string[];
/**
 * Pin the process-wide cache root. Highest precedence for {@link opencodeGlobalCacheDir}.
 * Use for host-injected `Path.cache` or an explicit `createCursor({ cacheDir })`.
 */
export declare function setHostCacheDirOverride(dir: string | undefined): void;
export declare function getHostCacheDirOverride(): string | undefined;
/** Resolve the native OpenCode cache root when no host bridge is installed. */
export declare function resolveHostCacheDir(env?: HostPathEnv): string;
/**
 * Native OpenCode global config dir: `$XDG_CONFIG_HOME/opencode`, otherwise
 * `~/.config/opencode` — OpenCode's `Global.Path.config` (`xdg-basedir`
 * `xdgConfig`, `packages/core/src/global.ts`), the same in 1.x and 2.0.
 */
export declare function opencodeGlobalConfigDir(env?: HostPathEnv): string;
/**
 * Host global cache dir for Cursor project metadata + model/version caches.
 *
 * Precedence:
 * 1. {@link setHostCacheDirOverride} / `createCursor({ cacheDir })` (host `Path.cache`)
 * 2. An injected structural host path bridge
 * 3. Native OpenCode XDG defaults ({@link resolveHostCacheDir})
 */
export declare function opencodeGlobalCacheDir(): string;
/** Native OpenCode global data root. */
export declare function opencodeGlobalDataDir(env?: HostPathEnv): string;
/** Host-portable durable data root; falls back to native OpenCode. */
export declare function hostGlobalDataDir(env?: HostPathEnv): string;
/**
 * Select the entrypoint's native OpenCode plan directory. OpenCode 2.0 sets its
 * Plan directory ({@link opencode2PlanDir}); OpenCode 1.x keeps the default.
 * The returned disposer removes only this selection, so an older plugin setup
 * disposed after a newer one leaves the newer selection in place. `undefined`
 * removes all.
 */
export declare function setNativePlansDir(dir: string | undefined): () => void;
/**
 * OpenCode 2.0's Plan directory: `<home>/.opencode/plan`, where its Plan agent
 * may write plan files (home is `OPENCODE_TEST_HOME`, else the OS home).
 */
export declare function opencode2PlanDir(env?: HostPathEnv): string;
/**
 * Directory for a new plan file when the session's own plan file
 * ({@link hostPlanFilePath}) is not known.
 *
 * An injected host path bridge owns host paths: `<globalDataDir()>/plans`.
 * Otherwise the native OpenCode location of the running entrypoint: OpenCode
 * 2.0's Plan directory, or OpenCode 1.x's no-VCS `Session.plan` base
 * (`<data>/plans`).
 */
export declare function hostPlansDir(_workspaceRoot?: string, env?: HostPathEnv): string;
/**
 * Cursor-compatible path slug (`/workspace/a/b` → `workspace-a-b`).
 * Used for per-workspace metadata under the host cache.
 */
export declare function slugifyWorkspacePath(workspaceRoot: string): string;
/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `<host-cache>/projects/<slug>/` under the resolved OpenCode/host cache root.
 *
 * This is what Cursor's RequestContextEnv.project_folder / MCP
 * workspace_project_dir point at — agent-tools, terminals, transcripts, etc.
 * Must NOT be the git workspace, or those dumps land in the repo.
 */
export declare function opencodeProjectDir(workspaceRoot: string): string;
/** Ensure {@link opencodeProjectDir} exists (mode 0o700) and return it. */
export declare function ensureOpencodeProjectDir(workspaceRoot: string): string;
