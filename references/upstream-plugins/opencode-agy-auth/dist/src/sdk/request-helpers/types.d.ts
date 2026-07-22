export declare const GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";
export interface GeminiApiError {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown[];
    [key: string]: unknown;
}
/**
 * The minimal representation of the Gemini API response we touch.
 */
export interface GeminiApiBody {
    response?: unknown;
    error?: GeminiApiError;
    [key: string]: unknown;
}
export interface GeminiErrorEnhancement {
    body?: GeminiApiBody;
    retryAfterMs?: number;
}
/**
 * Usage metadata exposed by Gemini responses. Fields are optional to reflect partial payloads.
 */
export interface GeminiUsageMetadata {
    totalTokenCount?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
}
/**
 * Thinking configuration accepted by Gemini.
 */
export interface ThinkingConfig {
    thinkingBudget?: number;
    thinkingLevel?: string;
    includeThoughts?: boolean;
}
export interface GoogleRpcErrorInfo {
    "@type"?: string;
    reason?: string;
    domain?: string;
    metadata?: Record<string, string>;
}
export interface GoogleRpcHelp {
    "@type"?: string;
    links?: Array<{
        description?: string;
        url?: string;
    }>;
}
export interface GoogleRpcQuotaFailure {
    "@type"?: string;
    violations?: Array<{
        subject?: string;
        description?: string;
    }>;
}
export interface GoogleRpcRetryInfo {
    "@type"?: string;
    retryDelay?: string | {
        seconds?: number;
        nanos?: number;
    };
}
export declare const CLOUDCODE_DOMAINS: string[];
