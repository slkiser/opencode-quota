import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeDashboardDatabase } from "../src/dashboard/native-database.js";
import { DashboardApi } from "../src/dashboard/api.js";
import { recordQuotaObservations } from "../src/dashboard/quota-snapshot-bridge.js";
import { openAIAccounting } from "../src/providers/accounting-adapters.js";
import {
  getResetEvents,
  advertiseResetDesktop,
  retryUncertainReset,
  claimResetEvents,
  settleResetEvent,
} from "../src/dashboard/reset-events.js";
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const watched = [{ providerId: "openai", windowId: "weekly" }];
function observation(id: string, now: number, before: boolean) {
  const accounting = openAIAccounting({
    success: true,
    label: "OpenAI",
    windows: {
      weekly: {
        percentRemaining: before ? 25 : 100,
        resetTimeIso: new Date(now + (before ? -1000 : 604800000)).toISOString(),
      },
    },
  });
  accounting.rows[0].account = { kind: "opaque", digest: "a".repeat(64) };
  return {
    providerId: "openai",
    result: {
      attempted: true,
      entries: [{ name: "Weekly", percentRemaining: before ? 25 : 100 }],
      errors: [],
      accounting,
      observation: { id, observedAt: now - (before ? 2000 : 0) },
    },
  };
}
async function seed() {
  root = await mkdtemp(join(tmpdir(), "quota-reset-events-"));
  const file = join(root, "history.db"),
    db = await openNativeDashboardDatabase(file),
    api = new DashboardApi(db),
    now = Date.now();
  const old = observation("before", now, true),
    current = observation("after", now, false);
  recordQuotaObservations(api, [old, current, current]);
  return { db, api, now, file, current };
}
describe("durable reset delivery state", () => {
  it("prefers an available desktop for the selected window and falls back after expiry", async () => {
    const { db, now } = await seed();
    advertiseResetDesktop(db, { consumerId: "desktop", watched, available: true, now });
    const plugin = {
      enabled: true,
      watched,
      channel: "plugin" as const,
      consumerId: "plugin",
      now,
    };
    expect(claimResetEvents(db, plugin)).toEqual([]);
    expect(claimResetEvents(db, { ...plugin, now: now + 45001 })).toHaveLength(1);
    db.close();
  });
  it("does not suppress other windows or an explicit first-available channel policy", async () => {
    const { db, now } = await seed();
    advertiseResetDesktop(db, {
      consumerId: "desktop",
      watched: [{ providerId: "openai", windowId: "hourly" }],
      available: true,
      now,
    });
    const plugin = {
      enabled: true,
      watched,
      channel: "plugin" as const,
      consumerId: "plugin",
      now,
    };
    const first = claimResetEvents(db, plugin)[0];
    settleResetEvent(db, {
      id: first.event.id,
      leaseToken: first.leaseToken,
      channel: "plugin",
      delivered: false,
      now,
    });
    advertiseResetDesktop(db, { consumerId: "desktop", watched, available: true, now });
    expect(claimResetEvents(db, { ...plugin, preferDesktop: false })).toHaveLength(1);
    db.close();
  });
  it("withdraws denied desktop capability and requires explicit uncertain retry", async () => {
    const { db, now } = await seed();
    advertiseResetDesktop(db, { consumerId: "desktop", watched, available: true, now });
    advertiseResetDesktop(db, { consumerId: "desktop", watched: [], available: false, now });
    const first = claimResetEvents(db, {
      enabled: true,
      watched,
      channel: "plugin",
      consumerId: "plugin",
      now,
      leaseMs: 5000,
    })[0];
    expect(retryUncertainReset(db, first.event.id, now)).toBe(false);
    expect(retryUncertainReset(db, first.event.id, now + 5001)).toBe(true);
    expect(
      claimResetEvents(db, {
        enabled: true,
        watched,
        channel: "desktop",
        consumerId: "desktop",
        now: now + 5002,
      }),
    ).toHaveLength(1);
    db.close();
  });
  it("does not let a larger unwatched backlog starve selected windows", async () => {
    const { db, now } = await seed();
    const original = getResetEvents(db)[0];
    for (let index = 0; index < 150; index++) {
      const event = {
        ...original,
        id: index.toString(16).padStart(64, "0"),
        providerId: "unwatched",
        observedAt: now - 100,
      };
      db.prepare(
        "INSERT INTO reset_events(id,provider,account_identity,window_id,observed_at,reset_at,event_data,state) VALUES(?,?,?,?,?,?,?,'pending')",
      ).run(
        event.id,
        event.providerId,
        event.accountIdentity,
        event.windowId,
        event.observedAt,
        event.resetAt,
        JSON.stringify(event),
      );
    }
    expect(
      claimResetEvents(db, { enabled: true, watched, channel: "desktop", consumerId: "a", now }),
    ).toHaveLength(1);
    db.close();
  });
  it("keeps future-dated events pending after a backward clock jump", async () => {
    const { db, now } = await seed();
    expect(
      claimResetEvents(db, {
        enabled: true,
        watched,
        channel: "desktop",
        consumerId: "a",
        now: now - 1000,
      }),
    ).toEqual([]);
    expect(getResetEvents(db)[0].state).toBe("pending");
    db.close();
  });
  it("rolls back event and rich row if the corresponding legacy snapshot cannot commit", async () => {
    const { db, api, current } = await seed();
    db.exec(
      "DELETE FROM reset_events; DELETE FROM accounting_observations WHERE observation_id='after'; DELETE FROM quota_snapshots WHERE json_extract(quota_data,'$.observation.id')='after';",
    );
    db.exec(
      "CREATE TRIGGER fail_snapshot BEFORE INSERT ON quota_snapshots BEGIN SELECT RAISE(ABORT,'fixture snapshot failure'); END;",
    );
    expect(recordQuotaObservations(api, [current])).toEqual(["History write failed for openai"]);
    expect(getResetEvents(db)).toEqual([]);
    expect(api.getAccountingHistory("openai")).toHaveLength(1);
    expect(api.getQuotaHistory("openai")).toHaveLength(1);
    db.close();
  });
  it("fails closed on corrupt event state and resumes after explicit repair", async () => {
    const { db, now } = await seed();
    const row = db.prepare("SELECT id,event_data FROM reset_events").get() as {
      id: string;
      event_data: string;
    };
    db.exec("UPDATE reset_events SET event_data='broken'");
    expect(() =>
      claimResetEvents(db, { enabled: true, watched, channel: "desktop", consumerId: "a", now }),
    ).toThrow();
    expect(db.prepare("SELECT state FROM reset_events").get()).toMatchObject({ state: "pending" });
    db.prepare("UPDATE reset_events SET event_data=? WHERE id=?").run(row.event_data, row.id);
    expect(
      claimResetEvents(db, { enabled: true, watched, channel: "desktop", consumerId: "a", now }),
    ).toHaveLength(1);
    db.close();
  });
  it("deduplicates through restart and acknowledges only the selected channel/lease after delivery", async () => {
    let { db, file, now } = await seed();
    expect(getResetEvents(db)).toHaveLength(1);
    expect(
      claimResetEvents(db, { enabled: false, watched, channel: "desktop", consumerId: "a", now }),
    ).toEqual([]);
    const claim = claimResetEvents(db, {
      enabled: true,
      watched,
      channel: "desktop",
      consumerId: "a",
      now,
    })[0];
    expect(
      claimResetEvents(db, { enabled: true, watched, channel: "plugin", consumerId: "b", now }),
    ).toEqual([]);
    expect(
      settleResetEvent(db, {
        id: claim.event.id,
        leaseToken: claim.leaseToken,
        channel: "plugin",
        delivered: true,
        now,
      }),
    ).toBe(false);
    expect(
      settleResetEvent(db, {
        id: claim.event.id,
        leaseToken: claim.leaseToken,
        channel: "desktop",
        delivered: true,
        now,
      }),
    ).toBe(true);
    db.close();
    db = await openNativeDashboardDatabase(file);
    new DashboardApi(db);
    expect(getResetEvents(db)[0].state).toBe("delivered");
    expect(
      claimResetEvents(db, { enabled: true, watched, channel: "plugin", consumerId: "c", now }),
    ).toEqual([]);
    db.close();
  });
  it("releases an explicit delivery failure, but exposes a crash as uncertain without automatic duplicate delivery", async () => {
    const { db, now } = await seed();
    const first = claimResetEvents(db, {
      enabled: true,
      watched,
      channel: "desktop",
      consumerId: "a",
      now,
    })[0];
    expect(
      settleResetEvent(db, {
        id: first.event.id,
        leaseToken: first.leaseToken,
        channel: "desktop",
        delivered: false,
        now,
      }),
    ).toBe(true);
    const retry = claimResetEvents(db, {
      enabled: true,
      watched,
      channel: "plugin",
      consumerId: "b",
      now,
      leaseMs: 5000,
    })[0];
    expect(retry.leaseToken).not.toBe(first.leaseToken);
    expect(
      claimResetEvents(db, {
        enabled: true,
        watched,
        channel: "desktop",
        consumerId: "restart",
        now: now + 6000,
      }),
    ).toEqual([]);
    expect(getResetEvents(db)[0].state).toBe("uncertain");
    expect(
      settleResetEvent(db, {
        id: retry.event.id,
        leaseToken: retry.leaseToken,
        channel: "plugin",
        delivered: true,
        now: now + 6000,
      }),
    ).toBe(false);
    db.close();
  });
  it("recovers a baseline after corrupt prior data without inventing a reset", async () => {
    const { db, api, now, current } = await seed();
    db.exec("DELETE FROM reset_events");
    db.exec("DELETE FROM accounting_observations WHERE observation_id='after'");
    db.exec("UPDATE accounting_observations SET row_data='broken'");
    recordQuotaObservations(api, [current]);
    expect(getResetEvents(db)).toEqual([]);
    const future = observation("later", now + 604800000, false);
    // Current evidence is valid but genuinely future-dated, so clock passage alone cannot notify.
    recordQuotaObservations(api, [future]);
    expect(getResetEvents(db)).toEqual([]);
    db.close();
  });
});
