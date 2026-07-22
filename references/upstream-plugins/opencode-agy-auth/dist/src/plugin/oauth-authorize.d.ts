import type { AgyTokenExchangeResult } from '../sdk/oauth';
import type { PluginClient } from './types';
/**
 * Builds the OAuth authorization callback for the plugin authentication method.
 */
export declare function createOAuthAuthorizeMethod(options?: {
    client?: PluginClient;
    getConfiguredProjectId?: () => Promise<string | undefined> | string | undefined;
    getUserAgentModel?: () => Promise<string | undefined> | string | undefined;
}): () => Promise<{
    url: string;
    instructions: string;
    method: 'code';
    callback: (callbackUrl: string) => Promise<AgyTokenExchangeResult>;
}>;
