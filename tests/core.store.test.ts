import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createQuotaStore,
  type ProviderFetch,
  type ProviderIdentity,
  type QuotaStore,
  type StoreProvider,
} from "../src/core/store.js";
import type { QuotaRow, QuotaSnapshot, SessionModel } from "../src/core/types.js";
import { quotaRow } from "./helpers/fake-answers.js";

const START_MS = Date.parse("2026-10-10T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** The weekly window's reset, an hour after the start, and the reset after it. */
const RESETS_AT = new Date(START_MS + HOUR).toISOString();
const NEXT_RESETS_AT = new Date(START_MS + 8 * 24 * HOUR).toISOString();

/** A Copilot row of a weekly window. */
const row = (key: string, percentRemaining: number, extra: Partial<QuotaRow> = {}) =>
  quotaRow(`copilot.${key}`, { window: "week", percentRemaining, ...extra });

function ok(rows: QuotaRow[]): ProviderFetch {
  return { rows, debug: [{ key: "source", value: "test" }] };
}

/** A provider whose identity and answers the test sets. */
function fakeProvider(id = "copilot") {
  let identity: ProviderIdentity = { key: "alice", persist: true };
  const fetch = vi.fn<() => Promise<ProviderFetch>>(async () => ok([row("allowance", 50)]));
  const provider: StoreProvider = {
    id,
    label: "Copilot",
    identity: async () => identity,
    fetch,
  };
  return {
    provider,
    fetch,
    signInAs(key: string, persist = true) {
      identity = { key, persist };
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("quota store", () => {
  let dir: string;
  let file: string;
  let clock: number;
  const stores: QuotaStore[] = [];

  function makeStore(
    providers: StoreProvider[],
    minIntervalMs = 5 * MINUTE,
    path: string | null = file,
    providerIdsForModel?: (model: SessionModel) => string[],
  ) {
    const store = createQuotaStore({
      source: async () => ({
        providers,
        minIntervalMs,
        ...(providerIdsForModel ? { providerIdsForModel } : {}),
      }),
      file: path,
      now: () => clock,
      log: () => {},
    });
    stores.push(store);
    return store;
  }

  /** A store that saw the weekly row at 5% before its reset; then 2 hours pass. */
  async function storePastWeeklyReset(
    copilot: ReturnType<typeof fakeProvider>,
    extra: Partial<QuotaRow> = {},
  ) {
    copilot.fetch.mockResolvedValue(ok([row("weekly", 5, { resetsAt: RESETS_AT, ...extra })]));
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });
    clock += 2 * HOUR;
    return store;
  }

  /** The weekly row refilled, with its next reset. */
  const refilled = (extra: Partial<QuotaRow> = {}) =>
    ok([row("weekly", 100, { resetsAt: NEXT_RESETS_AT, ...extra })]);

  function only(snapshot: QuotaSnapshot) {
    const [provider] = snapshot.providers;
    if (!provider) throw new Error("no provider in the snapshot");
    return provider;
  }

  async function savedFile(): Promise<{
    entries: Record<string, { rows: Array<{ login: string; row: QuotaRow }> }>;
  }> {
    return JSON.parse(await readFile(file, "utf8"));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-quota-store-"));
    file = join(dir, "state", "snapshot-v6.json");
    clock = START_MS;
  });

  afterEach(async () => {
    // A store may still be fetching or writing; let it finish before the folder goes.
    await Promise.all(stores.splice(0).map((store) => store.dispose()));
    await rm(dir, { recursive: true, force: true });
  });

  it("answers at once from the snapshot file after a restart", async () => {
    const first = fakeProvider();
    await makeStore([first.provider]).refresh({ reason: "manual" });

    const second = fakeProvider();
    const pending = deferred<ProviderFetch>();
    second.fetch.mockReturnValue(pending.promise);
    clock += 10 * MINUTE;
    const snapshot = await makeStore([second.provider]).snapshot();

    expect(only(snapshot)).toEqual({
      providerId: "copilot",
      label: "Copilot",
      rows: [row("allowance", 50)],
      okAtMs: START_MS,
      checkedAtMs: START_MS,
      refreshing: true,
      debug: [{ key: "source", value: "test" }],
    });
    // The poll it started is still running; the answer did not wait for it.
    expect(second.fetch).toHaveBeenCalledOnce();
    pending.resolve(ok([row("allowance", 40)]));
  });

  it("does nothing at all until asked", async () => {
    const source = vi.fn();
    createQuotaStore({ source, file, now: () => clock });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source).not.toHaveBeenCalled();
    await expect(readFile(file)).rejects.toThrow();
  });

  it("asks each provider once at a time", async () => {
    const copilot = fakeProvider();
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const store = makeStore([copilot.provider]);

    const first = store.refresh({ reason: "manual" });
    const second = store.refresh({ reason: "manual" });
    const instant = await store.snapshot();
    expect(only(instant).refreshing).toBe(true);
    pending.resolve(ok([row("allowance", 30)]));

    const [a, b] = await Promise.all([first, second]);
    expect(copilot.fetch).toHaveBeenCalledOnce();
    expect(only(a).rows).toEqual([row("allowance", 30)]);
    expect(only(b).rows).toEqual([row("allowance", 30)]);
    expect(only(b).refreshing).toBe(false);
  });

  it("keeps the minimum interval for polls, 30 s after a turn, none for manual", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider], 5 * MINUTE);
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);

    clock += 20 * SECOND;
    await store.refresh({ reason: "poll" });
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);

    clock += 11 * SECOND;
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);

    clock += 2 * MINUTE;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    await store.refresh({ reason: "manual" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);

    clock += 5 * MINUTE;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(4);
  });

  it("uses a provider's own interval and a turn floor never above the setting", async () => {
    const local = fakeProvider("cursor");
    local.provider.minIntervalMs = 0;
    const remote = fakeProvider("copilot");
    const store = makeStore([local.provider, remote.provider], 10 * SECOND);
    await store.refresh({ reason: "poll" });
    clock += 11 * SECOND;
    await store.refresh({ reason: "turn" });
    await store.refresh({ reason: "poll" });
    expect(local.fetch).toHaveBeenCalledTimes(3);
    expect(remote.fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes only the providers asked for", async () => {
    const copilot = fakeProvider("copilot");
    const openai = fakeProvider("openai");
    const store = makeStore([copilot.provider, openai.provider]);
    const snapshot = await store.refresh({ reason: "manual", providerIds: ["openai"] });
    expect(copilot.fetch).not.toHaveBeenCalled();
    expect(openai.fetch).toHaveBeenCalledOnce();
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
      "copilot",
      "openai",
    ]);
  });

  it("keeps the last rows when a refresh fails and backs off", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });

    clock += MINUTE;
    copilot.fetch.mockRejectedValue(new Error("fetch failed"));
    const failed = only(await store.refresh({ reason: "poll" }));
    expect(failed).toMatchObject({
      rows: [row("allowance", 50)],
      okAtMs: START_MS,
      checkedAtMs: START_MS + MINUTE,
      error: { code: "network", detail: "fetch failed" },
    });

    // 1 minute after the first failure, then 2 minutes after the second.
    clock += 59 * SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    clock += SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
    clock += 119 * SECOND;
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
    clock += SECOND;
    copilot.fetch.mockResolvedValue(ok([row("allowance", 20)]));
    const recovered = only(await store.refresh({ reason: "poll" }));
    expect(copilot.fetch).toHaveBeenCalledTimes(4);
    expect(recovered.rows).toEqual([row("allowance", 20)]);
    expect(recovered).not.toHaveProperty("error");
  });

  it("waits until the provider's own retry time after a rate limit", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({
      rows: [],
      error: { code: "rate_limited", retryAtMs: START_MS + 10 * MINUTE },
      debug: [],
    });
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });
    clock += 5 * MINUTE;
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);
    clock += 5 * MINUTE;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    // A manual refresh is the user's call and always asks.
    await store.refresh({ reason: "manual" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "hours away", retryInMs: 3 * 60 * MINUTE, waitMs: 3 * 60 * MINUTE },
    { name: "days away, at most a day", retryInMs: 3 * 24 * 60 * MINUTE, waitMs: 24 * 60 * MINUTE },
  ])("waits for a retry time $name", async ({ retryInMs, waitMs }) => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({
      rows: [],
      error: { code: "rate_limited", retryAtMs: START_MS + retryInMs },
      debug: [],
    });
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });
    clock += waitMs - SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);
    clock += SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "after a settings change (recheck %s), shows a new snapshot and checks a failed provider again only for a recheck",
    async (recheck) => {
      const copilot = fakeProvider();
      copilot.fetch.mockRejectedValueOnce(new Error("Request timeout after 5s"));
      const store = makeStore([copilot.provider]);
      await store.refresh({ reason: "manual" });
      const seen: QuotaSnapshot[] = [];
      store.subscribe((snapshot) => seen.push(snapshot));

      store.settingsChanged({ recheck });

      // A recheck answers with fresh rows; otherwise the failure and its backoff stay.
      await vi.waitFor(() => expect(seen.map((one) => !only(one).error)).toContain(recheck));
      await store.dispose();
      expect(copilot.fetch).toHaveBeenCalledTimes(recheck ? 2 : 1);
    },
  );

  it("records an empty answer as nothing reported", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({ rows: [], debug: [] });
    const snapshot = await makeStore([copilot.provider]).refresh({ reason: "manual" });
    expect(only(snapshot)).toMatchObject({ rows: [], error: { code: "no_data" } });
    expect(only(snapshot)).not.toHaveProperty("okAtMs");
  });

  it("shows rows only to the account that fetched them", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider]);
    await store.refresh({ reason: "manual" });

    copilot.signInAs("bob");
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const asBob = only(await store.snapshot());
    expect(asBob.rows).toEqual([]);
    expect(asBob).not.toHaveProperty("okAtMs");
    pending.resolve(ok([row("allowance", 90)]));
    await store.refresh({ reason: "poll" });

    copilot.signInAs("alice");
    const back = only(await store.snapshot());
    expect(back.rows).toEqual([row("allowance", 50)]);
    expect(copilot.fetch).toHaveBeenCalledTimes(2);

    // The file keeps both accounts, under hashed keys that never show the account itself.
    const saved = await savedFile();
    expect(Object.keys(saved.entries)).toHaveLength(2);
    for (const entry of Object.values(saved.entries)) expect(entry).not.toHaveProperty("persist");
    expect(JSON.stringify(saved)).not.toContain("alice");
    expect(JSON.stringify(saved)).not.toContain("bob");
  });

  it("drops a fetch when the login changed while it ran", async () => {
    const copilot = fakeProvider();
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const store = makeStore([copilot.provider]);
    const running = store.refresh({ reason: "manual" });
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalled());
    copilot.signInAs("bob");
    pending.resolve(ok([row("allowance", 10)]));
    const snapshot = await running;
    expect(only(snapshot).rows).toEqual([]);
  });

  it("keeps rows of a login that can't be told apart in memory only", async () => {
    const copilot = fakeProvider();
    copilot.signInAs("settings-only", false);
    const store = makeStore([copilot.provider]);
    const snapshot = await store.refresh({ reason: "manual" });
    expect(only(snapshot).rows).toEqual([row("allowance", 50)]);
    expect((await savedFile()).entries).toEqual({});

    const listener = vi.fn();
    store.subscribe(listener);
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    store.invalidateIdentity();
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalledTimes(2));
    expect(only(await store.snapshot()).rows).toEqual([]);
    pending.resolve(ok([row("allowance", 70)]));
    await vi.waitFor(() =>
      expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 70)]),
    );
  });

  it("records a reset notice once when a window refills", async () => {
    const copilot = fakeProvider();
    const store = await storePastWeeklyReset(copilot, { account: "pro" });
    copilot.fetch.mockResolvedValue(refilled({ account: "pro" }));
    const notice = {
      id: `copilot.weekly|pro||${RESETS_AT}`,
      rowId: "copilot.weekly",
      providerId: "copilot",
      account: "pro",
      label: "weekly",
      window: "week",
      percentRemaining: 100,
      atMs: START_MS + 2 * HOUR,
    };
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([notice]);

    clock += MINUTE;
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([notice]);
    // Another process sees it too.
    expect((await makeStore([copilot.provider], 0).snapshot()).resetNotices).toEqual([notice]);

    clock += HOUR;
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([]);
  });

  it("keeps a reset notice's full 80-character label and account in the file", async () => {
    const long = "😀".repeat(80);
    const copilot = fakeProvider();
    const store = await storePastWeeklyReset(copilot, { label: long, account: long });
    copilot.fetch.mockResolvedValue(refilled({ label: long, account: long }));
    await store.refresh({ reason: "poll" });

    const [notice] = (await makeStore([copilot.provider], 0).snapshot()).resetNotices;
    expect(notice).toMatchObject({ label: long, account: long });
  });

  it("gives no reset notice for windows that don't refill or rows that didn't reset", async () => {
    const later = new Date(START_MS + 5 * HOUR).toISOString();
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue(
      ok([
        row("session", 5, { window: "session", resetsAt: RESETS_AT }),
        row("weekly", 5, { resetsAt: RESETS_AT }),
        row("budget", 5, { type: "budget", resetsAt: RESETS_AT }),
      ]),
    );
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });
    clock += 2 * HOUR;
    copilot.fetch.mockResolvedValue(
      ok([
        row("session", 100, { window: "session", resetsAt: later }),
        row("weekly", 3, { resetsAt: later }),
        row("budget", 100, { type: "budget", resetsAt: later }),
      ]),
    );
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([]);
  });

  it("tells subscribers about every change until they leave", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider]);
    const listener = vi.fn();
    const broken = vi.fn(() => {
      throw new Error("subscriber broke");
    });
    store.subscribe(broken);
    const leave = store.subscribe(listener);
    await store.refresh({ reason: "manual" });
    // First the providers it has (none checked yet), then the fetched rows.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 50)]);

    leave();
    await store.refresh({ reason: "manual" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(broken).toHaveBeenCalledTimes(3);
  });

  it("tells subscribers about the rows read from the file and about providers turned on or off", async () => {
    const copilot = fakeProvider("copilot");
    await makeStore([copilot.provider]).refresh({ reason: "manual" });

    const providers = [copilot.provider];
    const restarted = makeStore(providers, HOUR);
    const listener = vi.fn();
    restarted.subscribe(listener);
    await restarted.snapshot();
    expect(listener).toHaveBeenCalledOnce();
    expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 50)]);

    await restarted.snapshot();
    expect(listener).toHaveBeenCalledOnce();

    providers.push(fakeProvider("openai").provider);
    await restarted.snapshot();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      listener.mock.lastCall?.[0].providers.map((p: { providerId: string }) => p.providerId),
    ).toEqual(["copilot", "openai"]);
  });

  it("ignores a broken file and skips bad rows in a good one", async () => {
    const copilot = fakeProvider();
    await makeStore([copilot.provider]).refresh({ reason: "manual" });
    const saved = await savedFile();
    const [key] = Object.keys(saved.entries);
    if (!key) throw new Error("nothing saved");
    saved.entries[key]?.rows.push({ login: "", row: { ...row("bad", 1), id: "openai.stolen" } });
    await writeFile(file, JSON.stringify(saved));
    const restarted = only(await makeStore([copilot.provider], HOUR).snapshot());
    expect(restarted.rows).toEqual([row("allowance", 50)]);

    await writeFile(file, "{ not json");
    const fresh = only(await makeStore([copilot.provider], HOUR).snapshot());
    expect(fresh.rows).toEqual([]);
  });

  it("keeps a failing login's last rows and backs off when another login answers", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({
      ...ok([row("allowance", 50, { account: "Home" }), row("allowance", 40, { account: "Work" })]),
      rowLogins: ["home-login", "work-login"],
    });
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });

    clock += MINUTE;
    copilot.fetch.mockResolvedValue({
      rows: [row("allowance", 30, { account: "Home" })],
      rowLogins: ["home-login"],
      error: { code: "login_expired", detail: "Work: token expired" },
      debug: [],
    });
    const partial = only(await store.refresh({ reason: "poll" }));
    expect(partial.rows).toEqual([
      row("allowance", 30, { account: "Home" }),
      row("allowance", 40, { account: "Work" }),
    ]);
    expect(partial).toMatchObject({ okAtMs: START_MS + MINUTE, error: { code: "login_expired" } });

    clock += 30 * SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    clock += 30 * SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
  });

  it("redacts credentials from a thrown error before it is shown or saved", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockRejectedValue(
      new Error("HTTP 401 Authorization: Bearer CANARYtoken0value0123 api_key=CANARYkey0value"),
    );
    const snapshot = await makeStore([copilot.provider]).refresh({ reason: "manual" });
    expect(only(snapshot).error).toMatchObject({ code: "login_expired" });
    expect(JSON.stringify(snapshot)).not.toContain("CANARY");
    expect(await readFile(file, "utf8")).not.toContain("CANARY");
  });

  it("keeps reset notices with the account that saw them", async () => {
    const copilot = fakeProvider();
    const store = await storePastWeeklyReset(copilot);
    copilot.fetch.mockResolvedValue(refilled());
    expect((await store.refresh({ reason: "poll" })).resetNotices).toHaveLength(1);

    // Bob never sees Alice's notice, nor does a process where the provider is off.
    copilot.signInAs("bob");
    expect((await makeStore([copilot.provider], HOUR).snapshot()).resetNotices).toEqual([]);
    expect((await makeStore([], HOUR).snapshot()).resetNotices).toEqual([]);
    copilot.signInAs("alice");
    expect((await makeStore([copilot.provider], HOUR).snapshot()).resetNotices).toHaveLength(1);
  });

  it("keeps a memory-only login's reset notices out of the file", async () => {
    const copilot = fakeProvider();
    copilot.signInAs("settings-only", false);
    const store = await storePastWeeklyReset(copilot);
    copilot.fetch.mockResolvedValue(refilled());
    expect((await store.refresh({ reason: "poll" })).resetNotices).toHaveLength(1);
    await makeStore([fakeProvider("openai").provider]).refresh({ reason: "manual" });
    expect(await readFile(file, "utf8")).not.toContain("copilot.weekly");

    store.invalidateIdentity();
    expect((await store.snapshot()).resetNotices).toEqual([]);
  });

  it("notices a reset that a provider reports only after repeating the old reset time", async () => {
    const copilot = fakeProvider();
    const store = await storePastWeeklyReset(copilot);

    // The provider's data lags: after the reset time it still reports the old window.
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([]);
    clock += HOUR;
    copilot.fetch.mockResolvedValue(refilled());
    const { resetNotices } = await store.refresh({ reason: "poll" });
    expect(resetNotices.map((notice) => notice.id)).toEqual([`copilot.weekly|||${RESETS_AT}`]);
  });

  it("drops a memory-only fetch that ran across a login change and shows that at once", async () => {
    const copilot = fakeProvider();
    copilot.signInAs("settings-only", false);
    const store = makeStore([copilot.provider]);
    await store.refresh({ reason: "manual" });

    const oldAccount = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(oldAccount.promise);
    copilot.fetch.mockResolvedValue(ok([row("allowance", 70)]));
    const running = store.refresh({ reason: "manual" });
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalledTimes(2));

    const listener = vi.fn();
    store.subscribe(listener);
    store.invalidateIdentity();
    // Cleared rows first, before any fetch answers; then the new login's rows.
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(only(listener.mock.calls[0]?.[0]).rows).toEqual([]);
    await vi.waitFor(() =>
      expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 70)]),
    );
    expect(copilot.fetch).toHaveBeenCalledTimes(3);

    oldAccount.resolve(ok([row("allowance", 10)]));
    // The refresh started for the old login answers with the new login's rows.
    expect(only(await running).rows).toEqual([row("allowance", 70)]);
    expect(only(await store.snapshot()).rows).toEqual([row("allowance", 70)]);
    const seen = listener.mock.calls.flatMap(([snapshot]) => only(snapshot).rows);
    expect(seen).not.toContainEqual(row("allowance", 10));
  });

  it("waits for running fetches and the last write when disposed", async () => {
    const copilot = fakeProvider();
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const store = makeStore([copilot.provider]);
    await store.snapshot();
    let disposed = false;
    const disposing = store.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposed).toBe(false);

    pending.resolve(ok([row("allowance", 30)]));
    await disposing;
    expect(Object.values((await savedFile()).entries).map((entry) => entry.rows)).toEqual([
      [{ login: "", row: row("allowance", 30) }],
    ]);
    // A disposed store refuses new work.
    await expect(store.snapshot()).rejects.toThrow("disposed");
    expect(copilot.fetch).toHaveBeenCalledOnce();
  });

  it("keeps both entries when two stores write the same file at once", async () => {
    const copilot = fakeProvider("copilot");
    const openai = fakeProvider("openai");
    const one = makeStore([copilot.provider]);
    const two = makeStore([openai.provider]);
    await Promise.all([one.refresh({ reason: "manual" }), two.refresh({ reason: "manual" })]);
    const saved = await savedFile();
    expect(
      Object.keys(saved.entries)
        .map((key) => key.split("|")[0])
        .sort(),
    ).toEqual(["copilot", "openai"]);
  });

  it("names the providers serving the session's model, from the same settings read", async () => {
    const copilot = fakeProvider("copilot");
    const openai = fakeProvider("openai");
    const forModel = vi.fn((model: SessionModel) =>
      model.providerID === "openai" ? ["openai", "azure"] : [],
    );
    const store = makeStore([copilot.provider, openai.provider], HOUR, file, forModel);
    const snapshot = await store.snapshot({ model: { id: "gpt-5", providerID: "openai" } });
    expect(snapshot.currentModelProviderIds).toEqual(["openai"]);
    expect(await store.snapshot()).not.toHaveProperty("currentModelProviderIds");
    expect(await store.snapshot({ model: {} })).not.toHaveProperty("currentModelProviderIds");
  });

  it("never answers a refresh with the old login's rows after a login change", async () => {
    const copilot = fakeProvider();
    const identity = vi.fn(async (): Promise<ProviderIdentity> => ({
      key: "alice",
      persist: true,
    }));
    copilot.provider.identity = identity;
    const store = makeStore([copilot.provider]);
    await store.refresh({ reason: "manual" });

    // The check after the next fetch is slow; Bob signs in meanwhile.
    const aliceLookup = deferred<ProviderIdentity>();
    identity
      .mockImplementationOnce(async () => ({ key: "alice", persist: true }))
      .mockImplementationOnce(() => aliceLookup.promise)
      .mockImplementation(async () => ({ key: "bob", persist: true }));
    copilot.fetch.mockResolvedValue(ok([row("allowance", 40)]));
    const running = store.refresh({ reason: "manual" });
    await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(4));
    const listener = vi.fn();
    store.subscribe(listener);
    store.invalidateIdentity();
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 40)]),
    );

    aliceLookup.resolve({ key: "alice", persist: true });
    // The refresh Alice started answers with Bob's rows.
    expect(only(await running).rows).toEqual([row("allowance", 40)]);
    // Later answers are Bob's.
    copilot.fetch.mockResolvedValue(ok([row("allowance", 99)]));
    expect(only(await store.refresh({ reason: "manual" })).rows).toEqual([row("allowance", 99)]);
  });

  it("waits for a refresh still reading its providers and refuses work after dispose", async () => {
    const copilot = fakeProvider();
    const providersRead = deferred<void>();
    const store = createQuotaStore({
      source: async () => {
        await providersRead.promise;
        return { providers: [copilot.provider], minIntervalMs: 0 };
      },
      file,
      now: () => clock,
      log: () => {},
    });
    stores.push(store);
    const refreshing = store.refresh({ reason: "manual" });
    const disposing = store.dispose();
    providersRead.resolve();
    await disposing;

    await expect(refreshing).resolves.toBeDefined();
    expect(copilot.fetch).not.toHaveBeenCalled();
    await expect(readFile(file)).rejects.toThrow();
    await expect(store.refresh({ reason: "manual" })).rejects.toThrow("disposed");
    await expect(store.snapshot()).rejects.toThrow("disposed");
  });

  it(
    "gives up on a login, provider list or fetch that never answers",
    { timeout: 2000 },
    async () => {
      const never = () => new Promise<never>(() => {});
      const stuck: StoreProvider = {
        id: "copilot",
        label: "Copilot",
        identity: never,
        fetch: never,
      };
      const timeouts = { readMs: 20, fetchMs: 20 };
      const store = createQuotaStore({
        source: async () => ({ providers: [stuck], minIntervalMs: 0 }),
        file,
        now: () => clock,
        log: () => {},
        timeouts,
      });
      const snapshot = await store.refresh({ reason: "manual" });
      expect(only(snapshot).error).toMatchObject({ code: "timeout" });
      await store.dispose();

      const noProviders = createQuotaStore({ source: never, file, now: () => clock, timeouts });
      await expect(noProviders.refresh({ reason: "manual" })).rejects.toThrow("timed out");
      await noProviders.dispose();
    },
  );

  it("numbers logins that share a name by login, so one failing keeps its number", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({
      ...ok([row("allowance", 50, { account: "Pro" }), row("allowance", 40, { account: "Pro" })]),
      rowLogins: ["first", "second"],
    });
    const store = makeStore([copilot.provider], 0);
    const before = only(await store.refresh({ reason: "poll" })).rows;
    const accountOf = (rows: QuotaRow[], percent: number) =>
      rows.find((item) => item.percentRemaining === percent)?.account;
    expect([accountOf(before, 50), accountOf(before, 40)].sort()).toEqual(["Pro", "Pro 2"]);

    // The first login fails; the second answers alone.
    clock += MINUTE;
    copilot.fetch.mockResolvedValue({
      rows: [row("allowance", 30, { account: "Pro" })],
      rowLogins: ["second"],
      error: { code: "login_expired", detail: "first: token expired" },
      debug: [],
    });
    const after = only(await store.refresh({ reason: "poll" })).rows;
    expect(after).toHaveLength(2);
    expect(accountOf(after, 50)).toBe(accountOf(before, 50));
    expect(accountOf(after, 30)).toBe(accountOf(before, 40));
  });

  it("numbers logins around names rows already have and gives each login its own notice", async () => {
    const copilot = fakeProvider();
    // Two logins without a name and one named "Account 2", all on the same window.
    const answer = (percent: number, at: string): ProviderFetch => ({
      rows: [
        row("weekly", percent, { resetsAt: at }),
        row("weekly", percent, { resetsAt: at }),
        row("weekly", percent, { resetsAt: at, account: "Account 2" }),
      ],
      rowLogins: ["first", "second", "third"],
      debug: [],
    });
    const accounts = (items: Array<{ account?: string }>) =>
      items.map((item) => item.account ?? "(none)").sort();
    copilot.fetch.mockResolvedValue(answer(5, RESETS_AT));
    const store = makeStore([copilot.provider], 0);
    const before = only(await store.refresh({ reason: "poll" })).rows;
    expect(accounts(before)).toEqual(["(none)", "Account 2", "Account 3"]);
    expect(before[2]?.account).toBe("Account 2");

    // All three reset at once: three notices.
    clock += 2 * HOUR;
    copilot.fetch.mockResolvedValue(answer(100, NEXT_RESETS_AT));
    const { resetNotices } = await store.refresh({ reason: "poll" });
    expect(accounts(resetNotices)).toEqual(["(none)", "Account 2", "Account 3"]);
    expect(new Set(resetNotices.map((notice) => notice.id)).size).toBe(3);
  });

  it("still fetches after a login change when an older refresh finishes reading with it", async () => {
    const copilot = fakeProvider();
    const identityRead = deferred<ProviderIdentity>();
    const identity = vi.fn(() => identityRead.promise);
    copilot.provider.identity = identity;
    const store = makeStore([copilot.provider], 0);
    const listener = vi.fn();
    store.subscribe(listener);
    const old = store.refresh({ reason: "manual" });
    await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(1));
    store.invalidateIdentity();
    await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(2));

    // Both operations read who is signed in from the same answer, in the same tick.
    identityRead.resolve({ key: "bob", persist: true });
    // The older refresh runs again for Bob.
    expect(only(await old).rows).toEqual([row("allowance", 50)]);
    expect(copilot.fetch).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 50)]),
    );
  });

  it("treats a snapshot file of another version exactly like no file", async () => {
    const copilot = fakeProvider();
    async function firstLook() {
      const store = makeStore([copilot.provider]);
      // Each store names itself with a new server id.
      const snapshot = { ...(await store.snapshot()), serverId: "" };
      await store.dispose();
      return { snapshot, saved: await readFile(file, "utf8") };
    }
    const withoutFile = await firstLook();
    const [key] = Object.keys((await savedFile()).entries);
    if (!key) throw new Error("nothing saved");
    // A recent entry: had it been read, the store would show it and not fetch.
    const entry = {
      providerId: "copilot",
      rows: [row("old", 10)],
      okAtMs: clock,
      checkedAtMs: clock,
      failures: 0,
      debug: [],
      notices: [],
      resetSeenAtMs: {},
    };
    for (const version of [1, 3]) {
      await writeFile(file, JSON.stringify({ version, entries: { [key]: entry } }));
      expect(await firstLook()).toEqual(withoutFile);
    }
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
  });

  it("works without a file", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider], 5 * MINUTE, null);
    expect(only(await store.refresh({ reason: "manual" })).rows).toEqual([row("allowance", 50)]);
    await expect(readFile(file)).rejects.toThrow();
  });
});
