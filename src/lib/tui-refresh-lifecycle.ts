export interface TuiRefreshLifecycle {
  reload: () => void;
  retain: () => void;
  release: () => void;
}

export interface TuiRefreshLifecycleOptions<T> {
  load: () => Promise<T>;
  apply: (value: T) => void;
  afterApply?: (value: T) => void;
  intervalMs: number;
  eventRefreshDelaysMs: readonly number[];
  recoveryDelaysMs?: readonly number[];
  subscribe: (scheduleRefresh: () => void) => Array<() => void>;
  onDispose: () => void;
}

export function createTuiRefreshLifecycle<T>(
  options: TuiRefreshLifecycleOptions<T>,
): TuiRefreshLifecycle {
  let refCount = 0;
  let disposed = false;
  let loadVersion = 0;
  let inFlight = false;
  let queued = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const reload = () => {
    if (disposed) return;

    if (inFlight) {
      queued = true;
      loadVersion += 1;
      return;
    }

    inFlight = true;
    const currentVersion = ++loadVersion;

    void options
      .load()
      .then((next) => {
        if (disposed || currentVersion !== loadVersion) return;
        options.apply(next);
        options.afterApply?.(next);
      })
      .catch(() => {
        if (disposed || currentVersion !== loadVersion) return;
      })
      .finally(() => {
        if (disposed) return;
        inFlight = false;
        if (queued) {
          queued = false;
          reload();
        }
      });
  };

  const queueRefresh = (delay: number) => {
    if (disposed) return;

    const timer = setTimeout(() => {
      timers.delete(timer);
      reload();
    }, delay);
    timers.add(timer);
  };

  const scheduleRefresh = () => {
    for (const delay of options.eventRefreshDelaysMs) queueRefresh(delay);
  };

  const interval = setInterval(reload, options.intervalMs);
  const unsubscribers = options.subscribe(scheduleRefresh);

  const dispose = () => {
    if (disposed) return;

    disposed = true;
    clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
    options.onDispose();
  };

  const lifecycle: TuiRefreshLifecycle = {
    reload,
    retain: () => {
      refCount += 1;
    },
    release: () => {
      refCount -= 1;
      if (refCount <= 0) dispose();
    },
  };

  reload();
  for (const delay of options.recoveryDelaysMs ?? []) queueRefresh(delay);

  return lifecycle;
}
