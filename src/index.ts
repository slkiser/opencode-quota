/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */

// Main plugin export - ONLY export plugin functions from the main entry point
// OpenCode's plugin loader iterates over all exports and calls them as functions
export { QuotaToastPlugin } from "./plugin.js";

// Re-export types for consumers (types are erased at runtime, so safe to export)
export type {
  QuotaToastConfig,
  GoogleModelId,
  PricingSnapshotSource,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaResult,
  GoogleQuotaResult,
  GoogleModelQuota,
} from "./lib/types.js";

// NOTE: tool exports are part of the plugin runtime contract and are not
// exported from the package entrypoint.

// NOTE: DEFAULT_CONFIG is NOT exported here because OpenCode's plugin loader
// would try to call it as a function. Import from "./lib/types.js" directly if needed.
