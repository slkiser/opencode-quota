/**
 * Per-session todo list used when the host does not ship `todowrite` /
 * `todoread` (OpenCode 2 dropped those builtins; OpenCode 1.x still has
 * `todowrite`).
 *
 * In-memory only — same lifetime as the provider process. A restart clears
 * the list until the next write/read, matching the mirrored Cursor-todo
 * snapshot in `language-model.ts`.
 */
export const TODOWRITE_TOOL = "todowrite";
export const TODOREAD_TOOL = "todoread";
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
export const TODO_PRIORITIES = ["high", "medium", "low"];
const lists = new Map();
const MAX_TRACKED_SESSIONS = 256;
function isStatus(value) {
    return typeof value === "string" && TODO_STATUSES.includes(value);
}
function isPriority(value) {
    return typeof value === "string" && TODO_PRIORITIES.includes(value);
}
/** Normalize one host/Cursor todo item. Drops entries with empty content. */
export function normalizeSessionTodo(value, index) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    const content = typeof record.content === "string" ? record.content : "";
    if (!content.trim())
        return undefined;
    const id = typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : String(index + 1);
    return {
        id,
        content,
        status: isStatus(record.status) ? record.status : "pending",
        priority: isPriority(record.priority) ? record.priority : "medium",
    };
}
export function normalizeSessionTodos(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
        const todo = normalizeSessionTodo(item, out.length);
        if (!todo)
            continue;
        let id = todo.id;
        if (seen.has(id))
            id = `${id}-${out.length + 1}`;
        seen.add(id);
        out.push(id === todo.id ? todo : { ...todo, id });
    }
    return out;
}
/** Fill omitted defaults before validation without dropping malformed entries. */
export function normalizeOpencodeTodoArgs(args) {
    if (!Array.isArray(args.todos))
        return args;
    return {
        ...args,
        todos: args.todos.map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return item;
            const todo = item;
            return {
                ...todo,
                ...(todo.id === undefined ? { id: String(index + 1) } : {}),
                ...(todo.status === undefined ? { status: "pending" } : {}),
                ...(todo.priority === undefined ? { priority: "medium" } : {}),
            };
        }),
    };
}
export function getSessionTodos(sessionID) {
    return lists.get(sessionID)?.map((todo) => ({ ...todo })) ?? [];
}
export function setSessionTodos(sessionID, todos) {
    const normalized = normalizeSessionTodos(todos);
    lists.delete(sessionID);
    lists.set(sessionID, normalized.map((todo) => ({ ...todo })));
    while (lists.size > MAX_TRACKED_SESSIONS) {
        const oldest = lists.keys().next().value;
        if (oldest === undefined)
            break;
        lists.delete(oldest);
    }
    return getSessionTodos(sessionID);
}
export function clearSessionTodos(sessionID) {
    lists.delete(sessionID);
}
/** Test-only: drop every session list. */
export function clearAllSessionTodos() {
    lists.clear();
}
