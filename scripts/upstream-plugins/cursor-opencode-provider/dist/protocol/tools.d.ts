import type { CursorImageInput } from "../image-input.js";
import { type CursorExecVariant } from "./exec-variants.js";
import { type CursorShellOutcome } from "../shell-timeout.js";
export declare const REQUEST_CONTEXT_RESULT_FIELD = 10;
export type OpencodeToolDef = {
    name: string;
    description?: string;
    inputSchema?: unknown;
    /** Original flattened identity when `name` is a Cursor-facing alias. */
    sourceName?: string;
};
/** Check explicit required keys after normalization, before host execution. */
export declare function missingRequiredToolArguments(tool: OpencodeToolDef | undefined, args: Record<string, unknown>): string[];
/** Canonical file/search tools must not silently ignore a misplaced shell command. */
export declare function misplacedShellCommand(tool: OpencodeToolDef | undefined, args: Record<string, unknown>): boolean;
/** Host file-tool argument key. OpenCode 1.x uses `filePath`; 2.0 uses `path`. */
export type HostFilePathKey = "path" | "filePath";
/** Host shell tool id. OpenCode 1.x uses `bash`; 2.0 uses `shell`. */
export type HostShellTool = "bash" | "shell";
/** OpenCode 1.x skill params use `name`; OpenCode 2.0 uses `id`. */
export type HostSkillArgKey = "name" | "id";
export type HostToolDialect = {
    filePathKey: HostFilePathKey;
    shellTool: HostShellTool;
    skillArgKey: HostSkillArgKey;
    shellDescription?: "optional" | "required";
};
export declare const OPENCODE_1_TOOL_DIALECT: HostToolDialect;
export declare const OPENCODE_2_TOOL_DIALECT: HostToolDialect;
/** Prefer `filePath`, then `path` / `file_path` — Cursor and both OpenCode majors. */
export declare function opencodePathArg(args: Record<string, unknown> | undefined): string | undefined;
/**
 * Infer the host tool dialect from advertised AI SDK schemas.
 * OpenCode 2.0 read/edit/write require `path` and rename bash → `shell`.
 * Skill: OpenCode 1.x requires `name`; OpenCode 2.0 requires `id`.
 */
export declare function hostToolDialectFromTools(tools: readonly {
    name?: string;
    inputSchema?: unknown;
}[], defaultDialect?: HostToolDialect): HostToolDialect;
export declare const CUSTOM_WEBSEARCH_TOOL = "custom_websearch";
export declare const CUSTOM_WEBFETCH_TOOL = "custom_webfetch";
export declare const CUSTOM_LIST_MCP_RESOURCES_TOOL = "custom_list_mcp_resources";
export declare const CUSTOM_READ_MCP_RESOURCE_TOOL = "custom_read_mcp_resource";
/** Cursor-facing alias → exact host tool name accepted by the AI SDK call. */
export type ToolAliasRegistry = ReadonlyMap<string, string>;
export type AliasedToolCatalog = {
    advertisedTools: OpencodeToolDef[];
    aliases: ToolAliasRegistry;
    ambiguous: ReadonlyMap<string, string[]>;
};
export type ToolServerIdentity = {
    /** Cursor MCP server id / provider_identifier (e.g. opencode, github). */
    server: string;
    /** Bare tool name inside that server (Cursor McpArgs.tool_name). */
    toolName: string;
    /** Full OpenCode tool id used for local execution (e.g. github_create_pull_request). */
    opencodeName: string;
};
/** Match OpenCode's McpCatalog.sanitize for config server ids. */
export declare function sanitizeMcpServerId(value: string): string;
/**
 * Resolve an OpenCode tool id using known MCP server ids from merged config.
 * Unknown names remain under the synthetic default server: a flattened tool
 * name alone cannot distinguish plugin/custom tools from `<server>_<tool>`.
 */
