/**
 * Structural host-skills capability installed before an unchanged provider loads.
 * Same install timing as `opencode.host.path-bridge`.
 */
export const HOST_SKILLS_BRIDGE = Symbol.for("opencode.host.skills");
export function skillsBridge() {
    const value = globalThis[HOST_SKILLS_BRIDGE];
    if (!value || typeof value !== "object")
        return undefined;
    const bridge = value;
    return typeof bridge.list === "function" ? bridge : undefined;
}
/** Test helper: install or clear the structural skills bridge. */
export function setHostSkillsBridgeForTests(bridge) {
    const globals = globalThis;
    if (bridge)
        globals[HOST_SKILLS_BRIDGE] = bridge;
    else
        delete globals[HOST_SKILLS_BRIDGE];
}
