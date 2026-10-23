import { restoreOpenCodeTimeout } from "./shell-timeout.js";
/**
 * OpenCode 1 exposes interrupted partial output as successful SDK output:
 * https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/message-v2.ts#L325-L346
 * Its shell also completes with exit:null after cancellation and appends its
 * own metadata block (tool/shell.ts L542-L589). Preserve failure in the model
 * projection while retaining progress text. A timed-out shell is stored with
 * a display notice in place of that block and only `state.output` reaches the
 * model, so the projection restores the block. Stored messages are not mutated.
 */
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
export function normalizeClassicInterruptedResults(messages) {
    return messages.map(message => {
        const msg = record(message);
        if (!msg || !Array.isArray(msg.parts))
            return message;
        return { ...msg, parts: msg.parts.map(item => {
                const part = record(item);
                const state = record(part?.state);
                if (part?.type !== "tool" || typeof part.callID !== "string" || !part.callID.startsWith("cursor_") || !state)
                    return item;
                const metadata = record(state.metadata);
                const timeoutMs = metadata?.cursorShellTimeoutMs;
                if (state.status === "completed" && part.tool === "bash" && typeof state.output === "string"
                    && typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs) && timeoutMs >= 0) {
                    return { ...part, state: { ...state, output: restoreOpenCodeTimeout(state.output, timeoutMs) } };
                }
                const partialError = state.status === "error" && metadata?.interrupted === true;
                // Null exit and the native trailing block must agree. Ordinary successful
                // stdout can legitimately contain the same words or markup.
                const shellAbort = state.status === "completed" && part.tool === "bash" && metadata?.exit === null
                    && typeof state.output === "string" && /<shell_metadata>\r?\nUser aborted the command\r?\n<\/shell_metadata>\s*$/.test(state.output);
                if (!partialError && !shellAbort)
                    return item;
                const message = typeof state.error === "string" && state.error ? state.error : "Tool execution interrupted";
                const progress = shellAbort ? state.output : typeof metadata?.output === "string" ? metadata.output : "";
                const { output: _output, title: _title, attachments: _attachments, ...base } = state;
                return { ...part, state: { ...base, status: "error", error: progress ? `${message}\n\n${progress}` : message,
                        metadata: { ...metadata, interrupted: false } } };
            }) };
    });
}
