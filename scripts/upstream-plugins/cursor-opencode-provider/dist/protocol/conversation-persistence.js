import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { CONVERSATION_CACHE_DIR, CONVERSATION_CACHE_SCHEMA_VERSION, CONVERSATION_CACHE_TTL_MS, } from "../shared.js";
import { decodeMessageSparse, encodeMessage } from "./messages.js";
import { trace } from "../debug.js";
const stores = new Map();
const initializedRoots = new Map();
const startupDiscardedStatuses = new Map();
const MAX_CONVERSATION_CACHE_BYTES = 256 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
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
    };
}
/**
 * Private proto3 layout, encoded inline because the published package contains
 * compiled JS only:
 *
 * ConversationCache: schema_version=1, session_key=2, conversation_id=3,
 * updated_at=4, checkpoint=5, blobs=6, request_context=7, tool_catalog=8,
 * post_compaction_rebase=9, host_agent=10, system_prompt_hash=11,
 * turn_provenance_json=12.
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
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const wireType = tag & 7;
        switch (tag >>> 3) {
            case 1:
                if (wireType !== 0)
                    throw new Error("invalid schema version");
                schemaVersion = reader.uint32();
                break;
            case 2:
                if (wireType !== 2)
                    throw new Error("invalid session key");
                sessionKey = reader.string();
                break;
            case 3:
                if (wireType !== 2)
                    throw new Error("invalid conversation id");
                conversationId = reader.string();
                break;
            case 4:
                if (wireType !== 0)
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
    };
}
function decodeCacheFile(compressed, expectedSessionKey) {
    try {
        if (compressed.length > MAX_CONVERSATION_CACHE_BYTES)
            return undefined;
        const protobufBytes = gunzipSync(compressed, { maxOutputLength: MAX_CONVERSATION_CACHE_BYTES });
        const conversation = decodeProtobuf(protobufBytes);
        if (expectedSessionKey && conversation.sessionKey !== expectedSessionKey)
            return undefined;
        return conversation;
    }
    catch {
        return undefined;
    }
}
function isFresh(value, now) {
    return now - value.updatedAt <= CONVERSATION_CACHE_TTL_MS;
}
async function readConversationFile(filePath, expectedSessionKey) {
    try {
        return decodeCacheFile(await readFile(filePath), expectedSessionKey);
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (code !== "ENOENT")
            return undefined;
        return undefined;
    }
}
async function readConversationFileWithStatus(filePath, expectedSessionKey) {
    try {
        const value = decodeCacheFile(await readFile(filePath), expectedSessionKey);
        return value ? { status: "restored", value } : { status: "invalid" };
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        return { status: code === "ENOENT" ? "missing" : "invalid" };
    }
}
/**
 * Remove an invalid/stale candidate without deleting a fresh atomic replacement.
 * The candidate is first moved aside. If it turns out another process replaced
 * it between inspection and rename, hard-link it back only when the live path is
 * still empty; otherwise the writer's newer path wins.
 */
