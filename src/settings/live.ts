/**
 * The settings a running server holds, and what each change of them asks of it. At the start it
 * writes the v5 settings into settings.jsonc once, reads the file, and gives the price list its
 * pricing settings. It holds each save made through it and, once followed, each edit of the file.
 */
import { safeErrorText } from "../core/redact.js";
import { usePricingSettings } from "../lib/modelsdev-pricing.js";
import type { V5Conversion } from "./convert.js";
import {
  convertV5,
  type LoadedSettings,
  loadSettings,
  type SaveResult,
  type SettingsWatch,
  saveSettings,
  watchSettings,
} from "./file.js";

/**
 * What a change of the held settings asks of the server. `recheck`: a checking or pricing setting
 * changed, or which of them the file sets, so every provider is checked again. `oldCommands`:
 * `system.oldCommands` changed, so the slash command list is built again.
 */
type LiveSettingsChange = { recheck: boolean; oldCommands: boolean };

type LiveSettings = {
  /** What converting the v5 settings at the start did; undefined when it had nothing to do. */
  readonly conversion: V5Conversion | undefined;
  /** The settings held now. */
  current(): LoadedSettings;
  /** True once this server wrote the v5 settings into settings.jsonc, at the start or by a save. */
  converted(): boolean;
  /** `saveSettings`, then the file is read again and held, before this resolves. */
  save(patch: unknown, options: Parameters<typeof saveSettings>[1]): Promise<SaveResult>;
  /**
   * From now on, calls `onChange` once per change of the settings or of the keys the file sets:
   * each save and each edit of the file (watched; close the returned watch to stop). A change
   * made since the start is read once more right after the watch starts. Call it once.
   */
  follow(onChange: (change: LiveSettingsChange) => Promise<void>): Promise<SettingsWatch>;
  /** Takes the pricing settings back; call it once no provider check can still read prices. */
  dispose(): void;
};

/**
 * The settings (or one part of them) with the keys of that part the file sets, so a value set
 * to its default in the file still differs from no value. The keys are sorted: their order in
 * the file changes nothing.
 */
function settingsWithSources(loaded: LoadedSettings, part?: "checking" | "pricing"): string {
  const fromFile = loaded.fromFile
    .filter((key) => part === undefined || key.startsWith(`providers.${part}.`))
    .sort();
  return JSON.stringify([
    part === undefined ? loaded.settings : loaded.settings.providers[part],
    fromFile,
  ]);
}

/**
 * `projectDir`: the folder whose v5 project files the status report lists as not read.
 * `debounceMs`: the file watch's (see `watchSettings`).
 */
export async function createLiveSettings({
  projectDir,
  debounceMs,
}: {
  projectDir: string;
  debounceMs?: number;
}): Promise<LiveSettings> {
  // The v5 settings move into settings.jsonc once, before anything reads the settings; a failure
  // leaves them converted in memory.
  const conversion = await convertV5().catch((error: unknown) => {
    console.warn(`[opencode-quota] settings conversion failed: ${safeErrorText(error)}`);
    return undefined;
  });
  let converted = conversion?.written ?? false;
  let current = await loadSettings({ projectDir });
  // Local estimates and usage reports use the price list of the settings held now.
  const unbindPricingSettings = usePricingSettings(() => current.settings.providers.pricing);
  let onChange: ((change: LiveSettingsChange) => Promise<void>) | undefined;

  async function hold(next: LoadedSettings): Promise<void> {
    const previous = current;
    current = next;
    if (settingsWithSources(next) === settingsWithSources(previous)) return;
    const changed = (part: "checking" | "pricing") =>
      settingsWithSources(next, part) !== settingsWithSources(previous, part);
    await onChange?.({
      recheck: changed("checking") || changed("pricing"),
      oldCommands: next.settings.system.oldCommands !== previous.settings.system.oldCommands,
    });
  }

  return {
    conversion,
    current: () => current,
    converted: () => converted,
    // The watch sees the save too; reading the file now holds the new settings at once.
    async save(patch, saveOptions) {
      const converting = !current.exists && Boolean(current.conversion);
      const result = await saveSettings(patch, saveOptions);
      if (result.ok) {
        if (converting) converted = true;
        await hold(await loadSettings({ projectDir }));
      }
      return result;
    },
    async follow(listener) {
      if (onChange) throw new Error("the settings are followed already");
      onChange = listener;
      const watch = await watchSettings((next) => void hold(next), { projectDir, debounceMs });
      await hold(await loadSettings({ projectDir }));
      return watch;
    },
    dispose: unbindPricingSettings,
  };
}
