/**
 * Host notes (OpenCode `<system-update>` and read-tool instructions) in the
 * shapes Cursor's own clients give model-visible context:
 * - mid-turn, plain text in a `user_context` injection, as Cursor SDK
 *   `Run.steer` sends it (no wrapper: wrapped text was refused live);
 * - on a later user turn, a `<system_reminder>` block in the message text;
 * - provider notices about one exec result, as postToolUse hook context.
 */
const SYSTEM_UPDATE_OPEN = "<system-update>";
const SYSTEM_UPDATE_CLOSE = "</system-update>";
const SYSTEM_REMINDER_OPEN = "<system_reminder>";
const SYSTEM_REMINDER_CLOSE = "</system_reminder>";
/** Cursor CLI's hook event name for context attached to a tool result. */
const POST_TOOL_USE_HOOK_EVENT = "postToolUse";
/** Cursor CLI rejects a hook additional_context longer than this. */
export const HOOK_ADDITIONAL_CONTEXT_MAX_CHARS = 10_000;
/** Delimiter for ordered note bodies in the restart-snapshot `hostNote` string. */
const HOST_NOTE_PERSIST_SEP = "\n\u001e\n";
/** Plain note text for one mid-turn injection, in host order. */
export function hostNoteText(notes) {
    return notes.map(hostNoteBody).filter(Boolean).join("\n\n");
}
/**
 * One postToolUse hook context per note, trimmed like Cursor CLI's carrier.
 * A note over the CLI limit is split rather than dropped, so no text is lost.
 */
export function hostNoteHookContexts(notes) {
    return notes.flatMap((note) => {
        const body = hostNoteBody(note);
        const chunks = [];
        for (let start = 0; start < body.length;) {
            let end = Math.min(body.length, start + HOOK_ADDITIONAL_CONTEXT_MAX_CHARS);
            // Never split a surrogate pair.
            if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1]))
                end--;
            chunks.push(body.slice(start, end));
            start = end;
        }
        return chunks.map((content) => ({ hook_event_name: POST_TOOL_USE_HOOK_EVENT, content }));
    });
}
/** One `<system_reminder>` block per note, for a user turn's text. */
export function wrapHostNoteForCursor(text) {
    return `${SYSTEM_REMINDER_OPEN}\n${escapeReminderTags(hostNoteBody(text))}\n${SYSTEM_REMINDER_CLOSE}`;
}
export function wrapHostNotesForCursor(notes) {
    return notes.filter((note) => hostNoteBody(note).length > 0).map(wrapHostNoteForCursor);
}
export function encodePersistedHostNotes(notes) {
    const present = notes.filter((note) => note.length > 0);
    if (present.length === 0)
        return undefined;
    return present.join(HOST_NOTE_PERSIST_SEP);
}
export function decodePersistedHostNotes(blob) {
    if (!blob)
        return [];
    return blob.split(HOST_NOTE_PERSIST_SEP).filter((note) => note.length > 0);
}
/**
 * Unwrap OpenCode `<system-update>` blocks. One host message may hold several
 * (joined by `hostTailNote`); text that is not only such blocks stays as is.
 * Each block ends at the first closing tag after its opening tag. The scan is
 * linear: host text is untrusted, and a lazy regex rescans from every unclosed
 * opening tag.
 */
function hostNoteBody(text) {
    const trimmed = text.trim();
    const bodies = [];
    let rest = "";
    let index = 0;
    for (;;) {
        const open = trimmed.indexOf(SYSTEM_UPDATE_OPEN, index);
        if (open < 0)
            break;
        const bodyStart = open + SYSTEM_UPDATE_OPEN.length;
        const close = trimmed.indexOf(SYSTEM_UPDATE_CLOSE, bodyStart);
        if (close < 0)
            break;
        bodies.push(unescapeSystemUpdateText(trimmed.slice(bodyStart, close).trim()));
        rest += trimmed.slice(index, open);
        index = close + SYSTEM_UPDATE_CLOSE.length;
    }
    rest += trimmed.slice(index);
    return bodies.length > 0 && rest.trim() === ""
        ? bodies.filter(Boolean).join("\n\n")
        : trimmed;
}
/**
 * Inverse of OpenCode's `escapeSystemUpdateText` (`packages/llm/src/protocols/
 * shared.ts`): it escapes `&`, `<`, `>` inside the wrapper. `&amp;` goes last.
 */
function unescapeSystemUpdateText(text) {
    return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
/** Same neutralization Cursor CLI applies to text placed inside its reminders. */
function escapeReminderTags(text) {
    return text.replace(/system_reminder/gi, "system_reminder_");
}
