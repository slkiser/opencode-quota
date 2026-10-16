import { gunzipSync, gzipSync } from "node:zlib";
export const FLAG_GZIP = 0x01;
export const FLAG_END_STREAM = 0x02;
export function encodeFrame(flags, payload) {
    let data = payload;
    if (flags & FLAG_GZIP) {
        data = gzipSync(data);
    }
    const len = data.length;
    const header = new Uint8Array(5);
    header[0] = flags;
    header[1] = (len >> 24) & 0xff;
    header[2] = (len >> 16) & 0xff;
    header[3] = (len >> 8) & 0xff;
    header[4] = len & 0xff;
    const out = new Uint8Array(5 + len);
    out.set(header, 0);
    out.set(data, 5);
    return out;
}
export function decodeFramePayload(frame) {
    return frame.flags & FLAG_GZIP ? gunzipSync(frame.payload) : frame.payload;
}
export function* streamFrames(buffer) {
    let offset = 0;
    while (offset + 5 <= buffer.length) {
        const flags = buffer[offset];
        const len = ((buffer[offset + 1] << 24) |
            (buffer[offset + 2] << 16) |
            (buffer[offset + 3] << 8) |
            buffer[offset + 4]) >>> 0;
        const start = offset + 5;
        if (start + len > buffer.length)
            break;
        yield { flags, payload: buffer.subarray(start, start + len) };
        offset = start + len;
    }
}
export async function* asyncStreamFrames(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let pendingLength = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done && chunks.length === 0)
                return;
            if (value) {
                chunks.push(value);
                pendingLength += value.length;
            }
            // Try to parse frames from accumulated data
            const merged = mergeChunks(chunks);
            const frames = Array.from(streamFrames(merged));
            const consumed = frames.reduce((sum, f) => sum + 5 + f.payload.length, 0);
            if (frames.length > 0) {
                for (const frame of frames) {
                    yield frame;
                }
                // Keep any trailing bytes for next iteration
                const remaining = merged.subarray(consumed);
                chunks.length = 0;
                if (remaining.length > 0) {
                    chunks.push(remaining);
                    pendingLength = remaining.length;
                }
                else {
                    pendingLength = 0;
                }
            }
            if (done)
                return;
        }
    }
    finally {
        reader.releaseLock();
    }
}
function mergeChunks(chunks) {
    if (chunks.length === 1)
        return chunks[0];
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
    }
    return merged;
}
