/**
 * Context Epoch — V2-style immutable system baseline + chronological updates.
 *
 * Mirrors OpenCode research CONTEXT.md:
 * - One Baseline System Context per conversation_id (provider-cache prefix)
 * - Later Context Source changes → Mid-Conversation System Message on the
 *   user turn; the baseline itself never changes within the epoch
 * - Epoch ends on conversation remint (compaction / post-compaction rebase)
 *
 * The baseline reaches Cursor as the frozen system-instructions rule in
 * RequestContext (`systemInstructionsRule`), on every Run. `seedSystemPrompt`
 * marks the Runs that start a conversation; it is not sent as a `system`
 * message, which Cursor does not follow.
 */
import { createHash } from "node:crypto";
import { trace } from "../debug.js";
export const MAX_CONTEXT_EPOCHS = 256;
const byConversationId = new Map();
function sha(text) {
    return createHash("sha256").update(text).digest("hex");
}
function joinSections(parts) {
    return parts.map((part) => part?.trim()).filter((part) => !!part).join("\n\n");
}
function snapshotOf(input) {
    return {
        hostSystemHash: sha(input.hostSystem?.trim() || ""),
        guidanceHash: sha(input.guidance?.trim() || ""),
        hostAgent: input.hostAgent?.trim() || "",
        workspaceRoot: input.workspaceRoot,
    };
}
function buildBaseline(input) {
    // Durable System Context only. Mode/kickoff one-shots stay chronological.
    return joinSections([input.hostSystem, input.guidance]);
}
function wrapReminder(body) {
    const trimmed = body.trim();
    if (!trimmed)
        return "";
    if (trimmed.startsWith("<system_reminder>"))
        return trimmed;
    return `<system_reminder>\n${trimmed}\n</system_reminder>`;
}
function renderSourceUpdates(previous, next, live) {
    const parts = [];
    if (next.hostAgent && previous.hostAgent !== next.hostAgent) {
        parts.push(wrapReminder(`Host primary agent is now ${JSON.stringify(next.hostAgent)}. ` +
            "Follow this agent's instructions and tool permissions for the rest of the turn. " +
            "This is a chronological context update; the original system baseline is unchanged."));
    }
    if (live.hostSystem?.trim() && previous.hostSystemHash !== next.hostSystemHash) {
        parts.push(wrapReminder("Host system instructions were updated for this session. Effective instructions:\n\n" +
            live.hostSystem.trim()));
    }
    if (live.guidance?.trim() && previous.guidanceHash !== next.guidanceHash) {
        parts.push(wrapReminder("OpenCode interaction guidance was updated for this session:\n\n" + live.guidance.trim()));
    }
    if (previous.workspaceRoot !== next.workspaceRoot && next.workspaceRoot) {
        parts.push(wrapReminder(`Workspace root is now ${JSON.stringify(next.workspaceRoot)}. ` +
            "Resolve workspace paths against exactly this root; never invent an absolute prefix."));
    }
    return parts.filter(Boolean);
}
function touch(epoch) {
    byConversationId.delete(epoch.conversationId);
    byConversationId.set(epoch.conversationId, epoch);
    while (byConversationId.size > MAX_CONTEXT_EPOCHS) {
        const oldest = byConversationId.keys().next().value;
        if (!oldest)
            break;
        byConversationId.delete(oldest);
    }
}
function combineMessages(parts) {
    const text = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
    return text || undefined;
}
/**
 * Admit System Context at a Safe Provider-Turn Boundary.
 *
 * - First seed: freeze baseline, return it as seedSystemPrompt; one-shots → mid.
 * - Checkpoint turn: never returns seedSystemPrompt; source diffs + one-shots → mid.
 * - Reseed same epoch: return frozen baseline bytes (not live host text).
 * - Recovered: restore the persisted rule and reassert live context once on the
 *   user turn. A legacy checkpoint without a rule has no original bytes.
 */
