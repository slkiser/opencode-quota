import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSnapshotPublisher } from "../src/core/snapshot-publisher.js";
import type { ProviderSnapshot, QuotaSnapshot } from "../src/core/types.js";
import { buildQuotaExportFromSnapshot } from "../src/lib/quota-export.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function provider(fields: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: "copilot",
    label: "Copilot",
    rows: [
      {
        id: "copilot.allowance",
        providerId: "copilot",
        account: "pro",
        label: "Premium requests",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "month",
        prominence: "primary",
        percentRemaining: 80,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    okAtMs: NOW - 30_000,
    checkedAtMs: NOW - 30_000,
    refreshing: false,
    debug: [],
    ...fields,
  };
}

function snapshot(providers: ProviderSnapshot[], generatedAtMs = NOW): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices: [],
    generatedAtMs,
    serverId: "server",
    revision: generatedAtMs,
  };
}

describe("export built from the quota snapshot rows", () => {
  it.each([
    { name: "ok", given: provider(), status: "ok" },
    { name: "partial", given: provider({ error: { code: "timeout" } }), status: "partial" },
    {
      name: "error",
      given: provider({ rows: [], okAtMs: undefined, error: { code: "login_expired" } }),
      status: "error",
    },
    {
      name: "unavailable",
      given: provider({ rows: [], okAtMs: undefined, checkedAtMs: undefined }),
      status: "unavailable",
    },
  ])("marks a provider $name", ({ given, status }) => {
    expect(buildQuotaExportFromSnapshot(snapshot([given]), NOW).providers.copilot?.status).toBe(
      status,
    );
  });

  it("writes each row as an entry in the v3 export shape", () => {
    const exported = buildQuotaExportFromSnapshot(
      snapshot([provider({ error: { code: "timeout" } })]),
      NOW,
    );
    expect(exported).toMatchObject({ version: 3, fromCache: true, cacheAgeSeconds: 30 });
    expect(exported.providers.copilot).toEqual({
      status: "partial",
      fetchedAt: Math.floor((NOW - 30_000) / 1000),
      entries: [
        expect.objectContaining({
          id: "copilot.allowance",
          name: "Copilot (pro) Premium requests",
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          window: "Monthly",
          percentRemaining: 80,
          resetAt: Date.parse("2026-11-01T00:00:00.000Z") / 1000,
        }),
      ],
      errors: [{ label: "Copilot", message: "Timed out" }],
    });
  });

  it("writes a provider's part from its last check as it is, rows or not", () => {
    const exportPart = { status: "error", fetchedAt: 1_000, error: "HTTP 503" } as const;
    const exported = buildQuotaExportFromSnapshot(snapshot([provider({ exportPart })]), NOW);
    expect(exported.providers.copilot).toEqual(exportPart);
    expect(exported.cacheAgeSeconds).toBe(Math.floor(NOW / 1000) - 1_000);
  });
});

describe("snapshot publisher", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-quota-publisher-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function start(exportEnabled: boolean) {
    const path = join(root, "quota-export.json");
    const loadSettings = vi.fn(async () => ({
      export: { enabled: exportEnabled, path },
      telemetry: false,
    }));
    const log = vi.fn();
    const publisher = createSnapshotPublisher({ loadSettings, log });
    const written = async () => JSON.parse(await readFile(path, "utf8"));
    return { publisher, loadSettings, log, written, path };
  }

  it("writes the export after a change, and only the newest of the waiting snapshots", async () => {
    const { publisher, loadSettings, written } = start(true);
    publisher.publish(snapshot([provider()], NOW - 2));
    publisher.publish(snapshot([provider({ label: "Older" })], NOW - 1));
    publisher.publish(snapshot([provider({ label: "Newest" })], NOW));
    await publisher.idle();

    expect(loadSettings).toHaveBeenCalledTimes(2);
    const exported = await written();
    expect(exported.providers.copilot.entries[0].name).toBe("Newest (pro) Premium requests");
  });

  it("writes nothing when the export is off, and nothing after dispose", async () => {
    const off = start(false);
    off.publisher.publish(snapshot([provider()]));
    await off.publisher.idle();
    await expect(readFile(off.path)).rejects.toThrow();

    const disposed = start(true);
    disposed.publisher.dispose();
    disposed.publisher.publish(snapshot([provider()]));
    await disposed.publisher.idle();
    expect(disposed.loadSettings).not.toHaveBeenCalled();
  });

  it("logs a failed publication and keeps publishing later snapshots", async () => {
    const { publisher, loadSettings, log, written } = start(true);
    loadSettings.mockRejectedValueOnce(new Error("settings unreadable"));
    publisher.publish(snapshot([provider()]));
    await publisher.idle();
    publisher.publish(snapshot([provider()]));
    await publisher.idle();

    expect(log).toHaveBeenCalledExactlyOnceWith(
      "could not publish the quota snapshot",
      expect.objectContaining({ message: "settings unreadable" }),
    );
    expect((await written()).providers.copilot.status).toBe("ok");
  });
});
