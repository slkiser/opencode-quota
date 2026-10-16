export type SessionActivitySource = {
    lastActivityAt(sessionId: string): number | undefined;
};
/** Tracks OpenCode message progress and propagates it through subagent ancestry. */
export declare class SessionActivityTracker implements SessionActivitySource {
    private readonly parentBySession;
    private readonly lastActivityBySession;
    linkSession(sessionId: string, parentId?: string): void;
    recordActivity(sessionId: string, at?: number): void;
    lastActivityAt(sessionId: string): number | undefined;
    removeSession(sessionId: string): void;
    clear(): void;
    private prune;
}
export declare const sessionActivity: SessionActivityTracker;
