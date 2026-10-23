type AgentUrlOptions = {
    apiBaseURL?: string;
    baseURL?: string;
    telemetryEnabled?: boolean;
    timeoutMs?: number;
};
/**
 * Resolve the Run stream origin for this account via the `GetServerConfig`
 * Connect RPC. Memoized for the process lifetime.
 *
 *   - already resolved → return the memo (no fetch)
 *   - otherwise → fetch `agentUrlConfig.agentnUrl` (then `agentUrl`), memoize, return
 *   - fetch fails / no valid `agentUrlConfig` → throw (no global-host fallback)
 *
 * Concurrent callers share a single in-flight fetch.
 */
export declare function resolveAgentUrl(token: string, options?: AgentUrlOptions): Promise<string>;
/** Reset the in-process memo. Tests only. */
export declare function resetAgentUrlCache(): void;
export {};
