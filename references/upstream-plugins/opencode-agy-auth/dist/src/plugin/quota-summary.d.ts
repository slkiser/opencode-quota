import type { GetAuth, PluginClient } from "./types";
export declare const AGY_QUOTA_SUMMARY_TOOL_NAME = "agy_quota_summary";
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
