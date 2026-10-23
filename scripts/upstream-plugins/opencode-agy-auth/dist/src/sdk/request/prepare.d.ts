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
export declare const LEGACY_MODEL_ENUM_FALLBACKS: Record<string, string>;
export declare function getModelEnum(modelName: string): string;
export declare function isClaudeModel(model: string): boolean;
export declare function sanitizeClaudeThinkingParts(contents: any[], model: string, sessionId?: string): void;
export declare function ensureTrailingUserTurn(contents: any[]): any[];
