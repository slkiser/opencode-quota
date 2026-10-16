import type { ChatLogger } from "../chat-logger";
/**
 * Normalizes Gemini/Agy responses, preserving request metadata and usage counters.
 */
export declare function transformAgyResponse(response: Response, streaming: boolean, _ignoredDebugContext?: any, requestedModel?: string, sessionId?: string, chatLogger?: ChatLogger | null): Promise<Response>;
