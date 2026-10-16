import { AGY_V2_QUOTA_COMMAND, AGY_V2_QUOTA_COMMAND_TEMPLATE } from './quota';
import { AGY_V2_QUOTA_SUMMARY_COMMAND, AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE } from './quota-summary';
import { type OpenCodeV2PluginContext, type OpenCodeV2PluginDefinition } from './types';
export { getSafeHeader, setSafeHeaders, toUrlString } from './headers';
export { resolveModelTier } from './tier';
export { getDiskSignatureCache, resetDiskSignatureCacheForTesting } from './cache';
export { loadStoredAuthFromJson, saveStoredAuthToJson, setStoredAuthOverrideForTesting, } from './v2-storage';
export { createV2FetchInterceptor } from './v2-fetch';
export { AGY_V2_QUOTA_COMMAND, AGY_V2_QUOTA_SUMMARY_COMMAND, AGY_V2_QUOTA_COMMAND_TEMPLATE, AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE, };
/**
 * Setup adapter for OpenCode v2 plugin architecture.
 */
export declare function setupOpenCodeV2(ctx: OpenCodeV2PluginContext): Promise<void>;
export declare const v2PluginDefinition: OpenCodeV2PluginDefinition;
export declare const createV2PluginDefinition: () => OpenCodeV2PluginDefinition;
