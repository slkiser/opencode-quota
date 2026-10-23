/**
 * Classic plugin tools built with the host's own `tool()` helper when it can
 * be found. Lives outside `plugin.ts` because OpenCode 1.x calls every export
 * of a plugin module as a plugin (`getLegacyPlugins`), so that module may
 * export `CursorPlugin` only.
 */
export declare function loadClassicTools(options?: {
    importModule?: (specifier: string) => Promise<{
        tool?: any;
    }>;
    configDirs?: string[];
}): Promise<{
    webSearch: any;
    imageSave: any;
}>;
