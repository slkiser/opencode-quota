// OpenCode 2 can evaluate the plugin and the AI SDK model as separate copies
// of this module (one per Location); the copy holding the Run must hear the
// plugin's interrupt.
const LISTENERS = Symbol.for("cursor-opencode-provider.host-interrupt-listeners");
const globals = globalThis;
const listeners = globals[LISTENERS] ??= new Set();
export function onHostInterrupt(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
/**
 * The host stopped this session's execution (OpenCode 2 never aborts `doStream`
 * for it). `reason: "shutdown"` keeps the turn for the next server start: its
 * state is saved, nothing is cancelled. Resolves once every listener settled.
 */
export async function notifyHostInterrupt(openCodeSessionId, reason, at = Date.now()) {
    await Promise.allSettled([...listeners].map(async (listener) => listener(openCodeSessionId, reason, at)));
}