async function discardCacheCandidate(filePath, now) {
    const quarantinePath = `${filePath}.${process.pid}.${randomUUID()}.stale`;
    try {
        await rename(filePath, quarantinePath);
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT")
            return undefined;
        throw error;
    }
    try {
        const moved = await readConversationFile(quarantinePath);
        if (moved && isFresh(moved, now)) {
            try {
                await link(quarantinePath, filePath);
                return moved;
            }
            catch (error) {
                const code = error && typeof error === "object" && "code" in error
                    ? error.code
                    : undefined;
                if (code !== "EEXIST")
                    throw error;
                return await readConversationFile(filePath);
            }
        }
    }
    finally {
        await unlink(quarantinePath).catch(() => { });
    }
    return await readConversationFile(filePath);
}
async function writeConversationFile(cacheDir, value) {
    const directory = conversationCacheDirectoryPath(cacheDir);
    const filePath = conversationCacheFilePath(cacheDir, value.sessionKey);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const encoded = encodeCacheFile(value);
    const { protobufBytes } = encoded;
    const compressed = gzipSync(protobufBytes, { level: zlibConstants.Z_BEST_COMPRESSION });
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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32")
        await chmod(directory, 0o700);
}
function queueWrite(store, value) {
    const snapshot = cloneConversation(value);
    const write = store.writeChain.catch(() => { }).then(() => writeConversationFile(store.cacheDir, snapshot));
    store.writeChain = write;
    return write;
}
function queueDelete(store) {
    const write = store.writeChain.catch(() => { }).then(async () => {
        await unlink(conversationCacheFilePath(store.cacheDir, store.sessionKey)).catch((error) => {
            const code = error && typeof error === "object" && "code" in error
                ? error.code
                : undefined;
            if (code !== "ENOENT")
                throw error;
        });
    });
    store.writeChain = write;
    return write;
}
async function pruneConversationDirectory(cacheDir, now) {
    const directory = conversationCacheDirectoryPath(cacheDir);
    await ensureCacheDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile())
            return;
        const filePath = path.join(directory, entry.name);
        if (entry.name.endsWith(".json")) {
            trace(`conversation persistence: startup removed legacy JSON snapshot file=${entry.name}`);
            await unlink(filePath).catch(() => { });
            return;
        }
        if (!entry.name.endsWith(".pb.gz"))
            return;
        const loaded = await readConversationFileWithStatus(filePath);
        if (loaded.status === "invalid") {
            recordStartupDiscard(cacheDir, entry.name, "invalid");
            trace(`conversation persistence: startup discarded invalid snapshot file=${entry.name}`);
            await discardCacheCandidate(filePath, now);
        }
        else if (loaded.value && !isFresh(loaded.value, now)) {
            recordStartupDiscard(cacheDir, entry.name, "expired");
            trace(`conversation persistence: startup discarded expired snapshot ` +
                `sessionKey=${loaded.value.sessionKey} ageMs=${Math.max(0, now - loaded.value.updatedAt)}`);
            await discardCacheCandidate(filePath, now);
        }
    }));
}
/** Create the per-session cache directory and prune records older than 24 hours once per process. */
export async function initializeConversationPersistence(cacheDir, now = Date.now()) {
    const key = path.resolve(cacheDir);
    let pending = initializedRoots.get(key);
    if (!pending) {
        pending = pruneConversationDirectory(key, now);
        initializedRoots.set(key, pending);
        pending.catch(() => {
            if (initializedRoots.get(key) === pending)
                initializedRoots.delete(key);
        });
    }
    await pending;
}
async function loadStore(cacheDir, sessionKey, now) {
    await initializeConversationPersistence(cacheDir, now);
    const filePath = conversationCacheFilePath(cacheDir, sessionKey);
    const loaded = await readConversationFileWithStatus(filePath, sessionKey);
    let value = loaded.value;
    let loadStatus = loaded.status === "missing"
        ? startupDiscardedStatuses.get(path.resolve(cacheDir))?.get(path.basename(filePath)) ?? "missing"
        : loaded.status;
    if (value && !isFresh(value, now)) {
        loadStatus = "expired";
        value = await discardCacheCandidate(filePath, now);
        if (value && isFresh(value, now))
            loadStatus = "restored";
    }
    return {
        cacheDir,
        sessionKey,
        value: value && value.sessionKey === sessionKey && isFresh(value, now) ? value : undefined,
        loadStatus,
        writeChain: Promise.resolve(),
    };
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
    const store = await getStore(cacheDir, sessionKey, now);
    return store.value ? cloneConversation(store.value) : undefined;
}
/** Read a snapshot together with the reason restart hydration did not restore it. */
export async function loadPersistedConversation(cacheDir, sessionKey, now = Date.now()) {
    const store = await getStore(cacheDir, sessionKey, now);
    return store.value
        ? { status: "restored", value: cloneConversation(store.value) }
        : { status: store.loadStatus };
}
/** Replace one session's durable snapshot and refresh its 24-hour lease. */
export async function persistConversation(cacheDir, value, now = Date.now()) {
    const store = await getStore(cacheDir, value.sessionKey, now);
    const snapshot = cloneConversation({
        ...value,
        updatedAt: now,
        toolCatalog: structuredClone(value.toolCatalog ?? []),
        postCompactionRebase: value.postCompactionRebase === true,
    });
    store.value = snapshot;
    store.loadStatus = "restored";
    startupDiscardedStatuses.get(path.resolve(cacheDir))?.delete(path.basename(conversationCacheFilePath(cacheDir, value.sessionKey)));
    await queueWrite(store, snapshot);
}
/** Delete only the expected binding so an overlapping newer turn cannot be removed. */
export async function deletePersistedConversation(cacheDir, sessionKey, expectedConversationId) {
    const store = await getStore(cacheDir, sessionKey);
    const current = store.value;
    if (!current || (expectedConversationId && current.conversationId !== expectedConversationId))
        return;
    store.value = undefined;
    store.loadStatus = "missing";
    await queueDelete(store);
}
export function resetConversationPersistenceForTests() {
    stores.clear();
    initializedRoots.clear();
    startupDiscardedStatuses.clear();
}
