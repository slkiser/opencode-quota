/**
 * Canonical Cursor agent.v1 exec request/result pairs.
 *
 * Source of truth: Cursor CLI generated `agent/v1/exec_pb.js` plus the
 * registrations in `agent-exec/dist/index.js`. Most request/result variants
 * share a field number; Pi requests deliberately use result field +1.
 *
 * `handling` describes this provider, not the Cursor CLI:
 * - opencode-tool: emitted through an advertised OpenCode tool
 * - provider-control: answered directly on the held-open Run stream
 * - unsupported: known Cursor-native capability with no safe AI SDK bridge
 */
export type CursorExecHandling = "opencode-tool" | "provider-control" | "unsupported";
export type CursorExecVariant = {
    requestField: number;
    requestName: string;
    resultField: number;
    resultName: string;
    handling: CursorExecHandling;
};
export declare const CURSOR_EXEC_VARIANTS: readonly CursorExecVariant[];
export declare function cursorExecVariantByRequestField(field: number): CursorExecVariant | undefined;
export declare function cursorExecVariantByRequestName(name: string): CursorExecVariant | undefined;
export declare function isExecRequestWithoutNewCall(field: number | undefined): boolean;
export declare function describeCursorExecVariant(field: number | undefined): string;
/**
 * `ForceBackgroundShellResult` / `ForceBackgroundSubagentResult` status.
 * Cursor CLI `ForceBackground{Shell,Subagent}Status`: 0 UNSPECIFIED,
 * 1 ACCEPTED, 2 NOT_FOUND.
 */
export declare const FORCE_BACKGROUND_STATUS_ERROR = 2;
