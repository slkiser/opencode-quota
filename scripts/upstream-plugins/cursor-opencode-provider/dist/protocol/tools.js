import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeMessage } from "./messages.js";
import { encodeJsonAsValue, decodeStructEntriesToJson, readAllFields } from "./struct.js";
import { buildEnv } from "../context/env.js";
import { ensureOpencodeProjectDir } from "../context/paths.js";
import { trace, traceRequestContextPaths } from "../debug.js";
import { cursorExecVariantByRequestName, FORCE_BACKGROUND_STATUS_ERROR, } from "./exec-variants.js";
import { APPLY_PATCH_TOOL, buildAddFilePatch, buildUpdateFilePatch, planSubstringEdit, } from "./apply-patch.js";
import { BACKGROUND_SHELL_MARKER, buildBackgroundShellCommand, } from "../shell-timeout.js";
import { normalizeOpencodeQuestionArgs } from "./ask-question.js";
import { normalizeOpencodeTodoArgs } from "../todo-store.js";
// Exec variant field number whose reply is the server-initiated request_context
// probe (ExecServerMessage #10 → ExecClientMessage #10). request/result share a
// field number for every exec variant, so this is also the result field.
export const REQUEST_CONTEXT_RESULT_FIELD = 10;
/** Check explicit required keys after normalization, before host execution. */
export function missingRequiredToolArguments(tool, args) {
    const schema = tool?.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
        return [];
    const required = schema.required;
    if (!Array.isArray(required))
        return [];
    return required.filter((key) => typeof key === "string" && (!Object.hasOwn(args, key) || args[key] === undefined));
}
/** Canonical file/search tools must not silently ignore a misplaced shell command. */
export function misplacedShellCommand(tool, args) {
    if (!tool || args.command === undefined)
        return false;
    if (!["read", "write", "edit", "grep", "glob", "ls"].includes(tool.name))
        return false;
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
        return false;
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
        return false;
    return !Object.hasOwn(properties, "command");
}
export const OPENCODE_1_TOOL_DIALECT = {
    filePathKey: "filePath",
    shellTool: "bash",
    skillArgKey: "name",
};
export const OPENCODE_2_TOOL_DIALECT = {
    filePathKey: "path",
    shellTool: "shell",
    skillArgKey: "id",
};
function jsonSchemaProperties(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
        return undefined;
    const obj = schema;
    if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
        return obj.properties;
    }
    const nested = obj.jsonSchema ?? obj.parameters ?? obj.schema;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const nestedProps = nested.properties;
        if (nestedProps && typeof nestedProps === "object" && !Array.isArray(nestedProps)) {
            return nestedProps;
        }
    }
    return undefined;
}
/** Prefer `filePath`, then `path` / `file_path` — Cursor and both OpenCode majors. */
export function opencodePathArg(args) {
    if (!args)
        return undefined;
    return str(args.filePath) ?? str(args.path) ?? str(args.file_path);
}
/**
 * Infer the host tool dialect from advertised AI SDK schemas.
 * OpenCode 2.0 read/edit/write require `path` and rename bash → `shell`.
 * Skill: OpenCode 1.x requires `name`; OpenCode 2.0 requires `id`.
 */
export function hostToolDialectFromTools(tools, defaultDialect = OPENCODE_1_TOOL_DIALECT) {
    let filePathKey;
    for (const name of ["read", "write", "edit"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        const props = jsonSchemaProperties(tool?.inputSchema);
        if (!props)
            continue;
        if ("path" in props && !("filePath" in props)) {
            filePathKey = "path";
            break;
        }
        if ("filePath" in props) {
            filePathKey = "filePath";
            break;
        }
    }
    const names = new Set(tools.map((tool) => tool.name).filter((name) => typeof name === "string"));
    const shellTool = names.has("shell") && !names.has("bash")
        ? "shell"
        : (names.has("bash") ? "bash" : defaultDialect.shellTool);
    if (!filePathKey) {
        // OpenCode 2 hosts advertise `shell` and `path` together; use that when schemas are opaque.
        filePathKey = shellTool === "shell" ? "path" : defaultDialect.filePathKey;
    }
    const skillProps = jsonSchemaProperties(tools.find((tool) => tool.name === "skill")?.inputSchema);
    let skillArgKey;
    if (skillProps) {
        if ("id" in skillProps && !("name" in skillProps))
            skillArgKey = "id";
        else if ("name" in skillProps)
            skillArgKey = "name";
    }
    if (!skillArgKey) {
        // Opaque skill schema: OpenCode 2 pairs `shell`+`path` with skill `id`.
        skillArgKey = shellTool === "shell" && filePathKey === "path"
            ? "id"
            : defaultDialect.skillArgKey;
    }
    const shellSchema = tools.find((tool) => tool.name === shellTool)?.inputSchema;
    const shellProps = jsonSchemaProperties(shellSchema);
    const description = shellProps?.description;
    const required = shellSchema && typeof shellSchema === "object" && !Array.isArray(shellSchema)
        ? shellSchema.required
        : undefined;
    return {
        filePathKey, shellTool, skillArgKey,
        ...(description && typeof description === "object"
            && description.type === "string"
            ? { shellDescription: Array.isArray(required) && required.includes("description")
                    ? "required" : "optional" }
            : {}),
    };
}
function assignHostFilePath(args, filePath, dialect) {
    delete args.filePath;
    delete args.path;
    delete args.file_path;
    if (filePath)
        args[dialect.filePathKey] = filePath;
}
export const CUSTOM_WEBSEARCH_TOOL = "custom_websearch";
export const CUSTOM_WEBFETCH_TOOL = "custom_webfetch";
export const CUSTOM_LIST_MCP_RESOURCES_TOOL = "custom_list_mcp_resources";
export const CUSTOM_READ_MCP_RESOURCE_TOOL = "custom_read_mcp_resource";
/** Match OpenCode's McpCatalog.sanitize for config server ids. */
export function sanitizeMcpServerId(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
/**
 * Resolve an OpenCode tool id using known MCP server ids from merged config.
 * Unknown names remain under the synthetic default server: a flattened tool
 * name alone cannot distinguish plugin/custom tools from `<server>_<tool>`.
 */
export function resolveToolServerIdentity(opencodeName, defaultServer = "opencode", knownMcpServers = []) {
    if (!opencodeName) {
        return { server: defaultServer, toolName: "mcp", opencodeName: "mcp" };
    }
    // Longest first handles configured ids where one is a prefix of another
    // (e.g. "git" and "git_hub"). OpenCode flattens with the sanitized id.
    const servers = [...new Set([...knownMcpServers].map(sanitizeMcpServerId).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
    for (const server of servers) {
        const prefix = `${server}_`;
        if (!opencodeName.startsWith(prefix) || opencodeName.length === prefix.length)
            continue;
        return {
            server,
            toolName: opencodeName.slice(prefix.length),
            opencodeName,
        };
    }
    return { server: defaultServer, toolName: opencodeName, opencodeName };
}
/**
 * Convert opencode's per-turn tool list into Cursor `McpToolDefinition`
 * entries for session exec remap / bridges. These are not sent on
 * RequestContext.tools (#7) or AgentRunRequest.mcp_tools (both omitted/empty
 * on the wire). Exec #36 still uses the same identity fields.
 *
 * Builtins and unknown plugin/custom tools are advertised under the synthetic
 * default server (`opencode`). Tools whose prefixes match configured MCP
 * servers keep those server ids (`github`, …). Composite `name` is
 * `<server>-<bareTool>`; local execution still uses the full OpenCode id
 * reconstructed in `mcpRealToolName`. Emit in advertised order — the epoch
 * catalog owns canonicalization; sorting here would insert on grow.
 */
export function toolsToDescriptors(tools, providerIdentifier = "opencode", knownMcpServers = []) {
    // Advertised order is the prefix. The epoch catalog sorts once on first
    // freeze and appends later names at the tail; re-sorting here would insert
    // a new tool in front of `z` and invalidate the tools bytes.
    return tools.map((t) => {
        const id = resolveToolServerIdentity(t.sourceName ?? t.name, providerIdentifier, knownMcpServers);
        const collisionSafeAlias = COLLISION_SAFE_ALIASES.has(t.name);
        return {
            // Keep the collision-safe public name exact. Prefixing it with the
            // synthetic default server weakens the distinction from Cursor-native
            // capabilities (web search/fetch, MCP resource list/read) in the
            // model-visible catalog.
            name: collisionSafeAlias ? t.name : `${id.server}-${id.toolName}`,
            description: t.description ?? "",
            input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
            provider_identifier: id.server,
            tool_name: t.sourceName ? t.name : id.toolName,
        };
    });
}
function normalizeInputSchema(schema) {
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        return schema;
    }
    return { type: "object", properties: {} };
}
// Despite the name, these rules cover any advertised OpenCode tool whose bare
// name collides with a Cursor-native capability, not only web search/fetch —
// see the MCP resource entries below and
// tasks/plans/fix-cursor-mcp-resource-exec.md Phase 0/2.
const WEB_ALIAS_RULES = [
    {
        alias: CUSTOM_WEBSEARCH_TOOL,
        exact: ["websearch", "web_search"],
        suffixes: ["_web_search", "-web_search", "_websearch", "-websearch"],
    },
    {
        alias: CUSTOM_WEBFETCH_TOOL,
        exact: ["webfetch", "web_fetch"],
        suffixes: ["_web_fetch", "-web_fetch", "_webfetch", "-webfetch"],
    },
    {
        alias: CUSTOM_LIST_MCP_RESOURCES_TOOL,
        exact: ["list_mcp_resources"],
        suffixes: ["_list_mcp_resources", "-list_mcp_resources"],
    },
    {
        alias: CUSTOM_READ_MCP_RESOURCE_TOOL,
        exact: ["read_mcp_resource"],
        suffixes: ["_read_mcp_resource", "-read_mcp_resource"],
    },
];
const COLLISION_SAFE_ALIASES = new Set([
    CUSTOM_WEBSEARCH_TOOL,
    CUSTOM_WEBFETCH_TOOL,
    CUSTOM_LIST_MCP_RESOURCES_TOOL,
    CUSTOM_READ_MCP_RESOURCE_TOOL,
]);
/**
 * Give collision-prone web capabilities names Cursor will not confuse with its
 * native UI-bound WebSearch/WebFetch interactions. Exact host tools win; a
 * flattened MCP suffix is accepted only when it identifies one unique tool.
 */
export function buildCustomWebToolAliases(tools) {
    const aliases = new Map();
    const ambiguous = new Map();
    const replacements = new Map();
    for (const rule of WEB_ALIAS_RULES) {
        // A host/plugin may already expose the collision-safe public name. Keep it
        // authoritative instead of hiding it behind a second mapping.
        if (tools.some((tool) => tool.name === rule.alias))
            continue;
        const exact = tools.filter((tool) => rule.exact.includes(tool.name.toLowerCase()));
        const candidates = exact.length > 0
            ? exact
            : tools.filter((tool) => {
                const name = tool.name.toLowerCase();
                return rule.suffixes.some((suffix) => name.endsWith(suffix));
            });
        if (candidates.length !== 1) {
            if (candidates.length > 1)
                ambiguous.set(rule.alias, candidates.map((tool) => tool.name));
            continue;
        }
        const original = candidates[0].name;
        aliases.set(rule.alias, original);
        replacements.set(original, rule.alias);
    }
    return {
        advertisedTools: tools.map((tool) => {
            const alias = replacements.get(tool.name);
            return alias ? { ...tool, name: alias, sourceName: tool.name } : { ...tool };
        }),
        aliases,
        ambiguous,
    };
}
export function resolveCustomWebToolAlias(toolName, aliases) {
    const direct = aliases?.get(toolName);
    if (direct)
        return direct;
    for (const [alias, original] of aliases ?? []) {
        if (toolName.endsWith(`_${alias}`))
            return original;
    }
    return toolName;
}
/**
 * Nested MCP descriptors. Full name/description/schema is for exec #36.
 * RequestContext `mcp_meta_tool_options` uses `{ namesOnly: true }` (`tool_name`
 * only). File-system `mcp_descriptors` are omitted on the wire.
 */
export function toolsToMcpDescriptors(tools, providerIdentifier = "opencode", knownMcpServers = [], options) {
    if (tools.length === 0)
        return [];
    const byServer = new Map();
    const namesOnly = options?.namesOnly === true;
    // Walk advertised order: first-seen server, then append tools onto that
    // server. Same-set host reorder is resolved by `resolveTurnToolState`
    // before encode so this walk stays epoch-stable.
    for (const t of tools) {
        const id = resolveToolServerIdentity(t.sourceName ?? t.name, providerIdentifier, knownMcpServers);
        let list = byServer.get(id.server);
        if (!list) {
            list = [];
            byServer.set(id.server, list);
        }
        const toolName = t.sourceName ? t.name : id.toolName;
        list.push(namesOnly
            ? { tool_name: toolName }
            : {
                tool_name: toolName,
                description: t.description ?? "",
                input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
            });
    }
    return [...byServer.keys()].map((server) => ({
        server_name: server,
        server_identifier: server,
        tools: byServer.get(server),
    }));
}
/**
 * @deprecated Prefer `buildRequestContext` from `../context/build.js`.
 * Kept as a sync tools-only fallback for unit tests that don't need collectors.
 */
export function buildLiveRequestContext(tools, providerIdentifier = "opencode", knownMcpServers = []) {
    const slim = toolsToMcpDescriptors(tools, providerIdentifier, knownMcpServers, { namesOnly: true });
    const cwd = process.cwd();
    const ctx = {
        env: buildEnv(cwd),
        mcp_file_system_options: {
            enabled: true,
            workspace_project_dir: ensureOpencodeProjectDir(cwd),
        },
        mcp_meta_tool_options: {
            enabled: true,
            ...(slim.length > 0 ? { mcp_descriptors: slim } : {}),
        },
        web_search_enabled: false,
        web_fetch_enabled: false,
        rules_info_complete: true,
        env_info_complete: true,
        repository_info_complete: true,
        mcp_file_system_info_complete: true,
        git_status_info_complete: true,
    };
    traceRequestContextPaths("buildLiveRequestContext", ctx);
    return ctx;
}
// ── Cursor exec-variant → opencode tool name ──
// Native ExecServerMessage variants only (agent.v1). There is no edit_args or
// glob_args on the exec channel — Cursor's EditToolCall is display-only, and
// glob/edit from opencode are advertised as MCP tools and arrive as mcp_args.
//
// Design note (F11): Cursor has native delete / background-shell tools; OpenCode
// does not. This provider intentionally remaps:
//   - delete_args → bash `rm -f -- <quoted-path>`
//   - background_shell_spawn_args → bash (original command; plugin wraps nohup)
//   - shell_args (#2) → bash, same timeout/background path as shell_stream; the
//     reply stays ShellResult (not the streaming oneof).
// Permissions still flow through OpenCode's advertised `bash` tool. Soft-
// background / detached children can outlive the OpenCode tool call; leftover
// process cleanup is left to the user / OS. Arg key remapping happens below.
const cursorToolToOpencode = {
    read_args: "read",
    write_args: "write",
    pi_read_args: "read",
    pi_bash_args: "bash",
    pi_edit_args: "edit",
    pi_write_args: "write",
    pi_grep_args: "grep",
    pi_find_args: "glob",
    pi_ls_args: "read",
    grep_args: "grep",
    ls_args: "read",
    delete_args: "bash",
    shell_args: "bash",
    shell_stream_args: "bash",
    background_shell_spawn_args: "bash",
    subagent_args: "task",
    mcp_args: "mcp",
};
const opencodeToolToCursor = {
    read: "read_args",
    write: "write_args",
    grep: "grep_args",
    bash: "shell_stream_args",
    shell: "shell_stream_args",
    task: "subagent_args",
    mcp: "mcp_args",
};
/** Cursor-only fields that must not be forwarded as OpenCode tool input. */
const CURSOR_INTERNAL_KEYS = new Set([
    "tool_call_id",
    "toolCallId",
    "exec_id",
    "span",
    "sandbox_policy",
    "requested_sandbox_policy",
    "smart_mode_approval",
    "smart_mode_approval_only",
    "skip_approval",
    "parsing_result",
    "classifier_result",
    "hook_approval_requirement",
    "conversation_id",
    "simple_commands",
    "has_input_redirect",
    "has_output_redirect",
    "is_background",
    "timeout_behavior",
    "hard_timeout",
    "close_stdin",
    "output_notification",
    "file_output_threshold_bytes",
    // WriteArgs #4. A request for WriteSuccess.file_content_after_write, which we
    // do not populate; harmless to omit, but it is not tool input.
    "return_file_content_after_write",
    "ignore",
]);
// WriteArgs #5/#6 are deliberately NOT internal: `file_bytes` carries the file
// content itself whenever Cursor sends it instead of `file_text` (its own
// LocalWriteExecutor prefers bytes when non-empty), and `encoding_hint` is how
// that payload is decoded. The `write` mapping consumes both explicitly.
/** Required content fields where an empty string is meaningful (for example, truncating a file). */
const PRESERVE_EMPTY_STRING_KEYS = new Set([
    "content",
    "file_text",
    "fileText",
    "stream_content",
    // Some advertised edit schemas use a single textual `input` payload. Preserve
    // an empty value so the executor reports the real edit error rather than a
    // misleading missing-property error.
    "input",
    "oldString",
    "old_string",
    "newString",
    "new_string",
]);
export function mapExecServerToToolName(execField) {
    return cursorToolToOpencode[execField];
}
export function mapToolNameToExecField(toolName) {
    return opencodeToolToCursor[toolName];
}
const CURSOR_SUBAGENT_TYPE_TO_OPENCODE = {
    generalPurpose: "general",
    "general-purpose": "general",
    general_purpose: "general",
    general: "general",
    unspecified: "general",
    "cursor-guide": "explore",
    cursor_guide: "explore",
    "best-of-n-runner": "general",
    best_of_n_runner: "general",
    bash: "general",
    shell: "general",
    debug: "general",
    computer_use: "general",
    computerUse: "general",
    browser_use: "general",
    browserUse: "general",
    media_review: "general",
    mediaReview: "general",
    watch_video: "general",
    watchVideo: "general",
    vm_setup_helper: "general",
    vmSetupHelper: "general",
    explore: "explore",
    bugbot: "explore",
    "security-review": "explore",
    security_review: "explore",
};
const SUBAGENT_CATALOG_MARKER = "Available agent types and the tools they have access to:";
const SUBAGENT_INLINE_MARKER = "Available subagents:";
function parseSubagentDescriptionCatalog(description) {
    if (!description)
        return { found: false, agents: [] };
    const marker = description.indexOf(SUBAGENT_CATALOG_MARKER);
    if (marker >= 0) {
        const agents = [];
        const lines = description.slice(marker + SUBAGENT_CATALOG_MARKER.length).split(/\r?\n/);
        let started = false;
        for (const line of lines) {
            const match = line.match(/^\s*-\s+([^:]+):\s*(.*)$/);
            if (!match) {
                if (started && line.trim())
                    break;
                continue;
            }
            started = true;
            const name = match[1].trim().replace(/^`|`$/g, "");
            if (!name)
                continue;
            const agentDescription = match[2].trim();
            agents.push({
                name,
                ...(agentDescription ? { description: agentDescription } : {}),
            });
        }
        return { found: true, agents };
    }
    // OpenCode 2 `subagent` inlines the list after "Available subagents:".
    const inlineAt = description.indexOf(SUBAGENT_INLINE_MARKER);
    if (inlineAt < 0)
        return { found: false, agents: [] };
    const rest = description.slice(inlineAt + SUBAGENT_INLINE_MARKER.length);
    const agents = [];
    const matches = rest.matchAll(/-\s+([A-Za-z0-9_-]+):\s*/g);
    const hits = [...matches];
    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const name = hit[1];
        const start = (hit.index ?? 0) + hit[0].length;
        const end = i + 1 < hits.length ? (hits[i + 1].index ?? rest.length) : rest.length;
        const agentDescription = rest.slice(start, end).trim();
        agents.push({
            name,
            ...(agentDescription ? { description: agentDescription } : {}),
        });
    }
    return { found: agents.length > 0, agents };
}
function subagentTypeEnumValues(schema) {
    const out = new Set();
    const seen = new Set();
    const visit = (value, propertyName) => {
        if (!value || typeof value !== "object")
            return;
        if (seen.has(value))
            return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item, propertyName);
            return;
        }
        const record = value;
        if ((propertyName === "subagent_type" || propertyName === "agent")
            && Array.isArray(record.enum)) {
            for (const item of record.enum) {
                if (typeof item === "string" && item)
                    out.add(item);
            }
        }
        for (const [key, child] of Object.entries(record))
            visit(child, key);
    };
    visit(schema);
    return [...out];
}
/** Extract the current host's permission-filtered Task/Actor recipient catalog. */
export function extractHostSubagentCatalog(tools) {
    const executorTool = tools.find((tool) => tool.name === "task")
        ?? tools.find((tool) => tool.name === "subagent");
    if (!executorTool)
        return { agents: [], complete: true };
    const described = parseSubagentDescriptionCatalog(executorTool.description);
    const enumNames = subagentTypeEnumValues(executorTool.inputSchema);
    const descriptions = new Map(described.agents.map((agent) => [agent.name, agent.description]));
    // A structured subagent_type/agent enum is stricter than prose, so it is authoritative.
    const names = new Set(enumNames.length > 0 ? enumNames : described.agents.map((agent) => agent.name));
    return {
        executor: executorTool.name === "subagent" ? "subagent" : "task",
        agents: [...names].map((name) => ({
            name,
            ...(descriptions.get(name) ? { description: descriptions.get(name) } : {}),
        })),
        complete: enumNames.length > 0 || described.found,
    };
}
const GENERIC_CURSOR_SUBAGENT_TYPES = new Set([
    "generalPurpose",
    "general-purpose",
    "general_purpose",
    "general",
    "unspecified",
]);
function cursorSubagentCandidates(subagentType) {
    if (GENERIC_CURSOR_SUBAGENT_TYPES.has(subagentType))
        return ["general"];
    if (subagentType === "cursor-guide" || subagentType === "cursor_guide") {
        return ["scout", "explore", "general"];
    }
    if (subagentType === "explore" ||
        subagentType === "bugbot" ||
        subagentType === "security-review" ||
        subagentType === "security_review") {
        return ["explore", "general"];
    }
    return ["general"];
}
/** Resolve a Cursor subtype against the agents the host can spawn this turn. */
export function resolveCursorSubagentType(subagentType, catalog) {
    const available = new Set(catalog?.agents.map((agent) => agent.name) ?? []);
    // Explicit host/custom names win. `unspecified` and general aliases are
    // intentionally excluded so they always select the host's generic agent.
    if (!GENERIC_CURSOR_SUBAGENT_TYPES.has(subagentType) && available.has(subagentType)) {
        return subagentType;
    }
    const candidates = cursorSubagentCandidates(subagentType);
    for (const candidate of candidates) {
        if (available.has(candidate))
            return candidate;
    }
    if (catalog?.complete)
        return undefined;
    return candidates[0];
}
/**
 * Cursor's native Task/subagent protocol uses Cursor-owned subtype names while
 * OpenCode-family hosts execute named agents. Map known Cursor built-ins to
 * the closest host agent and preserve unknown values so user-defined OpenCode
 * agents can still be called by exact name.
 */
