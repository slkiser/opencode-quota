import { TODOREAD_TOOL, TODOWRITE_TOOL, getSessionTodos, setSessionTodos, } from "../todo-store.js";
/**
 * OpenCode 2 snapshot: only `codemode === false` tools join the AI SDK catalog.
 * Everything else is Code Mode-only (`packages/core/src/tool.ts` direct vs
 * `codeModeTools`). Plugin-owned todo tools must opt into the direct catalog so
 * Cursor can execute them without going through Code Mode.
 */
export const OPENCODE2_DIRECT_TOOL_OPTIONS = { codemode: false };
/**
 * Force-enable plugin-owned `todowrite` / `todoread` on OpenCode 2.0.
 * Default is off: the host has no TUI/desktop checklist, so advertising
 * these in-memory tools is opt-in. OpenCode 1.x is unaffected (host builtin).
 * Same truthy rule as `CURSOR_PROVIDER_DEBUG` (`1` or `true`).
 */
export const CURSOR_OPENCODE2_TODOS_ENV = "CURSOR_OPENCODE2_TODOS";
export function isOpenCode2TodosEnabled(env = process.env) {
    const value = env[CURSOR_OPENCODE2_TODOS_ENV]?.toLowerCase();
    return value === "1" || value === "true";
}
/**
 * 1.x `todowrite` description, shortened. OpenCode 2 has no builtin todo
 * tools; this is the catalog text the model sees when the 2.0 gate is on.
 */
export const TODOWRITE_DESCRIPTION = `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.

Use proactively when the work is 3+ distinct steps, non-trivial, or the user lists multiple tasks. Skip single straightforward edits and purely informational questions.

States: pending, in_progress (exactly one at a time), completed, cancelled.
Update status as you go. Mark completed only after the work — including verification — is actually done.`;
export const TODOREAD_DESCRIPTION = "Read the current session todo list. Takes no arguments. Returns the full list as JSON.";
const TODO_ITEM_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string", description: "Optional stable item id" },
        content: { type: "string", description: "Brief description of the task" },
        status: {
            type: "string",
            description: "pending, in_progress, completed, or cancelled",
            enum: ["pending", "in_progress", "completed", "cancelled"],
        },
        priority: {
            type: "string",
            description: "high, medium, or low",
            enum: ["high", "medium", "low"],
        },
    },
    required: ["content"],
};
const TODO_OUTPUT_ITEM_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        content: { type: "string" },
        status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "cancelled"],
        },
        priority: {
            type: "string",
            enum: ["high", "medium", "low"],
        },
    },
    required: ["id", "content", "status", "priority"],
};
export const TODO_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        todos: { type: "array", items: TODO_OUTPUT_ITEM_SCHEMA },
    },
    required: ["todos"],
};
function todoResult(todos) {
    const content = JSON.stringify(todos, null, 2);
    return {
        output: { todos },
        content,
        metadata: { todos },
    };
}
function sessionIDFromContext(context) {
    if (!context || typeof context !== "object") {
        throw new Error("OpenCode 2.0 todo tool context did not provide a sessionID");
    }
    const id = context.sessionID;
    if (typeof id !== "string" || !id) {
        throw new Error("OpenCode 2.0 todo tool context did not provide a sessionID");
    }
    return id;
}
/** True when the host editor already owns this tool id. */
export function hostHasTool(draft, name) {
    if (typeof draft.get === "function") {
        try {
            if (draft.get(name))
                return true;
        }
        catch {
            // Host get() may throw for unknown ids; fall through to list().
        }
    }
    if (typeof draft.list === "function") {
        try {
            return draft.list().some((tool) => tool.id === name || tool.name === name);
        }
        catch {
            return false;
        }
    }
    return false;
}
/**
 * Register canonical `todowrite` / `todoread` when the 2.0 force-enable gate
 * is on and the host catalog does not already advertise them. No-op when the
 * gate is off (default), on OpenCode 1.x (this function is not called), and
 * on any 2.x host that restores the tools.
 */
export function registerTodoTools(draft) {
    if (!isOpenCode2TodosEnabled())
        return;
    if (!hostHasTool(draft, TODOWRITE_TOOL)) {
        draft.add({
            name: TODOWRITE_TOOL,
            description: TODOWRITE_DESCRIPTION,
            input: {
                type: "object",
                additionalProperties: false,
                properties: {
                    todos: {
                        type: "array",
                        description: "The updated todo list (replace-all snapshot)",
                        items: TODO_ITEM_SCHEMA,
                    },
                },
                required: ["todos"],
            },
            output: TODO_OUTPUT_SCHEMA,
            options: OPENCODE2_DIRECT_TOOL_OPTIONS,
            execute: async (input, context) => {
                const sessionID = sessionIDFromContext(context);
                const todos = setSessionTodos(sessionID, input?.todos);
                return todoResult(todos);
            },
        });
    }
    if (!hostHasTool(draft, TODOREAD_TOOL)) {
        draft.add({
            name: TODOREAD_TOOL,
            description: TODOREAD_DESCRIPTION,
            input: {
                type: "object",
                additionalProperties: false,
                properties: {},
            },
            output: TODO_OUTPUT_SCHEMA,
            options: OPENCODE2_DIRECT_TOOL_OPTIONS,
            execute: async (_input, context) => {
                const sessionID = sessionIDFromContext(context);
                return todoResult(getSessionTodos(sessionID));
            },
        });
    }
}
