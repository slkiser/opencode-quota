import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { applyProviderAddPlan, planProviderAdd } from "../src/lib/provider-add.js";
import { parseConfigDocument } from "../src/lib/opencode-config-editor.js";

const created: string[] = [];

async function configDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "provider-add-"));
  created.push(root);
  const dir = join(root, "opencode");
  await mkdir(dir, { recursive: true });
  return dir;
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    id: "private-gateway",
    mode: "remote-api",
    url: "https://gateway.example/accounting",
    format: "accounting-v1",
    apiKeyEnv: "PRIVATE_GATEWAY_KEY",
    modelIds: ["model-a"],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("provider add global config workflow", () => {
  it("previews exact JSONC with comments for every generated section", async () => {
    const dir = await configDir();
    const plan = await planProviderAdd({ definition: remote(), configDir: dir });

    expect(plan.path).toBe(join(dir, "opencode.jsonc"));
    expect(plan.format).toBe("jsonc");
    expect(plan.changed).toBe(true);
    expect(plan.updated).toContain(
      "// OpenCode Quota settings. Project quota-provider definitions are never trusted.",
    );
    expect(plan.updated).toContain(
      "// Ordered global-only definitions. Stable ids control state, cache, and provenance.",
    );
    expect(plan.updated).toContain("// Stable definition id;");
    expect(plan.updated).toContain("// Exactly one acquisition mode:");
    expect(plan.updated).toContain("// Fixed authenticated GET endpoint.");
    expect(plan.updated).toContain("// Safe response contract:");
    expect(plan.updated).toContain("// Environment variable name only.");
    expect(plan.updated).toContain('"quotaProviders"');
    expect(plan.updated).not.toContain("secret-value");
    expect(plan.ordinaryProviderRequired).toBe(true);
  });

  it("writes the preview atomically and is idempotent on a second run", async () => {
    const dir = await configDir();
    const first = await planProviderAdd({ definition: remote(), configDir: dir });
    await applyProviderAddPlan(first);
    expect(await readFile(first.path, "utf8")).toBe(first.updated);

    const second = await planProviderAdd({ definition: remote(), configDir: dir });
    expect(second.changed).toBe(false);
    expect(second.updated).toBe(first.updated);
  });

  it("updates an existing id in place without changing definition order", async () => {
    const dir = await configDir();
    const first = await planProviderAdd({
      definition: remote({ id: "first" }),
      configDir: dir,
    });
    await applyProviderAddPlan(first);
    const second = await planProviderAdd({
      definition: remote({
        id: "second",
        url: "https://second.example/accounting",
      }),
      configDir: dir,
    });
    await applyProviderAddPlan(second);
    const updated = await planProviderAdd({
      definition: remote({
        id: "first",
        label: "Updated First",
      }),
      configDir: dir,
    });
    await applyProviderAddPlan(updated);

    const parsed = parseConfigDocument(await readFile(updated.path, "utf8"), "jsonc", updated.path);
    const definitions = (
      (parsed.experimental as Record<string, unknown>).quotaToast as Record<string, unknown>
    ).quotaProviders as Array<Record<string, unknown>>;
    expect(definitions.map((definition) => definition.id)).toEqual(["first", "second"]);
    expect(definitions[0]?.label).toBe("Updated First");
  });

  it("preserves existing strict JSON without adding comments", async () => {
    const dir = await configDir();
    const path = join(dir, "opencode.json");
    await writeFile(
      path,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["@slkiser/opencode-quota@latest"],
      }),
      "utf8",
    );

    const plan = await planProviderAdd({ definition: remote(), configDir: dir });
    expect(plan.path).toBe(path);
    expect(plan.format).toBe("json");
    expect(plan.updated.split("\n").some((line) => line.trimStart().startsWith("//"))).toBe(false);
    expect(() => JSON.parse(plan.updated)).not.toThrow();
  });

  it("enables custom-provider support in a manual-mode quota sidecar", async () => {
    const dir = await configDir();
    const sidecarDir = join(dir, "opencode-quota");
    await mkdir(sidecarDir, { recursive: true });
    const sidecarPath = join(sidecarDir, "quota-toast.jsonc");
    await writeFile(sidecarPath, '{ // preserve\n  "enabledProviders": ["openai"],\n}\n', "utf8");

    const plan = await planProviderAdd({ definition: remote(), configDir: dir });
    expect(plan.path).toBe(sidecarPath);
    expect(plan.additionalDocumentEdits).toEqual([]);
    await applyProviderAddPlan(plan);

    const parsed = parseConfigDocument(await readFile(sidecarPath, "utf8"), "jsonc", sidecarPath);
    expect(parsed.enabledProviders).toEqual(["openai", "quota-providers"]);
    expect((parsed.quotaProviders as Array<Record<string, unknown>>)[0]?.id).toBe(
      "private-gateway",
    );
    expect(await readFile(sidecarPath, "utf8")).toContain("// preserve");
  });

  it("does not require a normal provider block for maintained Qwen tuning", async () => {
    const dir = await configDir();
    const plan = await planProviderAdd({
      configDir: dir,
      definition: {
        id: "qwen-code",
        mode: "local-estimate",
        windows: [
          { id: "daily", type: "utc-day", requestLimit: 2000 },
          { id: "rpm", type: "rolling", durationMinutes: 1, requestLimit: 120 },
        ],
      },
    });
    expect(plan.ordinaryProviderRequired).toBe(false);
    expect(plan.updated).not.toContain('"provider":');
  });

  it("rejects old customSources instead of migrating or aliasing it", async () => {
    const dir = await configDir();
    await writeFile(
      join(dir, "opencode.jsonc"),
      '{"experimental":{"quotaToast":{"customSources":[]}}}\n',
      "utf8",
    );
    await expect(planProviderAdd({ definition: remote(), configDir: dir })).rejects.toThrow(
      "customSources was removed",
    );
  });
});