export function mapCursorSubagentTypeToOpenCode(subagentType) {
    return CURSOR_SUBAGENT_TYPE_TO_OPENCODE[subagentType] ?? subagentType;
}
/** Resolve a native Cursor subagent request to this turn's executor and catalog. */
export function remapNativeSubagentForCatalog(parsed, advertisedToolNames, catalog) {
    if (parsed.resultField !== "subagent_result" || parsed.toolName !== "task")
        return;
    const advertised = new Set(advertisedToolNames);
    const executor = advertised.has("task")
        ? "task"
        : advertised.has("subagent")
            ? "subagent"
            : undefined;
    if (!executor)
        return;
    const description = str(parsed.args.description) ?? "";
    const prompt = str(parsed.args.prompt) ?? "";
    const cursorSubagentType = str(parsed.resultMetadata?.cursor_subagent_type) ??
        str(parsed.args.subagent_type) ??
        str(parsed.args.agent) ??
        "";
    const subagentType = resolveCursorSubagentType(cursorSubagentType, catalog);
    if (!subagentType) {
        const available = catalog?.agents.map((agent) => agent.name).join(", ") || "none";
        parsed.localError =
            `Cursor subagent '${cursorSubagentType}' has no compatible host agent. ` +
                `Available subagents: ${available}.`;
        return;
    }
    const resumeAgentId = str(parsed.args.task_id) ?? str(parsed.args.sessionID);
    parsed.toolName = executor;
    parsed.args = executor === "subagent"
        ? {
            agent: subagentType,
            description,
            prompt,
            ...(resumeAgentId ? { sessionID: resumeAgentId } : {}),
            ...(parsed.args.background === true ? { background: true } : {}),
        }
        : {
            description,
            prompt,
            subagent_type: subagentType,
            ...(resumeAgentId ? { task_id: resumeAgentId } : {}),
            ...(parsed.args.background === true ? { background: true } : {}),
        };
}
/** Matches Cursor's own pre-write read threshold (`local-exec` 52428800). */
const MAX_EDIT_SOURCE_BYTES = 50 * 1024 * 1024;
/**
 * Complete the private read inside Cursor's legacy edit transaction without
 * routing it through OpenCode's user-facing `read` tool. The latter caps every
 * result at 50 KB, while Cursor's editor needs the complete file to calculate
 * the correlated whole-file `write_args` that follows.
 *
 * The caller is responsible for proving that `filePath` is the same regular
 * file named by an active `edit_tool_call` and is contained by the workspace.
 */
export function buildCompleteEditReadMessages(execId, sourcePath, resultPath = sourcePath) {
    try {
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile() || stat.size > MAX_EDIT_SOURCE_BYTES)
            return undefined;
        const content = fs.readFileSync(sourcePath, "utf8");
        return [
            encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    read_result: {
                        success: {
                            path: resultPath,
                            content,
                            total_lines: countLines(content),
                            file_size: stat.size,
                            truncated: false,
                            range_applied: false,
                        },
                    },
                },
            }),
            buildExecStreamClose(execId),
        ];
    }
    catch {
        return undefined;
    }
}
/** Return the number of non-overlapping occurrences, stopping after ambiguity. */
function replacementOccurrenceCount(source, needle) {
    if (!needle)
        return 0;
    const first = source.indexOf(needle);
    if (first === -1)
        return 0;
    return source.indexOf(needle, first + needle.length) === -1 ? 1 : 2;
}
function previousLineStart(source, start) {
    if (start <= 0)
        return 0;
    const before = source[start - 1] === "\n" ? start - 2 : start - 1;
    return source.lastIndexOf("\n", before) + 1;
}
function followingLineEnd(source, end) {
    if (end >= source.length)
        return source.length;
    const newline = source.indexOf("\n", end);
    return newline === -1 ? source.length : newline + 1;
}
/**
 * Collapse a whole-file replacement into one unique, line-bounded substring
 * edit. Cursor's legacy edit executor computes a complete new file internally;
 * OpenCode's `edit` tool instead wants old/new substrings.
 */
function planWholeFileEdit(source, target) {
    if (!source || source === target)
        return undefined;
    let prefix = 0;
    const shared = Math.min(source.length, target.length);
    while (prefix < shared && source[prefix] === target[prefix])
        prefix++;
    let suffix = 0;
    while (suffix < source.length - prefix
        && suffix < target.length - prefix
        && source[source.length - suffix - 1] === target[target.length - suffix - 1])
        suffix++;
    const sourceChangeEnd = source.length - suffix;
    const targetChangeEnd = target.length - suffix;
    let start = prefix === 0 ? 0 : source.lastIndexOf("\n", prefix - 1) + 1;
    let end = sourceChangeEnd >= source.length
        ? source.length
        : followingLineEnd(source, sourceChangeEnd);
    // A pure insertion can initially select no source text. Include an adjacent
    // line because OpenCode edit deliberately rejects an empty oldString.
    if (start === end) {
        if (start > 0)
            start = previousLineStart(source, start);
        else
            end = followingLineEnd(source, end);
    }
    const replacement = () => ({
        oldString: source.slice(start, end),
        newString: source.slice(start, prefix)
            + target.slice(prefix, targetChangeEnd)
            + source.slice(sourceChangeEnd, end),
    });
    let result = replacement();
    while (replacementOccurrenceCount(source, result.oldString) !== 1) {
        const priorStart = start;
        const priorEnd = end;
        if (start > 0)
            start = previousLineStart(source, start);
        if (end < source.length)
            end = followingLineEnd(source, end);
        if (start === priorStart && end === priorEnd)
            return undefined;
        result = replacement();
    }
    return result;
}
/**
 * Preserve a legacy Cursor edit's intent when its internal executor follows
 * `edit_tool_call` with a whole-file `write_args` request.
 *
 * The result field intentionally remains `write_result`: that is the response
 * Cursor is awaiting even though OpenCode executes the mutation via `edit`.
 */
export function remapCorrelatedEditWriteForCatalog(parsed, advertisedToolNames, editPath, workspaceRoot) {
    if (parsed.resultField !== "write_result" || parsed.toolName !== "write")
        return false;
    const advertised = new Set(advertisedToolNames);
    if (!advertised.has("edit") && !advertised.has(APPLY_PATCH_TOOL))
        return false;
    const filePath = opencodePathArg(parsed.args);
    const content = stringValue(parsed.args.content);
    if (!filePath || content === undefined || !editPath)
        return false;
    const root = workspaceRoot ?? process.cwd();
    const absolute = path.resolve(root, filePath);
    if (absolute !== path.resolve(root, editPath))
        return false;
    let source;
    try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > MAX_EDIT_SOURCE_BYTES)
            return false;
        if (Buffer.byteLength(content, "utf8") > MAX_EDIT_SOURCE_BYTES)
            return false;
        source = fs.readFileSync(absolute, "utf8");
    }
    catch {
        // Missing targets are creations and must stay writes. Other read failures
        // also fall back to the original host permission path without guessing.
        return false;
    }
    const replacement = planWholeFileEdit(source, content);
    if (!replacement)
        return false;
    parsed.toolName = "edit";
    const filePathKey = typeof parsed.args.path === "string" && typeof parsed.args.filePath !== "string"
        ? "path"
        : "filePath";
    parsed.args = {
        [filePathKey]: filePath,
        oldString: replacement.oldString,
        newString: replacement.newString,
    };
    parsed.resultMetadata = { ...parsed.resultMetadata, path: filePath };
    return true;
}
/**
 * Express a native Cursor write/edit as `apply_patch` when the host swapped the
 * edit-tool family out from under us.
 *
 * OpenCode 1.x removes `edit` and `write` from the catalog for GPT models and
 * advertises `apply_patch` in their place — see the module comment in
 * `./apply-patch.ts` for the upstream reasoning and citations. Cursor keeps
 * using its native write/edit exec channel regardless, so without this the
 * request is refused as an unavailable tool and the model loses the ability to
 * change files at all.
 *
 * Keyed purely off the advertised set: this is inert whenever the host offers
 * `write`/`edit` normally, and equally inert when it offers neither those nor
 * `apply_patch` (the caller's unavailable-tool rejection still applies).
 */
