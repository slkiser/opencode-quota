/**
 * State shared by every copy of this package in one process.
 *
 * OpenCode 2 imports a separate copy of a plugin's module graph for each
 * location (project directory) it serves, all in one realm. Module-level state
 * then exists once per copy, so per-account work such as credential renewal ran
 * once per location. Keep that state here instead.
 *
 * Store plain data only (maps, strings, numbers, promises): every copy has its
 * own classes, so an instance stored by one copy fails `instanceof` in another.
 * Name keys with a version suffix (`….v1`) and bump it when the stored shape
 * changes, so two package versions in one process never read each other's data.
 */
export declare function processShared<T>(name: string, create: () => T): T;
