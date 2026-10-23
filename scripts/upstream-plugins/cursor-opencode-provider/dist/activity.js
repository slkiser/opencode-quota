import { processShared } from "./process-shared.js";
/** A host tool may keep its Run open this long from its own start. */
export const RUNNING_TOOL_CAP_MS = 4 * 60 * 60 * 1_000;
export function createSessionActivityState() {
    return {
        parentBySession: new Map(),
        lastActivityBySession: new Map(),
        openPrompts: new Map(),
        runningTools: new Map(),
    };
}
const MAX_ANCESTRY_DEPTH = 64;
const MAX_TRACKED_SESSIONS = 1_024;
const ACTIVITY_RETENTION_MS = 24 * 60 * 60 * 1_000;
/**
 * Tracks OpenCode message progress and propagates it through subagent ancestry.
 *
 * A permission or question prompt the host has open is waiting on the user, not
 * stalled: the host emits no events until the user answers, so an open prompt
 * counts as current activity for its session and every ancestor.
 */
export class SessionActivityTracker {
    parentBySession;
    lastActivityBySession;
    openPrompts;
    runningTools;
    constructor(state = createSessionActivityState()) {
        this.parentBySession = state.parentBySession;
        this.lastActivityBySession = state.lastActivityBySession;
        this.openPrompts = state.openPrompts;
        this.runningTools = state.runningTools;
    }
    linkSession(sessionId, parentId) {
        if (!sessionId)
            return;
        this.prune(Date.now());
        if (parentId && parentId !== sessionId)
            this.parentBySession.set(sessionId, parentId);
        else
            this.parentBySession.delete(sessionId);
        const existing = this.lastActivityBySession.get(sessionId);
        if (existing !== undefined)
            this.recordActivity(sessionId, existing);
        this.prune(Date.now());
    }
    recordActivity(sessionId, at = Date.now()) {
        if (!sessionId || !Number.isFinite(at))
            return;
        this.prune(at);
        const visited = new Set();
        let current = sessionId;
        for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
            if (visited.has(current))
                return;
            visited.add(current);
            const previous = this.lastActivityBySession.get(current);
            if (previous === undefined || at > previous) {
                // Map insertion order is our least-recently-active eviction order.
                this.lastActivityBySession.delete(current);
                this.lastActivityBySession.set(current, at);
            }
            current = this.parentBySession.get(current);
        }
        this.prune(at);
    }
    lastActivityAt(sessionId) {
        const now = Date.now();
        this.prune(now);
        if (this.awaitsUser(sessionId))
            return now;
        return this.lastActivityBySession.get(sessionId);
    }
    /** The host opened a permission or question prompt in `sessionId`. */
    openPrompt(sessionId, requestId, at = Date.now()) {
        if (!sessionId || !requestId)
            return;
        const key = `${sessionId}\0${requestId}`;
        this.openPrompts.delete(key);
        this.openPrompts.set(key, { sessionId, openedAt: at });
        this.recordActivity(sessionId, at);
    }
    /** The prompt was answered, rejected or cancelled. */
    closePrompt(sessionId, requestId, at = Date.now()) {
        if (!sessionId || !requestId)
            return;
        this.openPrompts.delete(`${sessionId}\0${requestId}`);
        this.recordActivity(sessionId, at);
    }
    /**
     * The host started running this tool. A repeated start keeps the original
     * time so a later event cannot extend the 4h ceiling.
     */
    toolStarted(sessionId, callId, at = Date.now()) {
        if (!sessionId || !callId || !Number.isFinite(at))
            return;
        const key = `${sessionId}\0${callId}`;
        if (!this.runningTools.has(key))
            this.runningTools.set(key, { sessionId, startedAt: at });
        this.recordActivity(sessionId, at);
    }
    /** Drop every running tool for this session. Activity history stays. */
    endRunningTools(sessionId, at = Date.now()) {
        if (!sessionId)
            return;
        let ended = false;
        for (const [key, tool] of this.runningTools) {
            if (tool.sessionId !== sessionId)
                continue;
            this.runningTools.delete(key);
            ended = true;
        }
        if (ended)
            this.recordActivity(sessionId, at);
    }
    /** The host finished the tool. The normal inactivity cap applies from now. */
    toolEnded(sessionId, callId, at = Date.now()) {
        if (!sessionId || !callId)
            return;
        this.runningTools.delete(`${sessionId}\0${callId}`);
        this.recordActivity(sessionId, at);
    }
    runningToolDeadline(sessionId, now, toolCapMs) {
        let deadline;
        for (const tool of this.runningTools.values()) {
            if (!this.belongsTo(tool.sessionId, sessionId))
                continue;
            const cap = tool.startedAt + toolCapMs;
            if (now >= cap)
                continue;
            deadline = deadline === undefined ? cap : Math.max(deadline, cap);
        }
        return deadline;
    }
    removeSession(sessionId) {
        this.parentBySession.delete(sessionId);
        this.lastActivityBySession.delete(sessionId);
        for (const [key, prompt] of this.openPrompts) {
            if (prompt.sessionId === sessionId)
                this.openPrompts.delete(key);
        }
        this.clearRunningTools(sessionId);
    }
    clear() {
        this.parentBySession.clear();
        this.lastActivityBySession.clear();
        this.openPrompts.clear();
        this.runningTools.clear();
    }
    /** A prompt is open in `sessionId` or in one of its descendants. */
    awaitsUser(sessionId) {
        for (const prompt of this.openPrompts.values()) {
            let current = prompt.sessionId;
            for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
                if (current === sessionId)
                    return true;
                current = this.parentBySession.get(current);
            }
        }
        return false;
    }
    prune(now) {
        const oldestAllowed = now - ACTIVITY_RETENTION_MS;
        // A prompt whose reply never arrived must not hold a Run open forever.
        for (const [key, prompt] of this.openPrompts) {
            if (prompt.openedAt >= oldestAllowed)
                break;
            this.openPrompts.delete(key);
        }
        while (this.openPrompts.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.openPrompts.keys().next().value;
            if (!oldest)
                break;
            this.openPrompts.delete(oldest);
        }
        for (const [sessionId, activityAt] of this.lastActivityBySession) {
            if (activityAt >= oldestAllowed)
                break;
            this.lastActivityBySession.delete(sessionId);
            this.parentBySession.delete(sessionId);
        }
        while (this.lastActivityBySession.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.lastActivityBySession.keys().next().value;
            if (!oldest)
                break;
            this.lastActivityBySession.delete(oldest);
            this.parentBySession.delete(oldest);
        }
        while (this.parentBySession.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.parentBySession.keys().next().value;
            if (!oldest)
                break;
            this.parentBySession.delete(oldest);
        }
        for (const [key, tool] of this.runningTools) {
            if (tool.startedAt < oldestAllowed)
                this.runningTools.delete(key);
        }
        // A tool whose end event never arrived must not grow the map without bound.
        while (this.runningTools.size > MAX_TRACKED_SESSIONS) {
            const oldest = this.runningTools.keys().next().value;
            if (!oldest)
                break;
            this.runningTools.delete(oldest);
        }
    }
    belongsTo(toolSessionId, sessionId) {
        let current = toolSessionId;
        for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
            if (current === sessionId)
                return true;
            current = this.parentBySession.get(current);
        }
        return false;
    }
    clearRunningTools(sessionId) {
        for (const [key, tool] of this.runningTools) {
            if (tool.sessionId === sessionId)
                this.runningTools.delete(key);
        }
    }
}
export const sessionActivity = new SessionActivityTracker(processShared("session-activity.v1", createSessionActivityState));
/**
 * Open or close a host prompt from an OpenCode event. OpenCode 1.x publishes
 * `permission.asked` / `permission.replied` and `question.asked` /
 * `question.replied` / `question.rejected` (older releases used
 * `permission.updated` and `permissionID`); OpenCode 2 publishes the same
 * permission events plus `form.created` / `form.replied` / `form.cancelled`.
 */
