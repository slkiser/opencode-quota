import type { BidiStream } from "./transport/connect.js";
import { CursorTransportError } from "./errors.js";
/**
 * `write()` returned false (bytes already buffered) and the later drain failed
 * or was unavailable. Callers must not replay that frame.
 */
export declare class StreamWriteDrainError extends CursorTransportError {
    readonly accepted = true;
    constructor(message: string, cause?: unknown);
}
/** True while a write on `stream` waits for `drain`; anything written next queues behind it. */
export declare function isStreamWriteBlocked(stream: BidiStream): boolean;
export declare function waitForStreamWrites(stream: BidiStream): Promise<void>;
/**
 * Keep awaited protocol writes ordered per Run stream. A large reply must
 * drain before another reply or heartbeat is queued; otherwise one writer
 * observes the backlog created by ignored `false` write() results.
 * `shouldWrite` is asked when the message's turn comes; false skips it.
 */
export declare function writeStreamMessage(stream: BidiStream, message: Uint8Array, operation: string, shouldWrite?: () => boolean): Promise<boolean>;