export declare function resolveToolServerIdentity(opencodeName: string, defaultServer?: string, knownMcpServers?: Iterable<string>): ToolServerIdentity;
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
export declare function toolsToDescriptors(tools: OpencodeToolDef[], providerIdentifier?: string, knownMcpServers?: Iterable<string>): Array<Record<string, unknown>>;
/**
 * Give collision-prone web capabilities names Cursor will not confuse with its
 * native UI-bound WebSearch/WebFetch interactions. Exact host tools win; a
 * flattened MCP suffix is accepted only when it identifies one unique tool.
 */
export declare function buildCustomWebToolAliases(tools: OpencodeToolDef[]): AliasedToolCatalog;
export declare function resolveCustomWebToolAlias(toolName: string, aliases: ToolAliasRegistry | undefined): string;
/**
 * Nested MCP descriptors. Full name/description/schema is for exec #36.
 * RequestContext `mcp_meta_tool_options` uses `{ namesOnly: true }` (`tool_name`
 * only). File-system `mcp_descriptors` are omitted on the wire.
 */
export declare function toolsToMcpDescriptors(tools: OpencodeToolDef[], providerIdentifier?: string, knownMcpServers?: Iterable<string>, options?: {
    namesOnly?: boolean;
}): Array<Record<string, unknown>>;
/**
 * @deprecated Prefer `buildRequestContext` from `../context/build.js`.
 * Kept as a sync tools-only fallback for unit tests that don't need collectors.
 */
export declare function buildLiveRequestContext(tools: OpencodeToolDef[], providerIdentifier?: string, knownMcpServers?: Iterable<string>): Record<string, unknown>;
export declare function mapExecServerToToolName(execField: string): string | undefined;
export declare function mapToolNameToExecField(toolName: string): string | undefined;
export type HostSubagentDefinition = {
    name: string;
    description?: string;
};
export type HostSubagentCatalog = {
    executor?: "task" | "subagent";
    agents: HostSubagentDefinition[];
    /** True when the OpenCode task/subagent tool supplied its complete, permission-filtered catalog. */
    complete: boolean;
};
/** Extract the current host's permission-filtered Task/Actor recipient catalog. */
export declare function extractHostSubagentCatalog(tools: OpencodeToolDef[]): HostSubagentCatalog;
/** Resolve a Cursor subtype against the agents the host can spawn this turn. */
export declare function resolveCursorSubagentType(subagentType: string, catalog?: HostSubagentCatalog): string | undefined;
/**
 * Cursor's native Task/subagent protocol uses Cursor-owned subtype names while
 * OpenCode-family hosts execute named agents. Map known Cursor built-ins to
 * the closest host agent and preserve unknown values so user-defined OpenCode
 * agents can still be called by exact name.
 */
export declare function mapCursorSubagentTypeToOpenCode(subagentType: string): string;
/** Resolve a native Cursor subagent request to this turn's executor and catalog. */
export declare function remapNativeSubagentForCatalog(parsed: ParsedExecRequest, advertisedToolNames: Iterable<string>, catalog?: HostSubagentCatalog): void;
/**
 * Complete the private read inside Cursor's legacy edit transaction without
 * routing it through OpenCode's user-facing `read` tool. The latter caps every
 * result at 50 KB, while Cursor's editor needs the complete file to calculate
 * the correlated whole-file `write_args` that follows.
 *
 * The caller is responsible for proving that `filePath` is the same regular
 * file named by an active `edit_tool_call` and is contained by the workspace.
 */
export declare function buildCompleteEditReadMessages(execId: number, sourcePath: string, resultPath?: string): Uint8Array[] | undefined;
/**
 * Preserve a legacy Cursor edit's intent when its internal executor follows
 * `edit_tool_call` with a whole-file `write_args` request.
 *
 * The result field intentionally remains `write_result`: that is the response
 * Cursor is awaiting even though OpenCode executes the mutation via `edit`.
 */
