import { type GeminiApiBody, type GeminiErrorEnhancement } from "./types";
/**
 * Enhances 404 errors for Gemini 3 models with direct preview access information.
 */
export declare function rewriteGeminiPreviewAccessError(body: GeminiApiBody, status: number, requestedModel?: string): GeminiApiBody | null;
/**
 * Enhances Gemini errors with validation/quota messages and retry hints.
 */
export declare function enhanceGeminiErrorResponse(body: GeminiApiBody, status: number): GeminiErrorEnhancement | null;
