import { sanitizeQuotaRenderData } from "./display-sanitize.js";
import { formatQuotaRows } from "./format.js";
import type { QuotaRenderData } from "./quota-render-data.js";
import type { QuotaToastConfig } from "./types.js";

export const TUI_SIDEBAR_MAX_WIDTH = 36;
export const TUI_SIDEBAR_LAYOUT = {
  maxWidth: TUI_SIDEBAR_MAX_WIDTH,
  narrowAt: TUI_SIDEBAR_MAX_WIDTH,
  tinyAt: 20,
} as const;

export function buildSidebarQuotaPanelLines(params: {
  data: QuotaRenderData;
  config: Pick<
    QuotaToastConfig,
    | "formatStyle"
    | "percentDisplayMode"
    | "percentLabelStyle"
    | "resetTimeDecimals"
    | "resetTimeSpaced"
  > &
    Partial<Pick<QuotaToastConfig, "accountingDetail">>;
}): string[] {
  const data = sanitizeQuotaRenderData(params.data);

  const quotaBody = formatQuotaRows({
    version: "1.0.0",
    layout: TUI_SIDEBAR_LAYOUT,
    entries: data.entries,
    errors: data.errors,
    style: params.config.formatStyle,
    percentDisplayMode: params.config.percentDisplayMode,
    percentLabelStyle: params.config.percentLabelStyle,
    accountingDetail: params.config.accountingDetail,
    resetTimeDecimals: params.config.resetTimeDecimals,
    resetTimeSpaced: params.config.resetTimeSpaced,
    sessionTokens: data.sessionTokens,
  });
  return quotaBody ? quotaBody.split("\n") : [];
}
