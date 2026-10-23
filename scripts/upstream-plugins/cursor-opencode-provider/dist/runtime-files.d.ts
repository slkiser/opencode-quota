export declare const MAX_RUNTIME_WRITE_BYTES: number;
export declare const MAX_RUNTIME_READ_BYTES: number;
export declare const RUNTIME_FILE_TTL_MS: number;
export declare const MAX_RUNTIME_SPILL_BYTES: number;
export declare const MAX_RUNTIME_SPILL_FILES = 128;
export type RuntimeLayout = {
    root: string;
    agentTools: string;
    terminals: string;
};
/** The one provider-owned layout, pinned by the RequestContext's project root. */
export declare function runtimeLayout(root: string, create?: boolean): RuntimeLayout;
export declare function runtimeRootFromContext(context: Record<string, unknown> | undefined): string | undefined;
export declare function maintainRuntimeFiles(layout: RuntimeLayout, now?: number): void;
/** Native internal filesystem requests never enter the host's workspace tools. */
export declare function runtimeExecMessages(message: Record<string, unknown>, context: Record<string, unknown> | undefined, allowTools: boolean): Promise<Uint8Array[] | undefined>;
/**
 * Age-based cleanup. A live supervisor rewrites its record every second, so a
 * terminal record or job untouched for the TTL is finished, was never
 * started, or was orphaned by a crash or reboot. Only deletions are budgeted:
 * young entries early in directory order cannot stall later cleanup.
 */
export declare function sweepRuntimeFiles(layout: RuntimeLayout, now?: number): void;
