/** aiserver.v1.GetDiffRequest.OutputFormat */
export declare const GIT_DIFF_FORMAT_UNSPECIFIED = 0;
export declare const GIT_DIFF_FORMAT_NAME_STATUS = 1;
export declare const GIT_DIFF_FORMAT_NAME_STATUS_AND_NUMSTAT = 2;
export declare const GIT_DIFF_FORMAT_FILE_DIFFS = 3;
export declare const GIT_DIFF_FORMAT_DIFFS_WITH_BEFORE_AND_AFTER = 4;
export type GitDiffChunk = {
    content: string;
    lines: string[];
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
};
export type GitFileDiff = {
    from: string;
    to: string;
    chunks: GitDiffChunk[];
    added: number;
    removed: number;
};
/** Parse `git diff --no-color` into aiserver.v1.FileDiff rows (CLI `Oc` / `FR`). */
export declare function parseUnifiedDiff(text: string): GitFileDiff[];
export declare function executeGitDiff(request: Record<string, unknown>, workspaceRoot: string): Promise<Record<string, unknown>>;
/**
 * Answer exec #44. GetDiffResponse has no error oneof — failures use
 * exec_client_control_message.throw, matching Cursor CLI `class Dc`.
 */
export declare function buildGitDiffExecMessages(input: {
    execId: number;
    request: Record<string, unknown>;
    workspaceRoot: string;
}): Promise<Uint8Array[]>;