export function remapEditToolsForCatalog(parsed, advertisedToolNames, workspaceRoot) {
    if (parsed.toolName !== "write" && parsed.toolName !== "edit")
        return;
    // `apply_patch` envelopes are text. A binary write has no patch form at all,
    // so it must stay a write and reach the byte-preserving path — converting it
    // here would drop the bytes and report a patch-translation failure instead of
    // the image Cursor asked to save.
    if (binaryWritePayload(parsed))
        return;
    const advertised = new Set(advertisedToolNames);
    if (advertised.has(parsed.toolName) || !advertised.has(APPLY_PATCH_TOOL))
        return;
    const requested = parsed.toolName;
    const filePath = opencodePathArg(parsed.args);
    const refuse = (reason) => {
        parsed.toolName = APPLY_PATCH_TOOL;
        parsed.args = {};
        parsed.localError =
            `Cursor ${requested} request cannot be expressed as an apply_patch call: ${reason}. ` +
                "The host advertises `apply_patch` instead of `edit`/`write` for this model.";
    };
    if (!filePath) {
        refuse("no target path was provided");
        return;
    }
    let patchText;
    if (requested === "write") {
        const content = stringValue(parsed.args.content);
        if (content === undefined) {
            refuse("no file content was provided");
            return;
        }
        // `*** Add File:` overwrites an existing target, so a whole-file write maps
        // directly without reading the current contents or diffing.
        patchText = buildAddFilePatch(filePath, content);
    }
    else {
        const oldString = stringValue(parsed.args.oldString);
        const newString = stringValue(parsed.args.newString);
        if (oldString === undefined || newString === undefined) {
            refuse("the replacement is missing its old or new text");
            return;
        }
        // apply_patch matches whole lines, so a substring edit has to be widened to
        // the lines it touches — which requires the file the model is editing.
        const absolute = path.resolve(workspaceRoot ?? process.cwd(), filePath);
        let source;
        try {
            // Bounded because this read is synchronous on the Run pump. Cursor's own
            // executor uses the same 50 MB threshold before reading a file it is
            // about to write.
            const size = fs.statSync(absolute).size;
            if (size > MAX_EDIT_SOURCE_BYTES) {
                refuse(`the target file is ${Math.round(size / 1024 / 1024)} MB, too large to patch`);
                return;
            }
            source = fs.readFileSync(absolute, "utf8");
        }
        catch (e) {
            refuse(`the target file could not be read (${e.message})`);
            return;
        }
        const plan = planSubstringEdit(source, oldString, newString, parsed.args.replaceAll === true);
        if (!plan.ok) {
            refuse(plan.reason);
            return;
        }
        patchText = buildUpdateFilePatch(filePath, plan.chunks);
    }
    parsed.toolName = APPLY_PATCH_TOOL;
    parsed.args = { patchText };
    // apply_patch's output does not carry opencode `write`'s <path> tag, so keep
    // the requested path for the typed Cursor result.
    parsed.resultMetadata = { ...parsed.resultMetadata, path: filePath };
}
function readRequestResultMetadata(raw, mappedArgs) {
    const requestedPath = str(raw.path)
        ?? str(raw.filePath)
        ?? str(raw.file_path)
        ?? opencodePathArg(mappedArgs)
        ?? "";
    return {
        path: requestedPath,
        ...(typeof mappedArgs.offset === "number" ? { offset: mappedArgs.offset } : {}),
        ...(typeof mappedArgs.limit === "number" ? { limit: mappedArgs.limit } : {}),
    };
}
/**
 * Cursor's native write executor echoes `WriteArgs.path` on `WriteSuccess.path`.
 * Large GetMcpTools / GetDynamicTools catalogs spill through `write_args` into
 * `agent-tools/<uuid>.txt` and then tell the model `filePath` from that success
 * path. Host write output is free-form prose (often no `<path>` tag), so the
 * request path is the only host-neutral identity we can report.
 */
function writeRequestResultMetadata(raw, mappedArgs) {
    const requestedPath = str(raw.path)
        ?? str(raw.filePath)
        ?? str(raw.file_path)
        ?? opencodePathArg(mappedArgs);
    return requestedPath ? { path: requestedPath } : undefined;
}
/**
 * A partial-read notice is for Cursor's model, never for a file. Refuse only
 * whole-file mutation forms that echo it. A targeted edit or Update File patch
 * cannot truncate an unseen tail, and may legitimately edit source that quotes
 * this provider's warning text.
 */
export function rejectPartialReadMutation(parsed) {
    if (parsed.localError)
        return;
    let content;
    if (parsed.toolName === "write") {
        content = parsed.args.content;
    }
    else if (parsed.toolName === APPLY_PATCH_TOOL) {
        const patchText = parsed.args.patchText;
        if (typeof patchText !== "string" || !patchText.includes("*** Add File:"))
            return;
        content = patchText;
    }
    else {
        return;
    }
    if (typeof content !== "string"
        || !content.includes("[Partial read:")
        || !content.includes("It is NOT the complete file."))
        return;
    const filePath = opencodePathArg(parsed.args) ?? "the target file";
    const nextOffset = /Continue with offset=(\d+)/.exec(content)?.[1];
    const longLine = content.includes("Use a byte-preserving read method");
    parsed.localError =
        `NO FILE CHANGE WAS MADE. Refusing a whole-file mutation of ${JSON.stringify(filePath)} ` +
            "because it contains the provider's partial-read notice. Do not retry the same mutation. " +
            (nextOffset
                ? `Read the file from offset=${nextOffset}, then use a targeted edit or Update File patch.`
                : longLine
                    ? "Inspect the full line with a byte-preserving read method, then use a targeted edit or Update File patch."
                    : "Read the remaining file ranges, then use a targeted edit or Update File patch.");
}
export function parseExecServerMessage(msg, dialect = OPENCODE_1_TOOL_DIALECT) {
    const id = msg.id;
    if (id === undefined)
        return undefined;
    // Find which args variant is set
    const execVariant = findOneOfVariant(msg, [
        "read_args", "write_args",
        "pi_read_args", "pi_bash_args", "pi_edit_args", "pi_write_args",
        "pi_grep_args", "pi_find_args", "pi_ls_args",
        "grep_args", "ls_args",
        "delete_args", "shell_args", "shell_stream_args", "background_shell_spawn_args", "mcp_args",
        "subagent_args",
    ]);
    if (!execVariant)
        return undefined;
    // Use the complete canonical request/result table. In particular, Pi request
    // fields #45..#51 pair with result fields #46..#52 rather than matching ids.
    const resultField = cursorExecVariantByRequestName(execVariant)?.resultName;
    if (!resultField)
        return undefined;
    const execId = msg.exec_id ?? "";
    // F11: Cursor native background shell → OpenCode bash. Keep the wrapper
    // self-contained so direct provider / hosts without shell.env still detach
    // and return a PID. The classic plugin replaces this with its display-safe
    // env or wrapper-file path before execution.
    if (execVariant === "background_shell_spawn_args") {
        const raw = msg.background_shell_spawn_args ?? {};
        const command = str(raw.command);
        const workingDirectory = str(raw.working_directory) ?? "";
        const args = {};
        if (command)
            args.command = buildBackgroundShellCommand(command);
        if (workingDirectory)
            args.workdir = workingDirectory;
        return {
            id,
            execId,
            toolName: dialect.shellTool,
            args,
            resultField,
            resultMetadata: {
                background_shell_spawn: true,
                command: command ?? "",
                working_directory: workingDirectory,
            },
            localError: raw.enable_write_shell_stdin_tool === true
                ? "Interactive background shells are not available through OpenCode's bash tool."
                : command
                    ? undefined
                    : "Cursor background shell request is missing a command.",
        };
    }
    if (execVariant === "subagent_args") {
        const raw = msg.subagent_args ?? {};
        const prompt = str(raw.prompt);
        const cursorSubagentType = str(raw.subagent_type);
        const subagentType = cursorSubagentType
            ? mapCursorSubagentTypeToOpenCode(cursorSubagentType)
            : undefined;
        const args = {
            description: describeSubagentTask(prompt, subagentType),
            prompt: prompt ?? "",
            subagent_type: subagentType ?? "",
        };
        const resumeAgentId = str(raw.resume_agent_id);
        if (resumeAgentId)
            args.task_id = resumeAgentId;
        // protobufjs materializes an absent proto3 optional bool as false in this
        // reflection schema. OpenCode's foreground default is already false, so
        // only forward the meaningful opt-in value.
        if (raw.run_in_background === true)
            args.background = true;
        return {
            id,
            execId,
            toolName: "task",
            args,
            resultField,
            resultMetadata: cursorSubagentType
                ? { cursor_subagent_type: cursorSubagentType }
                : undefined,
            localError: prompt && cursorSubagentType
                ? undefined
                : "Cursor subagent request is missing a required prompt or subagent type.",
        };
    }
    if (execVariant === "mcp_args") {
        // An MCP call to one of the tools we advertised. Resolve the real opencode
        // tool name (Cursor's model may have shortened "opencode-read" → "read") and
        // decode the argument map back into JSON for opencode to execute.
        const m = msg.mcp_args ?? {};
        const rawArgs = decodeMcpArgs(m.args);
        const mapped = mapCursorArgsToOpencode(mcpRealToolName(m), rawArgs, "mcp_args", dialect);
        return {
            id,
            execId,
            toolName: mapped.toolName,
            args: mapped.args,
            resultField,
            ...(mapped.toolName === "read"
                ? { resultMetadata: readRequestResultMetadata(rawArgs, mapped.args) }
                : {}),
        };
    }
    if (execVariant === "pi_edit_args") {
        const raw = msg.pi_edit_args ?? {};
        const edits = Array.isArray(raw.edits) ? raw.edits : [];
        const replacement = edits.length === 1 && edits[0] && typeof edits[0] === "object"
            ? edits[0]
            : undefined;
        const path = str(raw.path);
        const oldString = replacement ? stringValue(replacement.old_text) : undefined;
        const newString = replacement ? stringValue(replacement.new_text) : undefined;
        const args = {};
        assignHostFilePath(args, path, dialect);
        if (oldString !== undefined)
            args.oldString = oldString;
        if (newString !== undefined)
            args.newString = newString;
        return {
            id,
            execId,
            toolName: "edit",
            args,
            resultField,
            localError: path && oldString && newString !== undefined
                ? undefined
                : "Cursor Pi edit cannot be represented safely: expected one non-empty replacement.",
        };
    }
    const toolName = cursorToolToOpencode[execVariant];
    if (!toolName)
        return undefined;
    const mapped = mapCursorArgsToOpencode(toolName, msg[execVariant] ?? {}, execVariant, dialect);
    const rawArgs = msg[execVariant] ?? {};
    const resultMetadata = execVariant === "shell_stream_args" || execVariant === "shell_args"
        ? shellStreamResultMetadata(rawArgs)
        : execVariant === "read_args" || execVariant === "pi_read_args"
            ? readRequestResultMetadata(rawArgs, mapped.args)
            : execVariant === "write_args" || execVariant === "pi_write_args"
                ? writeRequestResultMetadata(rawArgs, mapped.args)
                : execVariant === "grep_args"
                    ? grepRequestResultMetadata(rawArgs)
                    : undefined;
    if (resultMetadata
        && resultMetadata.timeout_behavior !== 2
        && typeof resultMetadata.timeout_ms === "number") {
        // Cursor's protobuf default (timeout=0) means 30 seconds for an ordinary
        // foreground shell. OpenCode instead treats zero literally, so pass the
        // effective native value rather than the raw protobuf default.
        mapped.args.timeout = resultMetadata.timeout_ms;
    }
    return {
        id,
        execId,
        toolName: mapped.toolName,
        args: mapped.args,
        resultField,
        ...(resultMetadata || mapped.binaryBytes
            ? {
                resultMetadata: {
                    ...resultMetadata,
                    ...(mapped.binaryBytes
                        ? {
                            binaryWriteBytes: mapped.binaryBytes,
                            path: str(rawArgs.path) ?? str(rawArgs.file_path) ?? "",
                        }
                        : {}),
                },
            }
            : {}),
    };
}
function shellStreamResultMetadata(raw) {
    const timeout = num(raw.timeout) ?? 0;
    const timeoutBehavior = num(raw.timeout_behavior) ?? 0;
    const hardTimeout = num(raw.hard_timeout);
    // Cursor CLI: a nonzero timeout is used verbatim. A zero foreground timeout
    // defaults to 30s; zero with background/hard-timeout semantics means an
    // immediate soft handoff governed by the separate hard deadline.
    const effectiveTimeout = timeout !== 0
        ? timeout
        : (timeoutBehavior === 2 || (hardTimeout !== undefined && hardTimeout > 0) ? 0 : 30_000);
    return {
        shell_stream: true,
        command: str(raw.command) ?? "",
        working_directory: str(raw.working_directory) ?? "",
        timeout_ms: effectiveTimeout,
        timeout_behavior: timeoutBehavior,
        ...(hardTimeout !== undefined && hardTimeout > 0 ? { hard_timeout_ms: hardTimeout } : {}),
    };
}
/**
 * Remap Cursor exec / MCP arg shapes onto OpenCode's Effect Schema keys.
 * Without this, OpenCode rejects calls with InvalidArgumentsError
 * (e.g. `path` instead of `filePath`, `file_text` instead of `content`).
 */
