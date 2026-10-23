import type { GetAuth, PluginClient } from "./types";
export declare const AGY_QUOTA_TOOL_NAME = "agy_quota";
export declare const AGY_V2_QUOTA_COMMAND = "agy-quota";
export declare const AGY_V2_QUOTA_COMMAND_TEMPLATE = "Retrieve Agy Code Assist quota usage for the current authenticated account.\n\nImmediately call `agy_quota` with no arguments and return its output verbatim.\nDo not call other tools.\n";
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
