import protobuf from "protobufjs";
function addType(root, name, fields, oneofs) {
    const t = new protobuf.Type(name);
    for (const f of fields) {
        t.add(new protobuf.Field(f.name, f.id, f.type, f.repeated ? "repeated" : undefined));
    }
    for (const o of oneofs ?? []) {
        t.add(new protobuf.OneOf(o.name, o.fields));
    }
    root.add(t);
    return t;
}
// ── Utility messages ──
export function createMessageTypes() {
    const root = new protobuf.Root();
    addType(root, "TextDeltaUpdate", [
        { id: 1, name: "text", type: "string" },
    ]);
    addType(root, "ThinkingDeltaUpdate", [
        { id: 1, name: "text", type: "string" },
    ]);
    addType(root, "TurnEnded", [
        { id: 1, name: "input_tokens", type: "uint32" },
        { id: 2, name: "output_tokens", type: "uint32" },
        { id: 3, name: "cache_read", type: "uint32" },
        { id: 4, name: "cache_write", type: "uint32" },
        { id: 5, name: "reasoning_tokens", type: "uint32" },
    ]);
    addType(root, "Heartbeat", []);
    // Display ToolCall (interaction_update.tool_call_*) — agent.v1 oneof, not
    // {tool_name,args} strings. Decode finalized todo state for mirroring and
    // MCP errors for diagnostics; other completion results are not replayed.
    root.add(new protobuf.Enum("TodoStatus", {
        TODO_STATUS_UNSPECIFIED: 0,
        TODO_STATUS_PENDING: 1,
        TODO_STATUS_IN_PROGRESS: 2,
        TODO_STATUS_COMPLETED: 3,
        TODO_STATUS_CANCELLED: 4,
    }));
    addType(root, "TodoItem", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "content", type: "string" },
        { id: 3, name: "status", type: "TodoStatus" },
        { id: 4, name: "created_at", type: "int64" },
        { id: 5, name: "updated_at", type: "int64" },
        { id: 6, name: "dependencies", type: "string", repeated: true },
    ]);
    addType(root, "UpdateTodosArgs", [
        { id: 1, name: "todos", type: "TodoItem", repeated: true },
        { id: 2, name: "merge", type: "bool" },
    ]);
    addType(root, "UpdateTodosSuccess", [
        { id: 1, name: "todos", type: "TodoItem", repeated: true },
        { id: 2, name: "total_count", type: "int32" },
        { id: 3, name: "was_merge", type: "bool" },
    ]);
    addType(root, "UpdateTodosError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "UpdateTodosResult", [
        { id: 1, name: "success", type: "UpdateTodosSuccess" },
        { id: 2, name: "error", type: "UpdateTodosError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "UpdateTodosToolCall", [
        { id: 1, name: "args", type: "UpdateTodosArgs" },
        { id: 2, name: "result", type: "UpdateTodosResult" },
    ]);
    addType(root, "ReadToolArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "offset", type: "int32" },
        { id: 3, name: "limit", type: "int32" },
    ]);
    addType(root, "ReadToolCall", [{ id: 1, name: "args", type: "ReadToolArgs" }]);
    addType(root, "ShellToolCall", [{ id: 1, name: "args", type: "ShellArgs" }]);
    addType(root, "DeleteToolCall", [{ id: 1, name: "args", type: "DeleteArgs" }]);
    addType(root, "GlobToolCall", [{ id: 1, name: "args", type: "GlobArgs" }]);
    addType(root, "GrepToolCall", [{ id: 1, name: "args", type: "GrepArgs" }]);
    addType(root, "EditToolArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 6, name: "stream_content", type: "string" },
    ]);
    addType(root, "EditToolCall", [{ id: 1, name: "args", type: "EditToolArgs" }]);
    addType(root, "LsToolCall", [{ id: 1, name: "args", type: "LsArgs" }]);
    addType(root, "McpToolCall", [
        { id: 1, name: "args", type: "McpArgs" },
        { id: 2, name: "result", type: "McpResult" },
    ]);
    addType(root, "CreatePlanArgs", [
        { id: 1, name: "plan", type: "string" },
        { id: 2, name: "todos", type: "TodoItem", repeated: true },
        { id: 3, name: "overview", type: "string" },
        { id: 4, name: "name", type: "string" },
        { id: 5, name: "is_project", type: "bool" },
    ]);
    addType(root, "CreatePlanToolCall", [{ id: 1, name: "args", type: "CreatePlanArgs" }]);
    addType(root, "WebSearchToolArgs", [
        { id: 1, name: "search_term", type: "string" },
        { id: 2, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "WebSearchToolCall", [{ id: 1, name: "args", type: "WebSearchToolArgs" }]);
    addType(root, "SubagentTypeUnspecified", []);
    addType(root, "SubagentTypeComputerUse", []);
    addType(root, "SubagentTypeCustom", [{ id: 1, name: "name", type: "string" }]);
    addType(root, "SubagentTypeExplore", []);
    addType(root, "SubagentTypeMediaReview", []);
    addType(root, "SubagentTypeBash", []);
    addType(root, "SubagentTypeBrowserUse", []);
    addType(root, "SubagentTypeShell", []);
    addType(root, "SubagentTypeVmSetupHelper", []);
    addType(root, "SubagentTypeDebug", []);
    addType(root, "SubagentTypeCursorGuide", []);
    addType(root, "SubagentTypeWatchVideo", []);
    addType(root, "SubagentType", [
        { id: 1, name: "unspecified", type: "SubagentTypeUnspecified" },
        { id: 2, name: "computer_use", type: "SubagentTypeComputerUse" },
        { id: 3, name: "custom", type: "SubagentTypeCustom" },
        { id: 4, name: "explore", type: "SubagentTypeExplore" },
        { id: 5, name: "media_review", type: "SubagentTypeMediaReview" },
        { id: 6, name: "bash", type: "SubagentTypeBash" },
        { id: 7, name: "browser_use", type: "SubagentTypeBrowserUse" },
        { id: 8, name: "shell", type: "SubagentTypeShell" },
        { id: 9, name: "vm_setup_helper", type: "SubagentTypeVmSetupHelper" },
        { id: 10, name: "debug", type: "SubagentTypeDebug" },
        { id: 11, name: "cursor_guide", type: "SubagentTypeCursorGuide" },
        { id: 12, name: "watch_video", type: "SubagentTypeWatchVideo" },
    ], [{
            name: "type",
            fields: [
                "unspecified", "computer_use", "custom", "explore", "media_review", "bash",
                "browser_use", "shell", "vm_setup_helper", "debug", "cursor_guide", "watch_video",
            ],
        }]);
    addType(root, "TaskToolArgs", [
        { id: 1, name: "description", type: "string" },
        { id: 2, name: "prompt", type: "string" },
        { id: 3, name: "subagent_type", type: "SubagentType" },
        { id: 4, name: "model", type: "string" },
        { id: 5, name: "resume", type: "string" },
        { id: 6, name: "agent_id", type: "string" },
    ]);
    addType(root, "TaskToolCall", [{ id: 1, name: "args", type: "TaskToolArgs" }]);
    // Native subagent execution is separate from the display-only TaskToolCall.
    // Cursor asks the local client to run the task through ExecServerMessage #28
    // and waits for the correlated SubagentResult at ExecClientMessage #28.
    addType(root, "SubagentArgs", [
        { id: 1, name: "tool_call_id", type: "string" },
        { id: 2, name: "subagent_type", type: "string" },
        { id: 3, name: "model_id", type: "string" },
        { id: 4, name: "prompt", type: "string" },
        { id: 5, name: "readonly", type: "bool" },
        { id: 6, name: "resume_agent_id", type: "string" },
        { id: 7, name: "run_in_background", type: "bool" },
    ]);
    addType(root, "SubagentSuccess", [
        { id: 1, name: "agent_id", type: "string" },
        { id: 2, name: "final_message", type: "string" },
        { id: 3, name: "tool_call_count", type: "int32" },
        { id: 4, name: "background_reason", type: "int32" },
        { id: 5, name: "transcript_path", type: "string" },
    ]);
    addType(root, "SubagentError", [
        { id: 1, name: "agent_id", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "SubagentResult", [
        { id: 1, name: "success", type: "SubagentSuccess" },
        { id: 2, name: "error", type: "SubagentError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "AskQuestionOption", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "label", type: "string" },
    ]);
    addType(root, "AskQuestionItem", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "prompt", type: "string" },
        { id: 3, name: "options", type: "AskQuestionOption", repeated: true },
        { id: 4, name: "allow_multiple", type: "bool" },
    ]);
    addType(root, "AskQuestionArgs", [
        { id: 1, name: "title", type: "string" },
        { id: 2, name: "questions", type: "AskQuestionItem", repeated: true },
        // #5/#6 drive Cursor's non-blocking AskQuestion: the client answers the
        // interaction with `async` right away and delivers the real answers later
        // through ConversationAction.async_ask_question_completion_action, keyed by
        // the originating tool call id. See protocol/ask-question.ts.
        { id: 5, name: "run_async", type: "bool" },
        { id: 6, name: "async_original_tool_call_id", type: "string" },
    ]);
    addType(root, "AskQuestionToolCall", [{ id: 1, name: "args", type: "AskQuestionArgs" }]);
    addType(root, "FetchToolArgs", [
        { id: 1, name: "url", type: "string" },
        { id: 2, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "FetchToolCall", [{ id: 1, name: "args", type: "FetchToolArgs" }]);
    addType(root, "WebFetchToolCall", [{ id: 1, name: "args", type: "FetchToolArgs" }]);
    addType(root, "SwitchModeToolArgs", [
        { id: 1, name: "target_mode_id", type: "string" },
        { id: 2, name: "explanation", type: "string" },
        { id: 3, name: "tool_call_id", type: "string" },
    ]);
    // Display ToolCall.result (CLI success hardcodes from_mode_id=""); distinct from
    // InteractionResponse approved/rejected, which is the consent gate.
    addType(root, "SwitchModeSuccess", [
        { id: 1, name: "from_mode_id", type: "string" },
        { id: 2, name: "to_mode_id", type: "string" },
    ]);
    addType(root, "SwitchModeError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "SwitchModeRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "SwitchModeResult", [
        { id: 1, name: "success", type: "SwitchModeSuccess" },
        { id: 2, name: "error", type: "SwitchModeError" },
        { id: 3, name: "rejected", type: "SwitchModeRejected" },
    ], [{ name: "result", fields: ["success", "error", "rejected"] }]);
    addType(root, "SwitchModeToolCall", [
        { id: 1, name: "args", type: "SwitchModeToolArgs" },
        { id: 2, name: "result", type: "SwitchModeResult" },
    ]);
    addType(root, "PiReadToolArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "offset", type: "int32" },
        { id: 3, name: "limit", type: "int32" },
    ]);
    addType(root, "PiBashToolArgs", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "timeout", type: "double" },
    ]);
    addType(root, "PiEditReplacement", [
        { id: 1, name: "old_text", type: "string" },
        { id: 2, name: "new_text", type: "string" },
    ]);
    addType(root, "PiEditToolArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "edits", type: "PiEditReplacement", repeated: true },
    ]);
    addType(root, "PiWriteToolArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "content", type: "string" },
    ]);
    addType(root, "PiGrepToolArgs", [
        { id: 1, name: "pattern", type: "string" },
        { id: 2, name: "path", type: "string" },
        { id: 3, name: "glob", type: "string" },
        { id: 4, name: "ignore_case", type: "bool" },
        { id: 5, name: "literal", type: "bool" },
        { id: 6, name: "context", type: "int32" },
        { id: 7, name: "limit", type: "int32" },
    ]);
    addType(root, "PiFindToolArgs", [
        { id: 1, name: "pattern", type: "string" },
        { id: 2, name: "path", type: "string" },
        { id: 3, name: "limit", type: "int32" },
    ]);
    addType(root, "PiLsToolArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "limit", type: "int32" },
    ]);
    addType(root, "PiWriteToolCall", [{ id: 1, name: "args", type: "PiWriteToolArgs" }]);
    addType(root, "PiReadToolCall", [{ id: 1, name: "args", type: "PiReadToolArgs" }]);
    addType(root, "PiBashToolCall", [{ id: 1, name: "args", type: "PiBashToolArgs" }]);
    addType(root, "PiEditToolCall", [{ id: 1, name: "args", type: "PiEditToolArgs" }]);
    addType(root, "PiGrepToolCall", [{ id: 1, name: "args", type: "PiGrepToolArgs" }]);
    addType(root, "PiFindToolCall", [{ id: 1, name: "args", type: "PiFindToolArgs" }]);
    addType(root, "PiLsToolCall", [{ id: 1, name: "args", type: "PiLsToolArgs" }]);
    // Display-only native tools Cursor may complete without an ExecServerMessage.
    // ReadTodos mirrors UpdateTodos: args + result (see agent.v1 ReadTodosToolCall).
    addType(root, "ReadTodosArgs", [
        { id: 1, name: "status_filter", type: "TodoStatus", repeated: true },
        { id: 2, name: "id_filter", type: "string", repeated: true },
    ]);
    addType(root, "ReadTodosSuccess", [
        { id: 1, name: "todos", type: "TodoItem", repeated: true },
        { id: 2, name: "total_count", type: "int32" },
    ]);
    addType(root, "ReadTodosError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "ReadTodosResult", [
        { id: 1, name: "success", type: "ReadTodosSuccess" },
        { id: 2, name: "error", type: "ReadTodosError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "ReadTodosToolCall", [
        { id: 1, name: "args", type: "ReadTodosArgs" },
        { id: 2, name: "result", type: "ReadTodosResult" },
    ]);
    addType(root, "AwaitArgs", [
        { id: 1, name: "task_id", type: "string" },
        { id: 2, name: "block_until_ms", type: "uint32" },
        { id: 3, name: "regex", type: "string" },
    ]);
    addType(root, "AwaitToolCall", [{ id: 1, name: "args", type: "AwaitArgs" }]);
    addType(root, "GetMcpToolsArgs", [
        { id: 1, name: "server", type: "string" },
        { id: 2, name: "tool_name", type: "string" },
        { id: 3, name: "pattern", type: "string" },
        { id: 4, name: "tool_call_id", type: "string" },
    ]);
    // agent.v1 GetMcpToolsToolCall is args + result. Cursor's agent fills result
    // locally (GetDynamicTools / GetMcpTools); large catalogs spill through
    // write_args and put the spill path on GetMcpToolsSuccess.output_file_path.
    addType(root, "GetMcpToolsSuccess", [
        { id: 1, name: "content", type: "string" },
        { id: 2, name: "output_file_path", type: "string" },
    ]);
    addType(root, "GetMcpToolsError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "GetMcpToolsAgentResult", [
        { id: 1, name: "success", type: "GetMcpToolsSuccess" },
        { id: 2, name: "error", type: "GetMcpToolsError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "GetMcpToolsToolCall", [
        { id: 1, name: "args", type: "GetMcpToolsArgs" },
        { id: 2, name: "result", type: "GetMcpToolsAgentResult" },
    ]);
    addType(root, "GenerateImageToolArgs", [
        { id: 1, name: "description", type: "string" },
        { id: 2, name: "file_path", type: "string" },
        { id: 5, name: "reference_image_paths", type: "string", repeated: true },
    ]);
    // Cursor generates the image server-side and returns it on the display
    // tool_call frame. `image_data` is a base64 string, not bytes.
    addType(root, "GenerateImageSuccess", [
        { id: 1, name: "file_path", type: "string" },
        { id: 2, name: "image_data", type: "string" },
    ]);
    addType(root, "GenerateImageError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "GenerateImageResult", [
        { id: 1, name: "success", type: "GenerateImageSuccess" },
        { id: 2, name: "error", type: "GenerateImageError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "GenerateImageToolCall", [
        { id: 1, name: "args", type: "GenerateImageToolArgs" },
        { id: 2, name: "result", type: "GenerateImageResult" },
    ]);
    // InteractionQuery keeps query bodies opaque; decoded on demand like
    // AskQuestionInteractionQuery.
    addType(root, "GenerateImageRequestQuery", [
        { id: 1, name: "args", type: "GenerateImageToolArgs" },
        { id: 2, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "ToolCall", [
        { id: 57, name: "tool_call_id", type: "string" },
        { id: 1, name: "shell_tool_call", type: "ShellToolCall" },
        { id: 3, name: "delete_tool_call", type: "DeleteToolCall" },
        { id: 4, name: "glob_tool_call", type: "GlobToolCall" },
        { id: 5, name: "grep_tool_call", type: "GrepToolCall" },
        { id: 8, name: "read_tool_call", type: "ReadToolCall" },
        { id: 9, name: "update_todos_tool_call", type: "UpdateTodosToolCall" },
        { id: 10, name: "read_todos_tool_call", type: "ReadTodosToolCall" },
        { id: 12, name: "edit_tool_call", type: "EditToolCall" },
        { id: 13, name: "ls_tool_call", type: "LsToolCall" },
        { id: 15, name: "mcp_tool_call", type: "McpToolCall" },
        { id: 17, name: "create_plan_tool_call", type: "CreatePlanToolCall" },
        { id: 18, name: "web_search_tool_call", type: "WebSearchToolCall" },
        { id: 19, name: "task_tool_call", type: "TaskToolCall" },
        { id: 23, name: "ask_question_tool_call", type: "AskQuestionToolCall" },
        { id: 24, name: "fetch_tool_call", type: "FetchToolCall" },
        { id: 25, name: "switch_mode_tool_call", type: "SwitchModeToolCall" },
        { id: 28, name: "generate_image_tool_call", type: "GenerateImageToolCall" },
        { id: 37, name: "web_fetch_tool_call", type: "WebFetchToolCall" },
        { id: 42, name: "await_tool_call", type: "AwaitToolCall" },
        { id: 44, name: "get_mcp_tools_tool_call", type: "GetMcpToolsToolCall" },
        { id: 61, name: "pi_read_tool_call", type: "PiReadToolCall" },
        { id: 62, name: "pi_bash_tool_call", type: "PiBashToolCall" },
        { id: 63, name: "pi_edit_tool_call", type: "PiEditToolCall" },
        { id: 64, name: "pi_write_tool_call", type: "PiWriteToolCall" },
        { id: 65, name: "pi_grep_tool_call", type: "PiGrepToolCall" },
        { id: 66, name: "pi_find_tool_call", type: "PiFindToolCall" },
        { id: 67, name: "pi_ls_tool_call", type: "PiLsToolCall" },
    ], [{
            name: "tool",
            fields: [
                "shell_tool_call", "delete_tool_call", "glob_tool_call", "grep_tool_call",
                "read_tool_call", "update_todos_tool_call", "read_todos_tool_call",
                "edit_tool_call", "ls_tool_call",
                "mcp_tool_call", "create_plan_tool_call", "web_search_tool_call", "task_tool_call",
                "ask_question_tool_call", "fetch_tool_call", "switch_mode_tool_call",
                "generate_image_tool_call", "web_fetch_tool_call", "await_tool_call", "get_mcp_tools_tool_call",
                "pi_read_tool_call", "pi_bash_tool_call", "pi_edit_tool_call",
                "pi_write_tool_call", "pi_grep_tool_call", "pi_find_tool_call", "pi_ls_tool_call",
            ],
        }]);
    addType(root, "ToolCallStarted", [
        { id: 1, name: "call_id", type: "string" },
        { id: 2, name: "tool_call", type: "ToolCall" },
        { id: 3, name: "model_call_id", type: "string" },
    ]);
    // agent.v1 ToolCallCompletedUpdate has no string result field — result lives
    // inside the typed ToolCall variant.
    addType(root, "ToolCallCompleted", [
        { id: 1, name: "call_id", type: "string" },
        { id: 2, name: "tool_call", type: "ToolCall" },
        { id: 3, name: "model_call_id", type: "string" },
    ]);
    addType(root, "PartialToolCall", [
        { id: 1, name: "call_id", type: "string" },
        { id: 2, name: "tool_call", type: "ToolCall" },
        { id: 3, name: "args_text_delta", type: "string" },
        { id: 4, name: "model_call_id", type: "string" },
    ]);
    // agent.v1 ToolCallDeltaUpdate: keep the nested delta opaque; the pump
    // needs its presence as generation progress, not its display-only content.
    addType(root, "ToolCallDeltaUpdate", [
        { id: 1, name: "call_id", type: "string" },
        { id: 2, name: "tool_call_delta", type: "bytes" },
        { id: 3, name: "model_call_id", type: "string" },
    ]);
    // agent.v1 StepStartedUpdate / StepCompletedUpdate: step_id is uint64 (T:4),
    // not string — wrong type made every step_completed frame throw
    // "index out of range" in decodeMessage.
    addType(root, "StepStarted", [
        { id: 1, name: "step_id", type: "uint64" },
    ]);
    addType(root, "StepCompleted", [
        { id: 1, name: "step_id", type: "uint64" },
        { id: 2, name: "step_duration_ms", type: "int64" },
    ]);
    // agent.v1 ToolRequestsListedUpdate — Cursor lists how many tool calls this
    // generation will send so the client can place its step boundary (CLI does
    // not need this; OpenCode's AI SDK step does). Field 27 on InteractionUpdate.
    addType(root, "ToolRequestsListedUpdate", [
        { id: 1, name: "call_count", type: "uint32" },
    ]);
    // InteractionUpdate — the core streaming update message
    addType(root, "InteractionUpdate", [
        { id: 1, name: "text_delta", type: "TextDeltaUpdate" },
        { id: 2, name: "tool_call_started", type: "ToolCallStarted" },
        { id: 3, name: "tool_call_completed", type: "ToolCallCompleted" },
        { id: 4, name: "thinking_delta", type: "ThinkingDeltaUpdate" },
        { id: 7, name: "partial_tool_call", type: "PartialToolCall" },
        { id: 13, name: "heartbeat", type: "Heartbeat" },
        { id: 14, name: "turn_ended", type: "TurnEnded" },
        { id: 15, name: "tool_call_delta", type: "ToolCallDeltaUpdate" },
        { id: 16, name: "step_started", type: "StepStarted" },
        { id: 17, name: "step_completed", type: "StepCompleted" },
        { id: 27, name: "tool_requests_listed", type: "ToolRequestsListedUpdate" },
    ], [{ name: "update", fields: ["text_delta", "tool_call_started", "tool_call_completed", "thinking_delta", "partial_tool_call", "heartbeat", "turn_ended", "tool_call_delta", "step_started", "step_completed", "tool_requests_listed"] }]);
    // ── Exec channel ──
    // Field numbers match agent.v1. Extra fields we don't use are still declared
    // so protobufjs doesn't drop them on decode.
    addType(root, "ReadArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "tool_call_id", type: "string" },
        { id: 4, name: "offset", type: "int32" },
        { id: 5, name: "limit", type: "uint32" },
    ]);
    // agent.v1 ReadResult is a oneof — flat {content,error} was rejected by the
    // server (endless heartbeats after read_result).
    addType(root, "ReadSuccess", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "content", type: "string" },
        { id: 3, name: "total_lines", type: "int32" },
        { id: 4, name: "file_size", type: "int64" },
        { id: 5, name: "data", type: "bytes" },
        { id: 6, name: "truncated", type: "bool" },
        { id: 7, name: "output_blob_id", type: "bytes" },
        { id: 8, name: "range_applied", type: "bool" },
    ], [{ name: "output", fields: ["content", "data"] }]);
    addType(root, "ReadError", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    // Cursor's LocalReadExecutor validates the target before execution and, for a
    // missing / non-regular path, returns one of these typed ReadResult cases
    // instead of running the tool. Mirroring the exact field ids/shapes lets this
    // provider reply the same way so the model sees a structured file-not-found
    // observation and the host never surfaces a permission prompt.
    addType(root, "ReadFileNotFound", [{ id: 1, name: "path", type: "string" }]);
    addType(root, "ReadPermissionDenied", [{ id: 1, name: "path", type: "string" }]);
    addType(root, "ReadInvalidFile", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "reason", type: "string" },
    ]);
    addType(root, "ReadResult", [
        { id: 1, name: "success", type: "ReadSuccess" },
        { id: 2, name: "error", type: "ReadError" },
        { id: 4, name: "file_not_found", type: "ReadFileNotFound" },
        { id: 5, name: "permission_denied", type: "ReadPermissionDenied" },
        { id: 6, name: "invalid_file", type: "ReadInvalidFile" },
    ], [
        {
            name: "result",
            fields: ["success", "error", "file_not_found", "permission_denied", "invalid_file"],
        },
    ]);
    addType(root, "GrepArgs", [
        { id: 1, name: "pattern", type: "string" },
        { id: 2, name: "path", type: "string" },
        { id: 3, name: "glob", type: "string" },
        { id: 4, name: "output_mode", type: "string" },
        { id: 8, name: "case_insensitive", type: "bool" },
        { id: 10, name: "head_limit", type: "int32" },
        { id: 14, name: "tool_call_id", type: "string" },
        { id: 16, name: "offset", type: "int32" },
    ]);
    addType(root, "GrepError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "GrepFilesResult", [
        { id: 1, name: "files", type: "string", repeated: true },
        { id: 2, name: "total_files", type: "int32" },
        { id: 3, name: "client_truncated", type: "bool" },
    ]);
    addType(root, "GrepContentMatch", [
        { id: 1, name: "line_number", type: "int32" },
        { id: 2, name: "content", type: "string" },
    ]);
    addType(root, "GrepFileMatch", [
        { id: 1, name: "file", type: "string" },
        { id: 2, name: "matches", type: "GrepContentMatch", repeated: true },
    ]);
    addType(root, "GrepContentResult", [
        { id: 1, name: "matches", type: "GrepFileMatch", repeated: true },
        { id: 2, name: "total_lines", type: "int32" },
        { id: 3, name: "total_matched_lines", type: "int32" },
        { id: 4, name: "client_truncated", type: "bool" },
        { id: 5, name: "ripgrep_truncated", type: "bool" },
    ]);
    addType(root, "GrepUnionResult", [
        { id: 2, name: "files", type: "GrepFilesResult" },
        { id: 3, name: "content", type: "GrepContentResult" },
    ], [{ name: "result", fields: ["files", "content"] }]);
    {
        const t = new protobuf.Type("GrepSuccess");
        t.add(new protobuf.Field("pattern", 1, "string"));
        t.add(new protobuf.Field("path", 2, "string"));
        t.add(new protobuf.Field("output_mode", 3, "string"));
        t.add(new protobuf.MapField("workspace_results", 4, "string", "GrepUnionResult"));
        root.add(t);
    }
    addType(root, "GrepResult", [
        { id: 1, name: "success", type: "GrepSuccess" },
        { id: 2, name: "error", type: "GrepError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    // agent.v1.WriteArgs. Cursor's own LocalWriteExecutor reads `file_bytes`
    // first and only falls back to `file_text`, so a write whose content arrives
    // as bytes decodes to an empty string unless field 5 is declared here.
    addType(root, "WriteArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "file_text", type: "string" },
        { id: 3, name: "tool_call_id", type: "string" },
        { id: 4, name: "return_file_content_after_write", type: "bool" },
        { id: 5, name: "file_bytes", type: "bytes" },
        { id: 6, name: "encoding_hint", type: "string" },
    ]);
    addType(root, "WriteSuccess", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "lines_created", type: "int32" },
        { id: 3, name: "file_size", type: "int32" },
        { id: 4, name: "file_content_after_write", type: "string" },
    ]);
    addType(root, "WriteError", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    // Cursor's own executor reports a refused write with this variant rather than
    // a generic error, and its agent reads `operation` / `is_readonly` back.
    addType(root, "WritePermissionDenied", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "directory", type: "string" },
        { id: 3, name: "operation", type: "string" },
        { id: 4, name: "error", type: "string" },
        { id: 5, name: "is_readonly", type: "bool" },
    ]);
    addType(root, "WriteResult", [
        { id: 1, name: "success", type: "WriteSuccess" },
        { id: 3, name: "permission_denied", type: "WritePermissionDenied" },
        { id: 5, name: "error", type: "WriteError" },
    ], [{ name: "result", fields: ["success", "permission_denied", "error"] }]);
    // agent.v1 Pi exec results. Cursor places Pi requests at ExecServerMessage
    // fields #45..#51 and their corresponding ExecClientMessage results at
    // #46..#52 (the result fields are deliberately offset by one).
    //
    // The success payloads contain additional optional truncation/diff metadata;
    // OpenCode returns text, so the minimal output/error shapes are sufficient.
    addType(root, "PiWriteArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "content", type: "string" },
    ]);
    addType(root, "PiWriteSuccess", [
        { id: 1, name: "output", type: "string" },
    ]);
    addType(root, "PiWriteError", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "PiWriteRejected", [
        { id: 1, name: "reason", type: "string" },
    ]);
    addType(root, "PiWriteResult", [
        { id: 1, name: "success", type: "PiWriteSuccess" },
        { id: 2, name: "error", type: "PiWriteError" },
        { id: 3, name: "rejected", type: "PiWriteRejected" },
    ], [{ name: "result", fields: ["success", "error", "rejected"] }]);
    // agent.v1.PiTruncation. Every Pi *ExecSuccess shares output(1)+truncation(2)
    // and only diverges at field 3, so the shared PiOutputSuccess can carry it.
    // Cursor's own CLI always reports truncation rather than silently shortening
    // a payload; emitting this keeps a capped read distinguishable from a
    // complete one.
    addType(root, "PiTruncation", [
        { id: 1, name: "truncated", type: "bool" },
        { id: 2, name: "truncated_by", type: "string" },
        { id: 3, name: "total_lines", type: "uint32" },
        { id: 4, name: "output_lines", type: "uint32" },
        { id: 5, name: "output_bytes", type: "uint32" },
        { id: 6, name: "max_lines", type: "uint32" },
        { id: 7, name: "max_bytes", type: "uint32" },
        { id: 8, name: "first_line_exceeds_limit", type: "bool" },
        { id: 9, name: "last_line_partial", type: "bool" },
    ]);
    addType(root, "PiOutputSuccess", [
        { id: 1, name: "output", type: "string" },
        { id: 2, name: "truncation", type: "PiTruncation" },
    ]);
    addType(root, "PiExecError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "PiExecRejected", [{ id: 1, name: "reason", type: "string" }]);
    for (const resultType of [
        "PiReadExecResult",
        "PiBashExecResult",
        "PiGrepExecResult",
        "PiFindExecResult",
        "PiLsExecResult",
    ]) {
        addType(root, resultType, [
            { id: 1, name: "success", type: "PiOutputSuccess" },
            { id: 2, name: "error", type: "PiExecError" },
        ], [{ name: "result", fields: ["success", "error"] }]);
    }
    addType(root, "PiEditExecResult", [
        { id: 1, name: "success", type: "PiOutputSuccess" },
        { id: 2, name: "error", type: "PiExecError" },
        { id: 3, name: "rejected", type: "PiExecRejected" },
    ], [{ name: "result", fields: ["success", "error", "rejected"] }]);
    addType(root, "DeleteArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "DeleteSuccess", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "deleted_file", type: "string" },
    ]);
    addType(root, "DeleteError", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "DeleteResult", [
        { id: 1, name: "success", type: "DeleteSuccess" },
        { id: 7, name: "error", type: "DeleteError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "LsArgs", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "ignore", type: "string", repeated: true },
        { id: 3, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "LsDirectoryTreeFile", [{ id: 1, name: "name", type: "string" }]);
    addType(root, "LsDirectoryTreeNode", [
        { id: 1, name: "abs_path", type: "string" },
        { id: 2, name: "children_dirs", type: "LsDirectoryTreeNode", repeated: true },
        { id: 3, name: "children_files", type: "LsDirectoryTreeFile", repeated: true },
        { id: 6, name: "num_files", type: "int32" },
    ]);
    addType(root, "LsSuccess", [
        { id: 1, name: "directory_tree_root", type: "LsDirectoryTreeNode" },
    ]);
    addType(root, "LsError", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "LsResult", [
        { id: 1, name: "success", type: "LsSuccess" },
        { id: 2, name: "error", type: "LsError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "ShellArgs", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "timeout", type: "uint32" },
        { id: 4, name: "tool_call_id", type: "string" },
        // Canonical agent.v1 fields used by the native CLI to distinguish a
        // foreground cancellation deadline from a soft background handoff.
        { id: 13, name: "timeout_behavior", type: "uint32" },
        { id: 14, name: "hard_timeout", type: "uint32" },
    ]);
    addType(root, "ShellStreamStart", []); // optional SandboxPolicy only; empty is valid
    addType(root, "ShellStreamStdout", [{ id: 1, name: "data", type: "string" }]);
    addType(root, "ShellStreamStderr", [{ id: 1, name: "data", type: "string" }]);
    // agent.v1: code is uint32; protobufjs must emit code=0 (defaults are load-bearing).
    addType(root, "ShellStreamExit", [
        { id: 1, name: "code", type: "uint32" },
        { id: 2, name: "cwd", type: "string" },
        { id: 4, name: "aborted", type: "bool" },
        { id: 5, name: "abort_reason", type: "uint32" },
        { id: 6, name: "local_execution_time_ms", type: "uint32" },
    ]);
    addType(root, "ShellStreamBackgrounded", [
        { id: 1, name: "shell_id", type: "uint32" },
        { id: 2, name: "command", type: "string" },
        { id: 3, name: "working_directory", type: "string" },
        { id: 4, name: "pid", type: "uint32" },
        { id: 5, name: "ms_to_wait", type: "uint32" },
        { id: 6, name: "reason", type: "uint32" },
    ]);
    // ShellRejected / ShellPermissionDenied (shared with ShellResult) — reason/error at #3.
    addType(root, "ShellRejected", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "reason", type: "string" },
    ]);
    addType(root, "ShellPermissionDenied", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "error", type: "string" },
    ]);
    // ── Soft-deny stubs for known unsupported Cursor-native exec variants ──
    // These are encode-only: enough to emit a populated deny, not full success.
    // Canonical field numbers from agent.proto ExecClientMessage.
    // ShellResult is also the live reply for exec #2 shell_args (OpenCode bash).
    addType(root, "ShellSuccess", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "exit_code", type: "int32" },
        { id: 4, name: "signal", type: "string" },
        { id: 5, name: "stdout", type: "string" },
        { id: 6, name: "stderr", type: "string" },
        { id: 7, name: "execution_time", type: "int32" },
        { id: 9, name: "shell_id", type: "uint32" },
        { id: 11, name: "pid", type: "uint32" },
        { id: 12, name: "ms_to_wait", type: "int32" },
        { id: 13, name: "local_execution_time_ms", type: "int32" },
        { id: 14, name: "background_reason", type: "uint32" },
    ]);
    addType(root, "ShellFailure", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "exit_code", type: "int32" },
        { id: 4, name: "signal", type: "string" },
        { id: 5, name: "stdout", type: "string" },
        { id: 6, name: "stderr", type: "string" },
        { id: 7, name: "execution_time", type: "int32" },
        { id: 10, name: "abort_reason", type: "uint32" },
        { id: 11, name: "aborted", type: "bool" },
    ]);
    addType(root, "ShellTimeout", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "timeout_ms", type: "int32" },
    ]);
    addType(root, "ShellResult", [
        { id: 1, name: "success", type: "ShellSuccess" },
        { id: 2, name: "failure", type: "ShellFailure" },
        { id: 3, name: "timeout", type: "ShellTimeout" },
        { id: 4, name: "rejected", type: "ShellRejected" },
        { id: 102, name: "is_background", type: "bool" },
        { id: 104, name: "pid", type: "uint32" },
    ], [{ name: "result", fields: ["success", "failure", "timeout", "rejected"] }]);
    addType(root, "DiagnosticsError", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "DiagnosticsResult", [
        { id: 2, name: "error", type: "DiagnosticsError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "FetchError", [
        { id: 1, name: "url", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "FetchResult", [
        { id: 2, name: "error", type: "FetchError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "RecordScreenFailure", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "RecordScreenResult", [
        { id: 4, name: "failure", type: "RecordScreenFailure" },
    ], [{ name: "result", fields: ["failure"] }]);
    addType(root, "ComputerUseError", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "ComputerUseResult", [
        { id: 2, name: "error", type: "ComputerUseError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "WriteShellStdinError", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "WriteShellStdinResult", [
        { id: 2, name: "error", type: "WriteShellStdinError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "SubagentAwaitError", [
        { id: 1, name: "agent_id", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "SubagentAwaitResult", [
        { id: 4, name: "error", type: "SubagentAwaitError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "SmartModeClassifierError", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "SmartModeClassifierResult", [
        { id: 2, name: "error", type: "SmartModeClassifierError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "CanvasDiagnosticsError", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "CanvasDiagnosticsResult", [
        { id: 2, name: "error", type: "CanvasDiagnosticsError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "ShellAllowlistPrecheckResult", [
        { id: 1, name: "allowlisted", type: "bool" },
    ]);
    addType(root, "McpAllowlistPrecheckResult", [
        { id: 1, name: "allowlisted", type: "bool" },
    ]);
    addType(root, "WebFetchAllowlistPrecheckResult", [
        { id: 1, name: "allowlisted", type: "bool" },
    ]);
    addType(root, "ForceBackgroundShellResult", [
        { id: 1, name: "status", type: "uint32" },
    ]);
    addType(root, "ForceBackgroundSubagentResult", [
        { id: 1, name: "status", type: "uint32" },
    ]);
    addType(root, "ConversationSearchHit", [
        { id: 1, name: "conversation_id", type: "string" },
        { id: 2, name: "title", type: "string" },
        { id: 3, name: "source", type: "uint32" },
        { id: 4, name: "updated_at_ms", type: "int64" },
        { id: 5, name: "snippet", type: "string" },
    ]);
    addType(root, "ConversationSearchSuccess", [
        { id: 1, name: "hits", type: "ConversationSearchHit", repeated: true },
        { id: 2, name: "truncated", type: "bool" },
        { id: 3, name: "partial", type: "bool" },
        { id: 4, name: "rebuilding", type: "bool" },
    ]);
    addType(root, "ConversationSearchError", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "ConversationSearchResult", [
        { id: 1, name: "success", type: "ConversationSearchSuccess" },
        { id: 2, name: "error", type: "ConversationSearchError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "AgentStoreConflictError", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "AgentStoreConflictResult", [
        { id: 2, name: "error", type: "AgentStoreConflictError" },
    ], [{ name: "result", fields: ["error"] }]);
    addType(root, "AdoptResult", [
        { id: 1, name: "source_agent_id", type: "string" },
        { id: 2, name: "target_agent_id", type: "string" },
        { id: 3, name: "project_root_id", type: "string" },
        { id: 5, name: "error", type: "string" },
    ], [{ name: "result", fields: ["error"] }]);
    // aiserver.v1.GetDiffRequest / GetDiffResponse (exec #44). Enums as uint32
    // so protobufjs json decode does not stringify output_format / diff_type.
    addType(root, "GitDiffChunk", [
        { id: 1, name: "content", type: "string" },
        { id: 2, name: "lines", type: "string", repeated: true },
        { id: 3, name: "old_start", type: "int32" },
        { id: 4, name: "old_lines", type: "int32" },
        { id: 5, name: "new_start", type: "int32" },
        { id: 6, name: "new_lines", type: "int32" },
    ]);
    addType(root, "GitFileDiff", [
        { id: 1, name: "from", type: "string" },
        { id: 2, name: "to", type: "string" },
        { id: 3, name: "chunks", type: "GitDiffChunk", repeated: true },
        { id: 4, name: "added", type: "int32" },
        { id: 5, name: "removed", type: "int32" },
        { id: 6, name: "before_file_contents", type: "string" },
        { id: 7, name: "after_file_contents", type: "string" },
        { id: 8, name: "is_generated", type: "bool" },
    ]);
    addType(root, "GitDiff", [
        { id: 1, name: "diffs", type: "GitFileDiff", repeated: true },
        { id: 2, name: "diff_type", type: "uint32" },
    ]);
    addType(root, "GitDiffSubmoduleDiff", [
        { id: 1, name: "relative_path", type: "string" },
        { id: 2, name: "diff", type: "GitDiff" },
        { id: 3, name: "errored", type: "bool" },
    ]);
    addType(root, "GetDiffRequest", [
        { id: 1, name: "cwd", type: "string" },
        { id: 2, name: "ref", type: "string" },
        { id: 3, name: "base_ref", type: "string" },
        { id: 4, name: "merge_base", type: "bool" },
        { id: 5, name: "target_paths", type: "string", repeated: true },
        { id: 6, name: "unified_context_lines", type: "int32" },
        { id: 7, name: "max_untracked_files", type: "int32" },
        { id: 8, name: "output_format", type: "uint32" },
        { id: 9, name: "submodule_recurse_depth", type: "int32" },
        { id: 10, name: "include_space_changes", type: "bool" },
        { id: 11, name: "committed_only", type: "bool" },
        { id: 12, name: "compute_patch_id", type: "bool" },
        { id: 13, name: "return_head_sha", type: "bool" },
        { id: 14, name: "max_response_bytes", type: "int32" },
    ]);
    addType(root, "GetDiffResponse", [
        { id: 1, name: "diff", type: "GitDiff" },
        { id: 2, name: "submodule_diffs", type: "GitDiffSubmoduleDiff", repeated: true },
        { id: 3, name: "patch_id", type: "string" },
        { id: 4, name: "head_sha", type: "string" },
        { id: 5, name: "has_uncommitted_changes", type: "bool" },
    ]);
    // Cursor's non-blocking shell path is a separate exec variant from the
    // foreground ShellStream above. The host only needs the fields used at the
    // OpenCode boundary; protobufjs safely skips the richer classifier/approval
    // messages that are private to Cursor's native client.
    addType(root, "BackgroundShellSpawnArgs", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "tool_call_id", type: "string" },
        { id: 6, name: "enable_write_shell_stdin_tool", type: "bool" },
        { id: 7, name: "description", type: "string" },
        { id: 12, name: "skip_approval", type: "bool" },
        { id: 13, name: "conversation_id", type: "string" },
    ]);
    addType(root, "BackgroundShellSpawnSuccess", [
        { id: 1, name: "shell_id", type: "uint32" },
        { id: 2, name: "command", type: "string" },
        { id: 3, name: "working_directory", type: "string" },
        { id: 4, name: "pid", type: "uint32" },
    ]);
    addType(root, "BackgroundShellSpawnError", [
        { id: 1, name: "command", type: "string" },
        { id: 2, name: "working_directory", type: "string" },
        { id: 3, name: "error", type: "string" },
    ]);
    addType(root, "BackgroundShellSpawnResult", [
        { id: 1, name: "success", type: "BackgroundShellSpawnSuccess" },
        { id: 2, name: "error", type: "BackgroundShellSpawnError" },
        { id: 3, name: "rejected", type: "ShellRejected" },
        { id: 4, name: "permission_denied", type: "ShellPermissionDenied" },
    ], [{ name: "result", fields: ["success", "error", "rejected", "permission_denied"] }]);
    addType(root, "ShellStream", [
        { id: 1, name: "stdout", type: "ShellStreamStdout" },
        { id: 2, name: "stderr", type: "ShellStreamStderr" },
        { id: 3, name: "exit", type: "ShellStreamExit" },
        { id: 4, name: "start", type: "ShellStreamStart" },
        { id: 5, name: "rejected", type: "ShellRejected" },
        { id: 6, name: "permission_denied", type: "ShellPermissionDenied" },
        { id: 7, name: "backgrounded", type: "ShellStreamBackgrounded" },
    ], [{ name: "event", fields: ["stdout", "stderr", "exit", "start", "rejected", "permission_denied", "backgrounded"] }]);
    addType(root, "GlobArgs", [
        { id: 1, name: "target_directory", type: "string" },
        { id: 2, name: "glob_pattern", type: "string" },
    ]);
    addType(root, "GlobResult", [
        { id: 1, name: "files", type: "string", repeated: true },
        { id: 2, name: "error", type: "string" },
    ]);
    // `args` is a map<string, google.protobuf.Value> on the wire (repeated map
    // entries at field #2). We capture each entry as raw bytes and decode them in
    // tools.ts via struct.decodeStructEntriesToJson.
    addType(root, "McpArgs", [
        { id: 1, name: "name", type: "string" },
        { id: 2, name: "args", type: "bytes", repeated: true },
        { id: 3, name: "tool_call_id", type: "string" },
        { id: 4, name: "provider_identifier", type: "string" },
        { id: 5, name: "tool_name", type: "string" },
    ]);
    addType(root, "McpTextContent", [{ id: 1, name: "text", type: "string" }]);
    // Cursor CLI 2026.10.01 `agent/v1/mcp_exec_pb.js`: "McpImageContent|1 data 12|2 mime_type 9",
    // "McpToolResultContentItem|1 text #0 content|2 image #1 content".
    addType(root, "McpImageContent", [
        { id: 1, name: "data", type: "bytes" },
        { id: 2, name: "mime_type", type: "string" },
    ]);
    addType(root, "McpToolResultContentItem", [
        { id: 1, name: "text", type: "McpTextContent" },
        { id: 2, name: "image", type: "McpImageContent" },
    ], [{ name: "content", fields: ["text", "image"] }]);
    addType(root, "McpSuccess", [
        { id: 1, name: "content", type: "McpToolResultContentItem", repeated: true },
        { id: 2, name: "is_error", type: "bool" },
    ]);
    addType(root, "McpError", [
        { id: 1, name: "error", type: "string" },
        // Server-side CallDynamicTool validation uses a title (#1) and detail (#2).
        { id: 2, name: "detail", type: "string" },
    ]);
    addType(root, "McpResult", [
        { id: 1, name: "success", type: "McpSuccess" },
        { id: 2, name: "error", type: "McpError" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    // McpToolDefinition — agent.v1 shape for RequestContext.tools (#7) and
    // AgentRunRequest.mcp_tools (#4). Defined early so RequestContext* can
    // reference it.
    addType(root, "McpToolDefinition", [
        { id: 1, name: "name", type: "string" },
        { id: 2, name: "description", type: "string" },
        { id: 3, name: "input_schema", type: "bytes" },
        { id: 4, name: "provider_identifier", type: "string" },
        { id: 5, name: "tool_name", type: "string" },
    ]);
    // ── MCP resource exec (fields 17/18) ──
    // agent.v1 ListMcpResourcesExecArgs/Result, ReadMcpResourceExecArgs/Result.
    // Native Cursor exec variants: no descriptor, no advertisement, and Cursor
    // may emit either unsolicited regardless of what this provider advertises
    // (tasks/plans/fix-cursor-mcp-resource-exec.md, Correction 2). Under Option
    // B, list_mcp_resources/read_mcp_resource execute through the ordinary
    // field-11 MCP path via the alias rules below, so any 17/18 that still
    // reaches this provider gets the total fallback built in tools.ts.
    addType(root, "SmartModeApproval", [
        { id: 1, name: "request_id", type: "string" },
        { id: 2, name: "reason", type: "string" },
    ]);
    addType(root, "OutputLocation", [
        { id: 1, name: "file_path", type: "string" },
        { id: 2, name: "size_bytes", type: "int64" },
        { id: 3, name: "line_count", type: "int64" },
    ]);
    addType(root, "ListMcpResourcesExecArgs", [
        { id: 1, name: "server", type: "string" },
    ]);
    {
        const t = new protobuf.Type("ListMcpResourcesExecResult_McpResource");
        t.add(new protobuf.Field("uri", 1, "string"));
        t.add(new protobuf.Field("name", 2, "string"));
        t.add(new protobuf.Field("description", 3, "string"));
        t.add(new protobuf.Field("mime_type", 4, "string"));
        t.add(new protobuf.Field("server", 5, "string"));
        t.add(new protobuf.MapField("annotations", 6, "string", "string"));
        root.add(t);
    }
    addType(root, "ListMcpResourcesSuccess", [
        { id: 1, name: "resources", type: "ListMcpResourcesExecResult_McpResource", repeated: true },
    ]);
    addType(root, "ListMcpResourcesError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "ListMcpResourcesRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "ListMcpResourcesExecResult", [
        { id: 1, name: "success", type: "ListMcpResourcesSuccess" },
        { id: 2, name: "error", type: "ListMcpResourcesError" },
        { id: 3, name: "rejected", type: "ListMcpResourcesRejected" },
    ], [{ name: "result", fields: ["success", "error", "rejected"] }]);
    addType(root, "ReadMcpResourceExecArgs", [
        { id: 1, name: "server", type: "string" },
        { id: 2, name: "uri", type: "string" },
        { id: 3, name: "download_path", type: "string" },
        { id: 4, name: "tool_call_id", type: "string" },
        { id: 5, name: "smart_mode_approval", type: "SmartModeApproval" },
    ]);
    {
        // Interleaved field order matches agent.proto exactly: the text/blob oneof
        // (5/6) sits between the shared metadata (1-4) and the trailing
        // annotations/download/output fields (7-9).
        const t = new protobuf.Type("ReadMcpResourceSuccess");
        t.add(new protobuf.Field("uri", 1, "string"));
        t.add(new protobuf.Field("name", 2, "string"));
        t.add(new protobuf.Field("description", 3, "string"));
        t.add(new protobuf.Field("mime_type", 4, "string"));
        t.add(new protobuf.Field("text", 5, "string"));
        t.add(new protobuf.Field("blob", 6, "bytes"));
        t.add(new protobuf.MapField("annotations", 7, "string", "string"));
        t.add(new protobuf.Field("download_path", 8, "string"));
        t.add(new protobuf.Field("output_location", 9, "OutputLocation"));
        t.add(new protobuf.OneOf("content", ["text", "blob"]));
        root.add(t);
    }
    addType(root, "ReadMcpResourceError", [
        { id: 1, name: "uri", type: "string" },
        { id: 2, name: "error", type: "string" },
    ]);
    // Cursor quirk: on `rejected` only `reason` is set — `uri` (field 1) is
    // deliberately left empty. Mirror this; do not backfill uri on encode.
    addType(root, "ReadMcpResourceRejected", [
        { id: 1, name: "uri", type: "string" },
        { id: 2, name: "reason", type: "string" },
    ]);
    addType(root, "ReadMcpResourceNotFound", [{ id: 1, name: "uri", type: "string" }]);
    addType(root, "ReadMcpResourceExecResult", [
        { id: 1, name: "success", type: "ReadMcpResourceSuccess" },
        { id: 2, name: "error", type: "ReadMcpResourceError" },
        { id: 3, name: "rejected", type: "ReadMcpResourceRejected" },
        { id: 4, name: "not_found", type: "ReadMcpResourceNotFound" },
    ], [{ name: "result", fields: ["success", "error", "rejected", "not_found"] }]);
    // ── request_context (#10): server-initiated setup probe ──
    // At the start of an agent turn the server sends ExecServerMessage
    // {request_context_args} to ask the client for workspace/env/tool context.
    // The reply is ExecClientMessage {request_context_result{success{request_context}}}.
    // If we don't reply, the server blocks on heartbeats forever (the "times out,
    // no response" symptom). We populate a minimal-but-real RequestContext — env
    // (workspace/shell/os) plus the tool list echoed into #7 tools (same
    // McpToolDefinition shape as AgentRunRequest #4 mcp_tools) so the model keeps
    // the tools opencode advertised.
    addType(root, "RequestContextArgs", [
        { id: 2, name: "notes_session_id", type: "string" },
        { id: 3, name: "workspace_id", type: "string" },
        { id: 7, name: "use_cached", type: "bool" },
    ]);
    addType(root, "RequestContextEnv", [
        { id: 1, name: "os_version", type: "string" },
        { id: 2, name: "workspace_paths", type: "string", repeated: true },
        { id: 3, name: "shell", type: "string" },
        { id: 5, name: "sandbox_enabled", type: "bool" },
        { id: 7, name: "terminals_folder", type: "string" },
        { id: 10, name: "time_zone", type: "string" },
        { id: 11, name: "project_folder", type: "string" },
        { id: 12, name: "agent_transcripts_folder", type: "string" },
        { id: 14, name: "sandbox_supported", type: "bool" },
        { id: 20, name: "is_working_dir_home_dir", type: "bool" },
        { id: 21, name: "process_working_directory", type: "string" },
    ]);
    // Cursor applies a rule by its type: `global` is the CLI's `alwaysApply: true`
    // (its AGENTS.md / CLAUDE.md default). An untyped rule is only attachable on
    // request, so its content never reaches the model on its own.
    addType(root, "CursorRuleTypeGlobal", []);
    addType(root, "CursorRuleTypeFileGlobs", [
        { id: 1, name: "globs", type: "string", repeated: true },
    ]);
    addType(root, "CursorRuleTypeAgentFetched", [
        { id: 1, name: "description", type: "string" },
    ]);
    addType(root, "CursorRuleTypeManuallyAttached", []);
    addType(root, "CursorRuleType", [
        { id: 1, name: "global", type: "CursorRuleTypeGlobal" },
        { id: 2, name: "file_globbed", type: "CursorRuleTypeFileGlobs" },
        { id: 3, name: "agent_fetched", type: "CursorRuleTypeAgentFetched" },
        { id: 4, name: "manually_attached", type: "CursorRuleTypeManuallyAttached" },
    ], [{ name: "type", fields: ["global", "file_globbed", "agent_fetched", "manually_attached"] }]);
    addType(root, "CursorRule", [
        { id: 1, name: "full_path", type: "string" },
        { id: 2, name: "content", type: "string" },
        { id: 3, name: "type", type: "CursorRuleType" },
    ]);
    addType(root, "RepositoryIndexingInfo", [
        { id: 1, name: "relative_workspace_path", type: "string" },
        { id: 2, name: "remote_urls", type: "string", repeated: true },
        { id: 3, name: "remote_names", type: "string", repeated: true },
        { id: 4, name: "repo_name", type: "string" },
        { id: 5, name: "repo_owner", type: "string" },
        { id: 6, name: "is_tracked", type: "bool" },
        { id: 7, name: "is_local", type: "bool" },
        { id: 9, name: "workspace_uri", type: "string" },
    ]);
    addType(root, "GitRepoInfo", [
        { id: 1, name: "path", type: "string" },
        { id: 2, name: "status", type: "string" },
        { id: 3, name: "branch_name", type: "string" },
        { id: 4, name: "remote_url", type: "string" },
    ]);
    addType(root, "AgentSkill", [
        { id: 1, name: "full_path", type: "string" },
        { id: 2, name: "content", type: "string" },
        { id: 3, name: "description", type: "string" },
    ]);
    addType(root, "CustomSubagent", [
        { id: 1, name: "full_path", type: "string" },
        { id: 2, name: "name", type: "string" },
        { id: 3, name: "description", type: "string" },
        { id: 6, name: "prompt", type: "string" },
    ]);
    // Nested MCP filesystem / meta-tool shapes (agent.v1). Must be defined
    // before RequestContextPayload / RequestContext reference them.
    addType(root, "McpFsToolDescriptor", [
        { id: 1, name: "tool_name", type: "string" },
        { id: 3, name: "description", type: "string" },
        { id: 4, name: "input_schema", type: "bytes" },
    ]);
    addType(root, "McpDescriptor", [
        { id: 1, name: "server_name", type: "string" },
        { id: 2, name: "server_identifier", type: "string" },
        { id: 5, name: "tools", type: "McpFsToolDescriptor", repeated: true },
    ]);
    addType(root, "McpFileSystemOptions", [
        { id: 1, name: "enabled", type: "bool" },
        { id: 2, name: "workspace_project_dir", type: "string" },
        { id: 3, name: "mcp_descriptors", type: "McpDescriptor", repeated: true },
    ]);
    addType(root, "McpMetaToolOptions", [
        { id: 1, name: "enabled", type: "bool" },
        { id: 2, name: "mcp_descriptors", type: "McpDescriptor", repeated: true },
    ]);
    addType(root, "PermissionsAutoRunInstructions", [
        { id: 1, name: "allow_instructions", type: "string", repeated: true },
        { id: 2, name: "block_instructions", type: "string", repeated: true },
    ]);
    addType(root, "RequestContextPayload", [
        { id: 2, name: "rules", type: "CursorRule", repeated: true },
        { id: 4, name: "env", type: "RequestContextEnv" },
        { id: 6, name: "repository_info", type: "RepositoryIndexingInfo", repeated: true },
        { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
        { id: 11, name: "git_repos", type: "GitRepoInfo", repeated: true },
        { id: 13, name: "project_layouts", type: "LsDirectoryTreeNode", repeated: true },
        { id: 17, name: "web_search_enabled", type: "bool" },
        { id: 22, name: "custom_subagents", type: "CustomSubagent", repeated: true },
        { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
        { id: 24, name: "web_fetch_enabled", type: "bool" },
        { id: 25, name: "hooks_additional_context", type: "string" },
        { id: 29, name: "agent_skills", type: "AgentSkill", repeated: true },
        { id: 33, name: "git_repo_info_complete", type: "bool" },
        { id: 34, name: "mcp_meta_tool_options", type: "McpMetaToolOptions" },
        { id: 36, name: "mcp_info_complete", type: "bool" },
        { id: 39, name: "rules_info_complete", type: "bool" },
        { id: 40, name: "env_info_complete", type: "bool" },
        { id: 41, name: "repository_info_complete", type: "bool" },
        { id: 42, name: "custom_subagents_info_complete", type: "bool" },
        { id: 43, name: "agent_skills_info_complete", type: "bool" },
        { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
        { id: 45, name: "git_status_info_complete", type: "bool" },
        { id: 46, name: "user_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
        { id: 47, name: "project_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
    ]);
    addType(root, "RequestContextSuccess", [
        { id: 1, name: "request_context", type: "RequestContextPayload" },
    ]);
    addType(root, "RequestContextResult", [
        { id: 1, name: "success", type: "RequestContextSuccess" },
    ]);
    // Cursor probes MCP server availability before emitting an MCP-backed tool
    // call. OpenCode owns those servers, so answer from the live host catalog
    // rather than surfacing this as a user tool.
    addType(root, "McpStateExecArgs", [
        { id: 1, name: "server_identifiers", type: "string", repeated: true },
        { id: 2, name: "kick_only", type: "bool" },
    ]);
    addType(root, "McpInstructions", [
        { id: 1, name: "server_name", type: "string" },
        { id: 2, name: "instructions", type: "string" },
        { id: 3, name: "server_identifier", type: "string" },
    ]);
    addType(root, "McpStateServer", [
        { id: 1, name: "server_name", type: "string" },
        { id: 2, name: "server_identifier", type: "string" },
        { id: 3, name: "plugin", type: "string" },
        { id: 4, name: "marketplace", type: "string" },
        // Unlike McpDescriptor (#23/#34), exec #36 returns the full canonical
        // McpToolDefinition shape, including composite name and provider identity.
        { id: 5, name: "tools", type: "McpToolDefinition", repeated: true },
        { id: 6, name: "instructions", type: "McpInstructions", repeated: true },
        { id: 7, name: "status", type: "string" },
    ]);
    addType(root, "McpStateSuccess", [
        { id: 1, name: "servers", type: "McpStateServer", repeated: true },
    ]);
    addType(root, "McpStateError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "McpStateRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "McpStateExecResult", [
        { id: 1, name: "success", type: "McpStateSuccess" },
        { id: 2, name: "error", type: "McpStateError" },
        { id: 3, name: "rejected", type: "McpStateRejected" },
    ], [{ name: "result", fields: ["success", "error", "rejected"] }]);
    // ExecServerMessage — server asks us to execute a tool
    addType(root, "ExecServerMessage", [
        { id: 1, name: "id", type: "uint32" },
        { id: 15, name: "exec_id", type: "string" },
        { id: 19, name: "span", type: "string" },
        { id: 2, name: "shell_args", type: "ShellArgs" },
        { id: 3, name: "write_args", type: "WriteArgs" },
        { id: 4, name: "delete_args", type: "DeleteArgs" },
        { id: 5, name: "grep_args", type: "GrepArgs" },
        { id: 7, name: "read_args", type: "ReadArgs" },
        { id: 8, name: "ls_args", type: "LsArgs" },
        { id: 10, name: "request_context_args", type: "RequestContextArgs" },
        { id: 11, name: "mcp_args", type: "McpArgs" },
        { id: 14, name: "shell_stream_args", type: "ShellArgs" },
        { id: 16, name: "background_shell_spawn_args", type: "BackgroundShellSpawnArgs" },
        { id: 17, name: "list_mcp_resources_exec_args", type: "ListMcpResourcesExecArgs" },
        { id: 18, name: "read_mcp_resource_exec_args", type: "ReadMcpResourceExecArgs" },
        { id: 28, name: "subagent_args", type: "SubagentArgs" },
        { id: 36, name: "mcp_state_exec_args", type: "McpStateExecArgs" },
        { id: 44, name: "git_diff_request", type: "GetDiffRequest" },
        { id: 45, name: "pi_read_args", type: "PiReadToolArgs" },
        { id: 46, name: "pi_bash_args", type: "PiBashToolArgs" },
        { id: 47, name: "pi_edit_args", type: "PiEditToolArgs" },
        { id: 48, name: "pi_write_args", type: "PiWriteArgs" },
        { id: 49, name: "pi_grep_args", type: "PiGrepToolArgs" },
        { id: 50, name: "pi_find_args", type: "PiFindToolArgs" },
        { id: 51, name: "pi_ls_args", type: "PiLsToolArgs" },
    ], [{ name: "args", fields: [
                "shell_args", "write_args", "delete_args", "grep_args", "read_args", "ls_args",
                "request_context_args", "mcp_args", "shell_stream_args", "background_shell_spawn_args",
                "list_mcp_resources_exec_args", "read_mcp_resource_exec_args", "mcp_state_exec_args",
                "subagent_args", "git_diff_request",
                "pi_read_args", "pi_bash_args", "pi_edit_args", "pi_write_args",
                "pi_grep_args", "pi_find_args", "pi_ls_args",
            ] }]);
    // ExecClientMessage — client sends tool result back
    addType(root, "ExecClientMessage", [
        { id: 1, name: "id", type: "uint32" },
        { id: 15, name: "exec_id", type: "string" },
        { id: 39, name: "local_execution_time_ms", type: "uint64" },
        { id: 2, name: "shell_result", type: "ShellResult" },
        { id: 3, name: "write_result", type: "WriteResult" },
        { id: 4, name: "delete_result", type: "DeleteResult" },
        { id: 5, name: "grep_result", type: "GrepResult" },
        { id: 7, name: "read_result", type: "ReadResult" },
        { id: 8, name: "ls_result", type: "LsResult" },
        { id: 9, name: "diagnostics_result", type: "DiagnosticsResult" },
        { id: 10, name: "request_context_result", type: "RequestContextResult" },
        { id: 11, name: "mcp_result", type: "McpResult" },
        { id: 14, name: "shell_stream", type: "ShellStream" },
        { id: 16, name: "background_shell_spawn_result", type: "BackgroundShellSpawnResult" },
        { id: 17, name: "list_mcp_resources_exec_result", type: "ListMcpResourcesExecResult" },
        { id: 18, name: "read_mcp_resource_exec_result", type: "ReadMcpResourceExecResult" },
        { id: 20, name: "fetch_result", type: "FetchResult" },
        { id: 21, name: "record_screen_result", type: "RecordScreenResult" },
        { id: 22, name: "computer_use_result", type: "ComputerUseResult" },
        { id: 23, name: "write_shell_stdin_result", type: "WriteShellStdinResult" },
        { id: 28, name: "subagent_result", type: "SubagentResult" },
        { id: 29, name: "redacted_read_result", type: "ReadResult" },
        { id: 30, name: "force_background_shell_result", type: "ForceBackgroundShellResult" },
        { id: 31, name: "force_background_subagent_result", type: "ForceBackgroundSubagentResult" },
        { id: 36, name: "mcp_state_exec_result", type: "McpStateExecResult" },
        { id: 37, name: "subagent_await_result", type: "SubagentAwaitResult" },
        { id: 38, name: "smart_mode_classifier_result", type: "SmartModeClassifierResult" },
        { id: 40, name: "canvas_diagnostics_result", type: "CanvasDiagnosticsResult" },
        { id: 41, name: "shell_allowlist_precheck_result", type: "ShellAllowlistPrecheckResult" },
        { id: 42, name: "mcp_allowlist_precheck_result", type: "McpAllowlistPrecheckResult" },
        { id: 43, name: "web_fetch_allowlist_precheck_result", type: "WebFetchAllowlistPrecheckResult" },
        { id: 44, name: "git_diff_response", type: "GetDiffResponse" },
        { id: 46, name: "pi_read_result", type: "PiReadExecResult" },
        { id: 47, name: "pi_bash_result", type: "PiBashExecResult" },
        { id: 48, name: "pi_edit_result", type: "PiEditExecResult" },
        { id: 49, name: "pi_write_result", type: "PiWriteResult" },
        { id: 50, name: "pi_grep_result", type: "PiGrepExecResult" },
        { id: 51, name: "pi_find_result", type: "PiFindExecResult" },
        { id: 52, name: "pi_ls_result", type: "PiLsExecResult" },
        { id: 53, name: "conversation_search_result", type: "ConversationSearchResult" },
        { id: 54, name: "agent_store_conflict_result", type: "AgentStoreConflictResult" },
        { id: 55, name: "mini_swe_agent_bash_result", type: "ShellResult" },
        { id: 56, name: "adopt_result", type: "AdoptResult" },
    ], [{ name: "result", fields: [
                "shell_result", "write_result", "delete_result", "grep_result", "read_result", "ls_result",
                "diagnostics_result", "request_context_result", "mcp_result", "shell_stream", "background_shell_spawn_result",
                "list_mcp_resources_exec_result", "read_mcp_resource_exec_result",
                "fetch_result", "record_screen_result", "computer_use_result", "write_shell_stdin_result",
                "subagent_result", "redacted_read_result",
                "force_background_shell_result", "force_background_subagent_result",
                "mcp_state_exec_result",
                "subagent_await_result", "smart_mode_classifier_result", "canvas_diagnostics_result",
                "shell_allowlist_precheck_result", "mcp_allowlist_precheck_result", "web_fetch_allowlist_precheck_result",
                "git_diff_response",
                "pi_read_result", "pi_bash_result", "pi_edit_result", "pi_write_result",
                "pi_grep_result", "pi_find_result", "pi_ls_result",
                "conversation_search_result", "agent_store_conflict_result",
                "mini_swe_agent_bash_result", "adopt_result",
            ] }]);
    addType(root, "ExecServerControlMessage", [
        { id: 1, name: "abort", type: "ExecServerAbort" },
    ]);
    addType(root, "ExecServerAbort", [
        { id: 1, name: "id", type: "uint32" },
    ]);
    // Client→server control (ACM #5). Distinct from ExecServerControlMessage (ASM #5).
    // After every exec result (especially multi-frame shell_stream), the real CLI
    // sends stream_close{id} — without it the cloud waits forever on shell execs.
    addType(root, "ExecClientStreamClose", [{ id: 1, name: "id", type: "uint32" }]);
    addType(root, "ExecClientThrow", [
        { id: 1, name: "id", type: "uint32" },
        { id: 2, name: "error", type: "string" },
    ]);
    addType(root, "ExecClientHeartbeat", [{ id: 1, name: "id", type: "uint32" }]);
    addType(root, "ExecClientControlMessage", [
        { id: 1, name: "stream_close", type: "ExecClientStreamClose" },
        { id: 2, name: "throw", type: "ExecClientThrow" },
        { id: 3, name: "heartbeat", type: "ExecClientHeartbeat" },
    ], [{ name: "message", fields: ["stream_close", "throw", "heartbeat"] }]);
    // ── Run request types ──
    addType(root, "ParameterValue", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "value", type: "string" },
    ]);
    addType(root, "RequestedModel", [
        { id: 1, name: "model_id", type: "string" },
        { id: 2, name: "max_mode", type: "bool" },
        { id: 3, name: "parameters", type: "ParameterValue", repeated: true },
    ]);
    addType(root, "SelectedImageDimension", [
        { id: 1, name: "width", type: "int32" },
        { id: 2, name: "height", type: "int32" },
    ]);
    addType(root, "SelectedImageBlobIdWithData", [
        { id: 1, name: "blob_id", type: "bytes" },
        { id: 2, name: "data", type: "bytes" },
    ]);
    addType(root, "SelectedImage", [
        { id: 1, name: "blob_id", type: "bytes" },
        { id: 8, name: "data", type: "bytes" },
        { id: 9, name: "blob_id_with_data", type: "SelectedImageBlobIdWithData" },
        { id: 2, name: "uuid", type: "string" },
        { id: 3, name: "path", type: "string" },
        { id: 4, name: "dimension", type: "SelectedImageDimension" },
        { id: 7, name: "mime_type", type: "string" },
    ], [{ name: "data_or_blob_id", fields: ["blob_id", "data", "blob_id_with_data"] }]);
    addType(root, "SelectedContext", [
        { id: 1, name: "selected_images", type: "SelectedImage", repeated: true },
    ]);
    // agent.v1.AgentMode — the client's current mode, sent on every user message.
    root.add(new protobuf.Enum("AgentMode", {
        AGENT_MODE_UNSPECIFIED: 0,
        AGENT_MODE_AGENT: 1,
        AGENT_MODE_ASK: 2,
        AGENT_MODE_PLAN: 3,
        AGENT_MODE_DEBUG: 4,
        AGENT_MODE_TRIAGE: 5,
        AGENT_MODE_PROJECT: 6,
        AGENT_MODE_MULTITASK: 7,
        AGENT_MODE_CUSTOM: 8,
    }));
    addType(root, "UserMessage", [
        { id: 1, name: "text", type: "string" },
        { id: 2, name: "message_id", type: "string" },
        { id: 3, name: "selected_context", type: "SelectedContext" },
        { id: 4, name: "mode", type: "AgentMode" },
    ]);
    // RequestContext — UserMessageAction #2. Slim mcp_meta_tool_options names
    // the advertised catalog; AgentRunRequest.mcp_tools (#4) is empty on real turns.
    addType(root, "RequestContext", [
        { id: 2, name: "rules", type: "CursorRule", repeated: true },
        { id: 4, name: "env", type: "RequestContextEnv" },
        { id: 6, name: "repository_info", type: "RepositoryIndexingInfo", repeated: true },
        { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
        { id: 11, name: "git_repos", type: "GitRepoInfo", repeated: true },
        { id: 13, name: "project_layouts", type: "LsDirectoryTreeNode", repeated: true },
        { id: 17, name: "web_search_enabled", type: "bool" },
        { id: 22, name: "custom_subagents", type: "CustomSubagent", repeated: true },
        { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
        { id: 24, name: "web_fetch_enabled", type: "bool" },
        { id: 25, name: "hooks_additional_context", type: "string" },
        { id: 29, name: "agent_skills", type: "AgentSkill", repeated: true },
        { id: 33, name: "git_repo_info_complete", type: "bool" },
        { id: 34, name: "mcp_meta_tool_options", type: "McpMetaToolOptions" },
        { id: 36, name: "mcp_info_complete", type: "bool" },
        { id: 39, name: "rules_info_complete", type: "bool" },
        { id: 40, name: "env_info_complete", type: "bool" },
        { id: 41, name: "repository_info_complete", type: "bool" },
        { id: 42, name: "custom_subagents_info_complete", type: "bool" },
        { id: 43, name: "agent_skills_info_complete", type: "bool" },
        { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
        { id: 45, name: "git_status_info_complete", type: "bool" },
        { id: 46, name: "user_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
        { id: 47, name: "project_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
    ]);
    addType(root, "UserMessageAction", [
        { id: 1, name: "user_message", type: "UserMessage" },
        { id: 2, name: "request_context", type: "RequestContext" },
    ]);
    addType(root, "ResumeAction", [
        // Cursor CLI sends an empty ResumeAction. Field #2 is available for a
        // refreshed RequestContext; the conversation id belongs to AgentRunRequest.
        { id: 2, name: "request_context", type: "RequestContext" },
    ]);
    addType(root, "CancelAction", [
        // Cursor CLI CancelAction field #1 is the interruption reason, not an id.
        { id: 1, name: "reason", type: "string" },
    ]);
    // Deferred answers for an AskQuestion the client already replied to with
    // `async`. `original_args` is kept as raw bytes so the exact AskQuestionArgs
    // Cursor sent — including fields this schema does not model — is echoed back
    // verbatim rather than re-encoded from a lossy decode.
    addType(root, "AsyncAskQuestionCompletionAction", [
        { id: 1, name: "original_tool_call_id", type: "string" },
        { id: 2, name: "original_args", type: "bytes" },
        { id: 3, name: "result", type: "AskQuestionResult" },
    ]);
    // Cursor CLI 2026.10.01 descriptors: system context is
    // injected into the current Run without submitting another user turn.
    addType(root, "SystemContextInjection", [
        { id: 1, name: "producer", type: "string" },
        { id: 2, name: "content", type: "string" },
    ]);
    addType(root, "InjectContextAction", [
        { id: 1, name: "injection_id", type: "string" },
        { id: 2, name: "expected_run_id", type: "string" },
        { id: 4, name: "system_context", type: "SystemContextInjection" },
    ]);
    addType(root, "ConversationAction", [
        { id: 1, name: "user_message_action", type: "UserMessageAction" },
        { id: 2, name: "resume_action", type: "ResumeAction" },
        { id: 3, name: "cancel_action", type: "CancelAction" },
        { id: 8, name: "async_ask_question_completion_action", type: "AsyncAskQuestionCompletionAction" },
        { id: 19, name: "inject_context_action", type: "InjectContextAction" },
    ], [{
            name: "action",
            fields: [
                "user_message_action",
                "resume_action",
                "cancel_action",
                "async_ask_question_completion_action",
                "inject_context_action",
            ],
        }]);
    // Seed ConversationStateStructure for turn 1 (system prompt as JSON strings
    // in #1). After the first conversation_checkpoint_update we echo opaque
    // server bytes instead — CLI's live structure uses blob-id bytes in #1/#8.
    addType(root, "AssistantMessage", [
        { id: 1, name: "text", type: "string" },
    ]);
    addType(root, "ConversationStep", [
        { id: 1, name: "assistant_message", type: "AssistantMessage" },
    ], [{ name: "message", fields: ["assistant_message"] }]);
    addType(root, "AgentConversationTurn", [
        { id: 1, name: "user_message", type: "UserMessage" },
        { id: 2, name: "steps", type: "ConversationStep", repeated: true },
    ]);
    addType(root, "ConversationTurn", [
        { id: 1, name: "agent_conversation_turn", type: "AgentConversationTurn" },
    ], [{ name: "turn", fields: ["agent_conversation_turn"] }]);
    // Cursor checkpoints carry authoritative context occupancy in field #5. The
    // provider still transports the complete checkpoint as opaque bytes; these
    // declarations support targeted diagnostics/tests without a re-encode.
    addType(root, "PromptTokenBreakdownCategory", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "label", type: "string" },
        { id: 3, name: "estimated_tokens", type: "uint32" },
        { id: 4, name: "character_count", type: "uint32" },
    ]);
    addType(root, "PromptTokenBreakdownSnapshot", [
        { id: 1, name: "total_used_tokens", type: "uint32" },
        { id: 2, name: "max_tokens", type: "uint32" },
        { id: 3, name: "categories", type: "PromptTokenBreakdownCategory", repeated: true },
    ]);
    addType(root, "ConversationTokenDetails", [
        { id: 1, name: "used_tokens", type: "uint32" },
        { id: 2, name: "max_tokens", type: "uint32" },
        { id: 3, name: "breakdown", type: "PromptTokenBreakdownSnapshot" },
    ]);
    // Seed schema (JSON strings). AgentRunRequest.conversation_state remains
    // bytes, so live checkpoints are never decoded/re-encoded on transport.
    addType(root, "ConversationStateStructure", [
        { id: 1, name: "root_prompt_messages_json", type: "string", repeated: true },
        { id: 5, name: "token_details", type: "ConversationTokenDetails" },
        { id: 8, name: "turns", type: "ConversationTurn", repeated: true },
    ]);
    addType(root, "ModelDetails", [
        { id: 1, name: "model_id", type: "string" },
    ]);
    addType(root, "McpTools", [
        { id: 1, name: "mcp_tools", type: "McpToolDefinition", repeated: true },
    ]);
    addType(root, "AgentRunRequest", [
        { id: 1, name: "conversation_state", type: "bytes" },
        { id: 2, name: "action", type: "ConversationAction" },
        { id: 4, name: "mcp_tools", type: "McpTools" },
        { id: 5, name: "conversation_id", type: "string" },
        { id: 8, name: "custom_system_prompt", type: "string" },
        { id: 9, name: "requested_model", type: "RequestedModel" },
        { id: 10, name: "unknown_flag", type: "uint32" },
        { id: 12, name: "field_12", type: "uint32" },
        { id: 14, name: "selected_subagent_models", type: "RequestedModel", repeated: true },
        { id: 16, name: "conversation_group_id", type: "string" },
        { id: 25, name: "run_id", type: "string" },
    ]);
    // ── Client heartbeat ──
    addType(root, "ClientHeartbeat", []);
    // ── Interaction query/response channel ──
    // Cursor sends UI/integration requests outside the exec tool channel. Query
    // bodies stay opaque: this headless provider only needs their id + variant
    // to return a conservative typed response on the same Run stream.
    addType(root, "InteractionQuery", [
        { id: 1, name: "id", type: "uint32" },
        { id: 2, name: "web_search_request_query", type: "bytes" },
        { id: 3, name: "ask_question_interaction_query", type: "bytes" },
        { id: 4, name: "switch_mode_request_query", type: "bytes" },
        { id: 7, name: "create_plan_request_query", type: "bytes" },
        { id: 8, name: "setup_vm_environment_args", type: "bytes" },
        { id: 9, name: "web_fetch_request_query", type: "bytes" },
        { id: 10, name: "pr_management_request_query", type: "bytes" },
        { id: 11, name: "mcp_auth_request_query", type: "bytes" },
        { id: 12, name: "generate_image_request_query", type: "bytes" },
        { id: 13, name: "replace_env_args", type: "bytes" },
        { id: 14, name: "connect_scm_request_query", type: "bytes" },
    ], [{
            name: "query",
            fields: [
                "web_search_request_query", "ask_question_interaction_query",
                "switch_mode_request_query", "create_plan_request_query",
                "setup_vm_environment_args", "web_fetch_request_query",
                "pr_management_request_query", "mcp_auth_request_query",
                "generate_image_request_query", "replace_env_args",
                "connect_scm_request_query",
            ],
        }]);
    addType(root, "WebSearchRequestApproved", []);
    addType(root, "WebSearchRequestRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "WebSearchRequestResponse", [
        { id: 1, name: "approved", type: "WebSearchRequestApproved" },
        { id: 2, name: "rejected", type: "WebSearchRequestRejected" },
    ], [{ name: "result", fields: ["approved", "rejected"] }]);
    addType(root, "AskQuestionRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "AskQuestionError", [{ id: 1, name: "error_message", type: "string" }]);
    addType(root, "AskQuestionAsync", []);
    addType(root, "AskQuestionSuccessAnswer", [
        { id: 1, name: "question_id", type: "string" },
        { id: 2, name: "selected_option_ids", type: "string", repeated: true },
        { id: 3, name: "freeform_text", type: "string" },
    ]);
    addType(root, "AskQuestionSuccess", [
        { id: 1, name: "answers", type: "AskQuestionSuccessAnswer", repeated: true },
    ]);
    addType(root, "AskQuestionResult", [
        { id: 1, name: "success", type: "AskQuestionSuccess" },
        { id: 2, name: "error", type: "AskQuestionError" },
        { id: 3, name: "rejected", type: "AskQuestionRejected" },
        { id: 4, name: "async", type: "AskQuestionAsync" },
    ], [{ name: "result", fields: ["success", "error", "rejected", "async"] }]);
    addType(root, "AskQuestionInteractionResponse", [
        { id: 1, name: "result", type: "AskQuestionResult" },
    ]);
    // InteractionQuery keeps query bodies opaque (see the InteractionQuery
    // comment); this type decodes only the ask-question body on demand.
    addType(root, "AskQuestionInteractionQuery", [
        { id: 1, name: "args", type: "AskQuestionArgs" },
        { id: 2, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "SwitchModeRequestApproved", []);
    addType(root, "SwitchModeRequestRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "SwitchModeRequestResponse", [
        { id: 1, name: "approved", type: "SwitchModeRequestApproved" },
        { id: 2, name: "rejected", type: "SwitchModeRequestRejected" },
    ], [{ name: "result", fields: ["approved", "rejected"] }]);
    // InteractionQuery keeps query bodies opaque; decoded on demand like
    // AskQuestionInteractionQuery / CreatePlanRequestQuery.
    addType(root, "SwitchModeRequestQuery", [
        { id: 1, name: "args", type: "SwitchModeToolArgs" },
    ]);
    addType(root, "CreatePlanSuccess", []);
    addType(root, "CreatePlanError", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "CreatePlanResult", [
        { id: 1, name: "success", type: "CreatePlanSuccess" },
        { id: 2, name: "error", type: "CreatePlanError" },
        { id: 3, name: "plan_uri", type: "string" },
    ], [{ name: "result", fields: ["success", "error"] }]);
    addType(root, "CreatePlanRequestResponse", [
        { id: 1, name: "result", type: "CreatePlanResult" },
    ]);
    // InteractionQuery keeps query bodies opaque; decoded on demand like
    // AskQuestionInteractionQuery / GenerateImageRequestQuery.
    addType(root, "CreatePlanRequestQuery", [
        { id: 1, name: "args", type: "CreatePlanArgs" },
        { id: 2, name: "tool_call_id", type: "string" },
    ]);
    addType(root, "SetupVmEnvironmentSuccess", []);
    addType(root, "SetupVmEnvironmentResult", [
        { id: 1, name: "success", type: "SetupVmEnvironmentSuccess" },
    ], [{ name: "result", fields: ["success"] }]);
    addType(root, "WebFetchRequestApproved", []);
    addType(root, "WebFetchRequestRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "WebFetchRequestResponse", [
        { id: 1, name: "approved", type: "WebFetchRequestApproved" },
        { id: 2, name: "rejected", type: "WebFetchRequestRejected" },
    ], [{ name: "result", fields: ["approved", "rejected"] }]);
    addType(root, "PrManagementRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "PrManagementResult", [
        { id: 3, name: "rejected", type: "PrManagementRejected" },
    ], [{ name: "result", fields: ["rejected"] }]);
    addType(root, "McpAuthRequestApproved", []);
    addType(root, "McpAuthRequestRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "McpAuthRequestResponse", [
        { id: 1, name: "approved", type: "McpAuthRequestApproved" },
        { id: 2, name: "rejected", type: "McpAuthRequestRejected" },
    ], [{ name: "result", fields: ["approved", "rejected"] }]);
    addType(root, "GenerateImageRequestApproved", [{ id: 1, name: "description", type: "string" }]);
    addType(root, "GenerateImageRequestRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "GenerateImageRequestResponse", [
        { id: 1, name: "approved", type: "GenerateImageRequestApproved" },
        { id: 2, name: "rejected", type: "GenerateImageRequestRejected" },
    ], [{ name: "result", fields: ["approved", "rejected"] }]);
    addType(root, "ReplaceEnvSuccess", []);
    addType(root, "ReplaceEnvFailure", [
        { id: 1, name: "error_message", type: "string" },
        { id: 2, name: "setup_logs", type: "string" },
    ]);
    addType(root, "ReplaceEnvResult", [
        { id: 1, name: "success", type: "ReplaceEnvSuccess" },
        { id: 2, name: "failure", type: "ReplaceEnvFailure" },
    ], [{ name: "result", fields: ["success", "failure"] }]);
    addType(root, "ConnectScmRequestApproved", []);
    addType(root, "ConnectScmRequestRejected", [{ id: 1, name: "reason", type: "string" }]);
    addType(root, "ConnectScmRequestFailed", [{ id: 1, name: "error", type: "string" }]);
    addType(root, "ConnectScmRequestResponse", [
        { id: 1, name: "approved", type: "ConnectScmRequestApproved" },
        { id: 2, name: "rejected", type: "ConnectScmRequestRejected" },
        { id: 3, name: "failed", type: "ConnectScmRequestFailed" },
    ], [{ name: "result", fields: ["approved", "rejected", "failed"] }]);
    addType(root, "InteractionResponse", [
        { id: 1, name: "id", type: "uint32" },
        { id: 2, name: "web_search_request_response", type: "WebSearchRequestResponse" },
        { id: 3, name: "ask_question_interaction_response", type: "AskQuestionInteractionResponse" },
        { id: 4, name: "switch_mode_request_response", type: "SwitchModeRequestResponse" },
        { id: 7, name: "create_plan_request_response", type: "CreatePlanRequestResponse" },
        { id: 8, name: "setup_vm_environment_result", type: "SetupVmEnvironmentResult" },
        { id: 9, name: "web_fetch_request_response", type: "WebFetchRequestResponse" },
        { id: 10, name: "pr_management_result", type: "PrManagementResult" },
        { id: 11, name: "mcp_auth_request_response", type: "McpAuthRequestResponse" },
        { id: 12, name: "generate_image_request_response", type: "GenerateImageRequestResponse" },
        { id: 13, name: "replace_env_result", type: "ReplaceEnvResult" },
        { id: 14, name: "connect_scm_request_response", type: "ConnectScmRequestResponse" },
    ], [{
            name: "result",
            fields: [
                "web_search_request_response", "ask_question_interaction_response",
                "switch_mode_request_response", "create_plan_request_response",
                "setup_vm_environment_result", "web_fetch_request_response",
                "pr_management_result", "mcp_auth_request_response",
                "generate_image_request_response", "replace_env_result",
                "connect_scm_request_response",
            ],
        }]);
    // ── KV blob store (cursor moves large payloads out-of-band via this channel) ──
    // Server sends KvServerMessage (AgentServerMessage #4); client MUST reply with
    // KvClientMessage (AgentClientMessage #3) on the same Run stream, echoing `id`.
    // If we don't ack set_blob / answer get_blob, the server hangs (endless
    // heartbeats, no response) — this was the "no response" root cause.
    addType(root, "GetBlobArgs", [
        { id: 1, name: "blob_id", type: "bytes" },
    ]);
    addType(root, "GetBlobResult", [
        { id: 1, name: "blob_data", type: "bytes" },
    ]);
    addType(root, "SetBlobArgs", [
        { id: 1, name: "blob_id", type: "bytes" },
        { id: 2, name: "blob_data", type: "bytes" },
    ]);
    addType(root, "SetBlobResult", [
        { id: 1, name: "error", type: "string" },
    ]);
    addType(root, "KvServerMessage", [
        { id: 1, name: "id", type: "uint32" },
        { id: 2, name: "get_blob_args", type: "GetBlobArgs" },
        { id: 3, name: "set_blob_args", type: "SetBlobArgs" },
    ], [{ name: "message", fields: ["get_blob_args", "set_blob_args"] }]);
    addType(root, "KvClientMessage", [
        { id: 1, name: "id", type: "uint32" },
        { id: 2, name: "get_blob_result", type: "GetBlobResult" },
        { id: 3, name: "set_blob_result", type: "SetBlobResult" },
    ], [{ name: "message", fields: ["get_blob_result", "set_blob_result"] }]);
    // ── AgentClientMessage ──
    addType(root, "AgentClientMessage", [
        { id: 1, name: "run_request", type: "AgentRunRequest" },
        { id: 2, name: "exec_client_message", type: "ExecClientMessage" },
        { id: 3, name: "kv_client_message", type: "KvClientMessage" },
        { id: 4, name: "conversation_action", type: "ConversationAction" },
        { id: 5, name: "exec_client_control_message", type: "ExecClientControlMessage" },
        { id: 6, name: "interaction_response", type: "InteractionResponse" },
        { id: 7, name: "client_heartbeat", type: "ClientHeartbeat" },
    ], [{
            name: "message",
            fields: [
                "run_request",
                "exec_client_message",
                "kv_client_message",
                "conversation_action",
                "exec_client_control_message",
                "interaction_response",
                "client_heartbeat",
            ],
        }]);
    // ── AgentServerMessage ──
    addType(root, "AgentServerMessage", [
        { id: 1, name: "interaction_update", type: "InteractionUpdate" },
        { id: 2, name: "exec_server_message", type: "ExecServerMessage" },
        { id: 3, name: "conversation_checkpoint_update", type: "bytes" },
        { id: 4, name: "kv_server_message", type: "KvServerMessage" },
        { id: 5, name: "exec_server_control_message", type: "ExecServerControlMessage" },
        { id: 7, name: "interaction_query", type: "InteractionQuery" },
    ], [{ name: "message", fields: ["interaction_update", "exec_server_message", "conversation_checkpoint_update", "kv_server_message", "exec_server_control_message", "interaction_query"] }]);
    // ── AvailableModels types ──
    addType(root, "AvailableModelsRequest", []);
    addType(root, "AvailableModelParameterDefinition", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "values", type: "string", repeated: true },
    ]);
    addType(root, "AvailableModelParameterValue", [
        { id: 1, name: "id", type: "string" },
        { id: 2, name: "value", type: "string" },
    ]);
    addType(root, "AvailableModelVariant", [
        { id: 1, name: "parameter_values", type: "AvailableModelParameterValue", repeated: true },
        { id: 2, name: "display_name", type: "string" },
        { id: 3, name: "is_max_mode", type: "bool" },
        { id: 4, name: "is_default_max_config", type: "bool" },
        { id: 5, name: "is_default_non_max_config", type: "bool" },
    ]);
    addType(root, "AvailableModelEntry", [
        { id: 1, name: "name", type: "string" },
        { id: 2, name: "default_on", type: "bool" },
        { id: 5, name: "supports_agent", type: "bool" },
        { id: 9, name: "supports_thinking", type: "bool" },
        { id: 10, name: "supports_images", type: "bool" },
        { id: 14, name: "supports_max_mode", type: "bool" },
        { id: 15, name: "context_token_limit", type: "int32" },
        { id: 16, name: "context_token_limit_for_max_mode", type: "int32" },
        { id: 17, name: "client_display_name", type: "string" },
        { id: 18, name: "server_model_name", type: "string" },
        { id: 29, name: "parameter_definitions", type: "AvailableModelParameterDefinition", repeated: true },
        { id: 30, name: "variants", type: "AvailableModelVariant", repeated: true },
    ]);
    addType(root, "AvailableModelsResponse", [
        { id: 1, name: "model_names", type: "string", repeated: true },
        { id: 2, name: "models", type: "AvailableModelEntry", repeated: true },
    ]);
    return root;
}
// ── Singleton root ──
let _root = null;
export function getMessageTypes() {
    if (!_root) {
        _root = createMessageTypes();
    }
    return _root;
}
export function encodeMessage(typeName, message) {
    const root = getMessageTypes();
    const type = root.lookupType(typeName);
    const err = type.verify(message);
    if (err)
        throw new Error(`Invalid message for ${typeName}: ${err}`);
    return type.encode(type.fromObject(message)).finish();
}
export function decodeMessage(typeName, data) {
    const root = getMessageTypes();
    const type = root.lookupType(typeName);
    const decoded = type.decode(data);
    return type.toObject(decoded, { defaults: true, json: true, longs: Number });
}
/** Decode without inventing absent proto defaults (used for byte-stable snapshots). */
export function decodeMessageSparse(typeName, data) {
    const root = getMessageTypes();
    const type = root.lookupType(typeName);
    const decoded = type.decode(data);
    return type.toObject(decoded, { json: true, longs: Number });
}
/** Schema-free walk of one message's top-level wire fields (no nested descent). */
function readRawFields(buf) {
    const reader = protobuf.Reader.create(buf);
    const fields = [];
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        const wireType = tag & 7;
        switch (wireType) {
            case 0:
                fields.push({ field, wireType, varint: reader.uint64().toString() });
                break;
            case 1:
                fields.push({ field, wireType, fixed: reader.fixed64().toString() });
                break;
            case 2:
                fields.push({ field, wireType, bytes: reader.bytes() });
                break;
            case 5:
                fields.push({ field, wireType, fixed: reader.fixed32() });
                break;
            default:
                // Groups (3/4) aren't used on this wire; bail rather than desync the reader.
                return fields;
        }
    }
    return fields;
}
/**
 * Diagnostic-only: walk AgentServerMessage.interaction_update(1).turn_ended(14)
 * without going through our hand-written TurnEnded schema, so a `cache_write`/
 * `reasoning_tokens` question can be checked against the raw wire instead of
 * guessed. Confirmed field ids 1-5 (input/output/cache_read/cache_write/
 * reasoning) decode correctly. Live captures routinely include `f4` explicitly
 * as `0` while `f3` (cache_read) and `f5` (reasoning) are non-zero — Cursor's
 * agent TurnEnded populates the field but does not report write counts here.
 */
export function debugWalkTurnEnded(payload) {
    try {
        const top = readRawFields(payload);
        const iuField = top.find((f) => f.field === 1 && f.wireType === 2);
        if (!iuField?.bytes)
            return "(no interaction_update field)";
        const iu = readRawFields(iuField.bytes);
        const teField = iu.find((f) => f.field === 14 && f.wireType === 2);
        if (!teField?.bytes)
            return "(no turn_ended field in interaction_update)";
        const te = readRawFields(teField.bytes);
        return te
            .map((f) => `f${f.field}:wt${f.wireType}=${f.varint ?? f.fixed ?? (f.bytes ? `bytes[${f.bytes.length}]` : "?")}`)
            .join(" ");
    }
    catch (e) {
        return `(walk failed: ${e.message})`;
    }
}
/**
 * Decode a protobuf sub-message from a frame payload that wraps it in
 * a top-level field key + length varint.  Skips the outer wrapper and
 * decodes the inner body as `typeName`.
 */
export function decodeWrappedMessage(typeName, data) {
    let offset = 1; // skip field key
    // skip varint length
    while (offset < data.length) {
        const b = data[offset];
        offset++;
        if (!(b & 0x80))
            break;
    }
    return decodeMessage(typeName, data.subarray(offset));
}
