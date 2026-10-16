import { OPENCODE_1_TOOL_DIALECT, mapCursorArgsToOpencode, mapCursorSubagentTypeToOpenCode, mcpRealToolName, } from "./tools.js";
import { decodeStructEntriesToJson } from "./struct.js";
import { mapSwitchModeTarget } from "./switch-mode.js";
const TODO_STATUS = {
    0: "pending",
    1: "pending",
    2: "in_progress",
    3: "completed",
    4: "cancelled",
};
/**
 * Cursor ToolCall oneof field → default OpenCode tool id.
 *
 * F11: `delete_tool_call` has no OpenCode builtin; it remaps to bash (see the
 * delete_tool_call branch below for `rm -f -- <path>`).
 */
const VARIANT_TO_OPENCODE = {
    shell_tool_call: "bash",
    delete_tool_call: "bash",
    glob_tool_call: "glob",
    grep_tool_call: "grep",
    read_tool_call: "read",
    update_todos_tool_call: "todowrite",
    read_todos_tool_call: "todoread",
    edit_tool_call: "write",
    ls_tool_call: "read",
    mcp_tool_call: "mcp",
    create_plan_tool_call: "todowrite",
    web_search_tool_call: "websearch",
    task_tool_call: "task",
    ask_question_tool_call: "question",
    fetch_tool_call: "webfetch",
    web_fetch_tool_call: "webfetch",
    switch_mode_tool_call: "plan_enter",
    generate_image_tool_call: "generateimage",
    await_tool_call: "await",
    get_mcp_tools_tool_call: "get_mcp_tools",
    pi_read_tool_call: "read",
    pi_bash_tool_call: "bash",
    pi_edit_tool_call: "edit",
    pi_write_tool_call: "write",
    pi_grep_tool_call: "grep",
    pi_find_tool_call: "glob",
    pi_ls_tool_call: "read",
};
const TOOL_CALL_VARIANTS = Object.keys(VARIANT_TO_OPENCODE);
// ToolCallCompleted is a notification, not an execution request. Only mirror
// client-visible state whose authoritative final value is already present in
// the completed payload (or reconstructable from a prior mirrored snapshot for
// Cursor todo merges). Data-returning, interactive, and side-effecting calls
// must use an exec/interaction request channel where Cursor can receive their
// actual result.
//
// `get_mcp_tools_tool_call` is Cursor-native discovery (prompt name
// GetDynamicTools when dynamic namespaces are on). The agent executes it
// server-side after mcp_state; oversized catalogs spill through write_args.
const DISPLAY_STATE_MIRROR_VARIANTS = new Set([
    "update_todos_tool_call",
    "read_todos_tool_call",
    "create_plan_tool_call",
]);
const NATIVE_DISPLAY_VARIANTS = new Set([
    "get_mcp_tools_tool_call",
]);
/** Display variants Cursor executes itself (mcp_state + optional write spill). */
export function isNativeDisplayToolCall(variant) {
    return NATIVE_DISPLAY_VARIANTS.has(variant);
}
function asRecord(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}
/** Server-side dynamic-call failures may complete without a started/exec frame. */
export function displayMcpToolError(toolCall) {
    const call = asRecord(toolCall?.mcp_tool_call);
    const result = asRecord(call?.result);
    const error = asRecord(result?.error);
    const parts = [error?.error, error?.detail].filter((value) => typeof value === "string" && value.length > 0);
    return parts.length > 0 ? parts.join(": ") : undefined;
}
/** Native discovery errors are server-side results, never host execution. */
export function displayNativeDiscoveryError(toolCall) {
    const call = asRecord(toolCall?.get_mcp_tools_tool_call);
    const error = asRecord(asRecord(call?.result)?.error)?.error;
    return typeof error === "string" && error.length > 0 ? error : undefined;
}
function findToolVariant(toolCall) {
    for (const key of TOOL_CALL_VARIANTS) {
        if (toolCall[key] != null)
            return key;
    }
    for (const [key, value] of Object.entries(toolCall)) {
        if (!key.endsWith("_tool_call"))
            continue;
        if (value && typeof value === "object")
            return key;
    }
    return undefined;
}
function mapTodoStatus(status) {
    if (typeof status === "string" && status.length > 0) {
        const s = status.toLowerCase().replace(/^todo_status_/, "");
        if (s === "unspecified")
            return "pending";
        return s;
    }
    if (typeof status === "number" && TODO_STATUS[status])
        return TODO_STATUS[status];
    return "pending";
}
function mapTodos(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map((item, index) => {
        const t = asRecord(item) ?? {};
        const content = typeof t.content === "string" ? t.content : "";
        const id = typeof t.id === "string" && t.id.length > 0
            ? t.id
            : `todo_${index + 1}`;
        return {
            id,
            content,
            status: mapTodoStatus(t.status),
            priority: typeof t.priority === "string" && t.priority ? t.priority : "medium",
        };
    });
}
/**
 * Normalize a full todo snapshot for `mirroredTodos` storage. Returns
 * undefined when the input is not a todo array (nothing to learn). Drops the
 * synthetic "plan" id minted for create_plan mirrors so later merges never
 * resurrect it.
 */
