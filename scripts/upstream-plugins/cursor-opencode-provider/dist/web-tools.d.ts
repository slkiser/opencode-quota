import type { ToolContext, ToolResult } from "@opencode-ai/plugin";
export type OpenCodeWebSearchArgs = {
    query: string;
    numResults?: number;
    livecrawl?: "fallback" | "preferred";
    type?: "auto" | "fast" | "deep";
    contextMaxCharacters?: number;
};
export declare function parseOpenCodeWebSearchResponse(raw: string): string | undefined;
/**
 * Raw Exa web-search call: no host tool context, no permission prompt.
 *
 * Split out so both the classic plugin's `custom_websearch` tool and the
 * OpenCode 2.0 plugin's tool registration share one implementation — 2.0's
 * ToolContext has no `ask`, permissions being handled by the host instead.
 */
export type OpenCode2WebSearchResult = {
    url: string;
    title?: string;
    content?: string;
    time: {
        published?: number;
    };
};
/**
 * Turn an Exa MCP text blob into OpenCode 2.0 `websearch` results
 * (`{ url, title?, content?, time }`). Unknown shapes yield an empty list.
 */
export declare function parseExaWebSearchResults(raw: string): OpenCode2WebSearchResult[];
export declare function fetchOpenCodeWebSearchText(args: OpenCodeWebSearchArgs, signal: AbortSignal | undefined, fetchImpl?: typeof fetch): Promise<string>;
export declare function executeOpenCodeWebSearch(args: OpenCodeWebSearchArgs, context: ToolContext, fetchImpl?: typeof fetch): Promise<ToolResult>;
