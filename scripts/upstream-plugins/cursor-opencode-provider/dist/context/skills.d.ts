import type { OpencodeToolDef } from "../protocol/tools.js";
import { type HostSkill } from "./skills-bridge.js";
export type HostSkillFileEntry = {
    readonly id: string;
    readonly path: string;
};
export type AgentSkillWire = {
    readonly full_path: string;
    readonly description: string;
};
/** Locations Cursor can advertise; markers / builtins are omitted. */
export declare function isUsableSkillLocation(location: string | undefined): boolean;
export declare function normalizeSkillLocation(location: string): string;
export declare function skillToolAdvertised(tools: readonly OpencodeToolDef[] | undefined): boolean;
/** Record skill files a Location's host currently registers (OpenCode 2 plugin). */
export declare function rememberHostSkillFiles(directory: string, skills: readonly HostSkillFileEntry[]): void;
export declare function hostSkillFiles(directory: string | undefined): ReadonlyMap<string, string> | undefined;
/** Test helper. */
export declare function resetHostSkillFilesForTests(): void;
/**
 * path-desc `agent_skills` for cataloged skills that have a usable location,
 * in catalog order. Descriptions come from the catalog (epoch-stable).
 */
export declare function agentSkillsForCursor(systemText: string | undefined, options: {
    skillToolAdvertised: boolean;
    skillFiles?: ReadonlyMap<string, string>;
    bridgeSkills?: readonly HostSkill[];
}): AgentSkillWire[];
/** Fetch locations from the structural bridge when installed. */
export declare function loadBridgeSkills(input: {
    workspaceRoot: string;
    sessionID?: string;
}): Promise<HostSkill[] | undefined>;
export declare function applyAgentSkillsToContext(context: Record<string, unknown>, skills: readonly AgentSkillWire[]): void;
