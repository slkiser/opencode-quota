/**
 * The server settings, one module: `loadSettings`, `saveSettings(patch)`, `editSettings`,
 * `editSettingsFile`, `watchSettings`, `convertV5`, the settings a running server holds
 * (`createLiveSettings`) and the schema the agent tools describe and check values with.
 * Every client reads these settings from settings.jsonc through the quota RPC.
 */
export type { ConvertedKey, SkippedKey, V5Conversion } from "./convert.js";
export {
  type CustomSwitch,
  convertV5,
  editSettings,
  editSettingsFile,
  type LoadedSettings,
  loadSettings,
  type SaveResult,
  type SettingsChange,
  type SettingsFileEdit,
  type SettingsWatch,
  saveSettings,
  settingsPath,
  watchSettings,
} from "./file.js";
export { createLiveSettings } from "./live.js";
export {
  type ClientSettings,
  type CustomProviderSwitch,
  checkSetting,
  clientSettings,
  customProviderFingerprint,
  defaultSettings,
  describeRule,
  keysUnder,
  PROVIDER_IDS,
  SETTINGS_SCHEMA,
  type SettingRule,
  type Settings,
  type SettingsIssue,
  type SettingsPatch,
} from "./schema.js";
