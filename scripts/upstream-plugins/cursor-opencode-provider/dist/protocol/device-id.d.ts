/**
 * Stable device fingerprints, derived exactly like the Cursor CLI.
 * Cached for the process lifetime after first computation.
 */
export declare function getDeviceIds(): {
    machineId: string;
    macMachineId?: string;
};
