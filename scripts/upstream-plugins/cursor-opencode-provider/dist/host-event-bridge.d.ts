/**
 * Optional host-neutral event capability installed by a compatibility layer.
 *
 * The provider does not interpret host-specific event payloads here. It only
 * forwards the canonical OpenCode plugin event and the structural host values
 * that were supplied to the plugin at load time.
 */
export declare const HOST_EVENT_BRIDGE: unique symbol;
export type HostEventBridge = {
    handle(input: {
        event: unknown;
        client: unknown;
        directory: string;
        serverUrl: URL;
    }): void | Promise<void>;
};
export declare function dispatchHostEventBridge(input: {
    event: unknown;
    client: unknown;
    directory: string;
    serverUrl: URL;
}): Promise<void>;
