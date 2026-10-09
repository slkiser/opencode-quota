/**
 * OpenCode's own plan file per session, resolved while the session runs under
 * the `plan` agent. CreatePlan records the plan there so the `plan_exit` review
 * reads exactly the file the user approves.
 *
 * Resolution is structural: session `slug` / `time.created` from the classic
 * client, project VCS and worktree from the plugin input, and the location
 * from OpenCode's `Session.plan` rule (or an injected host path bridge).
 */
export declare function hostPlanFileFor(sessionID: string | undefined): string | undefined;
/** True once the session's plan file is known, including known to be absent. */
export declare function isHostPlanFileResolved(sessionID: string | undefined): boolean;
/**
 * Record a session's plan file. `null` records that the host defines none, so
 * it is not looked up again; `undefined` forgets it, so the next request retries.
 */
export declare function setHostPlanFile(sessionID: string, file: string | null | undefined): void;
export declare function resetHostPlanFilesForTests(): void;
/**
 * Resolve and remember the host plan file for one session. A session without
 * one is remembered as such; a failed lookup is not, so a later request retries.
 */
export declare function resolveHostPlanFile(input: {
    sessionID: string;
    getSession: (sessionID: string) => Promise<unknown>;
    worktree: string | undefined;
    vcs: boolean;
}): Promise<string | undefined>;
