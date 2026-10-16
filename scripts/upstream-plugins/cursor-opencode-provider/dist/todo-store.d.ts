/**
 * Per-session todo list used when the host does not ship `todowrite` /
 * `todoread` (OpenCode 2 dropped those builtins; OpenCode 1.x still has
 * `todowrite`).
 *
 * In-memory only — same lifetime as the provider process. A restart clears
 * the list until the next write/read, matching the mirrored Cursor-todo
 * snapshot in `language-model.ts`.
 */
export declare const TODOWRITE_TOOL = "todowrite";
export declare const TODOREAD_TOOL = "todoread";
export declare const TODO_STATUSES: readonly ["pending", "in_progress", "completed", "cancelled"];
export type TodoStatus = (typeof TODO_STATUSES)[number];
export declare const TODO_PRIORITIES: readonly ["high", "medium", "low"];
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
export type SessionTodo = {
    id: string;
    content: string;
    status: TodoStatus;
    priority: TodoPriority;
};
/** Normalize one host/Cursor todo item. Drops entries with empty content. */
export declare function normalizeSessionTodo(value: unknown, index: number): SessionTodo | undefined;
export declare function normalizeSessionTodos(value: unknown): SessionTodo[];
/** Fill omitted defaults before validation without dropping malformed entries. */
export declare function normalizeOpencodeTodoArgs(args: Record<string, unknown>): Record<string, unknown>;
export declare function getSessionTodos(sessionID: string): SessionTodo[];
export declare function setSessionTodos(sessionID: string, todos: unknown): SessionTodo[];
export declare function clearSessionTodos(sessionID: string): void;
/** Test-only: drop every session list. */
export declare function clearAllSessionTodos(): void;
