/**
 * NOTE: Special Design - Cross-turn signature disk-level persistent cache
 * Google Agy / Gemini 2.5/3 thinking models introduce strict "Thought Signature Validation" restrictions:
 * In multi-turn dialogues (especially with Tool calls), the next request must carry a context signature (thoughtSignature) exactly matching the previous API response.
 * To avoid conversation crashes caused by the following:
 * 1. IDE-side session lifecycle rebuilds, causing loss of in-memory signature states.
 * 2. Concurrent packets from multi-turn Tool interactions disrupting the memory cache of signatures.
 * We implement a disk cache layer here with a background thread that periodically flushes to disk. Using a combination of session ID (sessionId) and historical thought chain hash digest as the Key,
 * it persists the signatures and thought chains. Even if the IDE restarts or turns split, it can pull back the latest matching signature to fulfill official validation constraints.
 */
/**
 * Signature cache configuration options
 */
export interface SignatureCacheConfig {
    /** Whether to enable caching */
    enabled: boolean;
    /** In-memory cache time-to-live (seconds) */
    memory_ttl_seconds: number;
    /** Disk cache time-to-live (seconds) */
    disk_ttl_seconds: number;
    /** Auto-save interval to disk (seconds) */
    write_interval_seconds: number;
}
/**
 * Cache runtime state and statistics
 */
interface CacheStats {
    /** Memory hit count */
    memoryHits: number;
    /** Disk hit count */
    diskHits: number;
    /** Miss count */
    misses: number;
    /** Disk write count */
    writes: number;
    /** Total number of entries currently in memory */
    memoryEntries: number;
    /** Whether the cache is dirty (has unsaved data) */
    dirty: boolean;
    /** Whether disk storage is enabled */
    diskEnabled: boolean;
}
/**
 * Retrieve full thought chain cache data structure
 */
export interface ThinkingCacheData {
    /** Thought chain text */
    text: string;
    /** Signature */
    signature: string;
    /** Associated tool ID list */
    toolIds?: string[];
}
export declare class SignatureCache {
    private cache;
    private memoryTtlMs;
    private diskTtlMs;
    private writeIntervalMs;
    private cacheFilePath;
    private enabled;
    private dirty;
    private writeTimer;
    private cleanupTimer;
    private stats;
    constructor(config: SignatureCacheConfig);
    /**
     * Generates a unique cache key based on session ID and model ID
     */
    static makeKey(sessionId: string, modelId: string): string;
    /**
     * Stores a signature in cache (marks as dirty, awaits background disk write)
     */
    store(key: string, signature: string): void;
    /**
     * Retrieves a signature from cache and updates hit stats
     * Returns null if expired or missing
     */
    retrieve(key: string): string | null;
    /**
     * Checks if a key is valid and unexpired in cache (without affecting stats)
     */
    has(key: string): boolean;
    /**
     * Caches the full thought chain text content and signature
     * Allows self-healing and recovery of historical thought blocks even if the context is subsequently compressed.
     */
    storeThinking(key: string, thinkingText: string, signature: string, toolIds?: string[]): void;
    /**
     * Extracts full thought chain info from cache
     */
    retrieveThinking(key: string): ThinkingCacheData | null;
    /**
     * Checks if full thought chain content exists for a key
     */
    hasThinking(key: string): boolean;
    /**
     * Gets current cache stats and memory footprint
     */
    getStats(): CacheStats;
    /**
     * Manually triggers immediate save to disk
     */
    flush(): Promise<boolean>;
    /**
     * Graceful shutdown: stops all timers and flushes unsaved data to disk
     */
    shutdown(): void;
    /**
     * Loads signature cache from disk and validates TTL state
     */
    private loadFromDisk;
    /**
     * Synchronously saves memory cache to disk (using atomic write: temp file then rename)
     * Merges with existing unexpired entries on disk during write
     */
    private saveToDisk;
    /**
     * Starts timers for auto-saving and auto-cleaning expired memory entries
     */
    private startBackgroundTasks;
    /**
     * Removes memory cache entries exceeding their TTL
     */
    private cleanupExpired;
}
/**
 * Instantiates signature cache object based on config. Returns null if disabled.
 */
export declare function createSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null;
export {};
