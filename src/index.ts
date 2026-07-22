/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */

import { QuotaToastPlugin } from "./plugin.js";

type V1PluginModule = {
  id: string;
  server: typeof QuotaToastPlugin;
};

// V1 plugin format: default export with id + server.
// This avoids the legacy getLegacyPlugins fallback path in OpenCode's plugin
// loader, which iterates Object.values(mod) and can conflict with other
// plugins that also use the legacy path.
const pluginModule = {
  id: "@slkiser/opencode-quota",
  server: QuotaToastPlugin,
} satisfies V1PluginModule;

export default pluginModule;

// Keep the named export for backward compatibility with consumers that import
// { QuotaToastPlugin } directly.
export { QuotaToastPlugin } from "./plugin.js";

// Re-export types for consumers (types are erased at runtime, so safe to export)
export {
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  QUOTA_PROVIDER_WINDOW_TYPES,
  validateQuotaProviders,
} from "./lib/quota-providers.js";
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

export type {
  QuotaToastConfig,
  MaintainerAnnouncementsConfig,
  GoogleModelId,
  PricingSnapshotSource,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaResult,
  GoogleQuotaResult,
  GoogleModelQuota,
  MiniMaxResult,
  MiniMaxResultEntry,
} from "./lib/types.js";
