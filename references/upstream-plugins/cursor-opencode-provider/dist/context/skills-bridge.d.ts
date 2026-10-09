/**
 * Structural host-skills capability installed before an unchanged provider loads.
 * Same install timing as `opencode.host.path-bridge`.
 */
export declare const HOST_SKILLS_BRIDGE: unique symbol;
/** One host catalog skill the provider may advertise to Cursor. */
export type HostSkill = {
    name: string;
    id?: string;
    description: string;
    /** Absolute path, `file:` URL, or host URI (`skill://…`). Omit built-ins / markers. */
    location?: string;
};
export type OpenCodeSkillsBridge = {
    list(input: {
        directory: string;
        sessionID?: string;
    }): Promise<HostSkill[]>;
};
export declare function skillsBridge(): OpenCodeSkillsBridge | undefined;
/** Test helper: install or clear the structural skills bridge. */
export declare function setHostSkillsBridgeForTests(bridge: OpenCodeSkillsBridge | undefined): void;
