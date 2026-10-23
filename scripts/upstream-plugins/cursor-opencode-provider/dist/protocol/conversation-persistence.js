import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants as zlibConstants, gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import protobuf from "protobufjs";
import { CONVERSATION_CACHE_DIR, CONVERSATION_CACHE_SCHEMA_VERSION, CONVERSATION_CACHE_TTL_MS, } from "../shared.js";
import { decodeMessageSparse, encodeMessage } from "./messages.js";
import { trace } from "../debug.js";
import { readConversationCacheHeader } from "./conversation-cache-header.js";
const stores = new Map();
const initializedRoots = new Map();
const startupDiscardedStatuses = new Map();
const MAX_CONVERSATION_CACHE_BYTES = 256 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const maintenanceRoots = new Map();
const fileOperations = new Map();
/** `.${snapshot}.${pid}.${uuid}.tmp`, as written by writeConversationFile. */
const WRITER_TEMP_FILE = /^\..+\.pb\.gz\.\d+\.[^.]+\.tmp$/;
let testHook;
function errorCode(error) {
    return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
async function withFileOperation(filePath, operation) {
    const previous = fileOperations.get(filePath) ?? Promise.resolve();
    const result = previous.catch(() => { }).then(operation);
    const settled = result.then(() => { }, () => { });
    fileOperations.set(filePath, settled);
    void settled.then(() => {
        if (fileOperations.get(filePath) === settled)
            fileOperations.delete(filePath);
    });
    return result;
}
function quarantineDirectory(filePath) {
    return path.join(path.dirname(filePath), ".gc", path.basename(filePath));
}
/**
 * Entries of a directory another collector may remove at any time. Bun reads
 * a Dir lazily, so that ENOENT can surface from iteration instead of opendir;
 * either way the directory is treated as empty.
 */
async function* removableDirectoryEntries(directory) {
    let handle;
    try {
        handle = await opendir(directory);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return;
        throw error;
    }
    try {
        await testHook?.("directory-opened", directory);
    }
    catch (error) {
        await handle.close();
        throw error;
    }
    try {
        for await (const entry of handle)
            yield entry;
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            throw error;
    }
}
function openSnapshot(filePath) {
    return open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
}
function recordStartupDiscard(cacheDir, fileName, status) {
    const root = path.resolve(cacheDir);
    let statuses = startupDiscardedStatuses.get(root);
    if (!statuses) {
        statuses = new Map();
        startupDiscardedStatuses.set(root, statuses);
    }
    statuses.set(fileName, status);
}
export function conversationCacheDirectoryPath(cacheDir) {
    return path.join(cacheDir, CONVERSATION_CACHE_DIR);
}
function sessionFileName(sessionKey) {
    const label = sessionKey.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    const hash = createHash("sha256").update(sessionKey).digest("hex");
    return `${label || "session"}-${hash}.pb.gz`;
}
export function conversationCacheFilePath(cacheDir, sessionKey) {
    return path.join(conversationCacheDirectoryPath(cacheDir), sessionFileName(sessionKey));
}
function cloneConversation(value) {
    return {
        ...value,
        checkpoint: value.checkpoint ? Uint8Array.from(value.checkpoint) : undefined,
        blobs: value.blobs.map((blob) => ({ id: blob.id, data: Uint8Array.from(blob.data) })),
        requestContext: structuredClone(value.requestContext),
        toolCatalog: structuredClone(value.toolCatalog),
        postCompactionRebase: value.postCompactionRebase,
        ...(value.sentImageHashes ? { sentImageHashes: [...value.sentImageHashes] } : {}),
    };
}
/**
 * Private proto3 layout, encoded inline because the published package contains
 * compiled JS only:
 *
 * ConversationCache: schema_version=1, session_key=2, conversation_id=3,
 * updated_at=4, checkpoint=5, blobs=6, request_context=7, tool_catalog=8,
 * post_compaction_rebase=9, host_agent=10, system_prompt_hash=11,
 * turn_provenance_json=12, host_note=13, early_steers_json=14,
 * lost_request_json=15, sent_image_hashes=16 (repeated), sent_images_checkpoint_sha256=17.
 * Blob: id=1, data=2. Tool: name=1, description=2,
 * input_schema_json=3, source_name=4.
 *
 * Opaque protocol state stays as bytes. Only arbitrary host JSON Schemas remain
 * JSON, nested as UTF-8 bytes inside each Tool message.
 */
function fieldTag(field, wireType) {
    return (field << 3) | wireType;
}
function bytesToHex(bytes) {
    return Buffer.from(bytes).toString("hex");
}
function readUint64(reader) {
    const raw = reader.uint64();
    const value = typeof raw === "number" ? raw : Number(raw.toString());
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("invalid uint64");
    return value;
}
function readBlob(encoded) {
    const reader = protobuf.Reader.create(encoded);
    let id;
    let blobData;
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                if ((tag & 7) !== 2)
                    throw new Error("invalid blob id");
                id = reader.bytes();
                break;
            case 2:
                if ((tag & 7) !== 2)
                    throw new Error("invalid blob data");
                blobData = reader.bytes();
                break;
            default:
                reader.skipType(tag & 7);
        }
    }
    if (!id || id.length === 0 || !blobData)
        throw new Error("incomplete blob");
    return { id: bytesToHex(id), data: Uint8Array.from(blobData) };
}
function readTool(data) {
    const reader = protobuf.Reader.create(data);
    let name;
    let description;
    let inputSchema;
    let hasInputSchema = false;
    let sourceName;
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const wireType = tag & 7;
        switch (tag >>> 3) {
            case 1:
                if (wireType !== 2)
                    throw new Error("invalid tool name");
                name = reader.string();
                break;
            case 2:
                if (wireType !== 2)
                    throw new Error("invalid tool description");
                description = reader.string();
                break;
            case 3:
                if (wireType !== 2)
                    throw new Error("invalid tool schema");
                inputSchema = JSON.parse(utf8Decoder.decode(reader.bytes()));
                hasInputSchema = true;
                break;
            case 4:
                if (wireType !== 2)
                    throw new Error("invalid tool source name");
                sourceName = reader.string();
                break;
            default:
                reader.skipType(wireType);
        }
    }
    if (!name)
        throw new Error("incomplete tool");
    return {
        name,
        description,
        ...(hasInputSchema ? { inputSchema } : {}),
        sourceName,
    };
}
function blobIdBytes(id) {
    if (!/^(?:[0-9a-f]{2})+$/i.test(id))
        throw new Error("invalid conversation blob id");
    return Buffer.from(id, "hex");
}
function encodeCacheFile(value) {
    const writer = protobuf.Writer.create();
    const requestContext = encodeMessage("RequestContext", value.requestContext);
    writer.uint32(fieldTag(1, 0)).uint32(CONVERSATION_CACHE_SCHEMA_VERSION);
    writer.uint32(fieldTag(2, 2)).string(value.sessionKey);
    writer.uint32(fieldTag(3, 2)).string(value.conversationId);
    writer.uint32(fieldTag(4, 0)).uint64(value.updatedAt);
    if (value.checkpoint?.length)
        writer.uint32(fieldTag(5, 2)).bytes(value.checkpoint);
    for (const blob of value.blobs) {
        writer.uint32(fieldTag(6, 2)).fork();
        writer.uint32(fieldTag(1, 2)).bytes(blobIdBytes(blob.id));
        writer.uint32(fieldTag(2, 2)).bytes(blob.data);
        writer.ldelim();
    }
    writer.uint32(fieldTag(7, 2)).bytes(requestContext);
    for (const tool of value.toolCatalog) {
        writer.uint32(fieldTag(8, 2)).fork();
        writer.uint32(fieldTag(1, 2)).string(tool.name);
        if (tool.description !== undefined)
            writer.uint32(fieldTag(2, 2)).string(tool.description);
        if (tool.inputSchema !== undefined) {
            writer.uint32(fieldTag(3, 2)).bytes(Buffer.from(JSON.stringify(tool.inputSchema), "utf8"));
        }
        if (tool.sourceName !== undefined)
            writer.uint32(fieldTag(4, 2)).string(tool.sourceName);
        writer.ldelim();
    }
    if (value.postCompactionRebase)
        writer.uint32(fieldTag(9, 0)).bool(true);
    if (value.hostAgent)
        writer.uint32(fieldTag(10, 2)).string(value.hostAgent);
    if (value.systemPromptHash)
        writer.uint32(fieldTag(11, 2)).string(value.systemPromptHash);
    if (value.turnProvenance)
        writer.uint32(fieldTag(12, 2)).string(value.turnProvenance);
    if (value.hostNote)
        writer.uint32(fieldTag(13, 2)).string(value.hostNote);
    if (value.earlySteers)
        writer.uint32(fieldTag(14, 2)).string(value.earlySteers);
    if (value.lostRequest)
        writer.uint32(fieldTag(15, 2)).string(value.lostRequest);
    if (value.sentImagesCheckpoint && value.sentImageHashes?.length) {
        for (const hash of value.sentImageHashes)
            writer.uint32(fieldTag(16, 2)).string(hash);
        writer.uint32(fieldTag(17, 2)).string(value.sentImagesCheckpoint);
    }
    return { protobufBytes: writer.finish(), requestContextBytes: requestContext.length };
}
function decodeProtobuf(data) {
    const reader = protobuf.Reader.create(data);
    let schemaVersion;
    let sessionKey;
    let conversationId;
    let updatedAt;
    let checkpoint;
    const blobs = [];
    let requestContextBytes;
    const toolCatalog = [];
    let postCompactionRebase = false;
    let hostAgent;
    let systemPromptHash;
    let turnProvenance;
    let hostNote;
    let earlySteers;
    let lostRequest;
    const sentImageHashes = [];
    let sentImagesCheckpoint;
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const wireType = tag & 7;
        switch (tag >>> 3) {
            case 1:
                if (wireType !== 0 || schemaVersion !== undefined)
                    throw new Error("invalid schema version");
                schemaVersion = reader.uint32();
                break;
            case 2:
                if (wireType !== 2 || sessionKey !== undefined)
                    throw new Error("invalid session key");
                sessionKey = reader.string();
                break;
            case 3:
                if (wireType !== 2 || conversationId !== undefined)
                    throw new Error("invalid conversation id");
                conversationId = reader.string();
                break;
            case 4:
                if (wireType !== 0 || updatedAt !== undefined)
                    throw new Error("invalid update timestamp");
                updatedAt = readUint64(reader);
                break;
            case 5:
                if (wireType !== 2)
                    throw new Error("invalid checkpoint");
                checkpoint = Uint8Array.from(reader.bytes());
                break;
            case 6:
                if (wireType !== 2)
                    throw new Error("invalid blob");
                blobs.push(readBlob(reader.bytes()));
                break;
            case 7:
                if (wireType !== 2)
                    throw new Error("invalid request context");
                requestContextBytes = reader.bytes();
                break;
            case 8:
                if (wireType !== 2)
                    throw new Error("invalid tool");
                toolCatalog.push(readTool(reader.bytes()));
                break;
            case 9:
                if (wireType !== 0)
                    throw new Error("invalid compaction marker");
                postCompactionRebase = reader.bool();
                break;
            case 10:
                if (wireType !== 2)
                    throw new Error("invalid host agent");
                hostAgent = reader.string();
                break;
            case 11:
                if (wireType !== 2)
                    throw new Error("invalid system prompt hash");
                systemPromptHash = reader.string();
                break;
            case 12:
                if (wireType !== 2)
                    throw new Error("invalid turn provenance");
                turnProvenance = reader.string();
                break;
            case 13:
                if (wireType !== 2)
                    throw new Error("invalid host note");
                hostNote = reader.string();
                break;
            case 14:
                if (wireType !== 2)
                    throw new Error("invalid early steers");
                earlySteers = reader.string();
                break;
            case 15:
                if (wireType !== 2)
                    throw new Error("invalid lost request");
                lostRequest = reader.string();
                break;
            case 16:
                if (wireType !== 2)
                    throw new Error("invalid sent image hash");
                sentImageHashes.push(reader.string());
                break;
            case 17:
                if (wireType !== 2)
                    throw new Error("invalid sent images checkpoint");
                sentImagesCheckpoint = reader.string();
                break;
            default:
                reader.skipType(wireType);
        }
    }
    if (schemaVersion !== CONVERSATION_CACHE_SCHEMA_VERSION ||
        !sessionKey || !conversationId || updatedAt === undefined ||
        !requestContextBytes || requestContextBytes.length === 0)
        throw new Error("incomplete conversation cache");
    const requestContext = decodeMessageSparse("RequestContext", requestContextBytes);
    return {
        sessionKey,
        conversationId,
        updatedAt,
        checkpoint,
        blobs,
        requestContext,
        toolCatalog,
        postCompactionRebase,
        ...(hostAgent ? { hostAgent } : {}),
        ...(systemPromptHash ? { systemPromptHash } : {}),
        ...(turnProvenance ? { turnProvenance } : {}),
        ...(hostNote ? { hostNote } : {}),
        ...(earlySteers ? { earlySteers } : {}),
        ...(lostRequest ? { lostRequest } : {}),
        ...(sentImagesCheckpoint && sentImageHashes.length > 0 ? { sentImageHashes, sentImagesCheckpoint } : {}),
    };
}
function isFresh(value, now) {
    return now - value.updatedAt <= CONVERSATION_CACHE_TTL_MS;
}
/** Recover only this session's moved generations; never scan the conversation root. */
async function openConversationFile(filePath) {
    try {
        return { handle: await openSnapshot(filePath), sourcePath: filePath };
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            throw error;
    }
    let selected;
    let newest = -Infinity;
    try {
        for await (const entry of removableDirectoryEntries(quarantineDirectory(filePath))) {
            if (!entry.isFile() || !entry.name.endsWith(".snapshot"))
                continue;
            const sourcePath = path.join(quarantineDirectory(filePath), entry.name);
            let handle;
            try {
                handle = await openSnapshot(sourcePath);
            }
            catch (error) {
                if (errorCode(error) === "ENOENT")
                    continue;
                throw error;
            }
            try {
                const header = await readConversationCacheHeader(handle);
                const updatedAt = header.status === "metadata" ? header.value.updatedAt : -Infinity;
                if (!selected || updatedAt > newest) {
                    await selected?.handle.close();
                    selected = { handle, sourcePath };
                    newest = updatedAt;
                }
                else
                    await handle.close();
            }
            catch (error) {
                await handle.close();
                throw error;
            }
        }
        // A collector may have restored its candidate, or a writer published a new
        // generation while we inspected quarantine. The live name wins either way.
        try {
            const handle = await openSnapshot(filePath);
            await selected?.handle.close();
            return { handle, sourcePath: filePath };
        }
        catch (error) {
            if (errorCode(error) !== "ENOENT")
                throw error;
        }
        return selected;
    }
    catch (error) {
        await selected?.handle.close();
        throw error;
    }
}
async function readConversationFileWithStatus(filePath, expectedSessionKey, now) {
    const opened = await openConversationFile(filePath);
    if (!opened)
        return { status: "missing" };
    const { handle, sourcePath } = opened;
    let keepOpen = false;
    try {
        const stat = await handle.stat({ bigint: true });
        const identity = { dev: stat.dev, ino: stat.ino };
        const discarded = (status) => {
            keepOpen = true;
            return { status, identity, sourcePath, pin: handle };
        };
        if (!stat.isFile())
            throw new Error("conversation snapshot is not a regular file");
        if (stat.size > MAX_CONVERSATION_CACHE_BYTES)
            return discarded("invalid");
        const header = await readConversationCacheHeader(handle);
        if (header.status === "invalid")
            return discarded("invalid");
        if (header.status === "metadata") {
            if (header.value.sessionKey !== expectedSessionKey)
                return discarded("invalid");
            if (!isFresh(header.value, now))
                return discarded("expired");
            if (header.value.schemaVersion !== CONVERSATION_CACHE_SCHEMA_VERSION)
                return discarded("invalid");
        }
        const compressed = await handle.readFile();
        if (compressed.length > MAX_CONVERSATION_CACHE_BYTES)
            return discarded("invalid");
        await testHook?.("full-decode", filePath);
        let value;
        try {
            const bytes = await gunzipAsync(compressed, { maxOutputLength: MAX_CONVERSATION_CACHE_BYTES });
            value = decodeProtobuf(bytes);
        }
        catch {
            return discarded("invalid");
        }
        if (value.sessionKey !== expectedSessionKey)
            return discarded("invalid");
        return isFresh(value, now)
            ? { status: "restored", value, identity, sourcePath }
            : discarded("expired");
    }
    finally {
        if (!keepOpen)
            await handle.close();
    }
}
/**
 * Quarantine before deletion, then compare FILE IDENTITY rather than age. An
 * atomic replacement has a different inode and must be restored without clobbering
 * the live name. Readers can open this session's quarantine during that interval.
 */
