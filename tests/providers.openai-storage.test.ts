import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(async () => ({ openai: { type: "oauth", access: "native-cached" } })),
}));

import { openaiProvider } from "../src/providers/openai.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), "quota-openai-storage-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } },
          }),
        ),
    ),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(state.home, { recursive: true, force: true });
});

it.each([
  undefined,
  "{broken",
  '{"version":2,"accounts":[]}',
  '{"version":3,"accounts":{}}',
])("preserves native query and output with missing/invalid global storage: %s", async (storage) => {
  if (storage !== undefined) {
    await mkdir(join(state.home, ".opencode"));
    await writeFile(join(state.home, ".opencode", "oc-codex-multi-auth-accounts.json"), storage);
  }
  const out = await openaiProvider.fetch(createProviderAvailabilityContext());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(out.errors).toEqual([]);
  expect(out.entries).toHaveLength(1);
  expect(out.entries[0]).toMatchObject({ group: "OpenAI (Plus)", percentRemaining: 80 });
  expect(out.presentation).toEqual({ singleWindowDisplayName: "OpenAI (Plus)" });
  expect(out.statusDetails?.map((detail) => detail.key)).not.toContain("multi_auth_source");
});
