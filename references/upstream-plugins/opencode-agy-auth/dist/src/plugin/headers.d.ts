/**
 * HTTP header and URL manipulation utilities.
 * Shared between OpenCode v1 and v2 runtimes.
 */
export declare function getSafeHeader(headers: unknown, key: string): string | undefined;
export declare function setSafeHeaders(initHeaders: unknown, newHeaders: Record<string, string>): unknown;
export declare function toUrlString(value: RequestInfo): string;
