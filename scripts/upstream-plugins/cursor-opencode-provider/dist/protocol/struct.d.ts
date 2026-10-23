export type RawField = {
    fn: number;
    wt: number;
    varint: number;
    bytes?: Uint8Array;
    i64?: Uint8Array;
};
/** Walk a protobuf message's top-level fields off the raw wire bytes. */
export declare function readAllFields(b: Uint8Array): RawField[];
export type StrictRawField = {
    fn: number;
    wt: number;
    varint?: bigint;
    bytes?: Uint8Array;
    fixed64?: Uint8Array;
    fixed32?: Uint8Array;
};
/**
 * Strictly walk a protobuf message for security/replay decisions.
 *
 * Unlike `readAllFields`, this parser consumes the complete input, preserves
 * uint64 varints as bigint, represents fixed-width fields, and rejects invalid
 * tags, truncation, overflow, groups, and unsupported wire types. It deliberately
 * returns `undefined` instead of a partial result: callers must fail closed when
 * deciding whether replay is safe.
 */
export declare function readAllFieldsStrict(bytes: Uint8Array): StrictRawField[] | undefined;
/** Decode a google.protobuf.Value message (bytes) back into a JSON value. */
export declare function decodeValueToJson(bytes: Uint8Array): unknown;
/**
 * Decode a `map<string, Value>` field that was captured as repeated map-entry
 * messages (each `{1 key, 2 value}`) into a plain JSON object. Used for
 * `McpArgs.args`, which arrives as repeated field #2 on the wire.
 */
export declare function decodeStructEntriesToJson(entries: Uint8Array[]): Record<string, unknown>;
/** Encode an arbitrary JSON value as google.protobuf.Value bytes. */
export declare function encodeJsonAsValue(v: unknown): Uint8Array;
