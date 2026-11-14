export declare function queueConversationStateWrite<T>(cacheDir: string, sessionKey: string, write: () => Promise<T>): Promise<T>;
/** Wait until every snapshot write queued for the session, by any module copy, has finished or failed. */
export declare function settleConversationStateWrites(cacheDir: string, sessionKey: string): Promise<void>;
export declare function hasHostHistoryRewrite(cacheDir: string, sessionKey: string): boolean;
/** Only a committed compaction event calls this; preparing a summary does not. */
export declare function noteHostHistoryRewrite(cacheDir: string, sessionKey: string, eventID: string): Promise<void>;
/** Await the durable receipt; a failed save is retried by the next request. */
export declare function awaitHostHistoryRewrite(cacheDir: string, sessionKey: string): Promise<boolean>;
/** Consumed receipts kept so a late copy of their event cannot ask for a second rebase. */
export declare const MAX_CONSUMED_HOST_HISTORY_REWRITES = 256;
/** Consume only after the provider has replaced the old conversation binding. */
export declare function acknowledgeHostHistoryRewrite(cacheDir: string, sessionKey: string): void;
export declare function resetHostHistoryRewritesForTests(): void;
