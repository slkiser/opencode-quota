/**
 * Returns the URL string for supported RequestInfo inputs.
 */
export declare function toRequestUrlString(value: RequestInfo): string;
/**
 * Detects Gemini/Generative Language API requests via URL.
 */
export declare function isGenerativeLanguageRequest(input: RequestInfo): input is string;
export declare function parseGenerativeLanguageRequest(input: RequestInfo): {
    requestedModel: string;
    effectiveModel: string;
    action: string;
} | undefined;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function readString(value: unknown): string | undefined;
export declare function pickString(...values: unknown[]): string | undefined;
/**
 * Preserves Cloud Code trace identity for downstream clients by mapping traceId to responseId.
 */
export declare function injectResponseIdFromTrace<T extends Record<string, unknown>>(body: T): T;
