import type { PluginContext, PluginResult } from './plugin/types';
/**
 * Registers the Agy OAuth provider for Opencode.
 */
export declare const AgyCLIOAuthPlugin: ({ client }: PluginContext) => Promise<PluginResult>;
export declare const GoogleOAuthPlugin: typeof AgyCLIOAuthPlugin;
