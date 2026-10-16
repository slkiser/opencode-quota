/**
 * Configured MCP servers that own at least one advertised tool. Uses the same
 * server resolution as the RequestContext descriptors, so guidance never names
 * a server Cursor was not given. `toolNames` are OpenCode ids (alias
 * `sourceName` when present).
 */
export declare function listAdvertisedMcpServers(toolNames: Iterable<string>, knownMcpServers?: Iterable<string>): string[];
/**
 * Shared system-guidance line: name advertised dynamic-catalog tools and prefer
 * them over Grep/Shell when skills or project rules apply. Concrete skill ids
 * stay out of the frozen baseline (they live in the host system prompt / skill
 * tool, and in host `<system-update>` when the catalog changes — same split as
 * OpenCode's SkillGuidance / SkillInstructions).
 */
export declare function buildDynamicCatalogRoutingInstruction(options: {
    toolNames: Iterable<string>;
    knownMcpServers?: Iterable<string>;
}): string | undefined;
