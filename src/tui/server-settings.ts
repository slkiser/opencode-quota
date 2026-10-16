/** All Settings tabs edit the server's settings.jsonc through the quota RPC. */
import { createSignal } from "solid-js";
import type { QuotaSnapshot, Words } from "../core/types.js";
import { isRecord } from "../lib/json-guards.js";
import type {
  QuotaRpcSaveSettingsInput,
  QuotaRpcSaveSettingsOutput,
  QuotaRpcSettingsOutput,
} from "../rpc.js";
import {
  CHANGED_SINCE_REVIEW,
  clientSettings,
  defaultSettings,
  isRecordSetting,
} from "../settings/schema.js";

/** The ids switched off; every other provider is checked when found. */
export const PROVIDERS_KEY = "providers.off";

export function foundProviderIds(snapshot: QuotaSnapshot | undefined): string[] {
  return (snapshot?.providers ?? []).map(({ providerId }) =>
    providerId === "quota-providers" ? "custom" : providerId,
  );
}

export function isTicked(off: readonly string[], id: string): boolean {
  return !off.includes(id);
}

export function withTick(off: readonly string[], id: string, on: boolean): string[] {
  return on ? off.filter((other) => other !== id) : [...new Set([...off, id])];
}

/** Changes by dotted key as the JSON merge patch `saveSettings` takes. */
export function settingsPatch(changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split(".");
    let group = patch;
    for (const part of parts.slice(0, -1)) {
      group[part] ??= {};
      group = group[part] as Record<string, unknown>;
    }
    group[parts[parts.length - 1] as string] = value;
  }
  return patch;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One entry of `record` set to `value`, or removed when `value` is the saved one. */
function changed<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
  saved: unknown,
): Record<string, T> {
  const next = { ...record };
  if (same(value, saved)) delete next[key];
  else next[key] = value;
  return next;
}

export type ServerSettingsRpc = {
  settings(): Promise<QuotaRpcSettingsOutput>;
  saveSettings(input: QuotaRpcSaveSettingsInput): Promise<QuotaRpcSaveSettingsOutput>;
};

export type ServerSettings = ReturnType<typeof createServerSettings>;

