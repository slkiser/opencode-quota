import type { ProviderRow } from "../providers/contract.js";
import { parseQuotaV1 } from "./quota-providers-remote.js";

const MAX_AGE_MS = 120_000;

type Snapshot = { rows: ProviderRow[]; expiresAt: number; generation: number };

export function createPublishedQuota(now: () => number = Date.now) {
  const snapshots = new Map<string, Snapshot>();
  let generation = 0;
  function fresh(providerId: string) {
    const snapshot = snapshots.get(providerId);
    if (snapshot && snapshot.expiresAt > now()) return snapshot;
    snapshots.delete(providerId);
  }

  return {
    clear: () => snapshots.clear(),
    publish(providerId: string, body: unknown) {
      const parsed = parseQuotaV1(body, true);
      if (!parsed.success) return false;
      if (parsed.rows.length === 0) snapshots.delete(providerId);
      else {
        snapshots.set(providerId, {
          rows: parsed.rows,
          expiresAt: now() + MAX_AGE_MS,
          generation: fresh(providerId)?.generation ?? ++generation,
        });
      }
      return true;
    },
    read: (providerId: string) => fresh(providerId)?.rows,
    generation: (providerId: string) => fresh(providerId)?.generation,
  };
}

export type PublishedQuota = Pick<ReturnType<typeof createPublishedQuota>, "read" | "generation">;
