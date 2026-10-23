export declare function resetClientVersionCache(): void;
export declare function resolveClientVersion(): Promise<string>;
export declare function cursorAgentVersionsDir(): string | undefined;
export declare function discoverLocalVersion(dir?: string | undefined): string | undefined;
export declare function extractVersionFromInstaller(script: string): string | undefined;
