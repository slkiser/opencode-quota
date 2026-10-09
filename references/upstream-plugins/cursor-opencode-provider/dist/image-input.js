import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
export const MAX_CURSOR_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
function isToolMediaCaption(message) {
    if (!message || !Array.isArray(message.content))
        return false;
    const first = message.content[0];
    return first?.type === "text" && first.text === "Attached media from tool result:";
}
export function hasCursorUserImages(lastUser) {
    return !isToolMediaCaption(lastUser) && !!lastUser && Array.isArray(lastUser.content) && lastUser.content.some((part) => {
        if (!part || typeof part !== "object")
            return false;
        const file = part;
        return file.type === "file" && typeof file.mediaType === "string" && file.mediaType.startsWith("image/");
    });
}
function unsupported(functionality, message) {
    throw new UnsupportedFunctionalityError({ functionality, message });
}
export function assertCursorUserImageSupport(lastUser, supportsImages, modelId) {
    if (!hasCursorUserImages(lastUser) || supportsImages)
        return;
    unsupported("image input", `Cursor model ${JSON.stringify(modelId)} does not support image input`);
}
function decodeBase64(value, remaining) {
    const normalized = value.replace(/\s/g, "");
    if (!normalized || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized)) {
        return unsupported("image input", "Cursor provider received invalid base64 image data");
    }
    const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
    assertImageSize(Math.floor((normalized.length - padding) * 3 / 4), remaining);
    const data = Uint8Array.from(Buffer.from(normalized, "base64"));
    if (data.length === 0) {
        return unsupported("image input", "Cursor provider received an empty image");
    }
    return data;
}
function decodeDataUrl(value, remaining) {
    if (!value.startsWith("data:")) {
        return unsupported("image input", "Cursor provider supports base64-encoded image data URLs only");
    }
    const commaIndex = value.indexOf(",", 5);
    if (commaIndex < 0) {
        return unsupported("image input", "Cursor provider supports base64-encoded image data URLs only");
    }
    const metadata = value.slice(5, commaIndex);
    const finalSeparator = metadata.lastIndexOf(";");
    if (finalSeparator < 0 || metadata.slice(finalSeparator + 1) !== "base64") {
        return unsupported("image input", "Cursor provider supports base64-encoded image data URLs only");
    }
    const firstSeparator = metadata.indexOf(";");
    const mimeType = metadata.slice(0, firstSeparator);
    return {
        data: decodeBase64(value.slice(commaIndex + 1), remaining),
        mimeType: mimeType || undefined,
    };
}
function inferImageMimeType(data) {
    if (data.length >= 8 &&
        data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
        data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a)
        return "image/png";
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return "image/jpeg";
    }
    if (data.length >= 6) {
        const header = Buffer.from(data.subarray(0, 6)).toString("ascii");
        if (header === "GIF87a" || header === "GIF89a")
            return "image/gif";
    }
    if (data.length >= 12 &&
        Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
        Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP")
        return "image/webp";
    return undefined;
}
function assertImageSize(size, remaining) {
    if (size > remaining) {
        unsupported("image input", `Cursor provider image attachments exceed the ${MAX_CURSOR_IMAGE_INPUT_BYTES / 1024 / 1024} MiB limit`);
    }
}
function cursorImageBudget(value) {
    if (!Number.isFinite(value))
        return MAX_CURSOR_IMAGE_INPUT_BYTES;
    return Math.min(MAX_CURSOR_IMAGE_INPUT_BYTES, Math.max(0, Math.floor(value)));
}
function imageContentHash(data) {
    return createHash("sha256").update(data).digest("hex");
}
async function readResponseBytes(response, remaining) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > remaining) {
        assertImageSize(declaredLength, remaining);
    }
    if (!response.body) {
        const data = new Uint8Array(await response.arrayBuffer());
        assertImageSize(data.length, remaining);
        return data;
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.length;
            if (total > remaining) {
                await reader.cancel();
                assertImageSize(total, remaining);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }
    return data;
}
async function resolveImageData(value, remaining, signal) {
    if (value instanceof Uint8Array) {
        assertImageSize(value.length, remaining);
        return { data: Uint8Array.from(value) };
    }
    if (typeof value === "string") {
        return value.startsWith("data:") ? decodeDataUrl(value, remaining) : { data: decodeBase64(value, remaining) };
    }
    if (value.protocol === "data:")
        return decodeDataUrl(value.href, remaining);
    if (value.protocol === "file:") {
        const filePath = fileURLToPath(value);
        const info = await stat(filePath);
        assertImageSize(info.size, remaining);
        return { data: Uint8Array.from(await readFile(filePath)), filename: path.basename(filePath) };
    }
    if (value.protocol !== "http:" && value.protocol !== "https:") {
        return unsupported("image URL input", `Cursor provider does not support image URL protocol ${JSON.stringify(value.protocol)}`);
    }
    const response = await fetch(value, { signal });
    if (!response.ok) {
        return unsupported("image URL input", `Cursor provider could not fetch image URL (HTTP ${response.status})`);
    }
    return {
        data: await readResponseBytes(response, remaining),
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined,
        filename: path.basename(value.pathname) || undefined,
    };
}
async function decodeCursorImagePart(file, remaining, signal, defaultFilename, resolveLimit = remaining) {
    if (typeof file.mediaType !== "string" || !file.mediaType.startsWith("image/")) {
        return unsupported("file input", `Cursor provider supports image attachments only, not ${JSON.stringify(file.mediaType)}`);
    }
    if (!(file.data instanceof Uint8Array) && typeof file.data !== "string" && !(file.data instanceof URL)) {
        return unsupported("image input", "Cursor provider received an invalid image data value");
    }
    const resolved = await resolveImageData(file.data, resolveLimit, signal);
    assertImageSize(resolved.data.length, remaining);
    const declaredMimeType = file.mediaType;
    const mimeType = declaredMimeType === "image/*"
        ? (resolved.mimeType?.startsWith("image/") ? resolved.mimeType : inferImageMimeType(resolved.data))
        : declaredMimeType;
    if (!mimeType?.startsWith("image/") || mimeType === "image/*") {
        return unsupported("image input", "Cursor provider could not determine the image media type");
    }
    return {
        data: resolved.data,
        filename: (typeof file.filename === "string" && file.filename ? path.basename(file.filename) : undefined) ??
            resolved.filename ??
            defaultFilename,
        mimeType,
    };
}
export async function extractCursorUserImages(lastUser, signal, maxBytes = MAX_CURSOR_IMAGE_INPUT_BYTES) {
    if (!lastUser || !Array.isArray(lastUser.content))
        return [];
    const byteBudget = cursorImageBudget(maxBytes);
    const images = [];
    let totalBytes = 0;
    for (const part of lastUser.content) {
        if (!part || typeof part !== "object")
            continue;
        const file = part;
        if (file.type !== "file")
            continue;
        const image = await decodeCursorImagePart(toolImagePart(file) ?? file, byteBudget - totalBytes, signal, `image-${images.length + 1}`);
        totalBytes += image.data.length;
        images.push(image);
    }
    return images;
}
/** Normalize OpenCode / AI SDK attachment shapes before either delivery path. */
function toolImagePart(part) {
    if (!part || typeof part !== "object")
        return undefined;
    const file = part;
    if (!["file", "file-data", "image-data", "image-url", "media", "image"].includes(String(file.type)))
        return undefined;
    const mediaType = typeof file.mediaType === "string" ? file.mediaType
        : file.type === "image-url" ? "image/*" : file.mime;
    if (typeof mediaType !== "string" || !mediaType.startsWith("image/"))
        return undefined;
    const source = file.url ?? file.uri;
    const data = file.data ?? (typeof source === "string" && /^(?:https?|file):/.test(source) && URL.canParse(source)
        ? new URL(source) : source);
    return { ...file, mediaType, data };
}
function pushImageFileParts(parts, content, toolResult = false) {
    for (const part of content) {
        const file = toolImagePart(part);
        if (file?.type === "file")
            parts.push({ file, toolResult });
    }
}
function cursorHistoryImageParts(prompt) {
    const parts = [];
    // Last user attachments stay owned by extractCursorUserImages so a prompt that
    // still carries images on the trailing user message is not double-attached.
    let lastUserIndex = -1;
    for (let i = 0; i < prompt.length; i++) {
        const message = prompt[i];
        if (!message || typeof message !== "object")
            continue;
        if (message.role === "user")
            lastUserIndex = i;
    }
    for (let i = 0; i < prompt.length; i++) {
        const message = prompt[i];
        if (!message || typeof message !== "object")
            continue;
        const record = message;
        if (!Array.isArray(record.content))
            continue;
        if (record.role === "user") {
            if (i === lastUserIndex)
                continue;
            pushImageFileParts(parts, record.content, isToolMediaCaption(record));
            continue;
        }
        if (record.role === "assistant") {
            pushImageFileParts(parts, record.content);
            continue;
        }
        if (record.role !== "tool")
            continue;
        for (const part of record.content) {
            if (!part || typeof part !== "object")
                continue;
            const toolResult = part;
            if (toolResult.type !== "tool-result" || !toolResult.output || typeof toolResult.output !== "object") {
                continue;
            }
            const output = toolResult.output;
            if (output.type !== "content" || !Array.isArray(output.value))
                continue;
            for (const value of output.value) {
                if (!value || typeof value !== "object")
                    continue;
                const file = toolImagePart(value);
                if (file)
                    parts.push({ file, toolResult: true });
            }
        }
    }
    return parts;
}
export async function extractCursorHistoryImages(prompt, options) {
    const candidates = cursorHistoryImageParts(prompt);
    if (!options.supportsImages) {
        return { images: [], hashes: [], candidateCount: candidates.length, duplicateCount: 0 };
    }
    const maxBytes = cursorImageBudget(options.maxBytes ?? MAX_CURSOR_IMAGE_INPUT_BYTES);
    const images = [];
    const hashes = [];
    const hashesThisTurn = new Set();
    let duplicateCount = 0;
    let omittedCount = 0;
    let totalBytes = 0;
    for (const { file, toolResult } of candidates) {
        // Resolve against the per-image cap first so a previously sent duplicate
        // does not fail merely because little combined budget remains this turn.
        let image;
        try {
            image = await decodeCursorImagePart(file, MAX_CURSOR_IMAGE_INPUT_BYTES, options.signal, `image-${(options.filenameOffset ?? 0) + images.length + 1}`);
        }
        catch (error) {
            options.signal?.throwIfAborted();
            if (!toolResult || (error instanceof Error && error.name === "AbortError"))
                throw error;
            omittedCount++;
            continue;
        }
        const hash = imageContentHash(image.data);
        if (options.seenHashes?.has(hash) || hashesThisTurn.has(hash)) {
            duplicateCount++;
            continue;
        }
        assertImageSize(image.data.length, maxBytes - totalBytes);
        totalBytes += image.data.length;
        images.push(image);
        hashes.push(hash);
        hashesThisTurn.add(hash);
    }
    return { images, hashes, candidateCount: candidates.length, duplicateCount, ...(omittedCount > 0 ? { omittedCount } : {}) };
}
/**
 * Decode the images a host tool returned (its own `file-data` / `image-data`
 * parts, or the `file` parts OpenCode moves into the trailing
 * `Attached media from tool result:` message) for a held-Run exec result.
 * Non-image parts are skipped; a part that cannot be decoded is dropped so the
 * text result is still delivered.
 */
