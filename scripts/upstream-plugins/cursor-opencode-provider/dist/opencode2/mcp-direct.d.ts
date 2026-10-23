import type { ToolDraft } from "./types.js";
/**
 * OpenCode 2 puts an MCP server's tools in Code Mode unless that server's
 * config sets `codemode: false` (`packages/schema/src/mcp.ts`, applied in
 * `packages/core/src/tool/mcp.ts`). Only `options.codemode === false` joins
 * the AI SDK catalog (`packages/core/src/tool.ts`). This provider can advertise
 * a tool to Cursor only when it is in that catalog.
 *
 * That AI SDK placement is necessary but not sufficient for Cursor models:
 * non-native tools are still invoked through GetDynamicTools / CallDynamicTool
 * (see `src/context/dynamic-catalog.ts`, issue #29). Classic OpenCode 1.x already
 * puts MCP tools in the AI SDK catalog; this module is the OpenCode 2 equivalent.
 *
 * `config.codemode` is also the remote-connection switch: while it is not
 * false, OpenCode appends `?codemode=false` so servers that bundle their own
 * Code Mode return individual tools (`packages/core/src/mcp/client.ts`).
 * This module therefore leaves server config alone and clears the tool option
 * instead. An explicit server `codemode: true` stays in Code Mode. OpenCode's
 * own namespaced tools (the `opencode` namespace) are not MCP servers and are
 * left alone.
 *
 * The tool registry is location-scoped, so this placement is shared by every
 * provider in the process. `"codemode": true` on a server is the per-server
 * way to keep that server inside `execute`.
 */
export declare function mcpServerNamespace(server: string): string;
export declare function rememberDirectMcpNamespaces(target: Set<string>, servers: readonly (readonly [string, {
    readonly codemode?: boolean;
}])[]): void;
/** Move tools from the recorded MCP namespaces onto the direct catalog. */
export declare function exposeDirectMcpTools(editor: ToolDraft, namespaces: ReadonlySet<string>): void;
