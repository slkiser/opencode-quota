export const TOOL_RESULT_STATUS_KEY = "opencodeToolResult";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value : undefined;
export function nativeToolFailure(value, refusal) {
    const envelope = record(value);
    const error = record(envelope?.error);
    const type = typeof error?.type === "string" && error.type ? error.type : "tool.execution";
    const message = typeof error?.message === "string" && error.message
        ? error.message : typeof value === "string" && value ? value : `OpenCode tool failed (${type})`;
    const content = Array.isArray(envelope?.content) ? envelope.content.flatMap(item => {
        const part = record(item);
        return part?.type === "text" && typeof part.text === "string" && part.text ? [part.text] : [];
    }).join("\n") : "";
    return { type, text: content ? `${message}\n\n${content}` : message,
        ...(refusal ? { refusal } : type === "permission.rejected" ? { refusal: "rejected" } : {}) };
}
/** The native tool hook preserves the underlying typed permission cause. */
export function nativeToolRefusal(error) {
    const seen = new Set();
    for (let depth = 0; depth < 16 && !seen.has(error); depth++) {
        seen.add(error);
        const cause = record(error);
        if (!cause)
            return undefined;
        if (cause._tag === "Permission.BlockedError")
            return "permission_denied";
        if (cause._tag === "Permission.CorrectedError" || cause._tag === "Permission.DeclinedError")
            return "rejected";
        error = cause.error;
    }
    return undefined;
}
/** Metadata travels with each part, including history and independently loaded SDK copies. */
export function preserveNativeToolResults(messages, refusals = new Map()) {
    if (!Array.isArray(messages))
        return [];
    return messages.map(message => {
        const msg = record(message);
        if (msg?.role !== "tool" || !Array.isArray(msg.content))
            return message;
        return { ...msg, content: msg.content.map(item => {
                const part = record(item);
                const result = record(part?.result);
                if (part?.type !== "tool-result" || typeof part.id !== "string" || !result
                    || typeof result.type !== "string" || !["error", "text", "json", "content"].includes(result.type))
                    return item;
                const metadata = record(part.providerMetadata);
                const cursor = record(metadata?.cursor);
                const status = result.type === "error"
                    ? { callID: part.id, status: "error", failure: nativeToolFailure(result.value, refusals.get(part.id)) }
                    : { callID: part.id, status: "completed" };
                return { ...part, providerMetadata: { ...metadata, cursor: { ...cursor, [TOOL_RESULT_STATUS_KEY]: status } } };
            }) };
    });
}
export function toolResultFailure(options, callID) {
    const status = record(record(record(options)?.cursor)?.[TOOL_RESULT_STATUS_KEY]);
    if (status?.callID !== callID || status.status !== "error")
        return undefined;
    const failure = record(status.failure);
    if (!failure || typeof failure.type !== "string" || typeof failure.text !== "string")
        return undefined;
    const refusal = failure.refusal === "permission_denied" || failure.refusal === "rejected" ? failure.refusal : undefined;
    return { type: failure.type, text: failure.text || `OpenCode tool failed (${failure.type || "tool.execution"})`,
        ...(refusal ? { refusal } : {}) };
}