export function admitContextEpoch(input) {
    const conversationId = input.conversationId;
    const nextSnap = snapshotOf(input);
    const oneShots = (input.oneShotReminders ?? []).map((part) => part.trim()).filter(Boolean);
    const existing = byConversationId.get(conversationId);
    if (!existing) {
        if (input.hasCheckpoint) {
            // Restart / soft-evict recovery: keep the original rule and reassert the
            // live instructions chronologically without changing the cache prefix.
            const baselineSystemPrompt = input.recoveredBaseline ?? "";
            const epoch = {
                conversationId,
                baselineSystemPrompt,
                baselineHash: baselineSystemPrompt ? sha(baselineSystemPrompt) : "",
                recovered: true,
                snapshot: nextSnap,
            };
            touch(epoch);
            // The persisted rule is the original prefix, not necessarily the current
            // host instructions. Reconcile live context once before recording its
            // snapshot; otherwise a changed prompt is silently treated as admitted.
            // Even equality with the original baseline needs an update: the last
            // checkpoint may contain an intervening mode/instruction change.
            const liveBaseline = buildBaseline(input);
            const recoveryUpdate = baselineSystemPrompt && liveBaseline
                ? wrapReminder("Current host system instructions after session recovery:\n\n" + liveBaseline)
                : "";
            const midConversationMessage = combineMessages([recoveryUpdate, ...oneShots]);
            trace(`context epoch: recovered conversationId=${conversationId} ` +
                `oneShots=${oneShots.length}`);
            return { action: "recovered", midConversationMessage, epoch };
        }
        const baselineSystemPrompt = buildBaseline(input);
        const baselineHash = sha(baselineSystemPrompt);
        const epoch = {
            conversationId,
            baselineSystemPrompt,
            baselineHash,
            recovered: false,
            snapshot: nextSnap,
        };
        touch(epoch);
        trace(`context epoch: initialize conversationId=${conversationId} ` +
            `baselineHash=${baselineHash.slice(0, 16)} baselineLen=${baselineSystemPrompt.length} ` +
            `oneShots=${oneShots.length}`);
        return {
            action: "initialize",
            seedSystemPrompt: baselineSystemPrompt || undefined,
            midConversationMessage: combineMessages(oneShots),
            epoch,
        };
    }
    // Optional sources may be unavailable on a turn. Absence is not an explicit
    // deletion signal: carrying the prior observation avoids synthetic context
    // churn and preserves the warm prefix.
    const observedSnap = {
        hostSystemHash: input.hostSystem?.trim()
            ? nextSnap.hostSystemHash
            : existing.snapshot.hostSystemHash,
        guidanceHash: input.guidance?.trim()
            ? nextSnap.guidanceHash
            : existing.snapshot.guidanceHash,
        hostAgent: input.hostAgent?.trim()
            ? nextSnap.hostAgent
            : existing.snapshot.hostAgent,
        workspaceRoot: nextSnap.workspaceRoot || existing.snapshot.workspaceRoot,
    };
    const updates = renderSourceUpdates(existing.snapshot, observedSnap, input);
    const changed = existing.snapshot.hostSystemHash !== observedSnap.hostSystemHash
        || existing.snapshot.guidanceHash !== observedSnap.guidanceHash
        || existing.snapshot.hostAgent !== observedSnap.hostAgent
        || existing.snapshot.workspaceRoot !== observedSnap.workspaceRoot;
    if (changed) {
        existing.snapshot = observedSnap;
    }
    touch(existing);
    if (input.hasCheckpoint) {
        const midConversationMessage = combineMessages([...updates, ...oneShots]);
        if (changed || oneShots.length) {
            trace(`context epoch: ${changed ? "updated" : "unchanged"} conversationId=${conversationId} ` +
                `checkpoint=1 updates=${updates.length} oneShots=${oneShots.length}`);
        }
        return {
            action: changed ? "updated" : "unchanged",
            midConversationMessage,
            epoch: existing,
        };
    }
    // Recovered epochs have no original baseline bytes. A later seed Run must
    // not freeze live host text as if it were the prefix Cursor already holds.
    if (existing.recovered && !existing.baselineSystemPrompt) {
        const midConversationMessage = combineMessages([...updates, ...oneShots]);
        trace(`context epoch: recovered-hold conversationId=${conversationId} ` +
            `checkpoint=0 updates=${updates.length} oneShots=${oneShots.length} seed=omitted`);
        return {
            action: changed ? "updated" : "recovered",
            midConversationMessage,
            epoch: existing,
        };
    }
    const midConversationMessage = combineMessages([...updates, ...oneShots]);
    if (changed) {
        trace(`context epoch: updated conversationId=${conversationId} checkpoint=0 ` +
            `updates=${updates.length} seed=frozen-baseline`);
    }
    return {
        action: changed ? "updated" : "unchanged",
        seedSystemPrompt: existing.baselineSystemPrompt || undefined,
        midConversationMessage,
        epoch: existing,
    };
}
export function getContextEpoch(conversationId) {
    const epoch = byConversationId.get(conversationId);
    if (!epoch)
        return undefined;
    touch(epoch);
    return epoch;
}
/** Drop epoch state (compaction remint / binding clear). */
export function clearContextEpoch(conversationId) {
    if (!conversationId)
        return;
    if (byConversationId.delete(conversationId)) {
        trace(`context epoch: cleared conversationId=${conversationId}`);
    }
}
/**
 * Compaction remints conversation_id. RequestContext workspace base transfers;
 * System Context baseline does not — the destination starts a fresh epoch.
 */
export function endContextEpoch(previousConversationId, nextConversationId) {
    clearContextEpoch(previousConversationId);
    if (nextConversationId)
        clearContextEpoch(nextConversationId);
}
export function resetContextEpochsForTests() {
    byConversationId.clear();
}
/** Append a mid-conversation message after user text (V2: user precedes update). */
export function appendMidConversationMessage(userText, midConversationMessage) {
    if (!midConversationMessage?.trim())
        return userText;
    if (!userText.trim())
        return midConversationMessage.trim();
    if (userText.includes(midConversationMessage.trim()))
        return userText;
    return `${userText}\n\n${midConversationMessage.trim()}`;
}