export async function extractCursorToolResultImages(parts, options = {}) {
    const maxBytes = cursorImageBudget(options.maxBytes ?? MAX_CURSOR_IMAGE_INPUT_BYTES);
    const images = [];
    const hashes = [];
    let totalBytes = 0;
    let omittedCount = 0;
    options.signal?.throwIfAborted();
    for (const part of parts) {
        options.signal?.throwIfAborted();
        const file = toolImagePart(part);
        if (!file)
            continue;
        if (images.length >= (options.maxImages ?? Infinity) || totalBytes >= maxBytes) {
            omittedCount++;
            continue;
        }
        try {
            const image = await decodeCursorImagePart(file, maxBytes - totalBytes, options.signal, `image-${images.length + 1}`);
            options.signal?.throwIfAborted();
            totalBytes += image.data.length;
            images.push(image);
            hashes.push(imageContentHash(image.data));
        }
        catch (error) {
            // Tool media is optional: a missing file or failed download must not
            // strand every pending exec. Cancellation still belongs to the caller.
            options.signal?.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError")
                throw error;
            omittedCount++;
        }
    }
    return { images, hashes, omittedCount };
}
export async function extractCursorPromptImages(prompt, lastUser, options) {
    const maxBytes = cursorImageBudget(options.maxBytes ?? MAX_CURSOR_IMAGE_INPUT_BYTES);
    const toolCaption = isToolMediaCaption(lastUser);
    const caption = toolCaption && options.supportsImages
        ? await extractCursorToolResultImages(lastUser.content, { signal: options.signal, maxBytes })
        : undefined;
    const captionHashes = [];
    const seenHashes = new Set(options.seenHistoryHashes);
    let captionDuplicates = 0;
    const userImages = toolCaption ? (caption?.images ?? []).filter((_image, index) => {
        const hash = caption.hashes[index];
        if (seenHashes.has(hash)) {
            captionDuplicates++;
            return false;
        }
        seenHashes.add(hash);
        captionHashes.push(hash);
        return true;
    }) : await extractCursorUserImages(lastUser, options.signal, maxBytes);
    const userBytes = userImages.reduce((total, image) => total + image.data.length, 0);
    // Seed history dedupe with this-turn last-user hashes so the same bytes on an
    // earlier user/assistant/tool message are not attached twice in one Run.
    for (const image of userImages)
        seenHashes.add(imageContentHash(image.data));
    const history = await extractCursorHistoryImages(prompt, {
        supportsImages: options.supportsImages,
        seenHashes,
        signal: options.signal,
        maxBytes: maxBytes - userBytes,
        filenameOffset: userImages.length,
    });
    return {
        ...history,
        hashes: [...captionHashes, ...history.hashes],
        duplicateCount: history.duplicateCount + captionDuplicates,
        images: [...userImages, ...history.images],
        userImageCount: toolCaption ? 0 : userImages.length,
        ...((history.omittedCount ?? 0) + (caption?.omittedCount ?? 0) > 0
            ? { omittedCount: (history.omittedCount ?? 0) + (caption?.omittedCount ?? 0) } : {}),
    };
}
