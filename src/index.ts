/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */

export type {
  JsonV1Adapter,
  JsonV1Mapping,
  JsonV1Metric,
  JsonV1NumberSource,
  JsonV1Path,
  JsonV1TextSource,
  JsonV1TimestampEncoding,
  JsonV1TimestampSource,
  LocalEstimateQuotaProviderDefinition,
  LocalEstimateWindow,
  QuotaProviderDefinition,
  QuotaProviderRemoteFormat,
  RemoteApiQuotaProviderDefinition,
} from "./lib/quota-providers.js";
// Re-export types for consumers (types are erased at runtime, so safe to export)
export {
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  QUOTA_PROVIDER_WINDOW_TYPES,
  validateQuotaProviders,
} from "./lib/quota-providers.js";
export type {
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaResult,
} from "./lib/types.js";
export { default } from "./plugin.js";
export type { Settings, SettingsPatch } from "./settings/index.js";
