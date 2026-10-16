// Minimal encoder for google.protobuf.Value / Struct / ListValue.
//
// Cursor's per-turn tool descriptors carry the tool `input_schema` (a JSON
// Schema object) as a `google.protobuf.Value` whose `struct_value` holds the
// schema — NOT a JSON string. Verified against a live capture
// (request_context #7 → McpToolDefinition #3):
//   2a 9a07  0a10 0a04 74797065 1208 1a06 6f626a656374 ...
//   = Value{#5 struct_value: Struct{#1 fields: {"type": Value{#3 string "object"}}}}
//
// Field numbers (well-known types):
//   Value:     1 null_value, 2 number_value(double), 3 string_value,
//              4 bool_value, 5 struct_value(Struct), 6 list_value(ListValue)
//   Struct:    1 fields (map<string, Value>) — each entry msg{1 key, 2 value}
//   ListValue: 1 values (repeated Value)
function writeVarint(out, n) {
    let v = n >>> 0;
    while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
}
function writeTag(out, field, wire) {
    writeVarint(out, (field << 3) | wire);
}
function writeLengthDelimited(out, field, bytes) {
    writeTag(out, field, 2);
    writeVarint(out, bytes.length);
    for (let i = 0; i < bytes.length; i++)
        out.push(bytes[i]);
}
function writeString(out, field, str) {
    writeLengthDelimited(out, field, new TextEncoder().encode(str));
}
function writeDouble(out, field, num) {
    writeTag(out, field, 1); // 64-bit
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, num, true); // little-endian
    const view = new Uint8Array(buf);
    for (let i = 0; i < 8; i++)
        out.push(view[i]);
}
function readVarintAt(b, i) {
    let r = 0, s = 0;
    while (i < b.length) {
        const x = b[i++];
        r |= (x & 0x7f) << s;
        if (!(x & 0x80))
            break;
        s += 7;
    }
    return [r >>> 0, i];
}
/** Walk a protobuf message's top-level fields off the raw wire bytes. */
export function readAllFields(b) {
    let i = 0;
    const out = [];
    while (i < b.length) {
        let key;
        [key, i] = readVarintAt(b, i);
        const fn = key >>> 3, wt = key & 7;
        if (wt === 0) {
            let v;
            [v, i] = readVarintAt(b, i);
            out.push({ fn, wt, varint: v });
        }
        else if (wt === 2) {
            let len;
            [len, i] = readVarintAt(b, i);
            out.push({ fn, wt, varint: 0, bytes: b.subarray(i, i + len) });
            i += len;
        }
        else if (wt === 1) {
            out.push({ fn, wt, varint: 0, i64: b.subarray(i, i + 8) });
            i += 8;
        }
        else if (wt === 5) {
            i += 4; // i32 — not used by Value
        }
        else
            break;
    }
    return out;
}
const MAX_UINT32 = 0xffffffffn;
const MAX_UINT64 = 0xffffffffffffffffn;
const MAX_PROTOBUF_FIELD_NUMBER = 0x1fff_ffff;
/**
 * Decode one unsigned protobuf varint without JavaScript's 32-bit bitwise
 * truncation. `maximum` also enforces the protocol width: tags and lengths are
 * uint32, while wire-type 0 scalar values may use the full uint64 range.
 */
function readBoundedVarint(bytes, offset, maximum) {
    let value = 0n;
    let shift = 0n;
    for (let index = offset; index < bytes.length && index < offset + 10; index++) {
        const byte = bytes[index];
        value |= BigInt(byte & 0x7f) << shift;
        if (value > maximum)
            return undefined;
        if ((byte & 0x80) === 0)
            return { value, nextOffset: index + 1 };
        shift += 7n;
    }
    return undefined;
}
/**
 * Strictly walk a protobuf message for security/replay decisions.
 *
 * Unlike `readAllFields`, this parser consumes the complete input, preserves
 * uint64 varints as bigint, represents fixed-width fields, and rejects invalid
 * tags, truncation, overflow, groups, and unsupported wire types. It deliberately
 * returns `undefined` instead of a partial result: callers must fail closed when
 * deciding whether replay is safe.
 */
