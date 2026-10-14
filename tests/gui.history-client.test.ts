import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { HistoryHelperClient } from "../src/gui/history-client.js";
import type { HistoryRequest } from "../src/gui/history-helper.js";

const helperPath = fileURLToPath(new URL("./fixtures/history-helper.mjs", import.meta.url));
const clients: HistoryHelperClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
function client(options: ConstructorParameters<typeof HistoryHelperClient>[0] = {}) {
  const instance = new HistoryHelperClient({
    helperPath,
    nodeBinary: process.execPath,
    timeoutMs: 1000,
    ...options,
  });
  clients.push(instance);
  return instance;
}
function request(now: number): HistoryRequest {
  return {
    operation: "record",
    providerResults: [],
    now,
    pricing: { source: "bundled", autoRefresh: 0 },
  };
}
describe("bounded Node history helper", () => {
  it("serializes requests with IDs and shares a single worker", async () => {
    const worker = client();
    const results = await Promise.all([
      worker.request<{ pid: number; now: number }>(request(4)),
      worker.request<{ pid: number; now: number }>(request(5)),
    ]);
    expect(results.map((r) => r.now)).toEqual([4, 5]);
    expect(results[0]!.pid).toBe(results[1]!.pid);
  });
  it("bounds a hung worker and restarts after process death or unavailable binding", async () => {
    const worker = client({ timeoutMs: 300 });
    await expect(worker.request(request(2))).rejects.toThrow("timed out");
    await expect(worker.request(request(1))).rejects.toThrow("unavailable");
    await expect(worker.request(request(3))).rejects.toThrow("unavailable");
    await expect(worker.request(request(4))).resolves.toMatchObject({ now: 4 });
  });
  it("reports missing Node and disposal without leaking pending work", async () => {
    await expect(
      client({ nodeBinary: "/nonexistent/quota-node" }).request(request(4)),
    ).rejects.toThrow("unavailable");
    const worker = client();
    const pending = worker.request(request(2));
    const failed = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    worker.dispose();
    await failed;
    await expect(worker.request(request(4))).rejects.toThrow("unavailable");
  });
  it("starts a new helper when an idle worker has exited", async () => {
    const worker = client();
    const first = await worker.request<{ pid: number }>(request(4));
    process.kill(first.pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await worker.request<{ pid: number }>(request(4));
    expect(second.pid).not.toBe(first.pid);
  });
});
