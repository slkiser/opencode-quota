import { type CursorProviderError } from "./errors.js";
/** Plain data shared by the plugin and SDK copies, for one logical user turn. */
export type RetryBudget = {
    server: number;
    transport: number;
    retries: number;
    stallStartedAt?: number;
    /** A plain-text host continuation is admitted only after we requested a host retry. */
    hostRetryPending?: boolean;
    hostRetryKey?: string;
};
export declare function newRetryBudget(): RetryBudget;
/** A host retry or tool continuation must not mint a fresh retry allowance. */
export declare function turnRetryBudget(sessionKey: string | undefined, turnKey: string, continuationKey?: string): RetryBudget;
export declare function forgetRetryBudget(sessionKey: string | undefined, budget?: RetryBudget): void;
export declare function endlessRetriesEnabled(): boolean;
/** CLI's incomplete-stream error is explicitly transport; an idle deadline is server. */
export declare function retryCategory(failure: CursorProviderError): "server" | "transport";
/** Reserve one retry before either reopening locally or handing it to OpenCode. */
export declare function reserveRetry(budget: RetryBudget, failure: CursorProviderError, maxAttempts?: number, now?: number): void;
export declare function resetRetryBudgetsForTests(): void;
