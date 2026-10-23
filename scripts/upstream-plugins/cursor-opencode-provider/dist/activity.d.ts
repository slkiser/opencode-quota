/** A host tool may keep its Run open this long from its own start. */
export declare const RUNNING_TOOL_CAP_MS: number;
type RunningTool = {
    sessionId: string;
    startedAt: number;
};
/**
 * Everything the tracker knows, as plain data. The plugin that receives host
 * events and the provider that holds the Run can be different module copies
 * (OpenCode 2 loads one per location), so the process-wide tracker keeps this
 * in `processShared`: parent links, activity and prompts must all be seen by
 * the copy that renews the Run's lease.
 */
export type SessionActivityState = {
    parentBySession: Map<string, string>;
    lastActivityBySession: Map<string, number>;
    /** Open host prompts: `${sessionId}\0${requestId}` → session id and when it opened. */
    openPrompts: Map<string, {
        sessionId: string;
        openedAt: number;
    }>;
    /** `${sessionId}\0${callId}` → when that host tool started running. */
    runningTools: Map<string, RunningTool>;
};
export declare function createSessionActivityState(): SessionActivityState;
export type SessionActivitySource = {
    lastActivityAt(sessionId: string): number | undefined;
    /**
     * Latest 4h ceiling among host tools still running in this session or a
     * descendant. Undefined when none are still inside their own ceiling.
     */
    runningToolDeadline?(sessionId: string, now: number, toolCapMs: number): number | undefined;
};
/**
 * Tracks OpenCode message progress and propagates it through subagent ancestry.
 *
 * A permission or question prompt the host has open is waiting on the user, not
 * stalled: the host emits no events until the user answers, so an open prompt
 * counts as current activity for its session and every ancestor.
 */
export declare class SessionActivityTracker implements SessionActivitySource {
    private readonly parentBySession;
    private readonly lastActivityBySession;
    private readonly openPrompts;
    private readonly runningTools;
    constructor(state?: SessionActivityState);
    linkSession(sessionId: string, parentId?: string): void;
    recordActivity(sessionId: string, at?: number): void;
    lastActivityAt(sessionId: string): number | undefined;
    /** The host opened a permission or question prompt in `sessionId`. */
    openPrompt(sessionId: string, requestId: string, at?: number): void;
    /** The prompt was answered, rejected or cancelled. */
    closePrompt(sessionId: string, requestId: string, at?: number): void;
    /**
     * The host started running this tool. A repeated start keeps the original
     * time so a later event cannot extend the 4h ceiling.
     */
    toolStarted(sessionId: string, callId: string, at?: number): void;
    /** Drop every running tool for this session. Activity history stays. */
    endRunningTools(sessionId: string, at?: number): void;
    /** The host finished the tool. The normal inactivity cap applies from now. */
    toolEnded(sessionId: string, callId: string, at?: number): void;
    runningToolDeadline(sessionId: string, now: number, toolCapMs: number): number | undefined;
    removeSession(sessionId: string): void;
    clear(): void;
    /** A prompt is open in `sessionId` or in one of its descendants. */
    private awaitsUser;
    private prune;
    private belongsTo;
    private clearRunningTools;
}
export declare const sessionActivity: SessionActivityTracker;
/**
 * Open or close a host prompt from an OpenCode event. OpenCode 1.x publishes
 * `permission.asked` / `permission.replied` and `question.asked` /
 * `question.replied` / `question.rejected` (older releases used
 * `permission.updated` and `permissionID`); OpenCode 2 publishes the same
 * permission events plus `form.created` / `form.replied` / `form.cancelled`.
 */
export declare function applyHostPromptEvent(tracker: SessionActivityTracker, type: unknown, payload: unknown): void;
/**
 * A host tool that is actually running holds the Run past the inactivity cap.
 * OpenCode 1 reports that on the tool part (`running`, and not provider-executed).
 * OpenCode 2 reports it on `session.tool.called` when `executed` is not true.
 */
export declare function applyHostToolEvent(tracker: SessionActivityTracker, type: unknown, payload: unknown): void;
export {};
