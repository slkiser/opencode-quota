export interface V2SessionHooksState {
    lastInterceptedModel?: string;
    lastSessionId?: string;
}
export declare function createV2HttpRequestHook(state?: V2SessionHooksState): (event: any) => Promise<void>;
export declare function createV2HttpResponseHook(state?: V2SessionHooksState): (event: any) => Promise<void>;
export declare function createV2RetryHook(): (event: any) => Promise<void>;
export declare function registerV2SessionHooks(ctx: any): void;