async function discardCacheCandidate(filePath, identity, signal) {
    const directory = quarantineDirectory(filePath);
    const quarantinePath = path.join(directory, `${randomUUID()}.snapshot`);
    for (let attempt = 0;; attempt++) {
        await ensureCacheDirectory(directory);
        if (attempt === 0)
            await testHook?.("before-quarantine", filePath);
        signal?.throwIfAborted();
        try {
            await rename(filePath, quarantinePath);
            break;
        }
        catch (error) {
            if (errorCode(error) !== "ENOENT")
                throw error;
        }
        // ENOENT names either side: the candidate is gone, or another collector
        // removed this emptied quarantine directory after we created it.
        try {
            await lstat(filePath);
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                return "missing";
            throw error;
        }
        if (attempt === 2)
            return "preserved";
    }
    let removable = false;
    try {
        await testHook?.("after-quarantine", filePath);
        let moved;
        try {
            moved = await openSnapshot(quarantinePath);
        }
        catch (error) {
            // Another collector can finish/recover this immutable candidate first.
            if (errorCode(error) === "ENOENT")
                return "missing";
            throw error;
        }
        try {
            const stat = await moved.stat({ bigint: true });
            removable = !signal?.aborted && sameFile(identity, stat);
        }
        finally {
            await moved.close();
        }
    }
    finally {
        if (!removable) {
            // If restoration fails, retain the discoverable quarantine for the next
            // reader/pass. Never unlink the only surviving copy in a finally block.
            await link(quarantinePath, filePath).catch((error) => {
                if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOENT")
                    throw error;
            });
        }
        await unlink(quarantinePath).catch((error) => {
            if (errorCode(error) !== "ENOENT")
                throw error;
        });
        await rmdir(directory).catch((error) => {
            if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY")
                throw error;
        });
    }
    return removable ? "removed" : "preserved";
}
async function writeConversationFile(cacheDir, value) {
    const directory = conversationCacheDirectoryPath(cacheDir);
    const filePath = conversationCacheFilePath(cacheDir, value.sessionKey);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const encoded = encodeCacheFile(value);
    const { protobufBytes } = encoded;
    const compressed = await gzipAsync(protobufBytes, { level: zlibConstants.Z_BEST_COMPRESSION });
    await ensureCacheDirectory(directory);
    try {
        await writeFile(tempPath, compressed, { mode: 0o600 });
        await rename(tempPath, filePath);
        trace(`conversation persistence: snapshot written sessionKey=${value.sessionKey} ` +
            `fileBytes=${compressed.length} protobufBytes=${protobufBytes.length} ` +
            `checkpointBytes=${value.checkpoint?.length ?? 0} ` +
            `blobCount=${value.blobs.length} blobBytes=${value.blobs.reduce((sum, blob) => sum + blob.data.length, 0)} ` +
            `requestContextBytes=${encoded.requestContextBytes} ` +
            `toolCatalogBytes=${Buffer.byteLength(JSON.stringify(value.toolCatalog))}`);
    }
    finally {
        await unlink(tempPath).catch(() => { });
    }
}
async function ensureCacheDirectory(directory) {
    for (let attempt = 0;; attempt++) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (process.platform === "win32")
            return;
        try {
            await chmod(directory, 0o700);
            return;
        }
        catch (error) {
            // A concurrent collector can rmdir an emptied quarantine directory
            // between mkdir and chmod; recreate it instead of failing the pass.
            if (errorCode(error) !== "ENOENT" || attempt === 2)
                throw error;
        }
    }
}
function queueWrite(store, value) {
    const snapshot = cloneConversation(value);
    const filePath = conversationCacheFilePath(store.cacheDir, store.sessionKey);
    const write = store.writeChain.catch(() => { }).then(() => withFileOperation(filePath, () => writeConversationFile(store.cacheDir, snapshot)));
    store.writeChain = write;
    return write;
}
function queueDelete(store, expectedConversationId) {
    const write = store.writeChain.catch(() => { }).then(async () => {
        const filePath = conversationCacheFilePath(store.cacheDir, store.sessionKey);
        await withFileOperation(filePath, async () => {
            const opened = await openConversationFile(filePath);
            if (!opened)
                return;
            try {
                const stat = await opened.handle.stat({ bigint: true });
                const header = await readConversationCacheHeader(opened.handle);
                if (header.status !== "metadata" || header.value.sessionKey !== store.sessionKey ||
                    header.value.conversationId !== expectedConversationId)
                    return;
                if (opened.sourcePath === filePath)
                    await discardCacheCandidate(filePath, stat);
                else
                    await unlink(opened.sourcePath).catch((error) => {
                        if (errorCode(error) !== "ENOENT")
                            throw error;
                    });
            }
            finally {
                await opened.handle.close();
            }
        });
    });
    store.writeChain = write;
    return write;
}
async function recoverQuarantine(filePath, now, signal) {
    for await (const entry of removableDirectoryEntries(quarantineDirectory(filePath))) {
        signal.throwIfAborted();
        if (!entry.isFile() || !entry.name.endsWith(".snapshot"))
            continue;
        const candidate = path.join(quarantineDirectory(filePath), entry.name);
        let handle;
        try {
            handle = await openSnapshot(candidate);
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                continue;
            throw error;
        }
        let status;
        try {
            const header = await readConversationCacheHeader(handle, signal);
            if (header.status === "invalid")
                status = "invalid";
            else if (header.status === "metadata" && !isFresh(header.value, now))
                status = "expired";
        }
        finally {
            await handle.close();
        }
        signal.throwIfAborted();
        if (!status) {
            await link(candidate, filePath).catch((error) => {
                if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOENT")
                    throw error;
            });
        }
        await unlink(candidate).catch((error) => {
            if (errorCode(error) !== "ENOENT")
                throw error;
        });
        if (status)
            recordStartupDiscard(path.dirname(path.dirname(filePath)), path.basename(filePath), status);
    }
    await rmdir(quarantineDirectory(filePath)).catch((error) => {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY")
            throw error;
    });
}
async function pruneConversationDirectory(cacheDir, now, signal) {
    const directory = conversationCacheDirectoryPath(cacheDir);
    // Recover crash leftovers before inspecting canonical names. Only per-session
    // directories are read, and readers use exactly the same recovery location.
    for await (const entry of removableDirectoryEntries(path.join(directory, ".gc"))) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !entry.name.endsWith(".pb.gz"))
            continue;
        const filePath = path.join(directory, entry.name);
        await maintainEntry(entry.name, signal, () => withFileOperation(filePath, () => recoverQuarantine(filePath, now, signal)));
    }
    const entries = await opendir(directory);
    for await (const entry of entries) {
        signal.throwIfAborted();
        if (!entry.isFile())
            continue;
        const filePath = path.join(directory, entry.name);
        if (entry.name.endsWith(".json")) {
            await maintainEntry(entry.name, signal, () => unlink(filePath).catch((error) => {
                if (errorCode(error) !== "ENOENT")
                    throw error;
            }));
            continue;
        }
        if (WRITER_TEMP_FILE.test(entry.name)) {
            await maintainEntry(entry.name, signal, () => collectWriterTemp(filePath, now, signal));
            continue;
        }
        if (!entry.name.endsWith(".pb.gz"))
            continue;
        // In-process loads/writes/deletes share this per-file queue, so a loaded
        // session's snapshot still expires by its persisted age without restart.
        await maintainEntry(entry.name, signal, () => withFileOperation(filePath, async () => {
            signal.throwIfAborted();
            let handle;
            try {
                handle = await openSnapshot(filePath);
            }
            catch (error) {
                if (errorCode(error) === "ENOENT")
                    return;
                throw error;
            }
            try {
                const stat = await handle.stat({ bigint: true });
                if (!stat.isFile())
                    return;
                const identity = { dev: stat.dev, ino: stat.ino };
                let status;
                const header = await readConversationCacheHeader(handle, signal);
                if (header.status === "invalid")
                    status = "invalid";
                else if (header.status === "metadata" && !isFresh(header.value, now))
                    status = "expired";
                if (!status)
                    return;
                signal.throwIfAborted();
                if (await discardCacheCandidate(filePath, identity, signal) === "removed") {
                    recordStartupDiscard(cacheDir, entry.name, status);
                    trace(`conversation persistence: maintenance discarded ${status} snapshot file=${entry.name}`);
                }
            }
            finally {
                await handle.close();
            }
        }));
    }
}
/** One entry's I/O failure must not starve every later entry of collection. */
async function maintainEntry(fileName, signal, operation) {
    try {
        await operation();
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        trace(`conversation persistence: maintenance skipped file=${fileName}: ${String(error)}`);
    }
}
/**
 * A writer killed between writeFile and rename leaves its temp file behind.
 * An in-flight writer's temp always carries a fresh timestamp, so only a
 * readable expired prefix proves abandonment; unreadable temps are kept.
 */
