/**
 * Bounded CreatePlan write/review receipts for restart reconciliation.
 *
 * A saved file alone proves neither tool completion nor execution approval.
 * Incomplete operations fail closed; a new user turn is required.
 */
export type PlanOperationPhase = "write" | "review";
export type PlanOperationReceipt = {
    interactionId: number;
    createPlanToolCallId?: string;
    hostCallId: string;
    planPath: string;
    planUri: string;
    markdown: string;
    phase: PlanOperationPhase;
    bridgeKind: string;
    afterWrite?: "review" | "ack" | "hold";
    reviewToolName?: "plan_exit" | "question";
    consumedResultId?: string;
};
/** Refuse before mutation when the receipt budget is full. */
export declare function canAdmitPlanOperation(sessionKey: string | undefined, markdown: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function recordPlanOperation(sessionKey: string | undefined, receipt: PlanOperationReceipt): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function updatePlanOperationConsumed(sessionKey: string | undefined, hostCallId: string, consumedResultId: string, phase?: PlanOperationPhase): void;
export declare function clearPlanOperation(sessionKey: string | undefined, hostCallId: string): void;
export declare function clearPlanOperations(sessionKey: string | undefined): void;
export declare function planOperationsFor(sessionKey: string | undefined): readonly PlanOperationReceipt[];
/** Incomplete write/review after restart: fail closed; do not auto-replay mutation. */
export declare function incompletePlanOperations(sessionKey: string | undefined): readonly PlanOperationReceipt[];
export declare function serializePlanOperations(sessionKey: string): string | undefined;
export declare function restorePlanOperations(sessionKey: string, encoded: string | undefined): void;
export declare function resetPlanOperationsForTests(): void;
