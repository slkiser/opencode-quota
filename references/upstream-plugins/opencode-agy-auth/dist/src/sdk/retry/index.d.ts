import { retryInternals } from "./quota";
declare function initCooldownPersistence(): void;
export { initCooldownPersistence };
/**
 * Sends a request with retry/exponential backoff semantics, consistent with Gemini/Agy CLI.
 */
export declare function fetchWithRetry(input: RequestInfo, init: RequestInit | undefined): Promise<Response>;
export declare function shutdownRetryCooldowns(): void;
export { retryInternals };