export declare function remapCorrelatedEditWriteForCatalog(parsed: ParsedExecRequest, advertisedToolNames: Iterable<string>, editPath: string, workspaceRoot?: string): boolean;
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
export declare function remapEditToolsForCatalog(parsed: ParsedExecRequest, advertisedToolNames: Iterable<string>, workspaceRoot?: string): void;
export type ParsedExecRequest = {
    id: number;
    execId: string;
    toolName: string;
    args: Record<string, unknown>;
    /** ExecClientMessage result field to reply with (matches the request variant). */
    resultField: string;
    /** Typed error to return without asking OpenCode to execute invalid args. */
    localError?: string;
    /** Original request values needed by typed Cursor result messages. */
    resultMetadata?: Record<string, unknown>;
};
/**
 * A partial-read notice is for Cursor's model, never for a file. Refuse only
 * whole-file mutation forms that echo it. A targeted edit or Update File patch
 * cannot truncate an unseen tail, and may legitimately edit source that quotes
 * this provider's warning text.
 */
export declare function rejectPartialReadMutation(parsed: ParsedExecRequest): void;
export declare function parseExecServerMessage(msg: Record<string, unknown>, dialect?: HostToolDialect): ParsedExecRequest | undefined;
/**
 * Remap Cursor exec / MCP arg shapes onto OpenCode's Effect Schema keys.
 * Without this, OpenCode rejects calls with InvalidArgumentsError
 * (e.g. `path` instead of `filePath`, `file_text` instead of `content`).
 */
export declare function mapCursorArgsToOpencode(toolName: string, raw: Record<string, unknown>, execVariant?: string, dialect?: HostToolDialect): {
    toolName: string;
    args: Record<string, unknown>;
    binaryBytes?: Uint8Array;
};
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
export declare function decodeWriteBytes(bytes: Uint8Array, encodingHint?: string): string | undefined;
/**
 * True when a parsed `write` request carries bytes that are not text. Such a
 * request cannot go to OpenCode's `write` tool at all — it takes a string, and
 * additionally BOM-splits, diffs, and runs `Format.file()` on what it writes.
 */
export declare function binaryWritePayload(parsed: ParsedExecRequest): {
    path: string;
    data: Uint8Array;
} | undefined;
/**
 * Replace the prompt-derived task title with Cursor's TaskToolCall description
 * when the display call is correlated via tool_call_id. SubagentArgs itself has
 * no description field, so without this OpenCode shows a cut-off first-five-words
 * slice of the prompt.
 */
export declare function preferCorrelatedTaskDescription(parsed: ParsedExecRequest, description: string | undefined): void;
/**
 * Map Cursor McpArgs back to the OpenCode tool id.
 * Prefers provider_identifier + bare tool_name (github + create_pull_request
 * → github_create_pull_request). Builtins under the default server stay bare.
 */
export declare function mcpRealToolName(mcpArgs: Record<string, unknown>, defaultServer?: string): string;
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
export declare function isUriReadTarget(requested: string): boolean;
/**
 * Resolve a read target the way Cursor's LocalReadExecutor does before it
 * stats the file: untildify, then resolve a relative path against the workspace
 * root (`env.workspace_paths[0]`), else resolve as-is. Kept in lockstep with
 * agent utils `resolvePath(path, workspaceRoot)`.
 *
 * Only meaningful for local paths; check {@link isUriReadTarget} first.
 */
export declare function resolveReadTargetPath(requested: string, workspaceRoot: string): string;
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
export declare function classifyMissingReadTarget(absolutePath: string): Record<string, unknown> | undefined;
/**
 * Encode a pre-execution read rejection as the exact frames Cursor's client
 * emits: the ExecClientMessage carrying the typed ReadResult oneof case, then
 * the ACM #5 stream_close for that id. `readResult` is the case object from
 * classifyMissingReadTarget (e.g. `{ file_not_found: { path } }`).
 */
