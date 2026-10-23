export type OpencodeJson = {
    instructions?: string[];
    permission?: unknown;
    plugin?: string[];
    plugins?: string[];
    mcp?: Record<string, unknown>;
};
/** Same truthy rule as OpenCode's Flag.OPENCODE_DISABLE_PROJECT_CONFIG. */
export declare function isProjectConfigDisabled(): boolean;
/**
 * Merged `opencode.json` / `opencode.jsonc` for MCP server ids, plugin lists,
 * and interaction guidance. Instruction file bodies are not collected here.
 */
export declare function loadMergedConfig(workspaceRoot: string): Promise<OpencodeJson>;
