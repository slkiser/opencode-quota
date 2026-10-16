import { executeOpenCodeWebSearch } from "./web-tools.js";
/** Build the classic OpenCode web-search tool with the host's own Zod helper. */
export function createOpenCodeWebSearchTool(factory) {
    const schema = factory.schema;
    return factory.tool({
        description: "Search the web for current information using OpenCode's web search backend.",
        args: {
            query: schema.string().describe("Web search query"),
            numResults: schema.number().int().min(1).max(20).optional(),
            livecrawl: schema.enum(["fallback", "preferred"]).optional(),
            type: schema.enum(["auto", "fast", "deep"]).optional(),
            contextMaxCharacters: schema.number().int().positive().optional(),
        },
        execute: executeOpenCodeWebSearch,
    });
}
/**
 * Host-neutral JSON-schema fallback when the classic helper is unavailable.
 * OpenCode's legacy schema adapter marks every listed property required, so
 * expose only the genuinely required query rather than turning four optional
 * tuning fields into mandatory inputs.
 */
export const openCodeWebSearchTool = {
    description: "Search the web for current information using OpenCode's web search backend.",
    args: {
        query: { type: "string", description: "Web search query" },
    },
    execute: executeOpenCodeWebSearch,
};
export function createOpenCodeWebSearchToolFromPlugin(pluginModule) {
    return createOpenCodeWebSearchTool({ tool: pluginModule.tool, schema: pluginModule.tool.schema });
}
