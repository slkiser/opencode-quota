import { executeOpenCodeWebSearch } from "./web-tools.js";
type ToolFactory = {
    tool: (input: Record<string, unknown>) => Record<string, unknown>;
    schema: {
        string: () => any;
        number: () => any;
        enum: (values: readonly string[]) => any;
    };
};
/** Build the classic OpenCode web-search tool with the host's own Zod helper. */
export declare function createOpenCodeWebSearchTool(factory: ToolFactory): Record<string, unknown>;
/**
 * Host-neutral JSON-schema fallback when the classic helper is unavailable.
 * OpenCode's legacy schema adapter marks every listed property required, so
 * expose only the genuinely required query rather than turning four optional
 * tuning fields into mandatory inputs.
 */
export declare const openCodeWebSearchTool: {
    description: string;
    args: {
        query: {
            type: string;
            description: string;
        };
    };
    execute: typeof executeOpenCodeWebSearch;
};
export type { ToolFactory as OpenCodeToolFactory };
export declare function createOpenCodeWebSearchToolFromPlugin(pluginModule: any): Record<string, unknown>;
