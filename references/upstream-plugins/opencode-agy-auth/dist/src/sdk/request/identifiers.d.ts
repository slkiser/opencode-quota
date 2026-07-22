/**
 * Applies canonical identifiers for wrapped Code Assist payloads.
 */
export declare function normalizeWrappedIdentifiers(wrapped: Record<string, unknown>): {
    userPromptId: string;
    sessionId: string;
    requestId: string;
};
/**
 * Applies canonical identifiers for unwrapped request payloads prior to wrapping.
 */
export declare function normalizeRequestPayloadIdentifiers(payload: Record<string, unknown>): {
    userPromptId: string;
    sessionId: string;
    requestId: string;
};
