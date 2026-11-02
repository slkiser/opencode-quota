/**
 * All Settings tabs edit the server's settings.jsonc through the quota RPC, with a draft
 * (`settings-draft.ts`) shaped by the schema in `settings/schema.ts`.
 */
import type { QuotaSnapshot } from "../core/types.js";
import { offProviderId, SETTINGS_SCHEMA } from "../settings/schema.js";
import {
  createSettingsDraft,
  type ServerSettingsRpc,
  type SettingsDraft,
  settingsShape,
} from "./settings-draft.js";

export {
  isTicked,
  PROVIDERS_KEY,
  type ServerSettingsRpc,
  settingsPatch,
  withTick,
} from "./settings-draft.js";

export function foundProviderIds(snapshot: QuotaSnapshot | undefined): string[] {
  return (snapshot?.providers ?? []).map(({ providerId }) => offProviderId(providerId));
}

export type ServerSettings = SettingsDraft;

/** The saved server settings, and this window's changes and custom provider switches on top. */
export function createServerSettings(rpc: ServerSettingsRpc): ServerSettings {
  return createSettingsDraft(rpc, settingsShape(SETTINGS_SCHEMA));
}
