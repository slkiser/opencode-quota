/**
 * Prefixes that can introduce a progress fragment. These are not complete
 * answers by themselves; `isProgressOnlyAssistantText` still requires a
 * fragment (no sentence punctuation) and, for most verbs, an inspection object.
 */
export declare const PROGRESS_ONLY_PATTERNS: readonly RegExp[];
/**
 * True only for a short progress *fragment* that ended the turn without tools.
 *
 * Complete answers that happen to start with a progress verb ("Looking at the
 * code, the bug is in X", "Reviewing this PR: LGTM") must not match. A trailing
 * ellipsis is allowed; any other `.!?`, colon, semicolon, or comma is not.
 * Inspection verbs also need an inspection object ("the workspace", "this PR"),
 * not copulas such as "is not needed".
 */
export declare function isProgressOnlyAssistantText(text: string): boolean;
export declare function shouldContinueProgressOnlyTurn(input: {
    allowTools: boolean;
    advertisedToolCount: number;
    assistantText: string;
    emittedHostTools: number;
    continuationAttempts: number;
    pendingExecs: number;
}): boolean;
export declare function progressOnlyContinuationPrompt(workspaceRoot?: string): string;
