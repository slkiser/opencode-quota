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
export function mcpServerNamespace(server) {
    return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}
export function rememberDirectMcpNamespaces(target, servers) {
    target.clear();
    // The editor exposes normalized namespaces, not server ownership. Keep
    // ambiguous namespaces in their host-selected placement: otherwise a server
    // named `opencode` moves builtins too, or `my.docs` overrides an explicit
    // Code Mode choice on `my_docs`. Exclusions must win regardless of order.
    const excluded = new Set(["opencode"]);
    for (const [name, config] of servers) {
        const namespace = mcpServerNamespace(name);
        if (config.codemode === true)
            excluded.add(namespace);
        else
            target.add(namespace);
    }
    for (const namespace of excluded)
        target.delete(namespace);
}
/** Move tools from the recorded MCP namespaces onto the direct catalog. */
export function exposeDirectMcpTools(editor, namespaces) {
    if (namespaces.size === 0 || !editor.list || !editor.update)
        return;
    for (const tool of editor.list()) {
        const namespace = tool.options?.namespace;
        if (!namespace || !namespaces.has(namespace))
            continue;
        if (tool.options?.codemode === false)
            continue;
        editor.update(tool.id, (draft) => {
            const options = {};
            if (draft.options?.namespace !== undefined)
                options.namespace = draft.options.namespace;
            if (draft.options?.permission !== undefined)
                options.permission = draft.options.permission;
            options.codemode = false;
            draft.options = options;
        });
    }
}