export function snapshotMirroredTodos(todos) {
    if (!Array.isArray(todos))
        return undefined;
    return mapTodos(todos).filter((t) => {
        const id = typeof t.id === "string" ? t.id : "";
        return id.length > 0 && id !== "plan";
    });
}
/**
 * Refresh the mirrored snapshot from a host `todoread` tool result. The host
 * list is authoritative; returns undefined when the output is not recognizable
 * todo JSON (prose, caps, errors) so a stale-but-useful snapshot survives.
 */
export function snapshotMirroredTodosFromReadOutput(output) {
    let parsed;
    try {
        parsed = JSON.parse(output);
    }
    catch {
        return undefined;
    }
    const list = Array.isArray(parsed) ? parsed : (asRecord(parsed)?.todos ?? undefined);
    if (!Array.isArray(list))
        return undefined;
    return snapshotMirroredTodos(list);
}
/**
 * Overlay Cursor merge patches onto a previously mirrored full todo list.
 * Preserves prior order; appends newly introduced ids in patch order.
 *
 * Matching is by id first, then by exact (trimmed) content. The content
 * fallback covers mixed flows where the prior snapshot came from a direct
 * host `todowrite` (positional ids) while the patch references Cursor-side
 * ids for the same tasks. Patch items with neither an id/content match nor
 * their own content are skipped — a status-only update for an unknown item
 * cannot be mapped onto the host list.
 */
