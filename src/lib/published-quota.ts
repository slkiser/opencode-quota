import { randomUUID } from "node:crypto";
import type { ProviderRow } from "../providers/contract.js";
import { parseQuotaV1 } from "./quota-providers-remote.js";

const MAX_AGE_MS = 120_000;

type Snapshot = { rows: ProviderRow[]; receivedAt: number; timer: ReturnType<typeof setTimeout> };

export function createPublishedQuota(now: () => number = Date.now, changed = () => {}) {
  const snapshots = new Map<string, Snapshot>();
  const tickets = new Map<string, string>();
  let enabled = new Set<string>();

  function remove(providerId: string): boolean {
    const snapshot = snapshots.get(providerId);
    if (!snapshot) return false;
    clearTimeout(snapshot.timer);
    return snapshots.delete(providerId);
  }

  function fresh(providerId: string) {
    const snapshot = snapshots.get(providerId);
    if (snapshot && snapshot.receivedAt + MAX_AGE_MS > now()) return snapshot;
  }

  function clear() {
    const hadRows = snapshots.size > 0;
    for (const id of snapshots.keys()) remove(id);
    tickets.clear();
    if (hadRows) changed();
  }

  return {
    clear,
    reconcile(ids: readonly string[]) {
      enabled = new Set(ids);
      let removed = false;
      for (const id of snapshots.keys()) {
        if (!enabled.has(id)) removed = remove(id) || removed;
      }
      for (const id of tickets.keys()) if (!enabled.has(id)) tickets.delete(id);
      if (removed) changed();
    },
    probe(providerId: string) {
      if (!enabled.has(providerId)) return undefined;
      const ticket = randomUUID();
      tickets.set(providerId, ticket);
      return ticket;
    },
    publish(providerId: string, ticket: string | undefined, body: unknown) {
      if (!ticket || tickets.get(providerId) !== ticket) return false;
      const parsed = parseQuotaV1(body, true);
      if (!parsed.success) return false;
      tickets.delete(providerId);
      const removed = remove(providerId);
      if (parsed.rows.length) {
        const timer = setTimeout(() => {
          if (remove(providerId)) changed();
        }, MAX_AGE_MS);
        timer.unref();
        snapshots.set(providerId, { rows: parsed.rows, receivedAt: now(), timer });
      }
      if (removed || parsed.rows.length) changed();
      return true;
    },
    read: (providerId: string) => fresh(providerId),
  };
}

export type PublishedQuota = Pick<ReturnType<typeof createPublishedQuota>, "read">;
