import { trace } from "./debug.js";
import { CursorProtocolError } from "./errors.js";
import { sessionActivity } from "./activity.js";
export const DEFAULT_CONTINUATION_POLICY = {
    semanticIdleMs: 120_000,
    hardCapMs: 600_000,
    heartbeatMs: 5_000,
};
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_TOMBSTONE_TTL_MS = 15 * 60_000;
const DEFAULT_TOMBSTONE_LIMIT = 1_024;
// Well below Cursor's server-side concurrent-Run ceiling per HTTP/2 connection,
// so a caller that keeps abandoning Runs instead of delivering continuations
// gets corrected here instead of piling up open streams until Cursor's server
// force-closes the whole shared connection.
const DEFAULT_MAX_OPEN_SESSIONS = 24;
function positiveInteger(name, value, fallback) {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== "number" ||
        !Number.isSafeInteger(resolved) ||
        resolved <= 0 ||
        resolved > MAX_TIMER_MS) {
        throw new CursorProtocolError(`Cursor continuation ${name} must be a positive integer no greater than ${MAX_TIMER_MS}`);
    }
    return resolved;
}
export function resolveContinuationPolicy(options) {
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
        throw new CursorProtocolError("Cursor continuation options must be an object");
    }
    for (const key of Object.keys(options ?? {})) {
        if (!["heartbeatMs", "semanticIdleMs", "softHealthMs", "hardCapMs"].includes(key)) {
            throw new CursorProtocolError(`Unknown Cursor continuation option: ${key}`);
        }
    }
    if (options?.semanticIdleMs !== undefined &&
        options.softHealthMs !== undefined &&
        options.semanticIdleMs !== options.softHealthMs) {
        throw new CursorProtocolError("Cursor continuation semanticIdleMs and deprecated softHealthMs must match when both are set");
    }
    const heartbeatMs = positiveInteger("heartbeatMs", options?.heartbeatMs, DEFAULT_CONTINUATION_POLICY.heartbeatMs);
    const semanticIdleMs = positiveInteger("semanticIdleMs", options?.semanticIdleMs ?? options?.softHealthMs, DEFAULT_CONTINUATION_POLICY.semanticIdleMs);
    const hardCapMs = positiveInteger("hardCapMs", options?.hardCapMs, DEFAULT_CONTINUATION_POLICY.hardCapMs);
    if (heartbeatMs >= semanticIdleMs) {
        throw new CursorProtocolError("Cursor continuation heartbeatMs must be less than semanticIdleMs");
    }
    if (semanticIdleMs > hardCapMs) {
        throw new CursorProtocolError("Cursor continuation semanticIdleMs must be no greater than hardCapMs");
    }
    return { heartbeatMs, semanticIdleMs, hardCapMs };
}
export class SessionManager {
    // Composite key `${sessionId}:${execId}` → owning session. Composite keying
    // means two Run streams that both register an execId of 1 (Cursor resets
    // counters per stream) coexist instead of overwriting each other.
    byExecId = new Map();
    sessions = new Set();
    // Most recently registered open session per OpenCode session id. A second
    // registration for the same id means the caller started a fresh Run instead
    // of continuing the held-open one — the prior entry is stale and superseded.
    byOpenCodeSessionId = new Map();
    tombstones = new Map();
    now;
    setTimer;
    clearTimer;
    activitySource;
    tombstoneTtlMs;
    tombstoneLimit;
    maxOpenSessions;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
        this.activitySource = options.activitySource ?? sessionActivity;
        this.tombstoneTtlMs = positiveInteger("tombstoneTtlMs", options.tombstoneTtlMs, DEFAULT_TOMBSTONE_TTL_MS);
        this.tombstoneLimit = positiveInteger("tombstoneLimit", options.tombstoneLimit, DEFAULT_TOMBSTONE_LIMIT);
        this.maxOpenSessions = positiveInteger("maxOpenSessions", options.maxOpenSessions, DEFAULT_MAX_OPEN_SESSIONS);
    }
    registerSession(session) {
        if (session.closed)
            throw new CursorProtocolError("Cannot register a closed Cursor session");
        if (this.sessions.has(session))
            return;
        session.closed ??= false;
        session.closeError ??= null;
        session.pumpOwner ??= null;
        session.heartbeatCancel ??= null;
        session.hardDeadlineTimer ??= null;
        session.semanticDeadlineCancel ??= null;
        session.terminalUnsubscribe ??= null;
        session.deferredTerminalReason ??= null;
        session.policy ??= { ...DEFAULT_CONTINUATION_POLICY };
        session.createdAt ??= this.now();
        session.lastInboundAt ??= this.now();
        session.lastHeartbeatWriteAt ??= this.now();
        session.semanticDeadlineAt ??= this.now() + session.policy.semanticIdleMs;
        this.sessions.add(session);
        if (session.openCodeSessionId) {
            const prior = this.byOpenCodeSessionId.get(session.openCodeSessionId);
            if (prior && prior !== session && !prior.closed) {
                if (this.isPumping(prior)) {
                    // A live pull() is mid-await on this stream (nextFrameWithSemanticDeadline
                    // or the raw frame iterator). Forcing close() here would reject that await
                    // and propagate a real error to whatever still holds the ReadableStream —
                    // exactly the kind of self-inflicted failure this cap is meant to prevent.
                    // Let it finish or expire on its own (hard deadline / heartbeat failure).
                    trace(`sessionManager.registerSession: openCodeSessionId=${session.openCodeSessionId} ` +
                        `has a still-pumping prior session ${prior.sessionId} (pending=${prior.pending.size}) ` +
                        `— leaving it to finish or expire naturally instead of interrupting it`);
                }
                else {
                    // Display-only bridged pendings do not need a Cursor exec write — settle
                    // them first so a todowrite-only prior can still be superseded cleanly.
                    const settled = this.settleBridgedPending(prior);
                    if (settled > 0) {
                        trace(`sessionManager.registerSession: settled ${settled} bridged pending on prior ` +
                            `session ${prior.sessionId} before supersede`);
                    }
                    if (prior.pending.size > 0) {
                        // Real execs still outstanding — preparePriorSessionForFreshTurn should
                        // have cancelled + drained. Do not mid-exec supersede.
                        trace(`sessionManager.registerSession: openCodeSessionId=${session.openCodeSessionId} ` +
                            `has prior session ${prior.sessionId} with ${prior.pending.size} still-pending ` +
                            `exec(s) — refusing supersede; leaving held Run for cancel/drain/continuation`);
                    }
                    else {
                        trace(`sessionManager.registerSession: superseding stale session ${prior.sessionId} ` +
                            `(openCodeSessionId=${session.openCodeSessionId}, pending=${prior.pending.size}) ` +
                            `with new session ${session.sessionId}`);
                        this.close(prior, "superseded-by-new-run");
                    }
                }
            }
            this.byOpenCodeSessionId.set(session.openCodeSessionId, session);
        }
        this.enforceOpenSessionCap(session);
        this.subscribeTerminal(session);
    }
    /** Live open Run for this OpenCode session id, if any. */
    findOpenByOpenCodeSessionId(openCodeSessionId) {
        if (!openCodeSessionId)
            return undefined;
        const session = this.byOpenCodeSessionId.get(openCodeSessionId);
        return session && !session.closed ? session : undefined;
    }
    isActivelyPumping(session) {
        return this.isPumping(session);
    }
    /**
     * Clear display-only bridged pendings that do not require a Cursor exec write.
     * Used when the host starts a fresh user turn instead of returning the bridged
     * tool result (e.g. human `continue` while a todowrite mirror is outstanding).
     *
     * @returns number of bridged pendings settled
     */
    settleBridgedPending(session) {
        if (session.closed)
            return 0;
        let settled = 0;
        for (const [execId, pending] of [...session.pending.entries()]) {
            if (!pending.bridged)
                continue;
            if (pending.state === "claimed")
                continue;
            const key = this.key(session.sessionId, execId);
            this.putTombstone(key, "delivered");
            session.pending.delete(execId);
            this.byExecId.delete(key);
            settled++;
        }
        if (settled > 0) {
            if (session.pending.size === 0)
                this.recordSemanticProgress(session);
            this.scheduleHardDeadline(session);
        }
        return settled;
    }
    isPumping(session) {
        return session.pumpOwner != null || session.pumpActive;
    }
    /**
     * Force-close the oldest idle open session(s) once registration exceeds the
     * cap. Never closes a session with a live pull() mid-await, or one still
     * holding pending execs (continuation / fresh-turn cancel+drain owns those).
     * An unclosable backlog of genuinely active sessions just means the cap
     * can't be enforced until one finishes.
     */
    enforceOpenSessionCap(justRegistered) {
        while (this.sessions.size > this.maxOpenSessions) {
            let oldest;
            for (const candidate of this.sessions) {
                if (candidate === justRegistered || this.isPumping(candidate))
                    continue;
                // Held-open Runs with pending tools must not be cap-evicted — that is
                // mid-exec supersede by another name and throws away the prefix.
                if (candidate.pending.size > 0)
                    continue;
                if (!oldest || candidate.createdAt < oldest.createdAt)
                    oldest = candidate;
            }
            if (!oldest) {
                trace(`sessionManager.registerSession: open session cap exceeded ` +
                    `(${this.sessions.size} > ${this.maxOpenSessions}) but no idle session is ` +
                    `available to close — all remaining sessions are pumping or held-pending`);
                return;
            }
            trace(`sessionManager.registerSession: open session cap exceeded ` +
                `(${this.sessions.size} > ${this.maxOpenSessions}), force-closing oldest idle session ` +
                `${oldest.sessionId} (openCodeSessionId=${oldest.openCodeSessionId ?? "-"}, ` +
                `ageMs=${this.now() - oldest.createdAt}, pending=${oldest.pending.size})`);
            this.close(oldest, "open-session-cap-exceeded");
        }
    }
    recordSemanticProgress(session, at) {
        if (session.closed)
            return;
        const now = at ?? this.now();
        session.lastInboundAt = now;
        session.semanticDeadlineAt = now + session.policy.semanticIdleMs;
    }
    recordHeartbeatWrite(session) {
        if (!session.closed)
            session.lastHeartbeatWriteAt = this.now();
    }
    /** Register that `session` is awaiting a result for `execId`. */
    registerPending(execId, session, resultField, toolName, bridged = false, resultMetadata) {
        this.registerSession(session);
        if (session.closed)
            throw new CursorProtocolError("Cannot register a pending exec on a closed Cursor session");
        const now = this.now();
        const key = this.key(session.sessionId, execId);
        this.tombstones.delete(key);
        session.pending.set(execId, {
            resultField,
            toolName,
            bridged,
            resultMetadata,
            state: "pending",
            registeredAt: now,
            hardDeadlineAt: now + session.policy.hardCapMs,
        });
        this.byExecId.set(key, session);
        this.scheduleHardDeadline(session);
    }
    /** The pending exec info for an id on a specific session, if still awaiting it. */
    pendingFor(sessionId, execId) {
        return this.byExecId.get(this.key(sessionId, execId))?.pending.get(execId);
    }
    classify(sessionId, execId) {
        const key = this.key(sessionId, execId);
        const session = this.byExecId.get(key);
        if (session) {
            const pending = session.pending.get(execId);
            const legacyExpiresAt = session.expiresAt;
            if (!pending ||
                session.closed ||
                session.stream.isClosed() ||
                (typeof legacyExpiresAt === "number" && this.now() >= legacyExpiresAt)) {
                this.byExecId.delete(key);
                if (!session.closed)
                    this.close(session, "remote-clean-close");
            }
            else if (this.hardDeadlineExpired(session, pending)) {
                this.close(session, "hard-cap-expired");
            }
            else if (pending.state === "pending") {
                return { kind: "deliverable", session, pending };
            }
            else if (pending.state === "claimed") {
                return { kind: "duplicate", reason: "in-flight" };
            }
            else {
                return { kind: "duplicate", reason: "delivered" };
            }
        }
        const tombstone = this.getTombstone(key);
        if (!tombstone)
            return { kind: "missing", reason: "missing-process-local-state" };
        if (tombstone.reason === "delivered")
            return { kind: "duplicate", reason: "delivered" };
        return { kind: "terminal", reason: tombstone.reason };
    }
    claim(sessionId, execId) {
        const classification = this.classify(sessionId, execId);
        if (classification.kind !== "deliverable")
            return classification;
        classification.pending.state = "claimed";
        return {
            session: classification.session,
            execId,
            pending: classification.pending,
        };
    }
    deliverClaim(claim, frames) {
        const { session, execId, pending } = claim;
        const key = this.key(session.sessionId, execId);
        if (session.closed ||
            this.byExecId.get(key) !== session ||
            session.pending.get(execId) !== pending) {
            const current = this.classify(session.sessionId, execId);
            if (current.kind === "duplicate")
                return { ...current, framesWritten: 0 };
            if (current.kind === "terminal")
                return { ...current, framesWritten: 0 };
            return { kind: "missing", reason: "missing-process-local-state", framesWritten: 0 };
        }
        if (pending.state !== "claimed") {
            return {
                kind: "duplicate",
                reason: pending.state === "delivered" ? "delivered" : "in-flight",
                framesWritten: 0,
            };
        }
        if (this.hardDeadlineExpired(session, pending)) {
            this.close(session, "hard-cap-expired");
            return { kind: "terminal", reason: "hard-cap-expired", framesWritten: 0 };
        }
        let framesWritten = 0;
        try {
            if (!pending.bridged && frames.length === 0) {
                throw new CursorProtocolError("No result frames were produced");
            }
            for (const frame of frames) {
                session.stream.write(frame);
                framesWritten++;
            }
        }
        catch {
            const reason = framesWritten === 0 ? "result-write-failed" : "ambiguous-partial-write";
            this.close(session, reason);
            return { kind: "terminal", reason, framesWritten };
        }
        pending.state = "delivered";
        this.putTombstone(key, "delivered");
        session.pending.delete(execId);
        this.byExecId.delete(key);
        if (session.pending.size === 0)
            this.recordSemanticProgress(session);
        this.scheduleHardDeadline(session);
        return { kind: "delivered", framesWritten };
    }
    /** Find the live session awaiting one of the given exec ids. */
    findByExecIds(sessionId, execIds) {
        for (const id of execIds) {
            const classification = this.classify(sessionId, id);
            if (classification.kind === "deliverable")
                return classification.session;
        }
        return undefined;
    }
    /** Mark an exec id as resolved (its result has been delivered). */
    resolve(sessionId, execId) {
        const k = this.key(sessionId, execId);
        const s = this.byExecId.get(k);
        if (s) {
            s.pending.delete(execId);
            this.putTombstone(k, "delivered");
            this.scheduleHardDeadline(s);
        }
        this.byExecId.delete(k);
    }
    beginPump(session, owner) {
        this.registerSession(session);
        if (session.pumpOwner && session.pumpOwner !== owner) {
            throw new CursorProtocolError("Cursor session already has an active pump");
        }
        session.pumpOwner = owner;
        session.pumpActive = true;
    }
    isPumpOwner(session, owner) {
        return !session.closed && session.pumpOwner === owner;
    }
    endPump(session, owner) {
        if (session.pumpOwner !== owner)
            return false;
        session.pumpOwner = null;
        session.pumpActive = false;
        const deferred = session.deferredTerminalReason;
        session.deferredTerminalReason = null;
        if (deferred)
            this.close(session, deferred);
        return true;
    }
    /**
     * Swap the live bidi Run while a pump is still pulling frames.
     * Callers must cancel the session heartbeat and wait for the old stream's
     * write chain before this, so an in-flight heartbeat cannot close the session.
     */
    replaceStream(session, next, runId) {
        if (session.closed)
            throw new CursorProtocolError("Cannot replace stream on a closed Cursor session");
        session.heartbeatCancel?.();
        session.terminalUnsubscribe?.();
        session.terminalUnsubscribe = null;
        session.deferredTerminalReason = null;
        const old = session.stream;
        session.stream = next;
        if (runId !== undefined)
            session.runId = runId;
        session.frames = next.frames()[Symbol.asyncIterator]();
        session.pendingFrameRead = undefined;
        session.pushbackFrame = undefined;
        session.parallelStep = undefined;
        session.priorParallelStepCallIds = undefined;
        this.subscribeTerminal(session);
        try {
            old.destroy();
        }
        catch { /* already closed */ }
    }
    subscribeTerminal(session) {
        const boundStream = session.stream;
        const unsubscribe = boundStream.onTerminal?.((event) => {
            if (session.stream !== boundStream)
                return;
            this.onStreamTerminal(session, event);
        }) ?? (() => { });
        if (session.closed)
            unsubscribe();
        else
            session.terminalUnsubscribe = unsubscribe;
    }
    key(sessionId, execId) {
        return `${sessionId}:${execId}`;
    }
    close(session, reason = "ordinary-cleanup", error) {
        if (session.closed)
            return;
        session.closed = true;
        session.closeError = error ?? session.closeError ?? null;
        trace(`sessionManager.close: reason=${reason} pendingCount=${session.pending.size} blobs=${session.blobs.size}`);
        if (session.heartbeatCancel)
            session.heartbeatCancel();
        else if (session.heartbeat)
            clearInterval(session.heartbeat);
        session.heartbeat = null;
        session.heartbeatCancel = null;
        if (session.hardDeadlineTimer)
            this.clearTimer(session.hardDeadlineTimer);
        session.hardDeadlineTimer = null;
        session.semanticDeadlineCancel?.();
        session.semanticDeadlineCancel = null;
        session.terminalUnsubscribe?.();
        session.terminalUnsubscribe = null;
        session.deferredTerminalReason = null;
        for (const id of session.pending.keys()) {
            const key = this.key(session.sessionId, id);
            this.byExecId.delete(key);
            if (this.isTerminalReason(reason))
                this.putTombstone(key, reason);
        }
        session.pending.clear();
        session.pendingFrameRead = undefined;
        session.pushbackFrame = undefined;
        session.parallelStep = undefined;
        session.priorParallelStepCallIds = undefined;
        session.pumpOwner = null;
        session.pumpActive = false;
        session.displayToolCalls?.clear();
        session.mirroredTodos = undefined;
        session.blobs?.clear();
        this.sessions.delete(session);
        if (session.openCodeSessionId &&
            this.byOpenCodeSessionId.get(session.openCodeSessionId) === session) {
            this.byOpenCodeSessionId.delete(session.openCodeSessionId);
        }
        try {
            session.stream.destroy();
        }
        catch { /* already closed */ }
    }
    /**
     * Close only if nothing is awaiting a tool result AND no pull() is actively
     * pumping this session. OpenCode aborts each doStream after finishReason
     * "tool-calls"; that abort must NOT tear down the Cursor Run stream.
     * Equally, a late cancel from the previous ReadableStream must not destroy
     * the session once the continuation has cleared pending and resumed pumping.
     * Returns true if the session was closed.
     */
    closeUnlessPending(session) {
        if (session.closed)
            return true;
        const pumpActive = this.isPumping(session);
        if (session.pending.size > 0 || pumpActive) {
            trace(`sessionManager.closeUnlessPending: KEEP open pendingCount=${session.pending.size} pumpActive=${pumpActive}`);
            return false;
        }
        this.close(session, "ordinary-cleanup");
        return true;
    }
    dispose() {
        for (const session of [...this.sessions])
            this.close(session, "process-disposed");
        this.byExecId.clear();
    }
    sweepHardDeadlines() {
        for (const session of [...this.sessions]) {
            if (!session.closed &&
                [...session.pending.values()].some((pending) => this.hardDeadlineExpired(session, pending))) {
                this.close(session, "hard-cap-expired");
            }
        }
    }
    onStreamTerminal(session, event) {
        if (event.kind === "local-close" || session.closed)
            return;
        const reason = event.kind === "remote-error" ? "remote-error" : "remote-clean-close";
        if (event.kind === "remote-error")
            session.closeError = event.error;
        if (session.pumpOwner !== null) {
            session.deferredTerminalReason = reason;
            return;
        }
        this.close(session, reason, event.kind === "remote-error" ? event.error : undefined);
    }
    refreshHardDeadline(session, pending) {
        if (!session.openCodeSessionId)
            return pending.hardDeadlineAt;
        const activityAt = this.activitySource.lastActivityAt(session.openCodeSessionId);
        if (activityAt === undefined || activityAt <= pending.registeredAt)
            return pending.hardDeadlineAt;
        const renewedDeadline = activityAt + session.policy.hardCapMs;
        if (renewedDeadline > pending.hardDeadlineAt) {
            pending.hardDeadlineAt = renewedDeadline;
            trace("continuation lease renewed from OpenCode session activity");
        }
        return pending.hardDeadlineAt;
    }
    hardDeadlineExpired(session, pending) {
        return this.now() >= this.refreshHardDeadline(session, pending);
    }
    scheduleHardDeadline(session) {
        if (session.hardDeadlineTimer)
            this.clearTimer(session.hardDeadlineTimer);
        session.hardDeadlineTimer = null;
        if (session.closed || session.pending.size === 0)
            return;
        const earliest = Math.min(...[...session.pending.values()].map((pending) => this.refreshHardDeadline(session, pending)));
        const delayMs = Math.max(0, earliest - this.now());
        const timer = this.setTimer(() => {
            session.hardDeadlineTimer = null;
            if (session.closed)
                return;
            if ([...session.pending.values()].some((pending) => this.hardDeadlineExpired(session, pending))) {
                this.close(session, "hard-cap-expired");
            }
            else {
                this.scheduleHardDeadline(session);
            }
        }, delayMs);
        session.hardDeadlineTimer = timer;
        const unref = timer.unref;
        if (typeof unref === "function")
            unref.call(timer);
    }
    getTombstone(key) {
        const tombstone = this.tombstones.get(key);
        if (!tombstone)
            return undefined;
        if (this.now() >= tombstone.expiresAt) {
            this.tombstones.delete(key);
            return undefined;
        }
        return tombstone;
    }
    putTombstone(key, reason) {
        this.tombstones.delete(key);
        this.tombstones.set(key, {
            reason,
            expiresAt: this.now() + this.tombstoneTtlMs,
        });
        while (this.tombstones.size > this.tombstoneLimit) {
            const oldest = this.tombstones.keys().next().value;
            if (oldest === undefined)
                break;
            this.tombstones.delete(oldest);
        }
    }
    isTerminalReason(reason) {
        return !["ordinary-cleanup", "turn-ended", "initial-write-failed"].includes(reason);
    }
}
export async function readSessionFrame(session, timeoutMs) {
    if (session.pushbackFrame) {
        const value = session.pushbackFrame;
        session.pushbackFrame = undefined;
        return { done: false, value };
    }
    const pending = session.pendingFrameRead ??= session.frames.next();
    // A timed-out read can reject while no pump is consuming it. Preserve the
    // rejection for the next reader without an unhandled detached promise.
    void pending.catch(() => { });
    let timer;
    try {
        const result = timeoutMs === undefined ? await pending : await Promise.race([
            pending,
            new Promise(resolve => {
                timer = setTimeout(() => resolve({ done: true, timedOut: true }), timeoutMs);
                timer.unref?.();
            }),
        ]);
        if (!("timedOut" in result) && session.pendingFrameRead === pending) {
            session.pendingFrameRead = undefined;
        }
        return result;
    }
    catch (error) {
        if (session.pendingFrameRead === pending)
            session.pendingFrameRead = undefined;
        throw error;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export const sessionManager = new SessionManager();
function installProcessCleanup() {
    const dispose = () => {
        try {
            sessionManager.dispose();
        }
        catch {
            /* ignore */
        }
    };
    process.once("exit", dispose);
    process.once("beforeExit", dispose);
}
installProcessCleanup();