export function applyTodoMerge(prior, patch) {
    const rawPatch = Array.isArray(patch) ? patch : [];
    const mappedPatch = mapTodos(patch);
    const byId = new Map();
    const byContent = new Map();
    // Patch ids already folded into a prior record via content match: never
    // re-emit them as new items in the output phase.
    const consumedPatchIds = new Set();
    // Patch ids accepted as genuinely new content: the only patch ids the
    // output phase may append. Orphans skipped above (unknown id, no content)
    // must not leak back in here.
    const appendedPatchIds = new Set();
    for (const item of prior) {
        const id = typeof item.id === "string" && item.id.length > 0 ? item.id : "";
        if (!id)
            continue;
        const normalized = {
            id,
            content: typeof item.content === "string" ? item.content : "",
            status: typeof item.status === "string" ? item.status : mapTodoStatus(item.status),
            priority: typeof item.priority === "string" && item.priority ? item.priority : "medium",
        };
        byId.set(id, normalized);
        const key = normalized.content.trim();
        if (key && !byContent.has(key))
            byContent.set(key, normalized);
    }
    const overlay = (target, item, raw) => {
        // Only overwrite fields the patch actually carries. mapTodos fills
        // defaults ("" content, "pending" status, "medium" priority) that must not
        // clobber a prior item when Cursor sends an id+status-only patch.
        const next = { ...target, id: target.id };
        if (typeof raw.content === "string" && raw.content.length > 0) {
            next.content = raw.content;
        }
        if (raw.status !== undefined && raw.status !== null) {
            next.status = String(item.status);
        }
        if (typeof raw.priority === "string" && raw.priority) {
            next.priority = raw.priority;
        }
        return next;
    };
    for (let index = 0; index < mappedPatch.length; index++) {
        const item = mappedPatch[index];
        const raw = asRecord(rawPatch[index]) ?? {};
        const id = String(item.id);
        const byIdMatch = byId.get(id);
        if (byIdMatch) {
            const merged = overlay(byIdMatch, item, raw);
            byId.set(id, merged);
            // Keep the content index pointing at the fresh record so later
            // content-fallback matches never merge onto a stale copy.
            const oldKey = typeof byIdMatch.content === "string" ? byIdMatch.content.trim() : "";
            const newKey = typeof merged.content === "string" ? merged.content.trim() : "";
            if (oldKey && byContent.get(oldKey) === byIdMatch)
                byContent.delete(oldKey);
            if (newKey && !byContent.has(newKey))
                byContent.set(newKey, merged);
            continue;
        }
        const contentKey = typeof raw.content === "string" && raw.content.trim().length > 0
            ? raw.content.trim()
            : "";
        const byContentMatch = contentKey ? byContent.get(contentKey) : undefined;
        if (byContentMatch) {
            // Same task, different id space (host positional ids vs Cursor ids).
            // Keep the prior id so snapshot identity stays stable and order is
            // preserved; adopt the patch's status/priority/content.
            const merged = overlay(byContentMatch, item, raw);
            byId.set(String(byContentMatch.id), merged);
            if (contentKey)
                byContent.set(contentKey, merged);
            consumedPatchIds.add(id);
            continue;
        }
        if (!contentKey)
            continue;
        byId.set(id, item);
        byContent.set(contentKey, item);
        appendedPatchIds.add(id);
    }
    const out = [];
    const seen = new Set();
    for (const item of prior) {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id || seen.has(id))
            continue;
        const next = byId.get(id);
        if (next) {
            out.push(next);
            seen.add(id);
        }
    }
    for (const item of mappedPatch) {
        const id = String(item.id);
        // Id-matched items are already emitted under the prior id; content-matched
        // items were folded into the prior record (not appended under the foreign
        // patch id); orphans were skipped outright. Only genuinely new content
        // reaches the host list.
        if (seen.has(id) || consumedPatchIds.has(id))
            continue;
        if (!appendedPatchIds.has(id))
            continue;
        out.push(item);
        seen.add(id);
    }
    return out;
}
function unwrapArgs(variantPayload) {
    const nested = asRecord(variantPayload.args);
    return nested ?? variantPayload;
}
/**
 * Decode a Cursor ToolCall oneof into a display tool call we can bridge.
 *
 * @param priorMirroredTodos Last full todo snapshot mirrored this Run; used to
 *   expand Cursor `merge: true` updates that omit ToolCallCompleted.success.todos.
 */
