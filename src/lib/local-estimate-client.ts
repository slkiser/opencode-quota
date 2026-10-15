import { HistoryHelperClient } from "../gui/history-client.js";
import type { LocalQuotaDefinition } from "./quota-provider-definitions.js";
import type { QuotaProviderResult } from "./entries.js";
import type { QuotaToastConfig } from "./types.js";
let helper: HistoryHelperClient | null = null,
  active = 0;
/** One short-lived serialized native worker for concurrent local sources; no CLI handle leak. */
export async function fetchLocalQuotaEstimate(
  definition: LocalQuotaDefinition,
  pricing: QuotaToastConfig["pricingSnapshot"],
): Promise<QuotaProviderResult> {
  const selected = (helper ??= new HistoryHelperClient());
  active++;
  try {
    return await selected.request<QuotaProviderResult>({
      operation: "local-estimate",
      definition,
      now: Date.now(),
      pricing,
    });
  } catch {
    return {
      attempted: true,
      entries: [],
      errors: [
        {
          label: definition.label,
          message: "Local quota estimate unavailable (source, journal or native helper)",
        },
      ],
    };
  } finally {
    if (--active === 0) {
      selected.dispose();
      if (helper === selected) helper = null;
    }
  }
}
