import type { GetAuth, PluginClient } from "./types";
export declare const AGY_QUOTA_TOOL_NAME = "agy_quota";
interface AgyQuotaToolDependencies {
    client: PluginClient;
    getAuthResolver: () => GetAuth | undefined;
    getConfiguredProjectId: () => string | undefined;
    getUserAgentModel: () => string | undefined;
}
export declare function createAgyQuotaTool({ client, getAuthResolver, getConfiguredProjectId, getUserAgentModel, }: AgyQuotaToolDependencies): {
    description: string;
    args: {};
    execute(args: Record<string, never>, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
export {};
