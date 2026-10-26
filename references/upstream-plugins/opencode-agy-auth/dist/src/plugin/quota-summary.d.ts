import type { GetAuth, PluginClient } from "./types";
export declare const AGY_QUOTA_SUMMARY_TOOL_NAME = "agy_quota_summary";
export declare const AGY_V2_QUOTA_SUMMARY_COMMAND = "agy-quota-summary";
export declare const AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE = "Retrieve Agy Code Assist quota summary (weekly and 5-hour limits by model group) for the current authenticated account.\n\nImmediately call `agy_quota_summary` with no arguments and return its output verbatim.\nDo not call other tools.\n";
interface AgyQuotaSummaryToolDependencies {
    client: PluginClient;
    getAuthResolver: () => GetAuth | undefined;
    getConfiguredProjectId: () => string | undefined;
    getUserAgentModel: () => string | undefined;
}
export declare function createAgyQuotaSummaryTool({ client, getAuthResolver, getConfiguredProjectId, getUserAgentModel, }: AgyQuotaSummaryToolDependencies): {
    description: string;
    args: {};
    execute(args: Record<string, never>, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
export {};
