/**
 * Session rules that still deny edits after an agent switch.
 *
 * OpenCode evaluates session rules after the agent catalog; the last matching
 * rule wins. A plan-file allow does not lift a final `edit` deny on `*`, so
 * approving a plan cannot mean implementation is now permitted.
 */
/** Shared refusal clause for a mutation the session or this turn still forbids. */
export declare const SHELL_NOT_FOR_FILE_WRITES = "Do not create or change files through the shell.";
export declare const SESSION_PERMISSIONS_UNAVAILABLE_REASON: string;
/**
 * True when the last session rule whose action matches `edit` and whose
 * resource is `*` has effect `deny`. A later allow on only the plan path does
 * not count. A later `edit` `*` allow does.
 */
export declare function sessionRulesDenyEdits(permissions: unknown): boolean;
/** Session payload from either entrypoint: a bare info object or `{ data }`. */
export declare function permissionsFromSession(session: unknown): unknown;
/**
 * Read current permission evidence before a request can approve implementation.
 * Retry once for a transient host lookup failure. A failed read is not an empty
 * ruleset; classic SDK error responses may resolve instead of throwing.
 */
export declare function loadSessionForPermissions<T>(getSession: () => Promise<T>): Promise<T>;
/**
 * Current edit guidance to send, or `undefined` when none is needed.
 * A deny is stated every time. The no-deny note only supersedes a deny Cursor
 * may hold: one this process sent, or, when this process has sent nothing to
 * the conversation, one inside a checkpoint that ever received a deny.
 * Carried notes may reintroduce an older deny regardless of what this process
 * last sent.
 */
export declare function sessionEditsGuidance(conversationId: string, denied: boolean | undefined, options: {
    carriesEarlierState: boolean;
    carriesEditDeny?: boolean;
}): boolean | undefined;
/** Record only after the request or continuation carrying this state was written. */
export declare function recordSessionEditsGuidance(conversationId: string, denied: boolean | undefined): void;
/** Snapshot value: an unknown conversation may hold a deny. */
export declare function sessionEditsDenySent(conversationId: string): boolean;
/**
 * Restart snapshot marker; live state recorded by this process wins, unless the snapshot is newer than it
 * (`replace`: another module copy wrote it after this copy last served the conversation).
 */
export declare function restoreSessionEditsDenySent(conversationId: string, denySent: boolean, replace?: boolean): void;
export declare function resetSessionEditsGuidanceForTests(): void;
export declare function notPermittedThisTurnReason(toolName: string, permittedToolNames: Iterable<string>): string;