export function readAllFieldsStrict(bytes) {
    let offset = 0;
    const fields = [];
    while (offset < bytes.length) {
        const tag = readBoundedVarint(bytes, offset, MAX_UINT32);
        if (!tag)
            return undefined;
        offset = tag.nextOffset;
        const fieldNumber = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (fieldNumber === 0 || fieldNumber > MAX_PROTOBUF_FIELD_NUMBER)
            return undefined;
        if (wireType === 0) {
            const scalar = readBoundedVarint(bytes, offset, MAX_UINT64);
            if (!scalar)
                return undefined;
            fields.push({ fn: fieldNumber, wt: wireType, varint: scalar.value });
            offset = scalar.nextOffset;
            continue;
        }
        if (wireType === 1) {
            if (offset + 8 > bytes.length)
                return undefined;
            fields.push({ fn: fieldNumber, wt: wireType, fixed64: bytes.subarray(offset, offset + 8) });
            offset += 8;
            continue;
        }
        if (wireType === 2) {
            const encodedLength = readBoundedVarint(bytes, offset, MAX_UINT32);
            if (!encodedLength)
                return undefined;
            offset = encodedLength.nextOffset;
            const length = Number(encodedLength.value);
            if (offset + length > bytes.length)
                return undefined;
            fields.push({ fn: fieldNumber, wt: wireType, bytes: bytes.subarray(offset, offset + length) });
            offset += length;
            continue;
        }
        if (wireType === 5) {
            if (offset + 4 > bytes.length)
                return undefined;
            fields.push({ fn: fieldNumber, wt: wireType, fixed32: bytes.subarray(offset, offset + 4) });
            offset += 4;
            continue;
        }
        // Groups (3/4) are deprecated and recursive; no replay-safe frame uses them.
        return undefined;
    }
    return fields;
}
function decodeStructBytes(b) {
    const obj = {};
    for (const f of readAllFields(b)) {
        if (f.fn !== 1 || !f.bytes)
            continue; // Struct.fields (map) entries
        const { key, valBytes } = readMapEntry(f.bytes);
        if (key !== undefined)
            obj[key] = valBytes ? decodeValueToJson(valBytes) : null;
    }
    return obj;
}
function decodeListBytes(b) {
    const arr = [];
    for (const f of readAllFields(b)) {
        if (f.fn === 1 && f.bytes)
            arr.push(decodeValueToJson(f.bytes));
    }
    return arr;
}
function readMapEntry(b) {
    let key;
    let valBytes;
    for (const e of readAllFields(b)) {
        if (e.fn === 1 && e.bytes)
            key = new TextDecoder().decode(e.bytes);
        else if (e.fn === 2 && e.bytes)
            valBytes = e.bytes;
    }
    return { key, valBytes };
}
/** Decode a google.protobuf.Value message (bytes) back into a JSON value. */
export function decodeValueToJson(bytes) {
    const fs = readAllFields(bytes);
    if (fs.length === 0)
        return null;
    const f = fs[0];
    switch (f.fn) {
        case 1: return null; // null_value
        case 2: return f.i64 ? new DataView(f.i64.buffer, f.i64.byteOffset, 8).getFloat64(0, true) : 0;
        case 3: return f.bytes ? new TextDecoder().decode(f.bytes) : "";
        case 4: return f.varint !== 0;
        case 5: return f.bytes ? decodeStructBytes(f.bytes) : {};
        case 6: return f.bytes ? decodeListBytes(f.bytes) : [];
        default: return null;
    }
}
/**
 * Decode a `map<string, Value>` field that was captured as repeated map-entry
 * messages (each `{1 key, 2 value}`) into a plain JSON object. Used for
 * `McpArgs.args`, which arrives as repeated field #2 on the wire.
 */
export function decodeStructEntriesToJson(entries) {
    const obj = {};
    for (const entry of entries) {
        const { key, valBytes } = readMapEntry(entry);
        if (key !== undefined)
            obj[key] = valBytes ? decodeValueToJson(valBytes) : null;
    }
    return obj;
}
/** Encode an arbitrary JSON value as google.protobuf.Value bytes. */
export function encodeJsonAsValue(v) {
    const out = [];
    if (v === null || v === undefined) {
        writeTag(out, 1, 0); // null_value = 0
        writeVarint(out, 0);
    }
    else if (typeof v === "number") {
        writeDouble(out, 2, v);
    }
    else if (typeof v === "boolean") {
        writeTag(out, 4, 0);
        writeVarint(out, v ? 1 : 0);
    }
    else if (typeof v === "string") {
        writeString(out, 3, v);
    }
    else if (Array.isArray(v)) {
        const lv = [];
        for (const item of v)
            writeLengthDelimited(lv, 1, encodeJsonAsValue(item));
        writeLengthDelimited(out, 6, new Uint8Array(lv));
    }
    else if (typeof v === "object") {
        const st = [];
        for (const [key, val] of Object.entries(v).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
            if (val === undefined)
                continue;
            const entry = [];
            writeString(entry, 1, key);
            writeLengthDelimited(entry, 2, encodeJsonAsValue(val));
            writeLengthDelimited(st, 1, new Uint8Array(entry));
        }
        writeLengthDelimited(out, 5, new Uint8Array(st));
    }
    else {
        // Fallback: treat as null.
        writeTag(out, 1, 0);
        writeVarint(out, 0);
    }
    return new Uint8Array(out);
}
