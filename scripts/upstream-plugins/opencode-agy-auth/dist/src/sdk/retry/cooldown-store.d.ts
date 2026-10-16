export declare function loadCooldowns(): Map<string, number>;
export declare function saveCooldowns(entries: Map<string, number>): boolean;
export declare class CooldownStore {
    private dirty;
    private lastWriteTime;
    private writeTimer;
    private entries;
    bind(entries: Map<string, number>): void;
    markDirty(): void;
    flush(): boolean;
    shutdown(): void;
    private scheduleThrottledWrite;
    private clearWriteTimer;
}
