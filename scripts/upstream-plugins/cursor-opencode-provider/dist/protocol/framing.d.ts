export declare const FLAG_GZIP = 1;
export declare const FLAG_END_STREAM = 2;
export type Frame = {
    flags: number;
    payload: Uint8Array;
};
export declare function encodeFrame(flags: number, payload: Uint8Array): Uint8Array;
export declare function decodeFramePayload(frame: Frame): Uint8Array;
export declare function streamFrames(buffer: Uint8Array): Generator<Frame, void, void>;
export declare function asyncStreamFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Frame, void, void>;
