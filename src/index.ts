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
  id: "@thanhndv212/opencode-quota",
  server: QuotaToastPlugin,
} satisfies V1PluginModule;

export default pluginModule;

// Keep the named export for backward compatibility with consumers that import
// { QuotaToastPlugin } directly.
export { QuotaToastPlugin } from "./plugin.js";

export type {
  AccountingDocument,
  AccountingRow,
  AccountingQuantity,
  AccountingUnit,
  AccountingAuthority,
  AccountingBasisFact,
  AccountingResultType,
} from "./lib/accounting.js";

// Re-export types for consumers (types are erased at runtime, so safe to export)
export type {
  QuotaToastConfig,
  MaintainerAnnouncementsConfig,
  GoogleModelId,
  PricingSnapshotSource,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaResult,
  CopilotPlanResult,
  CopilotBudgetResult,
  CopilotBillingModel,
  GoogleQuotaResult,
  GoogleModelQuota,
  MiniMaxResult,
  MiniMaxResultEntry,
} from "./lib/types.js";
