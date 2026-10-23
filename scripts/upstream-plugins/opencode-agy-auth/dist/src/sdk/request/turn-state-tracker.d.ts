import { type ConversationState } from "./thinking";
export type TurnState = Pick<ConversationState, "inToolLoop" | "turnHasThinking" | "lastModelHasThinking" | "lastModelHasToolCalls">;
export declare class TurnStateTracker {
    private entries;
    private dirty;
    private lastWriteTime;
    private writeTimer;
    private readonly diskEnabled;
    constructor(diskEnabled?: boolean);
    getState(sessionId: string): TurnState | undefined;
    needsThinkingRecovery(sessionId: string): boolean;
    updateAfterResponse(sessionId: string, newState: TurnState): void;
    recoverFromContents(sessionId: string, contents: any[]): TurnState;
    clear(sessionId: string): void;
    shutdown(): void;
    private scheduleThrottledWrite;
    private clearWriteTimer;
}
export declare function initTurnStateTracker(): TurnStateTracker;
export declare function getTurnStateTracker(): TurnStateTracker | null;
export declare function shutdownTurnStateTracker(): void;
