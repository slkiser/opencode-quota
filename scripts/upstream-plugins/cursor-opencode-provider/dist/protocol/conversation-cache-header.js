import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { CONVERSATION_CACHE_SCHEMA_VERSION } from "../shared.js";
export const MAX_CACHE_HEADER_BYTES = 8 * 1024;
export const MAX_CACHE_HEADER_INPUT_BYTES = 128 * 1024;
/**
 * Schema 3 wrote the same canonical fields 1-4 prefix as the current schema, so
 * its persisted age is trustworthy even though its body is no longer loadable.
 */
const OLDEST_CANONICAL_PREFIX_SCHEMA_VERSION = 3;
/** A prefix is a retention hint, never evidence of payload/checksum validity. */
export function parseConversationCacheHeader(bytes) {
    let position = 0;
    const incomplete = Symbol("incomplete header");
    const indeterminate = Symbol("noncanonical header");
    const varint = () => {
        let value = 0n;
        for (let index = 0; index < 10; index++) {
            if (position === bytes.length)
                throw incomplete;
            const byte = bytes[position++];
            if (index === 9 && byte > 1)
                throw new Error("invalid cache header varint");
            value |= BigInt(byte & 127) << BigInt(index * 7);
            if (!(byte & 128))
                return value;
        }
        throw new Error("invalid cache header varint");
    };
    const string = () => {
        const length = varint();
        if (length > BigInt(MAX_CACHE_HEADER_BYTES))
            throw indeterminate;
        const end = position + Number(length);
        if (end > bytes.length)
            throw incomplete;
        const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(position, end));
        position = end;
        return value;
    };
    try {
        // Only our writer's canonical prefix is eligible for metadata-only pruning.
        // Other protobuf orders remain loadable through the full decoder.
        if (varint() !== 8n)
            return { status: "indeterminate" };
        // A newer schema may lay out its prefix differently; never age it here.
        const schemaVersion = varint();
        if (schemaVersion < BigInt(OLDEST_CANONICAL_PREFIX_SCHEMA_VERSION) ||
            schemaVersion > BigInt(CONVERSATION_CACHE_SCHEMA_VERSION))
            return { status: "indeterminate" };
        if (varint() !== 18n)
            return { status: "indeterminate" };
        const sessionKey = string();
        if (varint() !== 26n)
            return { status: "indeterminate" };
        const conversationId = string();
        if (varint() !== 32n)
            return { status: "indeterminate" };
        const updatedAt = Number(varint());
        if (!sessionKey || !conversationId || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
            return { status: "invalid" };
        }
        return {
            status: "metadata",
            value: { schemaVersion: Number(schemaVersion), sessionKey, conversationId, updatedAt },
        };
    }
    catch (error) {
        // A fragmented varint/string is normal streaming input, not corrupt data.
        if (error === incomplete)
            return undefined;
        if (error === indeterminate)
            return { status: "indeterminate" };
        return { status: "invalid" };
    }
}
/**
 * Inspect an opened generation without reading its checkpoint/blobs/context.
 * Positional reads leave the handle's offset at zero for subsequent full loading.
 * Stop BOTH streams on success; merely breaking consumption leaves inflation live.
 */
export function readConversationCacheHeader(handle, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const prefix = Buffer.alloc(MAX_CACHE_HEADER_BYTES);
        let length = 0;
        let inputBytes = 0;
        let settled = false;
        let pendingRead;
        // Own the positional reads ourselves. Destroying a ReadStream can close an
        // externally supplied fd on some runtimes, even with autoClose:false.
        const input = Readable.from((async function* () {
            let position = 0;
            while (!settled && position < MAX_CACHE_HEADER_INPUT_BYTES) {
                const chunk = Buffer.alloc(Math.min(4096, MAX_CACHE_HEADER_INPUT_BYTES - position));
                const read = handle.read(chunk, 0, chunk.length, position);
                pendingRead = read;
                const { bytesRead } = await read;
                pendingRead = undefined;
                if (!bytesRead || settled)
                    return;
                position += bytesRead;
                inputBytes += bytesRead;
                yield chunk.subarray(0, bytesRead);
            }
        })(), { objectMode: false, highWaterMark: 4096 });
        const unzip = createGunzip({ chunkSize: 1024 });
        const finish = (value, error) => {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            input.unpipe(unzip);
            input.destroy();
            unzip.destroy();
            // A read-ahead operation must settle before the caller reuses/closes the
            // pinned handle. The async generator cannot start another after settled.
            void Promise.resolve(pendingRead).then(() => {
                if (error)
                    reject(error);
                else
                    resolve(value);
            }, reject);
        };
        const abort = () => finish(undefined, signal?.reason ?? new Error("cache inspection aborted"));
        input.on("error", (error) => finish(undefined, error));
        unzip.on("error", () => finish({
            status: inputBytes >= MAX_CACHE_HEADER_INPUT_BYTES ? "indeterminate" : "invalid",
        }));
        unzip.on("end", () => finish({
            status: inputBytes >= MAX_CACHE_HEADER_INPUT_BYTES ? "indeterminate" : "invalid",
        }));
        unzip.on("data", (chunk) => {
            const available = Math.min(chunk.length, prefix.length - length);
            prefix.set(chunk.subarray(0, available), length);
            length += available;
            const result = parseConversationCacheHeader(prefix.subarray(0, length));
            if (result)
                finish(result);
            else if (length === prefix.length)
                finish({ status: "indeterminate" });
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            abort();
        else
            input.pipe(unzip);
    });
}