export function applyHostPromptEvent(tracker, type, payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    const text = (value) => typeof value === "string" ? value : "";
    switch (type) {
        case "permission.asked":
        case "permission.updated":
        case "question.asked":
            tracker.openPrompt(text(data.sessionID), text(data.id));
            break;
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
            tracker.closePrompt(text(data.sessionID), text(data.requestID) || text(data.permissionID));
            break;
        case "form.created": {
            const form = data.form && typeof data.form === "object" ? data.form : {};
            tracker.openPrompt(text(form.sessionID), text(form.id));
            break;
        }
        case "form.replied":
        case "form.cancelled":
            tracker.closePrompt(text(data.sessionID), text(data.id));
            break;
    }
}
/**
 * A host tool that is actually running holds the Run past the inactivity cap.
 * OpenCode 1 reports that on the tool part (`running`, and not provider-executed).
 * OpenCode 2 reports it on `session.tool.called` when `executed` is not true.
 */
export function applyHostToolEvent(tracker, type, payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    const text = (value) => typeof value === "string" ? value : "";
    if (type === "message.part.updated") {
        const part = data.part && typeof data.part === "object" ? data.part : undefined;
        if (!part || part.type !== "tool")
            return;
        const sessionId = text(part.sessionID);
        const callId = text(part.callID) || text(part.callId);
        const state = part.state && typeof part.state === "object" ? part.state : undefined;
        const metadata = part.metadata && typeof part.metadata === "object"
            ? part.metadata
            : undefined;
        if (!sessionId || !callId || !state)
            return;
        if (state.status === "running" && metadata?.providerExecuted !== true)
            tracker.toolStarted(sessionId, callId);
        else if (state.status === "completed" || state.status === "error")
            tracker.toolEnded(sessionId, callId);
        return;
    }
    if (type === "session.tool.called") {
        const sessionId = text(data.sessionID);
        const callId = text(data.id) || text(data.callID);
        if (!sessionId || !callId || data.executed === true)
            return;
        tracker.toolStarted(sessionId, callId);
        return;
    }
    if (type === "session.tool.success" || type === "session.tool.failed") {
        const sessionId = text(data.sessionID);
        const callId = text(data.id) || text(data.callID);
        if (sessionId && callId)
            tracker.toolEnded(sessionId, callId);
        return;
    }
    if (type === "session.idle") {
        const info = data.info && typeof data.info === "object" ? data.info : undefined;
        const sessionId = text(data.sessionID) || text(info?.id);
        if (sessionId)
            tracker.endRunningTools(sessionId);
    }
}
