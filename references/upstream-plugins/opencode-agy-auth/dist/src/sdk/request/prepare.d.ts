export interface ThinkingConfigDefaults {
    provider?: unknown;
    models?: Record<string, unknown>;
}
/**
 * Rewrites OpenAI-style requests into the format for Gemini Code Assist requests.
 */
export declare function prepareAgyRequest(input: RequestInfo, init: RequestInit | undefined, accessToken: string, projectId: string, thinkingConfigDefaults?: ThinkingConfigDefaults): {
    request: RequestInfo;
    init: RequestInit;
    streaming: boolean;
    requestedModel?: string;
    sessionId?: string;
};