export function mapCursorArgsToOpencode(toolName, raw, execVariant, dialect = OPENCODE_1_TOOL_DIALECT) {
    const cleaned = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v === undefined || v === null)
            continue;
        if (CURSOR_INTERNAL_KEYS.has(k))
            continue;
        // Drop empty strings from optional protobuf defaults, but retain required
        // content fields where empty means a valid destructive edit/write.
        if (typeof v === "string" && v.length === 0 && !PRESERVE_EMPTY_STRING_KEYS.has(k))
            continue;
        cleaned[k] = v;
    }
    // Native ls_args → OpenCode read (directory listing via read).
    if (execVariant === "ls_args") {
        const filePath = str(cleaned.path) ?? str(cleaned.filePath);
        return { toolName: "read", args: filePath ? { [dialect.filePathKey]: filePath } : {} };
    }
    // F11: Cursor native delete_args → OpenCode bash. No delete builtin exists, so
    // we emulate with `rm -f -- <path>` (shell-quoted). Same permission boundary
    // as any other bash tool call.
    if (execVariant === "delete_args") {
        const target = str(cleaned.path) ?? str(cleaned.filePath);
        return mapCursorArgsToOpencode(dialect.shellTool, {
            command: target ? `rm -f -- ${shellQuote(target)}` : "true",
        }, undefined, dialect);
    }
    switch (toolName) {
        case "read": {
            const args = {};
            const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path);
            assignHostFilePath(args, filePath, dialect);
            // Cursor often sends offset=0/limit=0 as protobuf defaults. OpenCode's
            // read treats limit=0 as "read zero lines" (empty content) — omit zeros.
            const offset = num(cleaned.offset);
            if (offset !== undefined && offset > 0)
                args.offset = offset;
            const limit = num(cleaned.limit);
            if (limit !== undefined && limit > 0)
                args.limit = limit;
            return { toolName: "read", args };
        }
        case "write": {
            const args = {};
            const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path);
            assignHostFilePath(args, filePath, dialect);
            // Cursor's LocalWriteExecutor prefers `file_bytes` whenever it is
            // non-empty and only falls back to `file_text`; mirror that order so a
            // byte-encoded write is not silently seen as empty content.
            const bytes = bytesValue(cleaned.file_bytes) ?? bytesValue(cleaned.fileBytes);
            let content;
            if (bytes !== undefined) {
                content = decodeWriteBytes(bytes, str(cleaned.encoding_hint) ?? str(cleaned.encodingHint));
                if (content === undefined) {
                    // Binary. Surface the raw bytes to the caller instead of a lossy
                    // decode; `binaryWritePayload` picks them up after parsing.
                    return { toolName: "write", args, binaryBytes: bytes };
                }
            }
            else {
                content = stringValue(cleaned.content)
                    ?? stringValue(cleaned.file_text)
                    ?? stringValue(cleaned.fileText)
                    ?? stringValue(cleaned.contents)
                    ?? stringValue(cleaned.text);
            }
            if (content !== undefined)
                args.content = content;
            return { toolName: "write", args };
        }
        case "edit": {
            // Preserve an opaque textual edit payload when the advertised executor
            // accepts that generic shape; rebuilding only OpenCode's targeted fields
            // would silently turn a valid call into `{}`.
            if (typeof cleaned.input === "string") {
                return { toolName: "edit", args: { input: cleaned.input } };
            }
            const args = {};
            const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path);
            assignHostFilePath(args, filePath, dialect);
            const oldString = stringValue(cleaned.oldString) ?? stringValue(cleaned.old_string);
            if (oldString !== undefined)
                args.oldString = oldString;
            const newString = stringValue(cleaned.newString) ?? stringValue(cleaned.new_string);
            if (newString !== undefined)
                args.newString = newString;
            if (typeof cleaned.replaceAll === "boolean")
                args.replaceAll = cleaned.replaceAll;
            return { toolName: "edit", args };
        }
        case "bash":
        case "shell": {
            const args = {};
            const command = str(cleaned.command);
            if (command)
                args.command = command;
            if (dialect.shellDescription) {
                const description = str(cleaned.description)
                    ?? (dialect.shellDescription === "required" && command
                        ? `Run: ${command.length > 60 ? `${command.slice(0, 57)}...` : command}`
                        : undefined);
                if (description)
                    args.description = description;
            }
            const workdir = str(cleaned.workdir) ?? str(cleaned.working_directory);
            if (workdir)
                args.workdir = workdir;
            const timeout = num(cleaned.timeout);
            if (timeout !== undefined)
                args.timeout = timeout;
            return { toolName: dialect.shellTool, args };
        }
        case "grep": {
            const pattern = str(cleaned.pattern);
            const path = str(cleaned.path);
            const include = str(cleaned.include) ?? str(cleaned.glob);
            // Cursor's native Grep often arrives with an empty pattern + a glob
            // (e.g. "**/*") when the model is really listing files. OpenCode's grep
            // requires a non-empty string pattern — remap to glob instead of
            // forwarding a call that will fail and loop.
            if (!pattern) {
                const args = { pattern: include ?? "**/*" };
                if (path)
                    args.path = path;
                return { toolName: "glob", args };
            }
            const args = { pattern };
            if (path)
                args.path = path;
            if (include)
                args.include = include;
            return { toolName: "grep", args };
        }
        case "glob": {
            const args = {};
            const pattern = str(cleaned.pattern) ?? str(cleaned.glob_pattern) ?? str(cleaned.globPattern);
            if (pattern)
                args.pattern = pattern;
            const path = str(cleaned.path) ?? str(cleaned.target_directory) ?? str(cleaned.targetDirectory);
            if (path)
                args.path = path;
            return { toolName: "glob", args };
        }
        case "skill": {
            // OpenCode 1.x skill requires `name`; OpenCode 2.0 requires `id`. Both
            // reject the other key (`additionalProperties: false`). Accept either
            // model/Cursor shape and emit only the dialect key.
            const value = str(cleaned[dialect.skillArgKey]) ?? str(cleaned.id) ?? str(cleaned.name);
            const args = { ...cleaned };
            delete args.id;
            delete args.name;
            if (value)
                args[dialect.skillArgKey] = value;
            return { toolName: "skill", args };
        }
        case "todowrite": {
            // OpenCode requires `priority` on every todo item. Cursor TodoWrite /
            // model MCP calls often omit it; fill host defaults before validation.
            return {
                toolName: "todowrite",
                args: normalizeOpencodeTodoArgs(cleaned),
            };
        }
        case "question": {
            // OpenCode requires `header` on every question. Model MCP calls often
            // omit it (AskQuestion bridge already fills it); default before validation.
            return {
                toolName: "question",
                args: normalizeOpencodeQuestionArgs(cleaned),
            };
        }
        default:
            return { toolName, args: cleaned };
    }
}
function str(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
function stringValue(v) {
    return typeof v === "string" ? v : undefined;
}
/** A non-empty protobuf `bytes` field, or undefined when absent/empty. */
function bytesValue(v) {
    if (v instanceof Uint8Array)
        return v.length > 0 ? v : undefined;
    if (Array.isArray(v) && v.every((b) => typeof b === "number")) {
        return v.length > 0 ? Uint8Array.from(v) : undefined;
    }
    return undefined;
}
/** UTF-16/32 embed NUL bytes in ordinary text; 8-bit encodings do not. */
const WIDE_TEXT_ENCODING = /^utf-?(16|32)/;
/**
 * Decode `WriteArgs.file_bytes`. `encoding_hint` names the file's original
 * encoding; OpenCode's `write` takes a string, so an unknown encoding label
 * falls back to UTF-8 rather than dropping the write.
 *
 * Returns undefined when the bytes are not text in that encoding. A non-fatal
 * decode would replace every undecodable sequence with U+FFFD and hand the host
 * a corrupted file that still reports success, so binary content must take the
 * byte-preserving path instead (see `isBinaryWriteRequest`).
 */
export function decodeWriteBytes(bytes, encodingHint) {
    const encoding = encodingHint?.trim().toLowerCase().replace(/[_ ]/g, "-");
    let decoder;
    let label = "utf-8";
    if (encoding && encoding !== "utf-8" && encoding !== "utf8") {
        try {
            decoder = new TextDecoder(encoding, { fatal: true });
            label = encoding;
        }
        catch {
            trace(`write: unsupported encoding_hint ${JSON.stringify(encodingHint)} — decoding as utf-8`);
        }
    }
    if (!decoder)
        decoder = new TextDecoder("utf-8", { fatal: true });
    // Single-byte encodings decode any byte sequence without error, so a decode
    // that cannot fail is not on its own evidence of text.
    if (!WIDE_TEXT_ENCODING.test(label) && bytes.includes(0))
        return undefined;
    try {
        return decoder.decode(bytes);
    }
    catch {
        return undefined;
    }
}
/**
 * True when a parsed `write` request carries bytes that are not text. Such a
 * request cannot go to OpenCode's `write` tool at all — it takes a string, and
 * additionally BOM-splits, diffs, and runs `Format.file()` on what it writes.
 */
export function binaryWritePayload(parsed) {
    if (parsed.toolName !== "write")
        return undefined;
    const data = parsed.resultMetadata?.binaryWriteBytes;
    if (!(data instanceof Uint8Array))
        return undefined;
    return { path: str(parsed.resultMetadata?.path) ?? "", data };
}
function num(v) {
    if (typeof v === "number" && Number.isFinite(v))
        return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
        return Number(v);
    return undefined;
}
/**
 * Fallback OpenCode task title when Cursor's SubagentArgs has no description.
 * Prefer {@link preferCorrelatedTaskDescription} when a TaskToolCall is available —
 * that carries Cursor's real 3–5 word title. This only slices the prompt.
 */
function describeSubagentTask(prompt, subagentType) {
    const words = prompt?.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 5);
    if (words?.length)
        return words.join(" ");
    return `${subagentType || "Delegated"} task`;
}
/**
 * Replace the prompt-derived task title with Cursor's TaskToolCall description
 * when the display call is correlated via tool_call_id. SubagentArgs itself has
 * no description field, so without this OpenCode shows a cut-off first-five-words
 * slice of the prompt.
 */
export function preferCorrelatedTaskDescription(parsed, description) {
    if (parsed.toolName !== "task" && parsed.toolName !== "subagent")
        return;
    if (parsed.resultField !== "subagent_result")
        return;
    const trimmed = description?.trim();
    if (!trimmed)
        return;
    parsed.args.description = trimmed;
}
function shellQuote(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
/**
 * Map Cursor McpArgs back to the OpenCode tool id.
 * Prefers provider_identifier + bare tool_name (github + create_pull_request
 * → github_create_pull_request). Builtins under the default server stay bare.
 */
export function mcpRealToolName(mcpArgs, defaultServer = "opencode") {
    const toolName = typeof mcpArgs.tool_name === "string" ? mcpArgs.tool_name : undefined;
    const provider = typeof mcpArgs.provider_identifier === "string" ? mcpArgs.provider_identifier : undefined;
    if (toolName) {
        if (provider && provider !== defaultServer) {
            // Already a full OpenCode id (legacy ads or model echo).
            if (toolName.startsWith(`${provider}_`))
                return toolName;
            return `${provider}_${toolName}`;
        }
        return toolName;
    }
    const name = typeof mcpArgs.name === "string" ? mcpArgs.name : "";
    const dash = name.indexOf("-");
    if (dash > 0) {
        const server = name.slice(0, dash);
        const bare = name.slice(dash + 1);
        if (server && bare) {
            if (server === defaultServer)
                return bare;
            return `${server}_${bare}`;
        }
    }
    return name || "mcp";
}
function decodeMcpArgs(raw) {
    if (!Array.isArray(raw))
        return {};
    const entries = raw.map((a) => (typeof a === "string" ? b64ToBytes(a) : a));
    try {
        return decodeStructEntriesToJson(entries);
    }
    catch {
        return {};
    }
}
function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function findOneOfVariant(msg, candidates) {
    for (const key of candidates) {
        if (msg[key] !== undefined && msg[key] !== null) {
            return key;
        }
    }
    return undefined;
}
// ── Pre-execution read validation (Cursor LocalReadExecutor parity) ──
/** Expand a leading `~` to the home directory, matching Cursor's untildify. */
function untildify(input) {
    return input.replace(/^~(?=$|\/|\\)/, os.homedir());
}
/**
 * A read target addressed by URI scheme rather than by local filesystem path.
 *
 * Cursor's LocalReadExecutor only ever reads local files, so this provider
 * mirrors its pre-execution validation. An advertised host read tool may also
 * accept URLs or internal URI schemes. Resolving those against the workspace
 * root mangles the URI and produces a false `file_not_found`, so URI targets
 * are forwarded untouched and left to the advertised executor.
 *
 * Requires a scheme of two or more characters followed by `://`, so Windows
 * drive letters (`C:\src`, `C:/src`) stay local paths.
 */
export function isUriReadTarget(requested) {
    return /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(requested);
}
/**
 * Resolve a read target the way Cursor's LocalReadExecutor does before it
 * stats the file: untildify, then resolve a relative path against the workspace
 * root (`env.workspace_paths[0]`), else resolve as-is. Kept in lockstep with
 * agent utils `resolvePath(path, workspaceRoot)`.
 *
 * Only meaningful for local paths; check {@link isUriReadTarget} first.
 */
export function resolveReadTargetPath(requested, workspaceRoot) {
    const expanded = untildify(requested);
    if (isAbsoluteToolPath(expanded)) {
        return isForeignAbsoluteToolPath(expanded) ? expanded : path.resolve(expanded);
    }
    if (workspaceRoot)
        return joinToolPath(workspaceRoot, expanded);
    return path.resolve(expanded);
}
/**
 * A typed ReadResult oneof case for a read target that fails Cursor's
 * pre-execution validation, or undefined when the path is a readable file the
 * tool should actually read. Mirrors LocalReadExecutor exactly:
 *  - missing path (ENOENT/ENOTDIR)     → file_not_found
 *  - directory                         → invalid_file "Path is a directory, not a file"
 *  - socket/fifo/etc (not a file)      → invalid_file "Path is neither a file nor a directory"
 * EACCES/EPERM (exists but unreadable) and any other stat error return undefined
 * so the call proceeds to OpenCode and a genuine permission decision is never
 * masked. Never rejects a non-existent *write/edit* target — this is read-only.
 */
export function classifyMissingReadTarget(absolutePath) {
    let stat;
    try {
        stat = fs.statSync(absolutePath);
    }
    catch (e) {
        const code = e.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return { file_not_found: { path: absolutePath } };
        }
        return undefined;
    }
    if (stat.isDirectory()) {
        return { invalid_file: { path: absolutePath, reason: "Path is a directory, not a file" } };
    }
    if (!stat.isFile()) {
        return {
            invalid_file: { path: absolutePath, reason: "Path is neither a file nor a directory" },
        };
    }
    return undefined;
}
/**
 * Encode a pre-execution read rejection as the exact frames Cursor's client
 * emits: the ExecClientMessage carrying the typed ReadResult oneof case, then
 * the ACM #5 stream_close for that id. `readResult` is the case object from
 * classifyMissingReadTarget (e.g. `{ file_not_found: { path } }`).
 */
export function buildReadRejectionMessages(execId, readResult) {
    return [
        encodeMessage("AgentClientMessage", {
            exec_client_message: {
                id: execId,
                local_execution_time_ms: 0,
                read_result: readResult,
            },
        }),
        buildExecStreamClose(execId),
    ];
}
/**
 * The leading tool-result images an exec result can carry on a held Run.
 * Cursor's own read executor answers an image file with its bytes in
 * `ReadSuccess.data` (#5) and no text; its MCP executor appends each MCP image
 * as an `McpImageContent` item (#2). Other result shapes have no image field.
 */
export function execResultImages(resultField, images) {
    if (!images?.length)
        return [];
    if (resultField === "read_result")
        return [images[0]];
    if (resultField === "mcp_result")
        return [...images];
    return [];
}
function mcpImageItems(images) {
    return images.map((image) => ({ image: { data: image.data, mime_type: image.mimeType } }));
}
/**
 * Build one or more ExecClientMessage frames for a tool result.
 * Shell replies are a sequence of ShellStream oneofs under the same id —
 * Start → stdout/stderr → exit — then an ACM #5 stream_close so the server
 * knows the client finished streaming (CLI always sends this; without it
 * shell execs hang on heartbeats forever).
 */
