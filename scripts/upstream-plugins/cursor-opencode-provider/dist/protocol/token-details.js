import protobuf from "protobufjs";
/** Cursor can update occupancy while retaining categories from an older checkpoint. */
export function currentCursorTokenBreakdown(details) {
    const breakdown = details?.breakdown;
    return breakdown
        && breakdown.totalUsedTokens === details.usedTokens
        && breakdown.maxTokens === details.maxTokens
        ? breakdown
        : undefined;
}
const MAX_BREAKDOWN_CATEGORIES = 128;
function requireWireType(actual, expected, field) {
    if (actual !== expected)
        throw new Error(`invalid ${field} wire type`);
}
function decodeCategory(data) {
    const reader = protobuf.Reader.create(data);
    let id = "";
    let label = "";
    let estimatedTokens = 0;
    let characterCount;
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const wireType = tag & 7;
        switch (tag >>> 3) {
            case 1:
                requireWireType(wireType, 2, "category id");
                id = reader.string();
                break;
            case 2:
                requireWireType(wireType, 2, "category label");
                label = reader.string();
                break;
            case 3:
                requireWireType(wireType, 0, "category token count");
                estimatedTokens = reader.uint32();
                break;
            case 4:
                requireWireType(wireType, 0, "category character count");
                characterCount = reader.uint32();
                break;
            default:
                reader.skipType(wireType);
        }
    }
    return {
        id,
        label,
        estimatedTokens,
        ...(characterCount === undefined ? {} : { characterCount }),
    };
}
function decodeBreakdown(data) {
    const reader = protobuf.Reader.create(data);
    let totalUsedTokens = 0;
    let maxTokens = 0;
    const categories = [];
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const wireType = tag & 7;
        switch (tag >>> 3) {
            case 1:
                requireWireType(wireType, 0, "breakdown used tokens");
                totalUsedTokens = reader.uint32();
                break;
            case 2:
                requireWireType(wireType, 0, "breakdown max tokens");
                maxTokens = reader.uint32();
                break;
            case 3:
                requireWireType(wireType, 2, "breakdown category");
                if (categories.length < MAX_BREAKDOWN_CATEGORIES) {
                    categories.push(decodeCategory(reader.bytes()));
                }
                else {
                    reader.bytes();
                }
                break;
            default:
                reader.skipType(wireType);
        }
    }
    return { totalUsedTokens, maxTokens, categories };
}
function decodeTokenDetails(data) {
    const reader = protobuf.Reader.create(data);
    let usedTokens = 0;
    let maxTokens = 0;
    let sawUsedTokens = false;
    let sawMaxTokens = false;
    let breakdown;
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const wireType = tag & 7;
        switch (tag >>> 3) {
            case 1:
                requireWireType(wireType, 0, "used tokens");
                usedTokens = reader.uint32();
                sawUsedTokens = true;
                break;
            case 2:
                requireWireType(wireType, 0, "max tokens");
                maxTokens = reader.uint32();
                sawMaxTokens = true;
                break;
            case 3:
                requireWireType(wireType, 2, "token breakdown");
                breakdown = decodeBreakdown(reader.bytes());
                break;
            default:
                reader.skipType(wireType);
        }
    }
    if (!sawUsedTokens && !sawMaxTokens && !breakdown)
        return undefined;
    return {
        usedTokens,
        maxTokens,
        ...(breakdown ? { breakdown } : {}),
    };
}
/**
 * Read field #5 (`ConversationTokenDetails`) from Cursor's opaque
 * `ConversationStateStructure` checkpoint without decoding or re-encoding the
 * rest of the state. Unknown checkpoint fields therefore remain byte-exact.
 */
export function decodeConversationTokenDetails(checkpoint) {
    if (!checkpoint?.length)
        return undefined;
    try {
        const reader = protobuf.Reader.create(checkpoint);
        let details;
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const wireType = tag & 7;
            if ((tag >>> 3) === 5) {
                requireWireType(wireType, 2, "conversation token details");
                details = decodeTokenDetails(reader.bytes());
            }
            else {
                reader.skipType(wireType);
            }
        }
        return details;
    }
    catch {
        return undefined;
    }
}
export function cursorContextUsageMetadata(details, source = "checkpoint-current-run") {
    const usedPercent = details.maxTokens > 0
        ? Math.max(0, Math.min(100, Math.round(details.usedTokens / details.maxTokens * 1_000) / 10))
        : undefined;
    const breakdown = currentCursorTokenBreakdown(details);
    return {
        contextUsageVersion: 2,
        source,
        stale: source === "checkpoint-previous-turn",
        usedTokens: details.usedTokens,
        maxTokens: details.maxTokens,
        remainingTokens: Math.max(0, details.maxTokens - details.usedTokens),
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(breakdown ? { breakdown } : {}),
    };
}
