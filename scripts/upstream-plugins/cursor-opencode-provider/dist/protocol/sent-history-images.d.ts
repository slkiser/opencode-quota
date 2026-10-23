/** `hashes` is shared between entries and never mutated. */
type HeldImages = {
    conversationId: string;
    checkpoint: string;
    hashes: readonly string[];
};
/**
 * One Run's view: `held` by the checkpoint it last stood on, `checkpointed` sent
 * before Cursor's latest checkpoint arrived, `sent` since, each with the last
 * frame arrival at its send. Only a turn that ends on a checkpoint of its own
 * moves `checkpointed` into `held`.
 */
export type RunHistoryImages = {
    held: readonly string[];
    checkpointed: string[];
    sent: Array<{
        hash: string;
        afterArrival: number;
    }>;
};
export declare function checkpointFingerprint(checkpoint: Uint8Array): string;
/** The images `checkpoint` is known to hold. */
export declare function heldHistoryImageHashes(sessionKey: string, conversationId: string, checkpoint: Uint8Array): ReadonlySet<string> | undefined;
export declare function runHistoryImages(held?: ReadonlySet<string>): RunHistoryImages;
/** `lastArrival`: the last frame arrival once the images are written. */
export declare function noteHistoryImagesSent(run: RunHistoryImages, hashes: readonly string[], lastArrival?: number): void;
/**
 * Cursor's checkpoints extend the one the Run started on, so each holds at least what that one held.
 * A checkpoint that arrived before images were written (read only after a host tool's result) holds none of them.
 */
export declare function noteHistoryImageCheckpoint(run: RunHistoryImages, sessionKey: string, conversationId: string, checkpoint: Uint8Array, arrival?: number): void;
/**
 * The turn ended. On a checkpoint of its own, that checkpoint holds what the Run
 * sent before it; without one, nothing the Run sent counts as held.
 */
export declare function confirmHistoryImagesAtTurnEnd(run: RunHistoryImages, sessionKey: string, conversationId: string, checkpoint: Uint8Array | undefined): void;
/** For the restart snapshot: the set the checkpoint being saved holds. */
export declare function heldHistoryImagesSnapshot(sessionKey: string, conversationId: string, checkpoint: Uint8Array | undefined): {
    checkpoint: string;
    hashes: string[];
} | undefined;
export declare function restoreHeldHistoryImages(sessionKey: string, conversationId: string, saved: {
    checkpoint?: string;
    hashes?: readonly string[];
}): void;
export declare function forgetHeldHistoryImages(sessionKey: string): void;
export declare function snapshotHeldHistoryImagesForTests(sessionKey: string): HeldImages[];
export declare function resetHeldHistoryImagesForTests(): void;
export {};
