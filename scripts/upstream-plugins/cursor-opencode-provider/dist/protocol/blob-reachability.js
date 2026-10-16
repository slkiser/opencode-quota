import protobuf from "protobufjs";
const MAX_NESTED_STATE_DEPTH = 64;
function hex(bytes) {
    let result = "";
    for (let index = 0; index < bytes.length; index++) {
        result += bytes[index].toString(16).padStart(2, "0");
    }
    return result;
}
/** Read only length-delimited fields while still validating the complete protobuf. */
function bytesFields(data) {
    const reader = protobuf.Reader.create(data);
    const fields = [];
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const number = tag >>> 3;
        const wireType = tag & 7;
        if (number === 0)
            throw new Error("invalid protobuf field zero");
        if (wireType === 2)
            fields.push({ number, bytes: reader.bytes() });
        else
            reader.skipType(wireType);
    }
    return fields;
}
function mapValue(entry) {
    return bytesFields(entry).find((field) => field.number === 2)?.bytes;
}
/**
 * Return the blob ids reachable from Cursor's latest ConversationStateStructure.
 *
 * This mirrors Cursor CLI's conversation-export traversal: turns lead to their
 * user message and steps, shell turns lead to command/output, state-level
 * summaries/todos/prompts are direct refs, and subagent states recurse. Unknown
 * protobuf fields are deliberately ignored for forward compatibility.
 *
 * `resolveBlob` must also resolve Cursor's content-as-id values. Throwing on a
 * missing hash or malformed referenced message makes the caller retain its full
 * snapshot rather than risk publishing an incomplete restart graph.
 */
export function collectReachableConversationBlobIds(checkpoint, resolveBlob) {
    const reachable = new Set();
    const reference = (id) => {
        if (id.length === 0)
            return undefined;
        reachable.add(hex(id));
        const value = resolveBlob(id);
        if (!value)
            throw new Error(`missing referenced blob ${hex(id)}`);
        return value;
    };
    const walkUserMessage = (data) => {
        const selectedContext = bytesFields(data).find((field) => field.number === 3)?.bytes;
        if (!selectedContext)
            return;
        for (const imageField of bytesFields(selectedContext)) {
            if (imageField.number !== 1)
                continue;
            for (const imagePart of bytesFields(imageField.bytes)) {
                if (imagePart.number === 1) {
                    reference(imagePart.bytes);
                }
                else if (imagePart.number === 9) {
                    const blobId = bytesFields(imagePart.bytes).find((field) => field.number === 1)?.bytes;
                    if (blobId)
                        reference(blobId);
                }
            }
        }
    };
    const walkTurn = (data) => {
        for (const turnField of bytesFields(data)) {
            if (turnField.number === 1) {
                for (const agentField of bytesFields(turnField.bytes)) {
                    if (agentField.number === 1) {
                        const userMessage = reference(agentField.bytes);
                        if (userMessage)
                            walkUserMessage(userMessage);
                    }
                    else if (agentField.number === 2) {
                        reference(agentField.bytes);
                    }
                }
                return;
            }
            if (turnField.number === 2) {
                for (const shellField of bytesFields(turnField.bytes)) {
                    if (shellField.number === 1 || shellField.number === 2) {
                        reference(shellField.bytes);
                    }
                }
                return;
            }
        }
    };
    const walkPersistedSubagent = (data, depth) => {
        const nestedState = bytesFields(data).find((field) => field.number === 1)?.bytes;
        if (nestedState)
            walkState(nestedState, depth + 1);
    };
    const walkState = (data, depth) => {
        if (depth > MAX_NESTED_STATE_DEPTH)
            throw new Error("conversation state nesting is too deep");
        for (const field of bytesFields(data)) {
            switch (field.number) {
                case 8: {
                    const turn = reference(field.bytes);
                    if (turn)
                        walkTurn(turn);
                    break;
                }
                case 1: // root_prompt_messages_json
                case 3: // todos
                case 6: // summary
                case 7: // plan
                case 13: // summary_archives
                    reference(field.bytes);
                    break;
                case 16: { // map<string, SubagentPersistedState> subagent_states
                    const persisted = mapValue(field.bytes);
                    if (persisted)
                        walkPersistedSubagent(persisted, depth);
                    break;
                }
                case 31: { // map<string, bytes> subagent_state_refs
                    const subagentId = mapValue(field.bytes);
                    if (!subagentId)
                        break;
                    const persisted = reference(subagentId);
                    if (persisted)
                        walkPersistedSubagent(persisted, depth);
                    break;
                }
            }
        }
    };
    walkState(checkpoint, 0);
    return reachable;
}
