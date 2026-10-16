import type { AgyTokenExchangeResult } from '../sdk/oauth';
import type { PluginClient } from './types';
/**
 * Builds the OAuth authorization callback for the plugin authentication method.
 */
export declare function createOAuthAuthorizeMethod(options?: {
    client?: PluginClient;
    getConfiguredProjectId?: () => Promise<string | undefined> | string | undefined;
    getUserAgentModel?: () => Promise<string | undefined> | string | undefined;
    openBrowser?: (url: string) => void;
}): () => Promise<{
    url: string;
    instructions: string;
    method: 'code';
    callback: (callbackUrl: string) => Promise<AgyTokenExchangeResult>;
}>;
export declare function parseOAuthCallbackInput(input: string): {
    code?: string;
    state?: string;
};
export declare function setOpenBrowserLauncherForTesting(launcher: typeof openBrowserLauncher | null): void;
export declare function defaultOpenBrowserLauncher(command: string, args: string[]): void;
declare let openBrowserLauncher: typeof defaultOpenBrowserLauncher;
export {};
