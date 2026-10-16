import type { PluginContext, PluginResult } from './plugin/types';
import { STATIC_MODELS_SIMPLE, TIER_MAPPING, resolveModelTier, type SimpleStaticModel } from './plugin/tier';
export { STATIC_MODELS_SIMPLE, TIER_MAPPING, resolveModelTier, type SimpleStaticModel };
/**
 * Registers the Agy OAuth provider for Opencode.
 */
export declare const AgyCLIOAuthPlugin: ({ client }: PluginContext) => Promise<PluginResult>;
export declare const GoogleOAuthPlugin: typeof AgyCLIOAuthPlugin;