async function collectWriterTemp(filePath, now, signal) {
    let handle;
    try {
        handle = await openSnapshot(filePath);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return;
        throw error;
    }
    let expired = false;
    try {
        if (!(await handle.stat()).isFile())
            return;
        const header = await readConversationCacheHeader(handle, signal);
        expired = header.status === "metadata" && !isFresh(header.value, now);
    }
    finally {
        await handle.close();
    }
    if (!expired)
        return;
    signal.throwIfAborted();
    await unlink(filePath).catch((error) => {
        if (errorCode(error) !== "ENOENT")
            throw error;
    });
    trace(`conversation persistence: maintenance discarded abandoned temp file=${path.basename(filePath)}`);
}
function scheduleMaintenance(cacheDir, now, force = false) {
    let state = maintenanceRoots.get(cacheDir);
    if (!state) {
        state = { controller: new AbortController() };
        maintenanceRoots.set(cacheDir, state);
    }
    if (state.task || state.controller.signal.aborted)
        return;
    if (!force && state.lastStarted !== undefined && now - state.lastStarted < MAINTENANCE_INTERVAL_MS)
        return;
    const current = state;
    const signal = current.controller.signal;
    const task = (async () => {
        await new Promise((resolve) => {
            const abort = () => {
                clearImmediate(current.scheduled);
                resolve();
            };
            current.scheduled = setImmediate(() => {
                signal.removeEventListener("abort", abort);
                current.scheduled = undefined;
                resolve();
            });
            current.scheduled.unref();
            signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        current.lastStarted = now;
        await testHook?.("maintenance-start", cacheDir);
        signal.throwIfAborted();
        await pruneConversationDirectory(cacheDir, now, signal);
    })();
    current.task = task;
    const done = () => {
        if (current.task === task)
            current.task = undefined;
    };
    void task.then(done, (error) => {
        done();
        if (!signal.aborted)
            trace(`conversation persistence: maintenance failed: ${String(error)}`);
    });
}
/** Readiness includes directory permissions only; maintenance never gates hydration. */
export async function initializeConversationPersistence(cacheDir, now = Date.now()) {
    const key = path.resolve(cacheDir);
    let pending = initializedRoots.get(key);
    if (!pending) {
        pending = ensureCacheDirectory(conversationCacheDirectoryPath(key));
        initializedRoots.set(key, pending);
        pending.catch(() => {
            if (initializedRoots.get(key) === pending)
                initializedRoots.delete(key);
        });
    }
    await pending;
    if (initializedRoots.get(key) === pending)
        scheduleMaintenance(key, now);
}
async function loadStore(cacheDir, sessionKey, now) {
    await initializeConversationPersistence(cacheDir, now);
    const filePath = conversationCacheFilePath(cacheDir, sessionKey);
    const loaded = await withFileOperation(filePath, async () => {
        const candidate = await readConversationFileWithStatus(filePath, sessionKey, now);
        try {
            if ((candidate.status === "invalid" || candidate.status === "expired") && candidate.identity) {
                if (candidate.sourcePath === filePath)
                    await discardCacheCandidate(filePath, candidate.identity);
                else if (candidate.sourcePath)
                    await unlink(candidate.sourcePath).catch((error) => {
                        if (errorCode(error) !== "ENOENT")
                            throw error;
                    });
                // A concurrent writer/recovery can replace the candidate during removal.
                const replacement = await readConversationFileWithStatus(filePath, sessionKey, now);
                await replacement.pin?.close();
                if (replacement.status !== "missing")
                    return replacement;
            }
            return candidate;
        }
        finally {
            await candidate.pin?.close();
        }
    });
    const value = loaded.value && loaded.value.sessionKey === sessionKey && isFresh(loaded.value, now)
        ? loaded.value
        : undefined;
    const loadStatus = loaded.status === "missing"
        ? startupDiscardedStatuses.get(path.resolve(cacheDir))?.get(path.basename(filePath)) ?? "missing"
        : loaded.status;
    return {
        cacheDir,
        sessionKey,
        ...(value ? { head: conversationHead(value), value } : {}),
        loadStatus,
        writeChain: Promise.resolve(),
    };
}
function conversationHead(value) {
    return {
        conversationId: value.conversationId,
        updatedAt: value.updatedAt,
        ...(value.turnProvenance ? { turnProvenance: value.turnProvenance } : {}),
    };
}
/**
 * Hand the loaded snapshot to its first reader, then read the durable copy.
 * Hydration needs it only while the session has no live binding, so keeping
 * a process-lifetime clone of every checkpoint and blob graph buys nothing.
 */
async function takeConversation(store, now) {
    const head = store.head;
    if (!head)
        return { status: store.loadStatus };
    const held = store.value;
    store.value = undefined;
    if (held && isFresh(held, now))
        return { status: "restored", value: held };
    await store.writeChain.catch(() => { });
    const filePath = conversationCacheFilePath(store.cacheDir, store.sessionKey);
    const loaded = await withFileOperation(filePath, async () => {
        const candidate = await readConversationFileWithStatus(filePath, store.sessionKey, now);
        await candidate.pin?.close();
        return candidate;
    });
    // A persist/delete that ran meanwhile owns the head; only report this read.
    if (store.head === head) {
        store.head = loaded.value ? conversationHead(loaded.value) : undefined;
        store.loadStatus = loaded.status;
    }
    return loaded.value ? { status: "restored", value: loaded.value } : { status: loaded.status };
}
async function getStore(cacheDir, sessionKey, now = Date.now()) {
    const root = path.resolve(cacheDir);
    const key = `${root}\0${sessionKey}`;
    let pending = stores.get(key);
    if (!pending) {
        pending = loadStore(root, sessionKey, now);
        stores.set(key, pending);
        pending.catch(() => {
            if (stores.get(key) === pending)
                stores.delete(key);
        });
    }
    return pending;
}
export async function getPersistedConversation(cacheDir, sessionKey, now = Date.now()) {
    return (await loadPersistedConversation(cacheDir, sessionKey, now)).value;
}
/** Read a snapshot together with the reason restart hydration did not restore it. */
export async function loadPersistedConversation(cacheDir, sessionKey, now = Date.now()) {
    return takeConversation(await getStore(cacheDir, sessionKey, now), now);
}
/** Turn provenance of the current snapshot, without decoding its payload. */
export async function getPersistedTurnProvenance(cacheDir, sessionKey, now = Date.now()) {
    const head = (await getStore(cacheDir, sessionKey, now)).head;
    if (!head?.turnProvenance || !isFresh(head, now))
        return undefined;
    return { conversationId: head.conversationId, turnProvenance: head.turnProvenance };
}
/** Replace one session's durable snapshot and refresh its 24-hour lease. */
export async function persistConversation(cacheDir, value, now = Date.now()) {
    const store = await getStore(cacheDir, value.sessionKey, now);
    // queueWrite takes its own copy; the store keeps only the head.
    const snapshot = {
        ...value,
        updatedAt: now,
        toolCatalog: value.toolCatalog ?? [],
        postCompactionRebase: value.postCompactionRebase === true,
    };
    store.head = conversationHead(snapshot);
    store.value = undefined;
    store.loadStatus = "restored";
    startupDiscardedStatuses.get(path.resolve(cacheDir))?.delete(path.basename(conversationCacheFilePath(cacheDir, value.sessionKey)));
    await testHook?.("before-write", conversationCacheFilePath(cacheDir, value.sessionKey));
    await queueWrite(store, snapshot);
    scheduleMaintenance(path.resolve(cacheDir), now);
}
/** Delete only the expected binding so an overlapping newer turn cannot be removed. */
export async function deletePersistedConversation(cacheDir, sessionKey, expectedConversationId) {
    const store = await getStore(cacheDir, sessionKey);
    const current = store.head;
    if (!current || (expectedConversationId && current.conversationId !== expectedConversationId))
        return;
    store.head = undefined;
    store.value = undefined;
    store.loadStatus = "missing";
    await queueDelete(store, current.conversationId);
}
/** Full snapshots still held in memory; the store should keep heads only. */
export async function retainedConversationSnapshotsForTests() {
    const settled = await Promise.allSettled(stores.values());
    return settled.filter((result) => result.status === "fulfilled" && result.value.value).length;
}
export function resetConversationPersistenceForTests() {
    for (const state of maintenanceRoots.values())
        state.controller.abort();
    maintenanceRoots.clear();
    fileOperations.clear();
    testHook = undefined;
    stores.clear();
    initializedRoots.clear();
    startupDiscardedStatuses.clear();
}
/** Deterministic maintenance barriers/race injection; not a request-path API. */
export function setConversationPersistenceHookForTests(hook) {
    testHook = hook;
}
export async function waitForConversationMaintenanceForTests(cacheDir, now = Date.now()) {
    const root = path.resolve(cacheDir);
    await initializeConversationPersistence(root, now);
    scheduleMaintenance(root, now, true);
    const state = maintenanceRoots.get(root);
    state.scheduled?.ref();
    await state.task;
}
