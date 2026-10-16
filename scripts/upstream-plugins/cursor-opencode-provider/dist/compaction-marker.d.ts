/**
 * Session-scoped compaction marker for the OpenCode 2.0 plugin.
 *
 * The classic plugin learns that a turn belongs to OpenCode's compaction agent
 * via the `chat.params` hook and forwards it as a provider option. OpenCode 2.0
 * removed `chat.params`; the only place the runtime names the owning agent is
 * `session.hook("context")`, which fires before dispatch. The 2.0 plugin writes
 * an explicit request-local provider option and records this session marker as
 * a compatibility fallback for hosts that do not preserve mutable options.
 *
 * Bounded so a long-lived server cannot accumulate ids for dead sessions.
 */
export declare function markCompactionSession(sessionID: string, isCompaction: boolean): void;
export declare function isCompactionSession(sessionID: string | undefined): boolean;
export declare function clearCompactionSessions(): void;
