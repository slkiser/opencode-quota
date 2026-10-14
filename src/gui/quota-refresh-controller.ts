import { normalizeGuiRefreshInterval } from "../lib/gui-config.js";
import type { QuotaFetchResult } from "./ipc/quota.js";

export interface QuotaRefreshSnapshot extends QuotaFetchResult {
  revision: number;
  fetching: boolean;
  stale: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastObservationAt: number | null;
  previousObservation: boolean;
  nextRefreshAt: number | null;
  refreshIntervalMs: number;
}

/** Main-process scheduling; renderer visibility does not control provider work. */
export class QuotaRefreshController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<QuotaRefreshSnapshot> | null = null;
  private pendingFresh = false;
  private queuedFresh: Promise<QuotaRefreshSnapshot> | null = null;
  private active = false;
  private suspended = false;
  private disposed = false;
  private failures = 0;
  private state: QuotaRefreshSnapshot;

  constructor(
    private readonly options: {
      fetch: (fresh: boolean) => Promise<QuotaFetchResult>;
      intervalMs: number;
      onChange?: (snapshot: QuotaRefreshSnapshot) => void;
    },
  ) {
    this.state = {
      revision: 0,
      entries: [],
      errors: [],
      detectedProviderIds: [],
      fetching: false,
      stale: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextRefreshAt: null,
      lastObservationAt: null,
      previousObservation: false,
      refreshIntervalMs: normalizeGuiRefreshInterval(options.intervalMs),
    };
  }

  getState(): QuotaRefreshSnapshot {
    return structuredClone(this.state);
  }

  start(): Promise<QuotaRefreshSnapshot> {
    if (this.disposed || this.active) return this.pending ?? Promise.resolve(this.getState());
    this.active = true;
    return this.refresh(false);
  }

  refresh(fresh = false): Promise<QuotaRefreshSnapshot> {
    if (this.disposed) return Promise.resolve(this.getState());
    if (this.pending) {
      if (!fresh || this.pendingFresh) return this.pending;
      // A manual request during a cached/automatic fetch gets one subsequent
      // fresh query. Concurrent manual callers share that same query.
      if (!this.queuedFresh) {
        this.queuedFresh = this.pending.then(() => {
          this.queuedFresh = null;
          return this.disposed ? this.getState() : this.run(true);
        });
      }
      return this.queuedFresh;
    }
    return this.run(fresh);
  }

  private run(fresh: boolean): Promise<QuotaRefreshSnapshot> {
    this.clearTimer();
    this.pendingFresh = fresh;
    this.state.fetching = true;
    this.state.lastAttemptAt = Date.now();
    this.pending = Promise.resolve()
      .then(() => this.options.fetch(fresh))
      .then(
        (result) => {
          if (this.disposed) return;
          const empty = result.entries.length === 0 && result.detectedProviderIds.length === 0;
          const failed = result.errors.length > 0 || (empty && this.state.entries.length > 0);
          const errors =
            failed && result.errors.length === 0
              ? [
                  {
                    label: "Quota",
                    message: "No providers available; showing the previous observation",
                  },
                ]
              : result.errors;
          // Retention is a visibly stale previous observation, never a merge of
          // old rows into a partially successful current result.
          if (!failed || result.entries.length > 0) {
            this.state.entries = result.entries;
            this.state.detectedProviderIds = result.detectedProviderIds;
            this.state.lastObservationAt = Date.now();
          }
          this.state.previousObservation =
            failed && result.entries.length === 0 && this.state.entries.length > 0;
          this.state.errors = errors;
          this.state.historyDiagnostics = result.historyDiagnostics ?? [];
          this.state.stale = failed;
          this.failures = failed ? this.failures + 1 : 0;
          if (!failed) this.state.lastSuccessAt = Date.now();
        },
        () => {
          if (this.disposed) return;
          this.state.errors = [{ label: "Quota", message: "Quota refresh failed" }];
          this.state.stale = true;
          this.state.previousObservation = this.state.entries.length > 0;
          this.failures++;
        },
      )
      .then(() => {
        this.pending = null;
        this.state.fetching = false;
        if (!this.disposed) {
          if (!this.queuedFresh) this.schedule();
          this.emit();
        }
        return this.getState();
      });
    this.emit();
    return this.pending;
  }

  setInterval(intervalMs: number): void {
    this.state.refreshIntervalMs = normalizeGuiRefreshInterval(intervalMs);
    this.clearTimer();
    if (!this.pending) this.schedule();
    this.emit();
  }

  /** Explicit settings changes invalidate retained observations from old settings. */
  clearObservation(): void {
    this.state.entries = [];
    this.state.errors = [];
    this.state.detectedProviderIds = [];
    this.state.lastSuccessAt = null;
    this.state.lastObservationAt = null;
    this.state.previousObservation = false;
    this.state.stale = false;
  }

  suspend(): void {
    this.suspended = true;
    this.clearTimer();
    this.emit();
  }

  resume(): Promise<QuotaRefreshSnapshot> {
    const wasSuspended = this.suspended;
    this.suspended = false;
    if (this.disposed || !wasSuspended || !this.active || !this.state.refreshIntervalMs) {
      return this.pending ?? Promise.resolve(this.getState());
    }
    return this.refresh(false);
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.clearTimer();
    this.state.fetching = false;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state.nextRefreshAt = null;
  }

  private schedule(): void {
    if (!this.active || this.suspended || this.disposed || !this.state.refreshIntervalMs) return;
    const backoff = this.failures
      ? Math.min(15 * 60_000, 30_000 * 2 ** Math.min(this.failures - 1, 5))
      : 0;
    const delay = Math.max(this.state.refreshIntervalMs, backoff);
    this.state.nextRefreshAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh(false);
    }, delay);
  }

  private emit(): void {
    if (this.disposed) return;
    this.state.revision++;
    try {
      this.options.onChange?.(this.getState());
    } catch {
      // A closed renderer must not stop scheduling or make a provider fetch fail.
    }
  }
}