export function parseDisplayToolCall(callId, toolCall, priorMirroredTodos) {
    if (!toolCall || !callId)
        return undefined;
    const variant = findToolVariant(toolCall);
    if (!variant)
        return undefined;
    const payload = asRecord(toolCall[variant]);
    if (!payload)
        return undefined;
    const args = unwrapArgs(payload);
    if (variant === "mcp_tool_call") {
        const name = mcpRealToolName(args);
        let mcpArgs = asRecord(args.args) ?? {};
        if (Array.isArray(args.args)) {
            mcpArgs = decodeStructEntriesToJson(args.args);
        }
        return {
            callId,
            variant,
            preferredToolName: name,
            args: mcpArgs,
        };
    }
    // create_plan_tool_call here is display-state mirroring into todowrite.
    // Separately, InteractionQuery create_plan_request_query writes a host plan
    // file via protocol/create-plan.ts (hostPlansDir) — that write is not an
    // execution of this display payload.
    if (variant === "update_todos_tool_call" || variant === "create_plan_tool_call") {
        const result = asRecord(payload.result);
        const success = asRecord(result?.success);
        // Cursor's completed frame may materialize proto-default `todos: []` even
        // when the real final snapshot is present on args.todos. An empty default
        // must not erase that named completion snapshot. A non-empty completed
        // payload remains authoritative (especially for merge calls).
        const completedTodos = Array.isArray(success?.todos) && success.todos.length > 0
            ? success.todos
            : undefined;
        const isMerge = variant === "update_todos_tool_call" && args.merge === true;
        // OpenCode todowrite replaces the whole list. Prefer the completed payload;
        // otherwise a non-merge args list; otherwise merge against the Run snapshot.
        const sourceTodos = completedTodos ?? (!isMerge ? args.todos : undefined);
        const canMergeFromPrior = sourceTodos === undefined &&
            isMerge &&
            Array.isArray(priorMirroredTodos) &&
            priorMirroredTodos.length > 0;
        const todos = canMergeFromPrior
            ? applyTodoMerge(priorMirroredTodos, args.todos)
            : mapTodos(sourceTodos);
        if (variant === "create_plan_tool_call") {
            const overview = typeof args.overview === "string" ? args.overview.trim() : "";
            const plan = typeof args.plan === "string" ? args.plan.trim() : "";
            const name = typeof args.name === "string" ? args.name.trim() : "";
            if (overview || plan || name) {
                todos.unshift({
                    id: "plan",
                    content: [name && `Plan: ${name}`, overview, plan].filter(Boolean).join("\n").slice(0, 2000),
                    // The plan file is already written by the time this display mirror
                    // runs. Leaving it `pending` parks a forever-open row on hosts that
                    // keep todowrite as the user-visible checklist.
                    status: "completed",
                    priority: "high",
                });
            }
        }
        return {
            callId,
            variant,
            preferredToolName: "todowrite",
            args: { todos },
            bridgeable: variant === "create_plan_tool_call"
                ? todos.length > 0
                : Array.isArray(sourceTodos) || canMergeFromPrior,
        };
    }
    // Cursor TodoRead is the same display-only channel as TodoWrite (agent.v1
    // read_todos_tool_call). OpenCode todoread takes an empty body; host filters
    // are not part of the canonical schema, so drop status_filter / id_filter.
    if (variant === "read_todos_tool_call") {
        return {
            callId,
            variant,
            preferredToolName: "todoread",
            args: {},
            bridgeable: true,
        };
    }
    if (variant === "edit_tool_call") {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.stream_content === "string" ? args.stream_content : undefined;
        return {
            callId,
            variant,
            preferredToolName: "write",
            args: { path, content },
            bridgeable: path.length > 0 && content !== undefined,
        };
    }
    if (variant === "pi_edit_tool_call") {
        const path = typeof args.path === "string" ? args.path : "";
        const edits = Array.isArray(args.edits) ? args.edits : [];
        const replacement = edits.length === 1 ? asRecord(edits[0]) : undefined;
        const oldText = replacement?.old_text;
        const newText = replacement?.new_text;
        return {
            callId,
            variant,
            preferredToolName: "edit",
            args: { path, old_string: oldText, new_string: newText },
            bridgeable: path.length > 0 &&
                typeof oldText === "string" && oldText.length > 0 &&
                typeof newText === "string",
        };
    }
    if (variant === "task_tool_call") {
        const subagentType = openCodeSubagentType(args.subagent_type);
        const description = typeof args.description === "string" ? args.description : "";
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const taskArgs = {
            description,
            prompt,
            subagent_type: subagentType,
        };
        if (typeof args.resume === "string" && args.resume)
            taskArgs.task_id = args.resume;
        return {
            callId,
            variant,
            preferredToolName: "task",
            args: taskArgs,
            bridgeable: description.length > 0 && prompt.length > 0 && !!subagentType,
        };
    }
    if (variant === "ask_question_tool_call") {
        const title = typeof args.title === "string" ? args.title : "";
        const questions = Array.isArray(args.questions)
            ? args.questions.map((q) => {
                const qq = asRecord(q) ?? {};
                const prompt = typeof qq.prompt === "string" ? qq.prompt : "";
                const options = Array.isArray(qq.options)
                    ? qq.options.map((o) => {
                        const oo = asRecord(o) ?? {};
                        return {
                            label: typeof oo.label === "string" ? oo.label : String(oo.id ?? ""),
                            description: typeof oo.description === "string" ? oo.description : "",
                        };
                    })
                    : [];
                return {
                    question: prompt,
                    header: (typeof qq.id === "string" && qq.id) || title || "Question",
                    options,
                    multiple: qq.allow_multiple === true,
                };
            })
            : [];
        return {
            callId,
            variant,
            preferredToolName: "question",
            args: { questions },
        };
    }
    if (variant === "switch_mode_tool_call") {
        // Display-path mirror of InteractionQuery #4. Same mapping as switch-mode.ts:
        // plan/spec → plan_enter; every other non-empty target → plan_exit.
        // Display completions stay non-replayed regardless of mapping.
        const target = typeof args.target_mode_id === "string" ? args.target_mode_id : "";
        const mapped = mapSwitchModeTarget(target);
        return {
            callId,
            variant,
            preferredToolName: mapped.ok ? mapped.toolName : "plan_exit",
            // OpenCode plan_enter / plan_exit both advertise an empty input schema.
            args: {},
            bridgeable: mapped.ok,
        };
    }
    // F11: display-path delete → bash `rm -f` (OpenCode has no delete tool).
    if (variant === "delete_tool_call") {
        const path = typeof args.path === "string" ? args.path : "";
        return {
            callId,
            variant,
            preferredToolName: "bash",
            args: path ? { command: `rm -f -- ${shellQuote(path)}` } : { command: "true" },
        };
    }
    const preferred = VARIANT_TO_OPENCODE[variant] ?? variant.replace(/_tool_call$/, "");
    return {
        callId,
        variant,
        preferredToolName: preferred,
        args,
    };
}
function shellQuote(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
/**
 * Pick an advertised OpenCode tool for a display call, remapping args as needed.
 * Returns undefined when nothing compatible is advertised this turn.
 */
export function resolveBridgedOpenCodeToolCall(display, advertised, dialect = OPENCODE_1_TOOL_DIALECT) {
    if (isNativeDisplayToolCall(display.variant))
        return undefined;
    if (!DISPLAY_STATE_MIRROR_VARIANTS.has(display.variant))
        return undefined;
    if (display.bridgeable === false)
        return undefined;
    const names = new Set([...advertised].filter(Boolean));
    if (names.size === 0)
        return undefined;
    const candidates = candidateToolNames(display, names);
    for (const toolName of candidates) {
        if (!names.has(toolName))
            continue;
        const mapped = mapCursorArgsToOpencode(toolName, display.args, undefined, dialect);
        if (toolName === "todowrite") {
            mapped.args = {
                todos: mapTodos(display.args.todos ?? mapped.args.todos),
            };
        }
        if (toolName === "todoread") {
            mapped.args = {};
        }
        return {
            toolName: mapped.toolName,
            args: mapped.args,
            callId: display.callId,
            variant: display.variant,
        };
    }
    return undefined;
}
function candidateToolNames(display, advertised) {
    const out = [];
    const add = (n) => {
        if (n && !out.includes(n))
            out.push(n);
    };
    add(display.preferredToolName);
    if (display.variant === "create_plan_tool_call")
        add("todowrite");
    if (display.variant === "update_todos_tool_call")
        add("todowrite");
    if (display.variant === "read_todos_tool_call")
        add("todoread");
    if (display.variant === "ask_question_tool_call")
        add("question");
    if (display.variant === "web_search_tool_call")
        add("websearch");
    if (display.variant === "fetch_tool_call" || display.variant === "web_fetch_tool_call") {
        add("webfetch");
    }
    for (const name of advertised) {
        if (name.toLowerCase() === display.preferredToolName.toLowerCase())
            add(name);
    }
    return out;
}
/** Map only Cursor subagent variants with a safe OpenCode identity. */
function openCodeSubagentType(raw) {
    const subtype = asRecord(raw);
    if (!subtype)
        return undefined;
    const custom = asRecord(subtype.custom);
    if (typeof custom?.name === "string" && custom.name.length > 0)
        return custom.name;
    if (subtype.explore != null)
        return mapCursorSubagentTypeToOpenCode("explore");
    if (subtype.cursor_guide != null)
        return mapCursorSubagentTypeToOpenCode("cursor_guide");
    if (subtype.bash != null)
        return mapCursorSubagentTypeToOpenCode("bash");
    if (subtype.shell != null)
        return mapCursorSubagentTypeToOpenCode("shell");
    if (subtype.debug != null)
        return mapCursorSubagentTypeToOpenCode("debug");
    if (subtype.computer_use != null)
        return mapCursorSubagentTypeToOpenCode("computer_use");
    if (subtype.browser_use != null)
        return mapCursorSubagentTypeToOpenCode("browser_use");
    if (subtype.media_review != null)
        return mapCursorSubagentTypeToOpenCode("media_review");
    if (subtype.watch_video != null)
        return mapCursorSubagentTypeToOpenCode("watch_video");
    if (subtype.vm_setup_helper != null)
        return mapCursorSubagentTypeToOpenCode("vm_setup_helper");
    if (subtype.unspecified != null)
        return mapCursorSubagentTypeToOpenCode("unspecified");
    return undefined;
}
/** Advertised OpenCode tool ids from Cursor McpToolDefinition descriptors. */
export function advertisedToolNamesFromDescriptors(descriptors) {
    const out = [];
    for (const d of descriptors) {
        const toolName = typeof d.tool_name === "string" ? d.tool_name : undefined;
        const provider = typeof d.provider_identifier === "string" ? d.provider_identifier : "opencode";
        if (!toolName)
            continue;
        if (provider && provider !== "opencode")
            out.push(`${provider}_${toolName}`);
        else
            out.push(toolName);
    }
    return out;
}
/** Walk a protobuf message and return top-level field numbers present. */
export function listProtobufFieldNumbers(buf) {
    const fields = [];
    let i = 0;
    while (i < buf.length) {
        let key = 0;
        let shift = 0;
        while (i < buf.length) {
            const byte = buf[i++];
            key |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0)
                break;
            shift += 7;
            if (shift > 35)
                return fields;
        }
        const field = key >>> 3;
        const wire = key & 7;
        fields.push(field);
        if (wire === 0) {
            // varint
            while (i < buf.length && (buf[i++] & 0x80) !== 0) { /* consume */ }
        }
        else if (wire === 1) {
            i += 8;
        }
        else if (wire === 2) {
            let len = 0;
            shift = 0;
            while (i < buf.length) {
                const byte = buf[i++];
                len |= (byte & 0x7f) << shift;
                if ((byte & 0x80) === 0)
                    break;
                shift += 7;
                if (shift > 35)
                    return fields;
            }
            i += len;
        }
        else if (wire === 5) {
            i += 4;
        }
        else {
            break;
        }
        if (i > buf.length)
            break;
    }
    return fields;
}
/**
 * Extract nested bytes for path of field numbers (each must be wire type 2).
 * Returns undefined if any segment is missing.
 */
