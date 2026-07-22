import type { GeminiApiBody, GeminiUsageMetadata } from "./types";
/**
 * Parses the Gemini API response body; handles array-wrapped responses sometimes returned by the API.
 */
export declare function parseGeminiApiBody(rawText: string): GeminiApiBody | null;
/**
 * Extracts usageMetadata from the response object with type-safe guards.
 */
export declare function extractUsageMetadata(body: GeminiApiBody): GeminiUsageMetadata | null;
