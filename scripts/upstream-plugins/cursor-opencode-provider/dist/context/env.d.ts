export declare function buildEnv(workspaceRoot: string): Record<string, unknown>;
/**
 * Real workspace root for path resolution (edits, reads, …).
 * Uses `env.workspace_paths[0]` — never `project_folder` /
 * `mcp_file_system_options.workspace_project_dir` (those are Cursor metadata roots).
 */
export declare function workspaceRootFromRequestContext(requestContext: Record<string, unknown> | undefined): string;
