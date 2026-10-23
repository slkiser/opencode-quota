/**
 * Host notes (OpenCode `<system-update>` and read-tool instructions) in the
 * shapes Cursor's own clients give model-visible context:
 * - mid-turn, plain text in a `user_context` injection, as Cursor SDK
 *   `Run.steer` sends it (no wrapper: wrapped text was refused live);
 * - on a later user turn, a `<system_reminder>` block in the message text;
 * - provider notices about one exec result, as postToolUse hook context.
 */
/** Cursor CLI rejects a hook additional_context longer than this. */
export declare const HOOK_ADDITIONAL_CONTEXT_MAX_CHARS = 10000;
/** Stable delivery order survives asynchronous acknowledgements and Run recovery. */
export type HostNoteBatch = {
    notes: string[];
    order: number;
};
export type HookAdditionalContext = {
    hook_event_name: string;
    content: string;
};
/** Plain note text for one mid-turn injection, in host order. */
export declare function hostNoteText(notes: readonly string[]): string;
/**
 * One postToolUse hook context per note, trimmed like Cursor CLI's carrier.
 * A note over the CLI limit is split rather than dropped, so no text is lost.
 */
export declare function hostNoteHookContexts(notes: readonly string[]): HookAdditionalContext[];
/** One `<system_reminder>` block per note, for a user turn's text. */
export declare function wrapHostNoteForCursor(text: string): string;
export declare function wrapHostNotesForCursor(notes: readonly string[]): string[];
export declare function encodePersistedHostNotes(notes: readonly string[]): string | undefined;
export declare function decodePersistedHostNotes(blob: string | undefined): string[];