export function buildExecClientMessages(input) {
    const resultField = input.resultField || "mcp_result";
    const frames = [];
    if (resultField === "shell_stream") {
        const stdout = groundShellPathText(input.output, shellPathRoot(input.resultMetadata, input.workspaceRoot));
        // Real clients always emit Start → Stdout/Stderr* → Exit (capture/tests).
        frames.push(encodeShellStream(input.execId, undefined, { start: {} }));
        if (input.error) {
            frames.push(encodeShellStream(input.execId, undefined, { stderr: { data: input.error } }));
            frames.push(encodeShellStream(input.execId, input.executionTimeMs, { exit: { code: 1, aborted: false } }));
        }
        else {
            if (stdout) {
                frames.push(encodeShellStream(input.execId, undefined, { stdout: { data: stdout } }));
            }
            if (input.shellOutcome?.kind === "backgrounded") {
                frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
                    backgrounded: {
                        shell_id: input.shellOutcome.shellId,
                        command: input.shellOutcome.command,
                        working_directory: input.shellOutcome.workingDirectory,
                        pid: input.shellOutcome.pid,
                        ms_to_wait: input.shellOutcome.msToWait,
                        reason: input.shellOutcome.reason,
                    },
                }));
            }
            else if (input.shellOutcome?.kind === "timeout") {
                frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
                    // Native CLI represents timeout structurally. ShellAbortReason.TIMEOUT=2.
                    exit: { code: 0, aborted: true, abort_reason: 2 },
                }));
            }
            else {
                const exitCode = input.shellOutcome?.kind === "exit"
                    ? Math.max(0, Math.min(0xffff_ffff, input.shellOutcome.code))
                    : 0;
                frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
                    exit: { code: exitCode, aborted: false },
                }));
            }
        }
    }
    else {
        const clientMsg = {
            id: input.execId,
            local_execution_time_ms: input.executionTimeMs ?? 0,
        };
        clientMsg[resultField] = buildTypedExecResult(resultField, input.output, input.error, input.toolName, input.resultMetadata, input.shellOutcome, input.workspaceRoot, execResultImages(resultField, input.images));
        frames.push(encodeMessage("AgentClientMessage", {
            exec_client_message: clientMsg,
        }));
    }
    // Always close the exec stream — mirrors CLI agent-exec after every handler.
    frames.push(buildExecStreamClose(input.execId));
    return frames;
}
/** ACM #5 exec_client_control_message { stream_close { id } }. */
export function buildExecStreamClose(execId) {
    return encodeMessage("AgentClientMessage", {
        exec_client_control_message: {
            stream_close: { id: execId },
        },
    });
}
export function buildUnsupportedExecDeny(input) {
    const { execId, variant, reason } = input;
    const resultName = variant.resultName;
    const frames = [];
    const throwFrame = (msg) => encodeMessage("AgentClientMessage", {
        exec_client_control_message: {
            throw: { id: execId, error: msg },
        },
    });
    switch (resultName) {
        case "shell_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    shell_result: { rejected: { reason } },
                },
            }));
            break;
        case "diagnostics_result":
        case "canvas_diagnostics_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    [resultName]: { error: { path: "", error: reason } },
                },
            }));
            break;
        case "fetch_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    fetch_result: { error: { url: "", error: reason } },
                },
            }));
            break;
        case "record_screen_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    record_screen_result: { failure: { error: reason } },
                },
            }));
            break;
        case "computer_use_result":
        case "write_shell_stdin_result":
        case "smart_mode_classifier_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    [resultName]: { error: { error: reason } },
                },
            }));
            break;
        case "redacted_read_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    redacted_read_result: { error: { path: "", error: reason } },
                },
            }));
            break;
        case "subagent_await_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    subagent_await_result: { error: { error: reason } },
                },
            }));
            break;
        case "shell_allowlist_precheck_result":
        case "mcp_allowlist_precheck_result":
        case "web_fetch_allowlist_precheck_result":
            // Typed precheck result is a bool, not a reason string. Encoding
            // `{allowlisted:false}` selects the ExecClientMessage oneof; protobufjs
            // writes field 1 as varint 0 so Cursor decodes the deny rather than an
            // empty/unspecified precheck.
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    [resultName]: { allowlisted: false },
                },
            }));
            break;
        case "force_background_shell_result":
        case "force_background_subagent_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    [resultName]: { status: FORCE_BACKGROUND_STATUS_ERROR },
                },
            }));
            break;
        case "mini_swe_agent_bash_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    mini_swe_agent_bash_result: { rejected: { reason } },
                },
            }));
            break;
        case "conversation_search_result":
            // No local Cursor conversation index. Empty success is truthful and
            // avoids a retry loop; the model can continue with listed tools.
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    conversation_search_result: {
                        success: { hits: [], truncated: false, partial: false, rebuilding: false },
                    },
                },
            }));
            break;
        case "agent_store_conflict_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    agent_store_conflict_result: { error: { error: reason } },
                },
            }));
            break;
        case "adopt_result":
            frames.push(encodeMessage("AgentClientMessage", {
                exec_client_message: {
                    id: execId,
                    local_execution_time_ms: 0,
                    adopt_result: { error: reason },
                },
            }));
            break;
        case "execute_hook_result":
            // agent.proto has no populated error oneof we can emit;
            // Cursor CLI answers this through exec_client_control_message.throw.
            frames.push(throwFrame(reason));
            frames.push(buildExecStreamClose(execId));
            return frames;
        default:
            // Fallback for any future unsupported variant without a dedicated shape:
            // typed error when possible, else throw. Unknown shapes should hard-fail
            // at the pump, so this path is not expected for known unsupported rows.
            frames.push(throwFrame(reason));
            frames.push(buildExecStreamClose(execId));
            return frames;
    }
    frames.push(buildExecStreamClose(execId));
    return frames;
}
/** OpenCode 2 `read` prints this when a text page does not reach EOF. */
const OPENCODE2_READ_TRUNCATION = /^\[Output truncated\. Continue reading with offset:\s*(\d+)\]\s*$/;
/** OpenCode 2 stops a read at 2,000 lines as well as 50 KB. */
const OPENCODE2_READ_MAX_LINES = 2_000;
const OPENCODE2_READ_MAX_LINE_CHARS = 2_000;
const OPENCODE2_READ_LINE_TRUNCATION = `... (line truncated to ${OPENCODE2_READ_MAX_LINE_CHARS} chars)`;
/**
 * `read-filesystem.ts` shortens each selected line to 2,000 UTF-16 code units.
 * One code unit encodes to at most three UTF-8 bytes. Add the 34-byte
 * `... (line truncated to 2000 chars)` suffix and one line separator when
 * proving a page was close enough for the next line not to fit.
 */
