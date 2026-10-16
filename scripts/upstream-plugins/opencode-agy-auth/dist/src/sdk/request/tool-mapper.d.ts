/**
 * Tool Name Schema Mapping for Gemini API
 *
 * Gemini API tool schemas strictly enforce function names matching `^[a-zA-Z_][a-zA-Z0-9_]*$`.
 * Agent frameworks (MCP servers, OpenCode plugins, OpenAI adapters) often use hyphens (-), dots (.),
 * slashes (/), or colons (:) in tool names (e.g. `context7_resolve_library_id`, `atlassian:get-issue`, `my-tool`).
 *
 * This module maintains a bidirectional mapping between original client tool names and Gemini-compliant tool names,
 * resolving collisions deterministically and persisting session mappings across multi-turn tool loops.
 */
export declare function sanitizeToolName(name: string): string;
export declare class ToolMapper {
    private originalToSanitized;
    private sanitizedToOriginal;
    /**
     * Register a tool name and get its Gemini-compliant sanitized name.
     * Handles naming collisions by appending a numeric suffix if needed.
     */
    register(originalName: string): string;
    /**
     * Map an original tool name to sanitized Gemini name.
     * If not already registered, registers it on the fly.
     */
    toGemini(originalName: string): string;
    /**
     * Restore a sanitized Gemini tool name back to the original client tool name.
     */
    fromGemini(sanitizedName: string): string;
    /**
     * Register tools from Gemini `tools[].functionDeclarations` array.
     */
    registerFromFunctionDeclarations(tools: unknown): void;
    /**
     * Register tools from OpenAI format `tools[].function.name`.
     */
    registerFromOpenAITools(tools: unknown): void;
    /**
     * Scan contents/messages to register any previously used tool names.
     */
    registerFromContents(contents: unknown): void;
}
export declare function getToolMapper(sessionId?: string): ToolMapper;
export declare function clearToolMapper(sessionId: string): void;
/**
 * Restores original client tool names inside Gemini candidates/parts functionCall objects.
 */
export declare function restoreToolNamesInResponse(body: unknown, toolMapper: ToolMapper): void;
