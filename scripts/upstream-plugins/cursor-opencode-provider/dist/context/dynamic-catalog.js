import { resolveToolServerIdentity } from "../protocol/tools.js";
/**
 * Issue #29: Cursor keeps OpenCode `skill` and MCP tools off its native
 * top-level function list. Both OpenCode 1.x and OpenCode 2.0 reach the model
 * as names in RequestContext `mcp_meta_tool_options`, then GetDynamicTools /
 * CallDynamicTool (exec `mcp_args`). This module builds the shared routing
 * guidance for both hosts.
 *
 * Skill names and descriptions are not repeated here: OpenCode puts them in
 * its own system prompt (`SystemPrompt.skills` / `SkillGuidance` /
 * `SkillInstructions`) and announces catalog changes itself (OpenCode 2
 * `<system-update>`).
 *
 * OpenCode 2 still needs `exposeDirectMcpTools` so MCP tools leave Code Mode
 * and enter the AI SDK catalog; without that step they never reach this
 * advertisement path at all.
 */
const MAX_MCP_SERVERS_IN_GUIDANCE = 8;
/** Synthetic server builtins and unknown tools are advertised under (`toolsToMcpDescriptors`). */
const DEFAULT_TOOL_SERVER = "opencode";
function listWithOverflow(items, limit) {
    const shown = items.slice(0, limit).map((item) => `\`${item}\``).join(", ");
    const hidden = items.length - limit;
    return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}
/**
 * Configured MCP servers that own at least one advertised tool. Uses the same
 * server resolution as the RequestContext descriptors, so guidance never names
 * a server Cursor was not given. `toolNames` are OpenCode ids (alias
 * `sourceName` when present).
 */
export function listAdvertisedMcpServers(toolNames, knownMcpServers = []) {
    const known = [...knownMcpServers];
    if (known.length === 0)
        return [];
    const servers = new Set();
    for (const name of toolNames) {
        const { server } = resolveToolServerIdentity(name, DEFAULT_TOOL_SERVER, known);
        if (server !== DEFAULT_TOOL_SERVER)
            servers.add(server);
    }
    return [...servers];
}
/**
 * Shared system-guidance line: name advertised dynamic-catalog tools and prefer
 * them over Grep/Shell when skills or project rules apply. Concrete skill ids
 * stay out of the frozen baseline (they live in the host system prompt / skill
 * tool, and in host `<system-update>` when the catalog changes — same split as
 * OpenCode's SkillGuidance / SkillInstructions).
 */
export function buildDynamicCatalogRoutingInstruction(options) {
    const names = [...options.toolNames];
    const hasSkill = names.includes("skill");
    const mcpServers = listAdvertisedMcpServers(names, options.knownMcpServers);
    if (!hasSkill && mcpServers.length === 0)
        return undefined;
    const extras = [];
    if (hasSkill)
        extras.push("`skill`");
    if (mcpServers.length > 0) {
        extras.push(`MCP servers such as ${listWithOverflow(mcpServers, MAX_MCP_SERVERS_IN_GUIDANCE)}`);
    }
    const lines = [
        `- OpenCode host tools that are not in Cursor's native top-level list (including ${extras.join(" and ")}) ` +
            "are reached through GetDynamicTools / CallDynamicTool (or the host's equivalent dynamic catalog). " +
            "When a skill matches or project rules name an MCP server, discover and call those tools that way " +
            "before Grep/Shell fallbacks. Do not narrate that they are unavailable. " +
            // Cursor's server answers lookups and calls in its own `cursor` namespace
            // (built-in tools such as GenerateImage) and rejects any other name there.
            `Host tools are in namespace \`${DEFAULT_TOOL_SERVER}\`` +
            (mcpServers.length > 0 ? " and MCP tools in their server's namespace" : "") +
            "; namespace `cursor` holds only Cursor's built-in tools.",
    ];
    if (hasSkill) {
        // Mirror OpenCode 1 SystemPrompt.skills / OC2 SkillInstructions.render.
        lines.push("- Skills provide specialized instructions and workflows for specific tasks. " +
            "Use the `skill` tool to load a skill when a task matches its description " +
            "(the host system prompt and `skill` tool carry names and descriptions). " +
            "A skill that is already present in the conversation as a `<skill_content>` block " +
            "does not need to be invoked again.");
    }
    return lines.join("\n");
}
