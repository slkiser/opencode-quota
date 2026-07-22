export interface ChatLogger {
    logRequest(url: string, method: string, headers: HeadersInit | undefined, body: BodyInit | null | undefined): void;
    logResponseHeaders(status: number, statusText: string, headers: Headers): void;
    logResponseBody(body: string): void;
    createLoggingTransformStream(): TransformStream<Uint8Array, Uint8Array>;
    close(): void;
}
export declare function createChatLogger(): ChatLogger | null;
