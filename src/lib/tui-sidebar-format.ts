import { sanitizeQuotaRenderData } from "./display-sanitize.js";
import { formatQuotaRows } from "./format.js";
import { wrapDisplayText } from "./format-utils.js";
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
  config: Pick<QuotaToastConfig, "formatStyle" | "percentDisplayMode" | "resetTimeDecimals"> &
    Partial<
      Pick<
        QuotaToastConfig,
        "accountingDetail" | "percentLabelStyle" | "quotaProjection" | "resetTimeSpaced"
      >
    >;
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
    wrapLabels: params.config.quotaProjection === "runway",
    sessionTokens: data.sessionTokens,
  });
  if (!quotaBody) return [];
  // The formatter fits every bar and value row to the sidebar width. Only free text
  // (errors, notices) runs longer, and the TUI would cut it, so wrap it here.
  return quotaBody
    .split("\n")
    .flatMap((line) =>
      line.length > TUI_SIDEBAR_MAX_WIDTH ? wrapDisplayText(line, TUI_SIDEBAR_MAX_WIDTH) : [line],
    );
}