/** The saved server settings, and this window's changes and custom provider switches on top. */
export function createServerSettings(rpc: ServerSettingsRpc) {
  const [saved, setSaved] = createSignal<QuotaRpcSettingsOutput>();
  const [changes, setChanges] = createSignal<Readonly<Record<string, unknown>>>({});
  const [switches, setSwitches] = createSignal<Readonly<Record<string, boolean>>>({});
  /** Custom providers the server would not switch on: their definition changed since shown. */
  const [changedIds, setChangedIds] = createSignal<readonly string[]>([]);
  const defaults = clientSettings(defaultSettings()).values;
  /** The definition shown when each custom switch was changed, kept across live updates. */
  const reviewedFingerprints = new Map<string, string>();
  let received = 0;
  let reads = 0;
  let saving: Promise<void> | undefined;
  let savingEdits: Map<string, unknown> | undefined;
  let savingSwitches: Map<string, boolean> | undefined;
  const savedValue = (key: string) => saved()?.values[key] ?? defaults[key];
  const savedCustom = (id: string) => saved()?.custom.find((entry) => entry.id === id);
  const value = (key: string): unknown => {
    const patch = changes()[key];
    if (!Object.hasOwn(changes(), key)) return savedValue(key);
    if (isRecordSetting(key) && isRecord(patch)) {
      const next = { ...(savedValue(key) as Record<string, unknown>) };
      for (const [id, item] of Object.entries(patch)) {
        if (item === null) delete next[id];
        else next[id] = item;
      }
      return next;
    }
    return patch === null ? defaults[key] : patch;
  };
  const draftValue = (key: string, next: unknown): unknown => {
    if (!isRecordSetting(key) || !isRecord(next)) return next === undefined ? null : next;
    const before = savedValue(key) as Record<string, unknown>;
    return Object.fromEntries(
      [...new Set([...Object.keys(before), ...Object.keys(next)])]
        .filter((id) => !same(before[id], next[id]))
        .map((id) => [id, next[id] ?? null]),
    );
  };
  const customOn = (id: string): boolean => switches()[id] ?? savedCustom(id)?.enabled ?? false;
  const dirty = () => Object.keys(changes()).length + Object.keys(switches()).length > 0;
  async function readSaved(): Promise<void> {
    const read = ++reads;
    const at = received;
    const next = await rpc.settings();
    if (read === reads && at === received) setSaved(next);
  }
  async function saveDraft(): Promise<void> {
    const sentChanges = changes();
    const sentSwitches = switches();
    const customEnabled = Object.fromEntries(
      Object.entries(sentSwitches).map(([id, enabled]) => [
        id,
        {
          enabled,
          fingerprint: reviewedFingerprints.get(id) ?? savedCustom(id)?.fingerprint ?? "",
        },
      ]),
    );
    savingEdits = new Map();
    savingSwitches = new Map();
    try {
      const result = await rpc.saveSettings({
        patch: settingsPatch(sentChanges),
        ...(Object.keys(customEnabled).length > 0 ? { customEnabled } : {}),
      });
      const changedSince = result.issues
        .filter((issue) => issue.message === CHANGED_SINCE_REVIEW)
        .map((issue) => issue.key.slice("providers.custom.".length));
      if (changedSince.length > 0) {
        await readSaved();
        setChangedIds(changedSince);
        for (const id of changedSince) reviewedFingerprints.delete(id);
        setSwitches((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !changedSince.includes(id))),
        );
      }
      if (!result.ok) {
        throw new Error(result.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
      }
      await readSaved();
      // Only edits made after Save started remain drafts, over the latest saved settings.
      const remaining: Record<string, unknown> = {};
      for (const [key, patch] of savingEdits) {
        if (isRecordSetting(key) && isRecord(patch)) {
          const before = savedValue(key) as Record<string, unknown>;
          const entries = Object.entries(patch).filter(
            ([id, item]) => !same(item === null ? undefined : item, before[id]),
          );
          if (entries.length > 0) remaining[key] = Object.fromEntries(entries);
        } else if (!same(patch === null ? defaults[key] : patch, savedValue(key))) {
          remaining[key] = patch;
        }
      }
      setChanges(remaining);
      setSwitches(
        Object.fromEntries(
          [...savingSwitches].filter(([id, on]) => on !== (savedCustom(id)?.enabled ?? false)),
        ),
      );
    } finally {
      savingEdits = undefined;
      savingSwitches = undefined;
    }
  }
  return {
    /** Undefined until the first server answer. */
    saved,
    receive(next: QuotaRpcSettingsOutput): void {
      received += 1;
      setSaved(next);
    },
    value,
    set(key: string, next: unknown): void {
      if (savingEdits) {
        if (isRecordSetting(key) && isRecord(next)) {
          const before = value(key) as Record<string, unknown>;
          const edits = Object.fromEntries(
            [...new Set([...Object.keys(before), ...Object.keys(next)])]
              .filter((id) => !same(before[id], next[id]))
              .map((id) => [id, next[id] ?? null]),
          );
          savingEdits.set(key, { ...(savingEdits.get(key) as Record<string, unknown>), ...edits });
        } else {
          savingEdits.set(key, next === undefined ? null : next);
        }
      }
      const patch = draftValue(key, next);
      const unchanged =
        same(next, savedValue(key)) ||
        (isRecordSetting(key) && isRecord(patch) && Object.keys(patch).length === 0);
      setChanges((current) => {
        const result = { ...current };
        if (unchanged) delete result[key];
        else result[key] = patch;
        return result;
      });
    },
    customOn,
    switchCustom(id: string, on: boolean): void {
      reviewedFingerprints.set(id, savedCustom(id)?.fingerprint ?? "");
      savingSwitches?.set(id, on);
      setChangedIds((current) => current.filter((other) => other !== id));
      setSwitches((current) => changed(current, id, on, savedCustom(id)?.enabled));
    },
    changedSinceReview: (id: string): boolean => changedIds().includes(id),
    dirty,
    /** The words this window changed, for the surfaces to show while you edit. */
    draftWords(): Partial<Words> {
      return Object.fromEntries(
        Object.entries(changes())
          .filter(([key]) => key.startsWith("words."))
          .map(([key, value]) => [
            key.slice("words.".length),
            value === null ? defaults[key] : value,
          ]),
      );
    },
    async load(): Promise<void> {
      await readSaved();
    },
    /**
     * Saves one setting straight away, apart from the window's draft (the Plugin tab's
     * switches), then reads the saved settings again. The error says why the server refused it.
     */
    async saveNow(key: string, next: unknown): Promise<void> {
      const result = await rpc.saveSettings({ patch: settingsPatch({ [key]: next }) });
      if (!result.ok) {
        throw new Error(result.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
      }
      await readSaved();
    },
    /**
     * Sends the changes and switches in one save; nothing is saved when the server refuses any
     * of them, and the error says why. A switch-on carries the fingerprint of the definition
     * shown: one that changed since is reloaded and marked, not switched on. A change made while
     * it saves (one back to the old value too) stays unsaved.
     */
    save(): Promise<void> {
      if (saving) return saving;
      if (!dirty()) return Promise.resolve();
      saving = saveDraft().finally(() => {
        saving = undefined;
      });
      return saving;
    },
    discard(): void {
      reviewedFingerprints.clear();
      savingEdits?.clear();
      savingSwitches?.clear();
      setChanges({});
      setSwitches({});
      setChangedIds([]);
    },
  };
}