export function extractProtobufSubmessage(buf, path) {
    let cur = buf;
    for (const want of path) {
        if (!cur)
            return undefined;
        let i = 0;
        let found;
        while (i < cur.length) {
            let key = 0;
            let shift = 0;
            while (i < cur.length) {
                const byte = cur[i++];
                key |= (byte & 0x7f) << shift;
                if ((byte & 0x80) === 0)
                    break;
                shift += 7;
                if (shift > 35)
                    return undefined;
            }
            const field = key >>> 3;
            const wire = key & 7;
            if (wire === 0) {
                while (i < cur.length && (cur[i++] & 0x80) !== 0) { /* consume */ }
            }
            else if (wire === 1) {
                i += 8;
            }
            else if (wire === 2) {
                let len = 0;
                shift = 0;
                while (i < cur.length) {
                    const byte = cur[i++];
                    len |= (byte & 0x7f) << shift;
                    if ((byte & 0x80) === 0)
                        break;
                    shift += 7;
                    if (shift > 35)
                        return undefined;
                }
                const slice = cur.subarray(i, i + len);
                i += len;
                if (field === want)
                    found = slice;
            }
            else if (wire === 5) {
                i += 4;
            }
            else {
                return undefined;
            }
            if (i > cur.length)
                return undefined;
        }
        cur = found;
    }
    return cur;
}
/**
 * Pull Cursor's tool_call_id out of a raw ExecServerMessage args variant so we
 * can correlate display tool_call_started with the authoritative exec path.
 */
export function extractExecDisplayCallId(execMsg) {
    for (const key of [
        "read_args",
        "write_args",
        "pi_write_args",
        "grep_args",
        "ls_args",
        "delete_args",
        "shell_stream_args",
        "background_shell_spawn_args",
        "mcp_args",
        "subagent_args",
    ]) {
        const args = asRecord(execMsg[key]);
        if (!args)
            continue;
        if (typeof args.tool_call_id === "string" && args.tool_call_id.length > 0) {
            return args.tool_call_id;
        }
    }
    return undefined;
}