const OPENCODE2_MAX_RENDERED_LINE_BYTES = (OPENCODE2_READ_MAX_LINE_CHARS * 3) + Buffer.byteLength(OPENCODE2_READ_LINE_TRUNCATION, "utf8") + 1;
function normalizeToolText(output) {
    return output.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
/**
 * OpenCode 2 `ReadTool.toModelContent` for a file. The whole string must match;
 * a file that merely quotes the header stays a numbered body line.
 *
 *   Read file <path>, lines <start>-<end>
 *   <n>: <line>
 *   [Output truncated. Continue reading with offset: <next>]
 */
function parseOpenCode2FileRead(output, resultMetadata) {
    const normalized = normalizeToolText(output).replace(/\n+$/, "");
    if (!normalized.startsWith("Read file "))
        return undefined;
    const lines = normalized.split("\n");
    const headerLine = (lines[0] ?? "").trim();
    const empty = /^Read file (.*), 0 lines$/.exec(headerLine);
    if (empty) {
        if (lines.length !== 1)
            return undefined;
        return {
            path: empty[1] ?? "",
            content: "",
            totalLines: 0,
            hostTruncated: false,
            outputCapped: false,
            truncatedLines: [],
        };
    }
    const header = /^Read file (.*), lines (\d+)-(\d+)$/.exec(headerLine);
    if (!header)
        return undefined;
    const start = Number(header[2]);
    const end = Number(header[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        return undefined;
    }
    let bodyEnd = lines.length;
    let nextOffset;
    const banner = OPENCODE2_READ_TRUNCATION.exec(lines[lines.length - 1] ?? "");
    if (banner) {
        nextOffset = Number(banner[1]);
        if (!Number.isSafeInteger(nextOffset) || nextOffset < 1)
            return undefined;
        bodyEnd -= 1;
    }
    const expected = end - start + 1;
    if (bodyEnd - 1 !== expected)
        return undefined;
    const raw = [];
    const truncatedLines = [];
    for (let index = 0; index < expected; index++) {
        const match = /^(\d+):[ \t](.*)$/.exec(lines[index + 1] ?? "");
        if (!match || Number(match[1]) !== start + index)
            return undefined;
        const value = match[2] ?? "";
        if (value.length === OPENCODE2_READ_MAX_LINE_CHARS + OPENCODE2_READ_LINE_TRUNCATION.length
            && value.endsWith(OPENCODE2_READ_LINE_TRUNCATION)) {
            truncatedLines.push(start + index);
        }
        raw.push(value);
    }
    const content = raw.join("\n");
    const hostTruncated = nextOffset !== undefined;
    const requestedLimit = num(resultMetadata?.limit);
    const effectiveLineLimit = requestedLimit !== undefined && requestedLimit > 0
        ? Math.min(requestedLimit, OPENCODE2_READ_MAX_LINES)
        : OPENCODE2_READ_MAX_LINES;
    // OpenCode 2 ends a text page only for the requested/default line limit or
    // the 50 KiB byte limit. Fewer lines than the effective line limit, together
    // with a page close enough that one maximum-size rendered line may not fit,
    // identifies the byte cap without the old ASCII-only 4 KiB guess.
    const outputCapped = hostTruncated
        && expected < effectiveLineLimit
        && Buffer.byteLength(content, "utf8") > OPENCODE_READ_MAX_BYTES - OPENCODE2_MAX_RENDERED_LINE_BYTES;
    if (hostTruncated) {
        return {
            path: header[1] ?? "",
            content,
            startLine: start,
            endLine: end,
            nextOffset,
            hostTruncated: true,
            outputCapped,
            truncatedLines,
        };
    }
    // A page that reached EOF is complete. Record the span so a non-1 offset is
    // not later mistaken for a silent cap, without flagging it truncated.
    return {
        path: header[1] ?? "",
        content,
        ...(start === 1
            ? { totalLines: end }
            : { startLine: start, endLine: end, totalLines: end }),
        hostTruncated: false,
        outputCapped: false,
        truncatedLines,
    };
}
/**
 * OpenCode 2 directory reads list bare entry names. Join them onto the
 * directory, then onto the workspace root, so the model can copy a real path
 * instead of inventing an absolute prefix.
 */
function parseOpenCode2DirectoryListing(output, workspaceRoot) {
    const normalized = normalizeToolText(output).replace(/\n+$/, "");
    if (!normalized.startsWith("Read directory "))
        return undefined;
    const lines = normalized.split("\n");
    const header = /^Read directory (.*), (?:0 entries|entries (\d+)-(\d+))$/.exec((lines[0] ?? "").trim());
    if (!header) {
        trace("parseOpenCode2DirectoryListing: OpenCode 2 directory header did not match — leaving output unchanged");
        return undefined;
    }
    const requested = header[1] ?? "";
    if (!isAbsoluteToolPath(requested) && !workspaceRoot)
        return undefined;
    let bodyEnd = lines.length;
    let banner;
    if (bodyEnd > 1 && OPENCODE2_READ_TRUNCATION.test(lines[bodyEnd - 1] ?? "")) {
        banner = lines[bodyEnd - 1];
        bodyEnd -= 1;
    }
    const rawEntries = lines.slice(1, bodyEnd);
    if (header[2] === undefined) {
        if (rawEntries.length !== 0)
            return undefined;
    }
    else {
        const start = Number(header[2]);
        const end = Number(header[3]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start + 1 !== rawEntries.length) {
            return undefined;
        }
    }
    const directory = resolveToolPath(requested, workspaceRoot);
    const directories = [];
    const files = [];
    const entries = rawEntries.map((entry) => {
        const resolved = resolveListedEntry(directory, entry);
        if (entry.endsWith("/") || entry.endsWith("\\"))
            directories.push(resolved);
        else
            files.push(resolved);
        return resolved;
    });
    const headerLine = header[2] === undefined
        ? `Read directory ${directory}, 0 entries`
        : `Read directory ${directory}, entries ${header[2]}-${header[3]}`;
    return {
        directory,
        entries,
        directories,
        files,
        text: [headerLine, ...entries, ...(banner ? [banner] : [])].join("\n"),
    };
}
/**
 * Absolute on this host, plus Windows drive and UNC paths. A posix agent must
 * not prefix `C:/…` or `\\server\…` just because `path.isAbsolute` rejects them.
 */
function isAbsoluteToolPath(filePath) {
    return path.isAbsolute(filePath)
        || /^[A-Za-z]:[\\/]/.test(filePath)
        || filePath.startsWith("\\\\");
}
/** Windows drive or UNC path that `path.isAbsolute` rejects on this host. */
function isForeignAbsoluteToolPath(filePath) {
    return isAbsoluteToolPath(filePath) && !path.isAbsolute(filePath);
}
/** Separator already used by a drive or UNC path. Host paths keep `path.sep`. */
function toolPathSeparator(filePath) {
    if (path.isAbsolute(filePath))
        return path.sep;
    if (filePath.startsWith("\\\\") || (filePath.includes("\\") && !filePath.includes("/")))
        return "\\";
    return "/";
}
/**
 * Join `relative` onto `root`. Node's `path.resolve` treats `C:/…` and
 * `\\server\…` as relative on posix and prefixes the process cwd. Keep those
 * roots intact, including `..`, and still use `path.resolve` for host paths.
 */
function joinToolPath(root, relative) {
    // `path.resolve` drops a trailing separator. Glob and find use that separator
    // to tell a directory from a file; putting it back keeps the marker.
    const directory = relative.endsWith("/") || relative.endsWith("\\");
    const joined = joinResolvedToolPath(root, relative);
    if (!directory || joined.endsWith("/") || joined.endsWith("\\"))
        return joined;
    return `${joined}${toolPathSeparator(joined)}`;
}
function joinResolvedToolPath(root, relative) {
    if (!isForeignAbsoluteToolPath(root))
        return path.resolve(root, relative);
    const sep = toolPathSeparator(root);
    const base = splitForeignAbsolute(root, sep);
    const parts = [...base.segments];
    for (const part of relative.split(/[\\/]+/)) {
        if (!part || part === ".")
            continue;
        if (part === "..") {
            if (parts.length > base.frozen)
                parts.pop();
            continue;
        }
        parts.push(part);
    }
    return parts.length === 0 ? base.prefix : `${base.prefix}${parts.join(sep)}`;
}
function splitForeignAbsolute(filePath, sep) {
    if (filePath.startsWith("\\\\")) {
        const segments = filePath.slice(2).split(/[\\/]+/).filter(Boolean);
        return { prefix: "\\\\", segments, frozen: Math.min(2, segments.length) };
    }
    const rest = filePath.slice(2).replace(/^[\\/]+/, "");
    return {
        prefix: `${filePath.slice(0, 2)}${sep}`,
        segments: rest ? rest.split(/[\\/]+/).filter(Boolean) : [],
        frozen: 0,
    };
}
function isRelativePathToken(token) {
    if (!token || isAbsoluteToolPath(token))
        return false;
    // A slash alone does not make arbitrary shell output a path. In particular,
    // compact JSON, quoted strings, package ids, and shell syntax must remain
    // byte-for-byte model-visible rather than being prefixed with the workspace.
    if (/[\0"'`{}\[\]<>|;]/.test(token) || token.startsWith("@"))
        return false;
    if (token.startsWith("./")
        || token.startsWith("../")
        || token.startsWith(".\\")
        || token.startsWith("..\\"))
        return true;
    return token.includes("/") || (path.sep === "\\" && token.includes("\\"));
}
function resolveListedEntry(directory, entry) {
    if (!entry || isAbsoluteToolPath(entry))
        return entry;
    if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\"))
        return entry;
    const directoryEntry = entry.endsWith("/") || entry.endsWith("\\");
    const resolved = joinToolPath(directory, entry);
    if (!directoryEntry || resolved.endsWith("/") || resolved.endsWith("\\"))
        return resolved;
    return `${resolved}${toolPathSeparator(resolved)}`;
}
function resolveToolPath(filePath, workspaceRoot) {
    if (!filePath || isAbsoluteToolPath(filePath))
        return filePath;
    if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\"))
        return filePath;
    if (!workspaceRoot)
        return filePath;
    return joinToolPath(workspaceRoot, filePath);
}
/**
 * Rewrite OpenCode 2 grep/glob lines that are still project-relative. Absolute
 * paths, indented match previews, and prose stay untouched. Grep file headers
 * drop the trailing colon only in the structured file list, not in this text.
 */
/**
 * Longer phrases first. "No files found" is a prefix of the pattern sentence,
 * and a suffix check must not stop on the shorter one.
 */
const SEARCH_STATUS_MESSAGES = [
    "No files found matching pattern",
    "No matches before timeout (scan incomplete)",
    "No files found",
    "No matches found",
];
/**
 * A glob/find miss is prose, not a path. Hosts sometimes still carry it as a
 * path segment (`../../workspace/No files found matching pattern`) or fold that
 * segment into a `# dir/` header plus a bare sentence. Either shape must stay
 * the sentence: joining it onto the workspace is what lists a fake file.
 */
function searchStatusMessage(line) {
    const trimmed = line.trim().replace(/^#+\s+/, "");
    for (const message of SEARCH_STATUS_MESSAGES) {
        if (trimmed === message || trimmed.endsWith(`/${message}`) || trimmed.endsWith(`\\${message}`)) {
            return message;
        }
    }
    return undefined;
}
function collapseSearchStatus(output) {
    return output.split("\n").map((line) => searchStatusMessage(line) ?? line).join("\n");
}
function isSearchStatusReport(output) {
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 && lines.every((line) => searchStatusMessage(line) !== undefined);
}
/**
 * Cursor's find/glob executor shows one path per line. A directory ends with
 * `/`; a file does not. Some hosts instead print a folded tree:
 *
 *   # src/
 *   a.ts
 *   ## components/
 *   button.tsx
 *   # tests/
 *
 * A `# dir/` line is a grouping header, not another match. Emitting it lists
 * the directory beside its own children (and the shared search prefix shows up
 * as a blank entry once that prefix is the directory being searched). Expand
 * the tree to the files underneath only. A header with no child is still just
 * an empty directory in the walk — Cursor find reports files, so leave it out
 * (same as targeting that empty directory and getting a miss).
 */
function parseGroupedPathListing(output) {
    const lines = output.replace(/\n+$/, "").split("\n");
    const events = [];
    const stack = [];
    let sawHeader = false;
    let inNotes = false;
    for (const line of lines) {
        if (!line.trim()) {
            if (sawHeader)
                inNotes = true;
            continue;
        }
        if (inNotes) {
            events.push({ kind: "note", text: line });
            continue;
        }
        const status = searchStatusMessage(line);
        if (status) {
            events.push({ kind: "note", text: status });
            continue;
        }
        const header = /^(#+)\s+(\S.*?)\s*$/.exec(line);
        if (header) {
            const rawName = header[2] ?? "";
            if (!rawName.endsWith("/") && !rawName.endsWith("\\"))
                return undefined;
            const depth = header[1].length - 1;
            if (depth > stack.length)
                return undefined;
            const name = rawName.slice(0, -1);
            if (!name || name === "." || name === "..")
                return undefined;
            stack.length = depth;
            const parent = depth === 0 ? "" : (stack[depth - 1] ?? "");
            if (depth > 0 && !parent)
                return undefined;
            const full = parent ? joinDisplayPath(parent, name) : name;
            stack.push(full);
            events.push({ kind: "dir", depth, path: full });
            sawHeader = true;
            continue;
        }
        if (line.startsWith(" ") || line.startsWith("\t") || /\s/.test(line) || line.includes("://")) {
            return undefined;
        }
        if (line.includes("/") || line.includes("\\"))
            return undefined;
        if (!sawHeader) {
            events.push({ kind: "file", path: line });
            continue;
        }
        const parent = stack[stack.length - 1];
        if (!parent)
            return undefined;
        events.push({ kind: "file", path: joinDisplayPath(parent, line) });
    }
    if (!sawHeader)
        return undefined;
    const paths = [];
    const notes = [];
    let sawFile = false;
    for (const event of events) {
        if (event.kind === "note")
            notes.push(event.text);
        else if (event.kind === "file") {
            sawFile = true;
            paths.push(event.path);
        }
        // Directory headers are structure only — never emit them as matches.
    }
    // The header existed only to hold the miss sentence. Emitting it lists a
    // directory that was never a match, usually the walk back to the workspace.
    if (!sawFile && notes.some((note) => searchStatusMessage(note)))
        return { paths: [], notes };
    return { paths, notes };
}
function joinDisplayPath(parent, child) {
    if (!parent || parent === ".")
        return child;
    if (parent === "/")
        return `/${child}`;
    const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    if (parent.endsWith("/") || parent.endsWith("\\"))
        return `${parent}${child}`;
    return `${parent}${sep}${child}`;
}
function renderGroupedPathListing(listing, workspaceRoot) {
    const paths = listing.paths.map((entry) => resolveToolPath(entry, workspaceRoot));
    if (paths.length === 0) {
        // Grouped output that only had directory headers (empty dirs) is a miss,
        // same as targeting that empty directory directly.
        if (listing.notes.length === 0)
            return "No files found";
        return listing.notes.join("\n");
    }
    if (listing.notes.length === 0)
        return paths.join("\n");
    return [...paths, "", ...listing.notes].join("\n");
}
function groundSearchOutput(output, workspaceRoot) {
    const normalized = normalizeToolText(output);
    const grouped = parseGroupedPathListing(normalized);
    if (grouped)
        return renderGroupedPathListing(grouped, workspaceRoot);
    const collapsed = collapseSearchStatus(normalized);
    if (isSearchStatusReport(collapsed))
        return collapsed;
    if (!workspaceRoot)
        return collapsed;
    const first = collapsed.split("\n", 1)[0] ?? "";
    const searchShaped = /^Found \d+ matches/.test(first) || searchStatusMessage(first) !== undefined;
    if (!searchShaped && !isBarePathList(collapsed))
        return collapsed;
    return collapsed.split("\n").map((line) => rewriteSearchPathLine(line, workspaceRoot)).join("\n");
}
function isBarePathList(output) {
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines.length > 2000)
        return false;
    return lines.every((line) => {
        if (line.startsWith("("))
            return true;
        if (/\s/.test(line) || line.includes("://"))
            return false;
        return true;
    });
}
function rewriteSearchPathLine(line, workspaceRoot) {
    if (!line || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("("))
        return line;
    const status = searchStatusMessage(line);
    if (status || line.startsWith("Found "))
        return status ?? line;
    const header = /^(.*):$/.exec(line);
    if (header && !header[1]?.includes("://")) {
        return `${resolveToolPath(header[1] ?? "", workspaceRoot)}:`;
    }
    if (line.includes("://"))
        return line;
    return resolveToolPath(line, workspaceRoot);
}
/**
 * Shell stdout is mixed prose. Rewrite only tokens that are clearly relative
 * paths, including `file:line` and `file:line:col`. Leave sentences, URLs, and
 * status words alone.
 */
function groundShellPathText(output, root) {
    if (!root || !output)
        return output;
    return normalizeToolText(output).split("\n").map((line) => rewriteShellPathLine(line, root)).join("\n");
}
function shellPathRoot(resultMetadata, workspaceRoot) {
    const workingDirectory = str(resultMetadata?.working_directory)?.trim();
    if (!workingDirectory)
        return workspaceRoot;
    if (isAbsoluteToolPath(workingDirectory))
        return workingDirectory;
    return workspaceRoot ? joinToolPath(workspaceRoot, workingDirectory) : undefined;
}
function rewriteShellPathLine(line, root) {
    if (!line || line.startsWith(" ") || line.startsWith("\t"))
        return line;
    const trimmed = line.trimEnd();
    if (trimmed.includes("://") || trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        return line;
    }
    const located = /^(.+?):(\d+)(?::(\d+))?$/.exec(trimmed);
    if (located && located[1] && isRelativePathToken(located[1])) {
        const suffix = located[3] !== undefined ? `:${located[2]}:${located[3]}` : `:${located[2]}`;
        return `${resolveToolPath(located[1], root)}${suffix}`;
    }
    if (/\s/.test(trimmed))
        return line;
    const header = /^(.*):$/.exec(trimmed);
    if (header && header[1] && isRelativePathToken(header[1])) {
        return `${resolveToolPath(header[1], root)}:`;
    }
    if (isRelativePathToken(trimmed))
        return resolveToolPath(trimmed, root);
    return line;
}
const OPENCODE_GREP_LINE = /^[ \t]+Line (\d+):[ \t]?(.*)$/;
/**
 * OpenCode 1.x and 2.0 both render grep as `Found N matches`, a `path:` header,
 * and indented `Line N: text` previews. A page with no previews is not content.
 */
function parseOpenCodeGrepContent(output, workspaceRoot) {
    const lines = normalizeToolText(output).split("\n");
    const first = lines[0]?.trim() ?? "";
    if (!/^Found \d+ matches\b/.test(first))
        return undefined;
    const matches = [];
    let current;
    let truncated = /\bmore matches available\b/.test(first);
    let sawLine = false;
    for (const raw of lines.slice(1)) {
        if (!raw.trim())
            continue;
        const preview = OPENCODE_GREP_LINE.exec(raw);
        if (preview) {
            sawLine = true;
            if (!current)
                continue;
            const lineNumber = Number(preview[1]);
            if (!Number.isSafeInteger(lineNumber) || lineNumber < 1)
                continue;
            current.matches.push({ line_number: lineNumber, content: preview[2] ?? "" });
            continue;
        }
        if (raw.trimStart().startsWith("(")) {
            if (/truncat/i.test(raw))
                truncated = true;
            continue;
        }
        if (raw.startsWith(" ") || raw.startsWith("\t"))
            continue;
        const header = /^(.*):$/.exec(raw.trim());
        if (!header || !header[1] || header[1].includes("://"))
            continue;
        current = { file: resolveToolPath(header[1], workspaceRoot), matches: [] };
        matches.push(current);
    }
    if (!sawLine)
        return undefined;
    const withHits = matches.filter((file) => file.matches.length > 0);
    if (withHits.length === 0)
        return undefined;
    return {
        matches: withHits,
        truncated,
        totalMatchedLines: withHits.reduce((count, file) => count + file.matches.length, 0),
    };
}
function grepRequestResultMetadata(raw) {
    const pattern = str(raw.pattern);
    const outputMode = str(raw.output_mode);
    const searchPath = str(raw.path);
    if (!pattern && !outputMode && !searchPath)
        return undefined;
    return {
        ...(pattern ? { pattern } : {}),
        ...(outputMode ? { output_mode: outputMode } : {}),
        ...(searchPath ? { path: searchPath } : {}),
    };
}
function extractGroundedPaths(output, workspaceRoot) {
    const normalized = normalizeToolText(output);
    const grouped = parseGroupedPathListing(normalized);
    if (grouped) {
        return grouped.paths.map((entry) => resolveToolPath(entry, workspaceRoot)).slice(0, 2000);
    }
    const collapsed = collapseSearchStatus(normalized);
    if (isSearchStatusReport(collapsed))
        return [];
    const directory = parseOpenCode2DirectoryListing(collapsed, workspaceRoot);
    if (directory)
        return directory.entries.slice(0, 2000);
    const first = collapsed.split("\n", 1)[0]?.trim() ?? "";
    if (/^Found \d+ matches/.test(first) || searchStatusMessage(first)) {
        const paths = [];
        for (const raw of collapsed.split("\n").slice(1)) {
            const line = raw.trim();
            if (!line
                || line.startsWith("(")
                || line.startsWith("Line ")
                || line.startsWith("#")
                || searchStatusMessage(line)
                || raw.startsWith(" ")
                || raw.startsWith("\t")) {
                continue;
            }
            const header = /^(.*):$/.exec(line);
            const candidate = header && !header[1]?.includes("://") ? (header[1] ?? "") : line;
            if (!candidate || candidate.includes("://") || searchStatusMessage(candidate))
                continue;
            paths.push(resolveToolPath(candidate, workspaceRoot));
        }
        return paths.slice(0, 2000);
    }
    if (isBarePathList(output)) {
        return output
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("("))
            .map((line) => resolveToolPath(line.endsWith(":") && !line.includes("://") ? line.slice(0, -1) : line, workspaceRoot))
            .slice(0, 2000);
    }
    return extractPathLines(output).map((line) => {
        const trimmed = line.trim();
        const candidate = trimmed.endsWith(":") && !trimmed.includes("://") ? trimmed.slice(0, -1) : trimmed;
        return resolveToolPath(candidate, workspaceRoot);
    });
}
/**
 * Strip opencode's `read` envelope, leaving raw file content.
 *
 * OpenCode 1.x (`tool/read.ts`) wraps content in an XML-ish envelope its own
 * models are trained on, but Cursor's are not:
 *   <path>{abs}</path>\n<type>file</type>\n<content>\n{N}: {line}\n…\n\n{footer}\n</content>
 * OpenCode 2 replaced that with `Read file <path>, lines <start>-<end>` plus
 * the same `N: ` prefixes and `[Output truncated. Continue reading with offset: N]`.
 * Forwarding either envelope verbatim made Cursor's model treat the wrapper as
 * literal file content and write tags or line prefixes back into files.
 *
 * Returns the raw file body (line numbers + footer + `<system-reminder>` dropped).
 *
 * Deliberately exception-safe: if the expected envelope is absent — non-read
 * output, already-raw text, or a future opencode format change — it returns the
 * input unchanged, so a result is never broken and we never throw mid-turn.
 * Callers must still gate `mcp_result` on `toolName === "read"`; this helper
 * alone is not a tool-identity check.
 */
export function unwrapReadOutput(output) {
    if (typeof output !== "string" || output.length === 0)
        return output;
    const opencode2 = parseOpenCode2FileRead(output);
    if (opencode2)
        return opencode2.content;
    if (normalizeToolText(output).startsWith("Read file ")) {
        trace("unwrapReadOutput: OpenCode 2 read header did not match the page parser — leaving output unchanged");
    }
    // Require the full opencode read-envelope skeleton *before* `<content>`
    // (read.ts opens with <path>…</path>, <type>file</type>, <content>) so a
    // stray "<content>" later in tool chatter can't trigger unwrapping just
    // because path/type tags appear elsewhere in the payload.
    const contentHeaderIdx = output.indexOf("<content>");
    if (contentHeaderIdx === -1)
        return output;
    const header = output.slice(0, contentHeaderIdx);
    const hasSkeleton = header.indexOf("<path>") !== -1 &&
        header.indexOf("<type>file</type>") !== -1;
    if (!hasSkeleton) {
        // Saw "<content>" but not the read skeleton ahead of it — almost certainly
        // a non-read payload, or an opencode format drift. Surface it so drift
        // can't silently resurrect the wrapper-corruption bug, but still fail
        // safe (no mutate).
        trace("unwrapReadOutput: <content> present without leading <path>/<type>file> skeleton — leaving output unchanged (possible non-read payload or opencode read format drift)");
        return output;
    }
    // Body starts right after "<content>\n". opencode emits one numbered line per
    // file line ("N: <line>"), then a blank, a "(…)" footer, and a standalone
    // "</content>". The body is a *contiguous run* of /^N: / lines — so we stop at
    // the first non-numbered line. Critically we do NOT search for a closing
    // "</content>" substring: a file line that literally contains "</content>"
    // is rendered as "N: </content>" (a body line), and a raw indexOf would
    // truncate the read there.
    let rest = output.slice(contentHeaderIdx + "<content>".length);
    if (rest.startsWith("\n"))
        rest = rest.slice(1);
    const raw = [];
    for (const line of rest.split("\n")) {
        const m = /^(\d+):[ \t]?(.*)$/.exec(line);
        if (!m)
            break; // blank / "(footer)" / "</content>" → end of body run
        // Strip only the leading "N: " prefix; a line that itself begins with
        // digits+colon keeps its content (we remove just the first match). Blank
        // file lines render as "N: " and are preserved (capture group is "").
        raw.push(m[2]);
    }
    // Envelope confirmed but no numbered body → empty file. Return "" rather
    // than the envelope (the envelope is exactly what Cursor echoes into writes).
    return raw.join("\n");
}
/**
 * Map OpenCode tool text into the agent.v1 result oneof for each exec variant.
 * OpenCode returns free-form text; we wrap it in the minimal success shape the
 * server accepts (verified against agent.v1 wire captures).
 */
export function buildTypedExecResult(resultField, output, error, toolName, resultMetadata, shellOutcome, workspaceRoot, images = []) {
    // Prefer the session workspace; never advertise the host process cwd (daemon
    // often starts in $HOME) as the path Cursor shows the model for glob/ls.
    const trimmedRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    // A posix process must not turn `C:/…` or `\\server\…` into `<cwd>/C:/…`.
    const resultRoot = trimmedRoot
        ? (isForeignAbsoluteToolPath(trimmedRoot) ? trimmedRoot : path.resolve(trimmedRoot))
        : undefined;
    switch (resultField) {
        case "read_result": {
            const parsedFile = parseOpenCode2FileRead(output, resultMetadata);
            const listing = error ? undefined : parseOpenCode2DirectoryListing(output, resultRoot);
            const rawPath = str(resultMetadata?.path)
                ?? parsedFile?.path
                ?? listing?.directory
                ?? extractPathTag(output)
                ?? "";
            const readPath = resolveToolPath(rawPath, resultRoot);
            if (error)
                return { error: { path: readPath, error } };
            const image = images[0];
            if (image) {
                return {
                    success: {
                        path: readPath,
                        data: image.data,
                        total_lines: 0,
                        file_size: readFileSize(readPath) || image.data.length,
                        truncated: false,
                    },
                };
            }
            // The host may have resolved an alternate spelling after the request
            // (for example a Unicode-space filename). Use the result's own path for
            // local stat/newline recovery while preserving the requested path in the
            // Cursor result, matching the existing OpenCode 1 behavior.
            const outputPath = parsedFile?.path ?? extractPathTag(output);
            const statPath = resolveToolPath(outputPath ?? readPath, resultRoot);
            // Strip OpenCode's read envelope so Cursor's model receives raw file
            // content and can't echo the wrapper into subsequent writes.
            // Cursor's native read_args lands here; `mcp_args` reads land in
            // mcp_result. Live captures show gpt-5.4-mini and grok-4.5 both use the
            // native channel, so this is the path that matters in practice.
            const outputMetadata = parseOpenCodeReadMetadata(output, resultMetadata);
            const content = listing
                ? listing.text
                : restoreCompleteReadTerminator(unwrapReadOutput(output), statPath, outputMetadata, resultMetadata, resultRoot);
            const totalLines = outputMetadata.totalLines ?? readFileLineCount(statPath) ?? countLines(content);
            const rangeApplied = readRangeApplied(resultMetadata, totalLines);
            // `truncated` alone is not enough: it is set here, and models still assert
            // the partial content is the whole file. Cursor's own executor puts the
            // limit marker in the output text for the same reason, so append one.
            const notices = [
                readTruncationNotice(output, resultMetadata),
                readLongLineTruncationNotice(output),
            ].filter((notice) => !!notice);
            return {
                success: {
                    path: listing?.directory || readPath,
                    content: notices.length > 0 ? `${content}\n\n${notices.join("\n\n")}` : content,
                    total_lines: totalLines,
                    file_size: listing ? 0 : readFileSize(statPath),
                    truncated: readOutputTruncated(resultMetadata, outputMetadata, totalLines),
                    range_applied: rangeApplied,
                },
            };
        }
        case "grep_result": {
            if (error)
                return { error: { error } };
            const cwd = resultRoot ?? "";
            const pattern = str(resultMetadata?.pattern) ?? "";
            const requestedPath = str(resultMetadata?.path) ?? cwd;
            const requestedMode = str(resultMetadata?.output_mode);
            // OpenCode always returns match previews. Cursor's native Grep defaults
            // to content; encoding that as files_with_matches drops the previews and
            // the model only sees paths. Keep files_with_matches for an explicit
            // files-only request, and for path lists (glob remaps, no matches).
            const parsedContent = parseOpenCodeGrepContent(output, resultRoot);
            const content = requestedMode === "files_with_matches"
                ? undefined
                : parsedContent;
            if (content) {
                return {
                    success: {
                        pattern,
                        path: requestedPath,
                        output_mode: "content",
                        workspace_results: {
                            [cwd]: {
                                content: {
                                    matches: content.matches,
                                    total_lines: content.totalMatchedLines,
                                    total_matched_lines: content.totalMatchedLines,
                                    client_truncated: content.truncated,
                                    ripgrep_truncated: false,
                                },
                            },
                        },
                    },
                };
            }
            const files = extractGroundedPaths(output, resultRoot);
            return {
                success: {
                    pattern,
                    path: requestedPath,
                    output_mode: "files_with_matches",
                    workspace_results: {
                        [cwd]: {
                            files: {
                                files,
                                total_files: files.length,
                                client_truncated: parsedContent?.truncated ?? false,
                            },
                        },
                    },
                },
            };
        }
        case "write_result": {
            // Prefer the path recorded from WriteArgs / a remapped apply_patch write.
            // Host write output is not a `<path>` envelope, and Cursor's GetMcpTools
            // spill copies WriteSuccess.path into the model-visible filePath.
            const remappedPath = str(resultMetadata?.path);
            if (error)
                return { error: { path: remappedPath ?? "", error } };
            return {
                success: {
                    path: remappedPath ?? extractPathTag(output) ?? "",
                    lines_created: countLines(output),
                    file_size: output.length,
                },
            };
        }
        case "pi_write_result":
            // PiWriteExecSuccess is just { output }; error is { error }.
            if (error)
                return { error: { error } };
            return { success: { output: output || "Wrote file successfully." } };
        case "pi_read_result": {
            if (error)
                return { error: { error } };
            // Pi results carry truncation structurally (PiReadExecSuccess field 2),
            // which is how Cursor's own executors report a capped payload.
            const content = unwrapReadOutput(output);
            const truncation = readTruncationMessage(output, content, resultMetadata);
            return { success: { output: content, ...(truncation ? { truncation } : {}) } };
        }
        case "shell_result": {
            const command = str(resultMetadata?.command) ?? "";
            const workingDirectory = str(resultMetadata?.working_directory) ?? "";
            const stdout = groundShellPathText(output, shellPathRoot(resultMetadata, resultRoot));
            if (error) {
                return {
                    failure: {
                        command,
                        working_directory: workingDirectory,
                        exit_code: 1,
                        stdout: stdout || "",
                        stderr: error,
                        aborted: false,
                    },
                };
            }
            if (shellOutcome?.kind === "timeout") {
                return {
                    timeout: {
                        command,
                        working_directory: workingDirectory,
                        timeout_ms: shellOutcome.timeoutMs,
                    },
                };
            }
            if (shellOutcome?.kind === "backgrounded") {
                return {
                    success: {
                        command: shellOutcome.command || command,
                        working_directory: shellOutcome.workingDirectory || workingDirectory,
                        exit_code: 0,
                        stdout: stdout,
                        shell_id: shellOutcome.shellId,
                        pid: shellOutcome.pid,
                        ms_to_wait: shellOutcome.msToWait,
                        background_reason: shellOutcome.reason,
                    },
                    is_background: true,
                    pid: shellOutcome.pid,
                };
            }
            const exitCode = shellOutcome?.kind === "exit"
                ? Math.max(0, Math.min(0xffff_ffff, shellOutcome.code))
                : 0;
            return {
                success: {
                    command,
                    working_directory: workingDirectory,
                    exit_code: exitCode,
                    stdout: stdout,
                },
            };
        }
        case "pi_bash_result":
            if (error)
                return { error: { error } };
            return { success: { output: groundShellPathText(output, shellPathRoot(resultMetadata, resultRoot)) } };
        case "pi_edit_result":
            if (error)
                return { error: { error } };
            return { success: { output } };
        case "pi_grep_result":
        case "pi_find_result":
            if (error)
                return { error: { error } };
            return { success: { output: groundSearchOutput(output, resultRoot) } };
        case "pi_ls_result": {
            if (error)
                return { error: { error } };
            const listing = parseOpenCode2DirectoryListing(output, resultRoot);
            return { success: { output: listing?.text ?? groundSearchOutput(output, resultRoot) } };
        }
        case "delete_result":
            if (error)
                return { error: { path: "", error } };
            return { success: { path: "", deleted_file: "" } };
        case "background_shell_spawn_result": {
            const command = str(resultMetadata?.command) ?? "";
            const workingDirectory = str(resultMetadata?.working_directory) ?? "";
            if (error)
                return { error: { command, working_directory: workingDirectory, error } };
            // Prefer the structured outcome captured by the plugin after-hook; markers
            // are already stripped from the stored/rendered OpenCode output by then.
            if (shellOutcome?.kind === "backgrounded") {
                return {
                    success: {
                        shell_id: shellOutcome.shellId,
                        command: shellOutcome.command || command,
                        working_directory: shellOutcome.workingDirectory || workingDirectory,
                        pid: shellOutcome.pid,
                    },
                };
            }
            // Fallback when no plugin hook ran: parse the private spawn marker inline.
            const match = new RegExp(`${BACKGROUND_SHELL_MARKER}(\\d+):([^\\r\\n]+)`).exec(output);
            const pid = match ? Number(match[1]) : 0;
            if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
                return {
                    error: {
                        command,
                        working_directory: workingDirectory,
                        error: "OpenCode did not return a valid background shell process id.",
                    },
                };
            }
            return {
                success: {
                    shell_id: pid,
                    command,
                    working_directory: workingDirectory,
                    pid,
                },
            };
        }
        case "ls_result": {
            if (error)
                return { error: { path: "", error } };
            const listing = parseOpenCode2DirectoryListing(output, resultRoot);
            const rootPath = listing?.directory || resultRoot || "";
            const entries = listing ? listing.entries : extractGroundedPaths(output, resultRoot);
            const directories = listing?.directories ?? [];
            const files = listing?.files ?? entries;
            return {
                success: {
                    directory_tree_root: {
                        abs_path: rootPath,
                        children_dirs: directories.map((entry) => ({
                            abs_path: stripTrailingPathSeparator(entry),
                            children_dirs: [],
                            children_files: [],
                            num_files: 0,
                        })),
                        children_files: files.map((entry) => ({
                            name: listedEntryName(entry),
                        })),
                        num_files: files.length,
                    },
                },
            };
        }
        case "mcp_result": {
            if (error)
                return { error: { error } };
            // opencode built-ins (read/write/grep/…) are advertised as MCP tools, so
            // a read call returns through mcp_result. Scope the unwrap to toolName
            // "read" so a non-read MCP tool whose output merely contains a
            // "<content>"-like block is never rewritten.
            if (toolName === "grep" || toolName === "glob") {
                return {
                    success: {
                        content: [{ text: { text: groundSearchOutput(output, resultRoot) } }, ...mcpImageItems(images)],
                        is_error: false,
                    },
                };
            }
            if (toolName !== "read") {
                return {
                    success: { content: [{ text: { text: output } }, ...mcpImageItems(images)], is_error: false },
                };
            }
            const listing = parseOpenCode2DirectoryListing(output, resultRoot);
            if (listing) {
                return {
                    success: { content: [{ text: { text: listing.text } }, ...mcpImageItems(images)], is_error: false },
                };
            }
            // Carry the truncation notice as its own content item: the file content
            // item stays byte-exact, so it can still never be echoed into a write.
            const notices = [
                readTruncationNotice(output, resultMetadata),
                readLongLineTruncationNotice(output),
            ].filter((notice) => !!notice);
            return {
                success: {
                    content: [
                        { text: { text: unwrapReadOutput(output) } },
                        ...notices.map((notice) => ({ text: { text: notice } })),
                        ...mcpImageItems(images),
                    ],
                    is_error: false,
                },
            };
        }
        case "subagent_result": {
            const task = parseOpenCodeTaskOutput(output);
            if (error || task.state === "error") {
                return {
                    error: {
                        ...(task.agentId ? { agent_id: task.agentId } : {}),
                        error: error ?? task.message ?? output,
                    },
                };
            }
            return {
                success: {
                    agent_id: task.agentId ?? "",
                    ...(task.message !== undefined ? { final_message: task.message } : {}),
                    tool_call_count: 0,
                    // OpenCode marks an asynchronous launch as state="running". Cursor's
                    // canonical USER_REQUEST enum value is 2; foreground/default is 0.
                    background_reason: task.state === "running" ? 2 : 0,
                },
            };
        }
        default:
            // Unknown variant: best-effort success wrapper so the server sees a oneof.
            if (error)
                return { error: { error } };
            return { success: { content: output } };
    }
}
function parseOpenCodeTaskOutput(output) {
    // Attribute order is not guaranteed; accept id/state in either order and
    // ignore additional attributes OpenCode may emit on the <task> open tag.
    const open = /<task\b([^>]*)>/i.exec(output);
    if (!open)
        return { message: output };
    const attrs = open[1];
    const agentId = /\bid="([^"]+)"/i.exec(attrs)?.[1];
    const state = /\bstate="(running|completed|error)"/i.exec(attrs)?.[1];
    if (!agentId || !state)
        return { message: output };
    const tag = state === "error" ? "task_error" : "task_result";
    const body = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`, "i").exec(output);
    return {
        agentId,
        state,
        message: body?.[1] ?? output,
    };
}
function extractPathTag(output) {
    const m = output.match(/<path>([^<]+)<\/path>/);
    return m?.[1];
}
/**
 * Isolate opencode's read footer: the last blank-line-separated block before
 * the closing `</content>`. Scanning the whole envelope would let a file that
 * merely *quotes* a footer (this repository's own docs and tests do) pass for a
 * truncated read. The body can never contain a blank line — every source line
 * is rendered as `N: …`, so even an empty line keeps its `N: ` prefix.
 *
 * Falls back to the full string when the envelope is absent, preserving
 * behavior for non-standard read output.
 */
function readEnvelopeFooter(output) {
    const close = output.lastIndexOf("\n</content>");
    if (close === -1)
        return output;
    const start = output.lastIndexOf("\n\n", close);
    if (start === -1)
        return output;
    return output.slice(start + 2, close);
}
/** Recover full-file metadata before unwrapReadOutput removes OpenCode's footer. */
function parseOpenCodeReadMetadata(output, resultMetadata) {
    const opencode2 = parseOpenCode2FileRead(output, resultMetadata);
    if (opencode2) {
        return {
            ...(opencode2.startLine !== undefined ? { startLine: opencode2.startLine } : {}),
            ...(opencode2.endLine !== undefined ? { endLine: opencode2.endLine } : {}),
            ...(opencode2.totalLines !== undefined ? { totalLines: opencode2.totalLines } : {}),
            ...(opencode2.nextOffset !== undefined ? { nextOffset: opencode2.nextOffset } : {}),
            outputCapped: opencode2.outputCapped,
            hostTruncated: opencode2.hostTruncated,
            ...(opencode2.truncatedLines.length > 0 ? { truncatedLines: opencode2.truncatedLines } : {}),
        };
    }
    const footer = readEnvelopeFooter(output);
    const showing = /Showing lines (\d+)-(\d+)(?: of (\d+))?\./.exec(footer);
    if (showing) {
        return {
            startLine: Number(showing[1]),
            endLine: Number(showing[2]),
            ...(showing[3] ? { totalLines: Number(showing[3]) } : {}),
            outputCapped: footer.includes("(Output capped at "),
        };
    }
    const complete = /\(End of file - total (\d+) lines?\)/.exec(footer);
    if (complete)
        return { totalLines: Number(complete[1]) };
    return {};
}
/**
 * OpenCode's numbered read envelope cannot represent the terminator after the
 * final line. Cursor's legacy edit executor performs exact replacement against
 * this content, so dropping a real LF/CRLF makes otherwise-valid edits fail and
 * encourages a whole-file rewrite. Restore only that final terminator for an
 * unbounded, confirmed-complete read; paged/capped reads stay untouched.
 */
function restoreCompleteReadTerminator(content, readPath, metadata, resultMetadata, workspaceRoot) {
    if (!readPath
        || metadata.totalLines === undefined
        || metadata.startLine !== undefined
        || metadata.endLine !== undefined
        || num(resultMetadata?.offset) !== undefined
        || num(resultMetadata?.limit) !== undefined
        || content.endsWith("\n"))
        return content;
    const absolute = isAbsoluteToolPath(readPath)
        ? readPath
        : joinToolPath(workspaceRoot ?? process.cwd(), readPath);
    let fd;
    try {
        fd = fs.openSync(absolute, "r");
        const size = fs.fstatSync(fd).size;
        if (size === 0)
            return content;
        const tail = Buffer.alloc(Math.min(2, size));
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        if (tail.length >= 2 && tail[tail.length - 2] === 0x0d && tail[tail.length - 1] === 0x0a) {
            return `${content}\r\n`;
        }
        if (tail[tail.length - 1] === 0x0a)
            return `${content}\n`;
    }
    catch {
        // The host read result remains authoritative when the local path cannot be
        // inspected (deleted/raced/permission changed after the tool completed).
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* already closed */ }
        }
    }
    return content;
}
/**
 * OpenCode's `read` caps output at 50 KB (`tool/read.ts` MAX_BYTES = 50 * 1024)
 * and cuts on a whole-line boundary, then appends
 * "(Output capped at 50 KB. Showing lines X-Y. Use offset=N to continue.)".
 *
 * `unwrapReadOutput` strips that footer along with the envelope, deliberately:
 * Cursor's model echoes whatever it is handed straight back into the next
 * write, so anything left in the content stream can end up written into the
 * file. But dropping the notice with no replacement is worse — the model then
 * believes a capped read is the complete file, rewrites it from what it has,
 * and everything past the cap is destroyed.
 *
 * Cursor's own CLI never truncates silently. Its local executor annotates every
 * capped payload ("50KB limit reached", "[Showing last …KB of line N (50KB
 * limit). Full output: …]") and returns structured truncation metadata. Mirror
 * that, keeping the signal out of the file content itself so it still cannot be
 * echoed into a write.
 */
function readTruncationSummary(output, resultMetadata) {
    const meta = parseOpenCodeReadMetadata(output, resultMetadata);
    if (meta.startLine === undefined || meta.endLine === undefined)
        return undefined;
    // A complete read reports "(End of file …)" and never reaches this shape.
    if (meta.totalLines !== undefined && meta.endLine >= meta.totalLines && !meta.outputCapped)
        return undefined;
    return {
        startLine: meta.startLine,
        endLine: meta.endLine,
        nextOffset: meta.nextOffset ?? meta.endLine + 1,
        capped: meta.outputCapped === true,
        ...(meta.totalLines !== undefined ? { totalLines: meta.totalLines } : {}),
    };
}
/**
 * Model-visible replacement for the stripped footer.
 *
 * Only for reads the model did not ask to bound. A caller that passed an
 * explicit offset/limit already knows it asked for a slice — warning there
 * would cry wolf on every deliberate paged read.
 */
function readTruncationNotice(output, resultMetadata) {
    const summary = readTruncationSummary(output, resultMetadata);
    if (!summary)
        return undefined;
    const rangeRequested = num(resultMetadata?.offset) !== undefined || num(resultMetadata?.limit) !== undefined;
    if (rangeRequested && !summary.capped)
        return undefined;
    const range = summary.totalLines !== undefined
        ? `lines ${summary.startLine}-${summary.endLine} of ${summary.totalLines}`
        : `lines ${summary.startLine}-${summary.endLine}`;
    return (`[Partial read: the content above is ${range}` +
        (summary.capped ? ", capped at the host's 50 KB output limit" : "") +
        `. It is NOT the complete file. Continue with offset=${summary.nextOffset} before ` +
        `acting on the whole file; writing the content above back would delete everything ` +
        `after line ${summary.endLine}.]`);
}
function readLongLineTruncationNotice(output) {
    const lines = parseOpenCodeReadMetadata(output).truncatedLines;
    if (!lines || lines.length === 0)
        return undefined;
    const displayed = lines.slice(0, 8).join(", ");
    const remainder = lines.length > 8 ? ` and ${lines.length - 8} more` : "";
    return (`[Partial read: OpenCode shortened ${lines.length === 1 ? "line" : "lines"} ` +
        `${displayed}${remainder} to ${OPENCODE2_READ_MAX_LINE_CHARS} characters. ` +
        "It is NOT the complete file. Use a byte-preserving read method to inspect the full " +
        "line content before acting on the whole file; writing the content above back would lose data.]");
}
/** agent.v1.PiTruncation for a capped OpenCode read. */
function readTruncationMessage(output, content, resultMetadata) {
    const summary = readTruncationSummary(output, resultMetadata);
    const longLines = parseOpenCodeReadMetadata(output, resultMetadata).truncatedLines;
    if (!summary && (!longLines || longLines.length === 0))
        return undefined;
    const rangeRequested = num(resultMetadata?.offset) !== undefined || num(resultMetadata?.limit) !== undefined;
    if (summary && rangeRequested && !summary.capped && (!longLines || longLines.length === 0))
        return undefined;
    return {
        truncated: true,
        truncated_by: summary?.capped ? "bytes" : longLines?.length ? "characters" : "lines",
        ...(summary?.totalLines !== undefined ? { total_lines: summary.totalLines } : {}),
        output_lines: summary
            ? Math.max(0, summary.endLine - summary.startLine + 1)
            : countLines(content),
        output_bytes: Buffer.byteLength(content, "utf8"),
        ...(summary?.capped ? { max_bytes: OPENCODE_READ_MAX_BYTES } : {}),
    };
}
/** `tool/read.ts` MAX_BYTES — mirrored only to report the cap, never to apply it. */
const OPENCODE_READ_MAX_BYTES = 50 * 1024;
function readRangeApplied(resultMetadata, totalLines) {
    const offset = num(resultMetadata?.offset);
    const limit = num(resultMetadata?.limit);
    if (offset === undefined && limit === undefined)
        return false;
    if (totalLines === 0)
        return false;
    const startLine = offset ?? 1;
    return startLine < 0 || startLine <= totalLines;
}
function readOutputTruncated(resultMetadata, outputMetadata, totalLines) {
    if (outputMetadata.truncatedLines && outputMetadata.truncatedLines.length > 0)
        return true;
    if (outputMetadata.outputCapped)
        return true;
    if (outputMetadata.hostTruncated) {
        const rangeRequested = num(resultMetadata?.offset) !== undefined || num(resultMetadata?.limit) !== undefined;
        if (!rangeRequested)
            return true;
    }
    const returnedEnd = outputMetadata.endLine;
    if (returnedEnd === undefined || totalLines === 0)
        return false;
    const offset = num(resultMetadata?.offset);
    const limit = num(resultMetadata?.limit);
    const startLine = offset ?? 1;
    if (startLine < 0)
        return false;
    const expectedEnd = limit === undefined
        ? totalLines
        : Math.min(totalLines, Math.max(1, startLine) + limit - 1);
    return returnedEnd < expectedEnd;
}
function listedEntryName(entry) {
    const trimmed = stripTrailingPathSeparator(entry);
    const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
function stripTrailingPathSeparator(entry) {
    return entry.endsWith("/") || entry.endsWith("\\") ? entry.slice(0, -1) : entry;
}
function readFileSize(filePath) {
    if (!filePath)
        return 0;
    try {
        return fs.statSync(filePath).size;
    }
    catch {
        return 0;
    }
}
function readFileLineCount(filePath) {
    if (!filePath)
        return undefined;
    let fd;
    try {
        fd = fs.openSync(filePath, "r");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let totalBytes = 0;
        let lines = 1;
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            totalBytes += bytesRead;
            for (let index = 0; index < bytesRead; index++) {
                if (buffer[index] === 0x0a)
                    lines++;
            }
        }
        return totalBytes === 0 ? 0 : lines;
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch {
                /* best effort */
            }
        }
    }
}
function extractPathLines(output) {
    const lines = collapseSearchStatus(output).split("\n").map((l) => l.trim()).filter(Boolean);
    // A folded `# dir/` header is not itself a path. Prefer absolute / relative
    // path-looking lines; fall back to remaining non-status lines.
    const usable = lines.filter((line) => !searchStatusMessage(line) && !/^#+\s+\S/.test(line));
    const paths = usable.filter((l) => l.startsWith("/") || l.startsWith("./") || l.includes("/"));
    return (paths.length > 0 ? paths : usable).slice(0, 2000);
}
function countLines(s) {
    if (!s)
        return 0;
    let n = 1;
    for (let i = 0; i < s.length; i++)
        if (s.charCodeAt(i) === 10)
            n++;
    return n;
}
function encodeShellStream(execId, executionTimeMs, shellStream) {
    const clientMsg = {
        id: execId,
        shell_stream: shellStream,
    };
    if (executionTimeMs !== undefined) {
        clientMsg.local_execution_time_ms = executionTimeMs;
    }
    return encodeMessage("AgentClientMessage", {
        exec_client_message: clientMsg,
    });
}
// ── Map a Cursor tool call to the opencode tool-call struct ──
export function buildToolCallPart(execMsg, sessionId) {
    // Tag the toolCallId with the originating session's id so the result-bearing
    // doStream call can disambiguate the Run stream — Cursor resets exec ids per
    // stream, so two concurrent conversations would otherwise collide on `id`.
    return {
        toolCallId: `cursor_${sessionId}_${execMsg.id}`,
        toolName: execMsg.toolName,
        // LanguageModelV3ToolCall.input is a *stringified* JSON object. The AI SDK
        // does `input.trim()` before JSON.parse; emitting a plain object crashes
        // with "input.trim is not a function" and the model retries forever.
        // OpenCode's processor then receives the parsed object from the SDK.
        input: JSON.stringify(execMsg.args ?? {}),
    };
}
// ── Extract exec id from tool call id ──
export function parseExecIdFromToolCallId(toolCallId) {
    // Format: cursor_<sessionId>_<execId>. sessionId may itself contain
    // underscores (e.g. UUIDs), so anchor on the trailing _<digits>.
    const match = toolCallId.match(/^cursor_(.+)_(\d+)$/);
    if (!match)
        return undefined;
    const execId = parseInt(match[2], 10);
    if (!Number.isFinite(execId))
        return undefined;
    return { sessionId: match[1], execId };
}
// ── Unknown exec diagnostics ──
//
// Request/result field numbers are not universally identical (the Pi range is
// offset by one), so unknown variants must never receive a guessed empty reply.
// The pump uses this raw detector to report schema drift and fail the Run.
/**
 * Find the exec variant field number from the raw (gunzipped) AgentServerMessage
 * payload: peel field #2 (exec_server_message), then return the first
 * message-typed field that isn't id(#1)/exec_id(#15)/span_context(#19).
 * Returns undefined if there is no exec_server_message or no variant set.
 */
export function detectExecVariantField(agentServerPayload) {
    const execBytes = readAllFields(agentServerPayload).find((f) => f.fn === 2 && f.wt === 2)?.bytes;
    if (!execBytes)
        return undefined;
    for (const f of readAllFields(execBytes)) {
        if (f.wt !== 2)
            continue; // message-typed only (wire type 2)
        if (f.fn === 1 || f.fn === 15 || f.fn === 19)
            continue;
        return f.fn;
    }
    return undefined;
}
/**
 * Encode exec #10 request_context_result from a prebuilt RequestContext payload.
 */
export function buildRequestContextResult(execId, requestContext) {
    traceRequestContextPaths(`buildRequestContextResult id=${execId}`, requestContext);
    return encodeMessage("AgentClientMessage", {
        exec_client_message: {
            id: execId,
            request_context_result: {
                success: {
                    request_context: requestContext,
                },
            },
        },
    });
}
/**
 * Answer Cursor's exec #36 MCP-state probe from the session's live tool
 * descriptors: `toolsToDescriptors` output for the advertised catalog (after
 * web-tool aliasing), refreshed on every `doStream`. These are the same
 * identities the names-only RequestContext advertises and exec remap uses, so
 * Cursor's native get_mcp_tools can correlate the later
 * provider_identifier/tool_name request. OpenCode remains the executor; this
 * only confirms those tools are available, with full name/description/schema.
 */
export function buildMcpStateResult(execId, args, toolDescriptors) {
    const requested = new Set(Array.isArray(args.server_identifiers)
        ? args.server_identifiers.filter((id) => typeof id === "string" && id.length > 0)
        : []);
    // Group in advertised order: first-seen server, then its tools.
    const byServer = new Map();
    for (const tool of toolDescriptors) {
        const server = stringValue(tool.provider_identifier);
        const toolName = stringValue(tool.tool_name);
        if (!server || !toolName)
            continue;
        if (requested.size > 0 && !requested.has(server))
            continue;
        let list = byServer.get(server);
        if (!list) {
            list = [];
            byServer.set(server, list);
        }
        list.push({
            name: stringValue(tool.name) ?? `${server}-${toolName}`,
            // GetDynamicTools exposes the inner schema without the outer call identity.
            // Keep the exact identity in the definition, including truncated searches.
            description: `CallDynamicTool identity: ${JSON.stringify({ namespace: server, toolName })}. `
                + `Complete outer envelope: ${JSON.stringify({ namespace: server, toolName, arguments: {} })}. `
                + "Replace arguments with this inputSchema's object; keep both identity fields outside it. "
                + "Write namespace and toolName FIRST, then arguments containing this inputSchema's object. "
                + "All three outer fields are required on every invocation.\n\n"
                + (stringValue(tool.description) ?? ""),
            input_schema: tool.input_schema,
            provider_identifier: server,
            tool_name: toolName,
        });
    }
    const servers = [...byServer].map(([server, tools]) => ({
        server_name: server,
        server_identifier: server,
        tools,
    }));
    return encodeMessage("AgentClientMessage", {
        exec_client_message: {
            id: execId,
            mcp_state_exec_result: { success: { servers } },
        },
    });
}
/**
 * Total fallback for Cursor's native MCP-resource exec channel (agent.v1
 * fields #17/#18, tasks/plans/fix-cursor-mcp-resource-exec.md). Under Option B
 * `list_mcp_resources`/`read_mcp_resource` execute through the ordinary
 * field-11 MCP path via the alias rules above, so any 17/18 that still reaches
 * this provider is Cursor emitting the native variant unsolicited (its own
 * client owns both executors unconditionally — there is no descriptor to
 * un-advertise). Cursor's executors are total; mirror that here rather than
 * guessing a generic success, which risks an endless heartbeat loop.
 */
export function buildListMcpResourcesFallback(execId) {
    return encodeMessage("AgentClientMessage", {
        exec_client_message: {
            id: execId,
            list_mcp_resources_exec_result: { success: { resources: [] } },
        },
    });
}
/** See buildListMcpResourcesFallback. Always an `error`, even for `download_path`. */
export function buildReadMcpResourceFallback(execId, server, uri) {
    return encodeMessage("AgentClientMessage", {
        exec_client_message: {
            id: execId,
            read_mcp_resource_exec_result: {
                error: { uri, error: `Server "${server}" not found` },
            },
        },
    });
}
