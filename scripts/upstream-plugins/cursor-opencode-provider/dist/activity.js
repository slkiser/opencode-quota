const MAX_ANCESTRY_DEPTH = 64;
const MAX_TRACKED_SESSIONS = 1_024;
const ACTIVITY_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Tracks OpenCode message progress and propagates it through subagent ancestry. */
export class SessionActivityTracker {
    parentBySession = new Map();
    lastActivityBySession = new Map();
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
        this.prune(Date.now());
        return this.lastActivityBySession.get(sessionId);
    }
    removeSession(sessionId) {
        this.parentBySession.delete(sessionId);
        this.lastActivityBySession.delete(sessionId);
    }
    clear() {
        this.parentBySession.clear();
        this.lastActivityBySession.clear();
    }
    prune(now) {
        const oldestAllowed = now - ACTIVITY_RETENTION_MS;
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
    }
}
export const sessionActivity = new SessionActivityTracker();