export declare function buildReadRejectionMessages(execId: number, readResult: Record<string, unknown>): Uint8Array[];
export type ToolResultInput = {
    execId: number;
    /** ExecClientMessage result field (from ParsedExecRequest.resultField). */
    resultField: string;
    output: string;
    error?: string;
    executionTimeMs?: number;
    /**
     * Resolved opencode tool name (read/write/grep/…). Gates read-envelope
     * unwrapping on the mcp_result path so non-read MCP output is never
     * rewritten. read_result is always a read, so it unwraps regardless.
     */
    toolName?: string;
    /** Original request fields required by a typed result (background shell). */
    resultMetadata?: Record<string, unknown>;
    /** Structured shell completion captured by the OpenCode plugin hook. */
    shellOutcome?: CursorShellOutcome;
    /**
     * Workspace root for result shapes that must name a directory
     * (grep_result workspace_results keys, ls_result directory_tree_root).
     * Must not fall back to process.cwd() — the OpenCode 2.0 daemon's cwd is
     * often $HOME and would re-advertise the wrong folder to the model.
     */
    workspaceRoot?: string;
    /** Images the host tool returned; see `execResultImages` for which results carry them. */
    images?: readonly CursorImageInput[];
};
/**
 * The leading tool-result images an exec result can carry on a held Run.
 * Cursor's own read executor answers an image file with its bytes in
 * `ReadSuccess.data` (#5) and no text; its MCP executor appends each MCP image
 * as an `McpImageContent` item (#2). Other result shapes have no image field.
 */
export declare function execResultImages(resultField: string, images: readonly CursorImageInput[] | undefined): CursorImageInput[];
/**
 * Build one or more ExecClientMessage frames for a tool result.
 * Shell replies are a sequence of ShellStream oneofs under the same id —
 * Start → stdout/stderr → exit — then an ACM #5 stream_close so the server
 * knows the client finished streaming (CLI always sends this; without it
 * shell execs hang on heartbeats forever).
 */
export declare function buildExecClientMessages(input: ToolResultInput): Uint8Array[];
/** ACM #5 exec_client_control_message { stream_close { id } }. */
export declare function buildExecStreamClose(execId: number): Uint8Array;
export declare function buildUnsupportedExecDeny(input: {
    execId: number;
    variant: CursorExecVariant;
    reason: string;
}): Uint8Array[];
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
export declare function unwrapReadOutput(output: string): string;
/**
 * Map OpenCode tool text into the agent.v1 result oneof for each exec variant.
 * OpenCode returns free-form text; we wrap it in the minimal success shape the
 * server accepts (verified against agent.v1 wire captures).
 */
export declare function buildTypedExecResult(resultField: string, output: string, error?: string, toolName?: string, resultMetadata?: Record<string, unknown>, shellOutcome?: CursorShellOutcome, workspaceRoot?: string, images?: readonly CursorImageInput[]): Record<string, unknown>;
export declare function buildToolCallPart(execMsg: ParsedExecRequest, sessionId: string): {
    toolCallId: string;
    toolName: string;
    input: string;
};
export declare function parseExecIdFromToolCallId(toolCallId: string): {
    sessionId: string;
    execId: number;
} | undefined;
/**
 * Find the exec variant field number from the raw (gunzipped) AgentServerMessage
 * payload: peel field #2 (exec_server_message), then return the first
 * message-typed field that isn't id(#1)/exec_id(#15)/span_context(#19).
 * Returns undefined if there is no exec_server_message or no variant set.
 */
export declare function detectExecVariantField(agentServerPayload: Uint8Array): number | undefined;
/**
 * Encode exec #10 request_context_result from a prebuilt RequestContext payload.
 */
export declare function buildRequestContextResult(execId: number, requestContext: Record<string, unknown>): Uint8Array;
/**
 * Answer Cursor's exec #36 MCP-state probe from the session's live tool
 * descriptors: `toolsToDescriptors` output for the advertised catalog (after
 * web-tool aliasing), refreshed on every `doStream`. These are the same
 * identities the names-only RequestContext advertises and exec remap uses, so
 * Cursor's native get_mcp_tools can correlate the later
 * provider_identifier/tool_name request. OpenCode remains the executor; this
 * only confirms those tools are available, with full name/description/schema.
 */
export declare function buildMcpStateResult(execId: number, args: Record<string, unknown>, toolDescriptors: ReadonlyArray<Record<string, unknown>>): Uint8Array;
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
export declare function buildListMcpResourcesFallback(execId: number): Uint8Array;
/** See buildListMcpResourcesFallback. Always an `error`, even for `download_path`. */
export declare function buildReadMcpResourceFallback(execId: number, server: string, uri: string): Uint8Array;
