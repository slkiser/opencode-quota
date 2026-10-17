import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { loadCustomQuotaDefinitions } from "./quota-provider-config.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { prepareProviderAdd, writeProviderPlan } from "./quota-provider-editor.js";

export async function runCliProvider(argv: string[]): Promise<number> {
  const [action, input, ...flags] = argv;
  if (action === "status" && input === undefined) {
    const loaded = loadCustomQuotaDefinitions();
    console.log(
      `Global custom definitions: ${loaded.definitions.length}${loaded.issues.length ? " (configuration unavailable or invalid)" : ""}`,
    );
    for (const d of loaded.definitions) console.log(`${d.id}: ${d.mode}; provider ${d.providerId}`);
    console.log(
      "No quota requests performed. Use show --provider <id> --details to validate source availability.",
    );
    return loaded.issues.length ? 1 : 0;
  }
  if (action !== "add" || !input) {
    console.error(
      "Usage: token-watcher provider add <definition.json> [--write --expect <preview-sha256>] | provider status",
    );
    return 1;
  }
  let write = false;
  let expected: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--write" && !write) write = true;
    else if (flags[i] === "--expect" && !expected && /^[a-f0-9]{64}$/u.test(flags[i + 1] ?? ""))
      expected = flags[++i];
    else {
      console.error("Invalid provider arguments");
      return 1;
    }
  }
  if (write !== Boolean(expected)) {
    console.error("Writing requires --write --expect <preview-sha256> from a reviewed preview");
    return 1;
  }
  try {
    const info = statSync(input);
    if (!info.isFile() || info.size > 65536) throw new Error("Invalid definition file");
    const definition = parseJsonOrJsonc(readFileSync(input, "utf8"), true);
    const target = join(getOpencodeRuntimeDirs().configDir, "opencode-quota", "quota-toast.json");
    const loaded = loadCustomQuotaDefinitions();
    // Do not silently shadow a legacy/alternate global definitions array.
    if (
      loaded.issues.length ||
      (loaded.definitions.length && loaded.path && resolve(loaded.path) !== resolve(target))
    ) {
      console.error(
        "Existing definitions use an invalid or alternate global config. Move the reviewed quotaProviders array to the primary sidecar before adding providers.",
      );
      return 1;
    }
    const plan = prepareProviderAdd(target, definition);
    if (!write) {
      console.log(`Global sidecar: ${target}\n${plan.preview}\nPreview SHA256: ${plan.digest}`);
      console.log(
        plan.changed
          ? "Review the complete changed field, then repeat with --write --expect <preview-sha256>."
          : "Already configured; no changes required.",
      );
      return 0;
    }
    const result = writeProviderPlan(plan, expected!);
    console.log(
      plan.changed
        ? "Provider configured. Reload quota settings to activate it."
        : "Already configured; no changes required.",
    );
    if (result.backup) console.log(`Private rollback copy: ${result.backup}`);
    if (result.durabilityWarning)
      console.error(
        "Config was written, but directory sync was unavailable; keep the rollback copy until verified.",
      );
    return 0;
  } catch {
    // Parser/OS errors can contain user text, file contents or endpoint details.
    console.error(
      "Provider configuration failed: invalid definition, changed preview, unavailable file or concurrent write. No raw config diagnostics are printed; review a fresh preview.",
    );
    return 1;
  }
}
